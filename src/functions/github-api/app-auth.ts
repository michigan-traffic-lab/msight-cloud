import { createSign, randomUUID } from 'node:crypto';
import { GetSecretValueCommand, SecretsManagerClient } from '@aws-sdk/client-secrets-manager';
import type { GithubErrorCode } from '../../shared/github/rpc';

/**
 * Authenticating as the GitHub App, and as one of its installations.
 *
 * Two distinct credentials, and conflating them is the usual source of
 * confusion:
 *
 *   App JWT             — signed here with the App's private key, proves "I am
 *                         this App", lives ~9 minutes, and can do exactly two
 *                         useful things: read `GET /app` and mint installation
 *                         tokens. It cannot touch a repository.
 *   Installation token  — minted with the JWT above, scoped to one
 *                         installation's repos and granted permissions, lives
 *                         one hour, and is what actually reads a repo. It is
 *                         also a usable git credential
 *                         (https://x-access-token:<token>@github.com/...),
 *                         which is why no deploy key is needed anywhere.
 *
 * Neither is ever returned to the console or written to a log.
 */

/** Thrown with a code the RPC layer maps straight onto a response. */
export class GithubAuthError extends Error {
  constructor(
    readonly code: GithubErrorCode,
    message: string,
    readonly status: number | null = null
  ) {
    super(message);
    this.name = 'GithubAuthError';
  }
}

export interface AppCredentials {
  appId: number;
  privateKey: string;
  webhookSecret: string | null;
}

const secrets = new SecretsManagerClient({});

/**
 * The credentials, cached for the life of the container.
 *
 * Safe to hold: rotating the private key means writing a new secret version,
 * and Lambda containers are replaced within minutes. A failed load is not
 * cached, so a transient Secrets Manager error at cold start does not poison
 * every later invocation.
 */
let cached: AppCredentials | null = null;

function requireEnv(key: string): string {
  const value = process.env[key];
  if (!value) {
    throw new GithubAuthError(
      'app_not_configured',
      `${key} is not set on the github-api function.`
    );
  }
  return value;
}

/**
 * A PEM pasted through a JSON field arrives with its newlines escaped often
 * enough that accepting both spellings is worth four lines. A key with literal
 * "\n" in it fails signing with an opaque OpenSSL error, which is a miserable
 * thing to debug from a console form.
 */
function normalizePem(raw: string): string {
  const pem = raw.includes('-----BEGIN') && !raw.includes('\n') ? raw.replace(/\n/g, '\n') : raw;
  return pem.trim().replace(/\n/g, '\n');
}

export async function loadCredentials(): Promise<AppCredentials> {
  if (cached) {
    return cached;
  }

  const secretId = requireEnv('GITHUB_APP_SECRET_ARN');
  const result = await secrets.send(new GetSecretValueCommand({ SecretId: secretId }));

  if (!result.SecretString) {
    throw new GithubAuthError(
      'app_not_configured',
      'No GitHub App credentials have been saved yet.'
    );
  }

  // The stack creates this secret holding a throwaway placeholder, so "not
  // configured yet" and "configured wrongly" both land here. They get the same
  // message because the fix is the same, and the first is by far the likelier.
  const notConfigured =
    'No GitHub App credentials have been saved for this deployment. Save the App ID ' +
    'and the .pem private key on the Microservices page first.';

  let parsed: { app_id?: unknown; private_key?: unknown; webhook_secret?: unknown };
  try {
    parsed = JSON.parse(result.SecretString);
  } catch {
    throw new GithubAuthError('app_not_configured', notConfigured);
  }

  const appId = Number(parsed.app_id);
  if (!Number.isInteger(appId) || appId <= 0) {
    throw new GithubAuthError('app_not_configured', notConfigured);
  }

  if (typeof parsed.private_key !== 'string' || !parsed.private_key.includes('-----BEGIN')) {
    throw new GithubAuthError('app_not_configured', notConfigured);
  }

  cached = {
    appId,
    privateKey: normalizePem(parsed.private_key),
    webhookSecret:
      typeof parsed.webhook_secret === 'string' && parsed.webhook_secret.length > 0
        ? parsed.webhook_secret
        : null,
  };
  return cached;
}

function base64url(input: Buffer | string): string {
  return Buffer.from(input).toString('base64url');
}

/**
 * A JWT signed as the App.
 *
 * `iat` is backdated a minute because GitHub rejects a token whose issue time
 * is in the future by its clock, and Lambda clocks are close but not identical.
 * `exp` is nine minutes out; GitHub's hard ceiling is ten and it rejects
 * anything beyond it outright.
 */
export function signAppJwt(credentials: AppCredentials, now = Date.now()): string {
  const issuedAt = Math.floor(now / 1000) - 60;
  const header = base64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const payload = base64url(
    JSON.stringify({ iat: issuedAt, exp: issuedAt + 600, iss: String(credentials.appId) })
  );
  const signingInput = `${header}.${payload}`;

  let signature: string;
  try {
    signature = createSign('RSA-SHA256')
      .update(signingInput)
      .sign(credentials.privateKey)
      .toString('base64url');
  } catch (error) {
    // Almost always a malformed PEM rather than anything about GitHub, and the
    // OpenSSL message alone does not say so.
    throw new GithubAuthError(
      'bad_private_key',
      'The stored private key could not be used to sign. Re-download the .pem from ' +
        'the GitHub App settings page and save it again. ' +
        `(${error instanceof Error ? error.message : 'unknown error'})`
    );
  }

  return `${signingInput}.${signature}`;
}

interface CachedToken {
  token: string;
  /** Epoch ms. */
  expiresAt: number;
}

/**
 * Installation tokens, cached per container.
 *
 * Per container rather than shared, because the alternative would be a cache
 * this function cannot reach: Valkey is inside the VPC and this function is
 * deliberately outside it. The cost of that is a few extra mints across cold
 * containers, against a rate limit measured in thousands per hour, on a path
 * only ever driven by an admin clicking something.
 */
const tokenCache = new Map<number, CachedToken>();

/** Refreshed early: a token that expires mid-request is a confusing 401. */
const TOKEN_REFRESH_MARGIN_MS = 5 * 60 * 1000;

export function cachedInstallationToken(installationId: number, now = Date.now()): string | null {
  const entry = tokenCache.get(installationId);
  if (!entry || entry.expiresAt - TOKEN_REFRESH_MARGIN_MS <= now) {
    return null;
  }
  return entry.token;
}

export function rememberInstallationToken(
  installationId: number,
  token: string,
  expiresAtIso: string
): void {
  const expiresAt = Date.parse(expiresAtIso);
  tokenCache.set(installationId, {
    token,
    // A token GitHub described with an unparseable expiry is still good for an
    // hour by contract; assume the minimum rather than discarding it.
    expiresAt: Number.isFinite(expiresAt) ? expiresAt : Date.now() + 55 * 60 * 1000,
  });
}

export function forgetInstallationToken(installationId: number): void {
  tokenCache.delete(installationId);
}

/** Correlates one console action with its GitHub calls in the logs. */
export function newRequestId(): string {
  return randomUUID();
}

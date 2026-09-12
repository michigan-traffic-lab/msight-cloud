import { createHmac, timingSafeEqual } from 'node:crypto';
import { GetSecretValueCommand, SecretsManagerClient } from '@aws-sdk/client-secrets-manager';
import { InvokeCommand, LambdaClient } from '@aws-sdk/client-lambda';
import type { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from 'aws-lambda';

/**
 * Where GitHub delivers pushes.
 *
 * The only unauthenticated entry point in this deployment that can cause a
 * deployment, which is why it is its own function and why it does almost
 * nothing. Its entire job is to establish that a request really came from the
 * GitHub App — everything after that is decided in the VPC against the
 * registry, by code the console already calls.
 *
 * It is deliberately outside the VPC and has no database access. It needs the
 * App's webhook secret and the right to invoke one function, and giving it a
 * route to Aurora as well would widen what a flaw here could reach for no gain.
 *
 * Three things are worth knowing about the shape of this:
 *
 *   * The signature is checked before the body is parsed. HMAC is computed over
 *     the raw bytes, so parsing first and re-serialising would compare a hash
 *     of something GitHub never sent.
 *
 *   * Everything is answered 200, including rejections. GitHub retries nothing
 *     and shows delivery failures to the repository owner; a 401 on a request
 *     that was never from GitHub is noise on someone else's account, and a 500
 *     on a push that matched no service would make an ordinary event look like
 *     a fault. The body says what happened, and the App's delivery log shows
 *     it.
 *
 *   * The push is handed on asynchronously. API Gateway caps an integration at
 *     30 seconds and a first-time provision can take longer, so waiting would
 *     mean GitHub recording a failed delivery for work that succeeded. What
 *     actually happened is written to the service's history instead, which is
 *     where anyone would look for it anyway.
 */

const secrets = new SecretsManagerClient({});
const lambda = new LambdaClient({});

const ADMIN_FUNCTION_NAME = process.env.ADMIN_VPC_API_FUNCTION_NAME ?? '';
const APP_SECRET_ARN = process.env.GITHUB_APP_SECRET_ARN ?? '';

/**
 * Cached for the life of the container.
 *
 * Rotating the webhook secret means writing a new secret version, and Lambda
 * containers are replaced within minutes. A failed load is not cached, so a
 * transient Secrets Manager error at cold start does not poison every later
 * delivery.
 */
let cachedSecret: string | null = null;

async function webhookSecret(): Promise<string | null> {
  if (cachedSecret !== null) {
    return cachedSecret;
  }

  const result = await secrets.send(new GetSecretValueCommand({ SecretId: APP_SECRET_ARN }));
  if (!result.SecretString) {
    return null;
  }

  try {
    const parsed = JSON.parse(result.SecretString) as { webhook_secret?: unknown };
    if (typeof parsed.webhook_secret === 'string' && parsed.webhook_secret.length > 0) {
      cachedSecret = parsed.webhook_secret;
      return cachedSecret;
    }
  } catch {
    // Falls through to null: an unparseable secret is "not configured", which
    // is the same outcome and the same fix.
  }

  return null;
}

/**
 * Whether the body really came from the App holding this secret.
 *
 * `timingSafeEqual` rather than `===`, and the length is checked first because
 * it throws on a mismatch. The comparison is of hex digests, so a forged header
 * of the wrong length is rejected before any byte comparison happens.
 */
export function signatureMatches(input: {
  body: string;
  header: string | undefined;
  secret: string;
}): boolean {
  if (!input.header || !input.header.startsWith('sha256=')) {
    return false;
  }

  const expected = `sha256=${createHmac('sha256', input.secret).update(input.body, 'utf8').digest('hex')}`;
  const presented = Buffer.from(input.header, 'utf8');
  const computed = Buffer.from(expected, 'utf8');

  if (presented.length !== computed.length) {
    return false;
  }
  return timingSafeEqual(presented, computed);
}

/** GitHub's all-zero sha, which is what a deleted branch reports as its head. */
const NO_COMMIT = '0000000000000000000000000000000000000000';

export interface PushFacts {
  repoFullName: string;
  branch: string;
  commitSha: string | null;
  pusher: string;
  message: string | null;
}

/**
 * Pulls the few fields that matter out of a push payload, or explains why the
 * push is not one to act on.
 *
 * Tags and branch deletions both arrive here as pushes. A tag names no branch
 * to rebuild; a deletion names one that no longer exists, and building it could
 * only fail. Both are ordinary events rather than errors, so they are named as
 * skips and answered 200.
 */
export function pushFactsFrom(payload: Record<string, unknown>): PushFacts | { skip: string } {
  const ref = typeof payload.ref === 'string' ? payload.ref : '';
  if (!ref.startsWith('refs/heads/')) {
    return { skip: ref.startsWith('refs/tags/') ? 'a tag, not a branch' : `unsupported ref "${ref}"` };
  }

  if (payload.deleted === true) {
    return { skip: 'the branch was deleted' };
  }

  const after = typeof payload.after === 'string' ? payload.after : null;
  if (after === NO_COMMIT) {
    return { skip: 'the push has no head commit' };
  }

  const repository = (payload.repository ?? {}) as Record<string, unknown>;
  const repoFullName = typeof repository.full_name === 'string' ? repository.full_name : '';
  if (!repoFullName) {
    return { skip: 'the payload names no repository' };
  }

  const pusher = (payload.pusher ?? {}) as Record<string, unknown>;
  const sender = (payload.sender ?? {}) as Record<string, unknown>;
  const headCommit = (payload.head_commit ?? null) as Record<string, unknown> | null;
  const message =
    headCommit && typeof headCommit.message === 'string' ? headCommit.message.split('\n')[0]! : null;

  return {
    repoFullName,
    branch: ref.slice('refs/heads/'.length),
    commitSha: after,
    // `pusher.name` is a git identity and can be anything; `sender.login` is
    // the GitHub account that caused the delivery. Preferring the login means
    // the attribution in the history matches a real account.
    pusher:
      (typeof sender.login === 'string' && sender.login) ||
      (typeof pusher.name === 'string' && pusher.name) ||
      'unknown',
    message,
  };
}

/**
 * Hands the push to the in-VPC admin function, as an admin, and does not wait.
 *
 * Asynchronous on purpose. API Gateway caps an integration at 30 seconds, and
 * acting on a push can legitimately take longer than that: a first-time
 * provision creates an image repository, two log groups and a build project
 * before it starts the build, and a monorepo push can do that for several
 * services in a row. Waiting would mean GitHub recording a failed delivery for
 * work that actually succeeded, which is worse than useless — it is misleading.
 *
 * Nothing is lost by not waiting. The outcome of every launch is written to the
 * service's history and shown in the console, a launch that dies mid-step is
 * repaired by the five-minute reconcile, and Lambda's own retries are safe here
 * because `launchMicroservice` is claim-guarded and idempotent.
 */
async function forwardPush(facts: PushFacts, deliveryId: string | null): Promise<void> {
  const path = '/v1/admin/microservices/github-push';
  const event = {
    version: '2.0',
    routeKey: `POST ${path}`,
    rawPath: path,
    rawQueryString: '',
    headers: { 'content-type': 'application/json' },
    requestContext: {
      http: { method: 'POST', path, sourceIp: 'github', protocol: 'HTTP/1.1', userAgent: 'github-webhook' },
      authorizer: {
        jwt: {
          claims: {
            'cognito:groups': ['admin'],
            'cognito:username': `push:${facts.pusher}`,
          },
          scopes: [],
        },
      },
      requestId: `push-${deliveryId ?? Date.now()}`,
    },
    body: JSON.stringify({
      repo_full_name: facts.repoFullName,
      branch: facts.branch,
      commit_sha: facts.commitSha,
      pusher: facts.pusher,
      message: facts.message,
      delivery_id: deliveryId,
    }),
    isBase64Encoded: false,
  };

  const result = await lambda.send(
    new InvokeCommand({
      FunctionName: ADMIN_FUNCTION_NAME,
      // Fire and forget. A 202 here means Lambda accepted the event, which is
      // as much as this function can know and all it needs to.
      InvocationType: 'Event',
      Payload: Buffer.from(JSON.stringify(event)),
    })
  );

  // Only reachable for a refused invocation — throttling, or a function that is
  // not there. A failure inside the admin function cannot surface here by
  // definition, and shows up in its own logs and the service's history instead.
  if ((result.StatusCode ?? 0) !== 202) {
    throw new Error(`the admin function did not accept the push (${result.StatusCode})`);
  }
}

function reply(status: string, extra: Record<string, unknown> = {}): APIGatewayProxyResultV2 {
  return {
    statusCode: 200,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ status, ...extra }),
  };
}

export async function handler(event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> {
  const headers = event.headers ?? {};
  // API Gateway lowercases header names; spelled that way rather than searched
  // for case-insensitively because the platform guarantees it.
  const deliveryId = headers['x-github-delivery'] ?? null;
  const eventName = headers['x-github-event'] ?? null;

  const body = event.isBase64Encoded
    ? Buffer.from(event.body ?? '', 'base64').toString('utf8')
    : (event.body ?? '');

  const secret = await webhookSecret();
  if (!secret) {
    /**
     * No secret means nothing can be verified, so nothing is acted on.
     *
     * Only reachable for an App created before webhooks were wired up, or one
     * whose secret was never saved. Logged at error because it is a
     * configuration fault that silently disables every rebuild.
     */
    console.error('github webhook rejected: no webhook secret is configured', { deliveryId });
    return reply('not_configured');
  }

  if (!signatureMatches({ body, header: headers['x-hub-signature-256'], secret })) {
    console.warn('github webhook rejected: signature mismatch', { deliveryId, eventName });
    return reply('bad_signature');
  }

  // Past this line the request is known to be from the App.

  if (eventName === 'ping') {
    // Sent once when the webhook is first enabled. Answering it is what turns
    // the tick green in the App's settings.
    console.log('github webhook ping', { deliveryId });
    return reply('pong');
  }

  if (eventName !== 'push') {
    // The App is subscribed to `push`; installation events arrive whether or
    // not anyone asked for them. Nothing here acts on those yet.
    return reply('ignored', { event: eventName });
  }

  let payload: Record<string, unknown>;
  try {
    payload = JSON.parse(body) as Record<string, unknown>;
  } catch {
    console.error('github webhook: push payload was not JSON', { deliveryId });
    return reply('bad_payload');
  }

  const facts = pushFactsFrom(payload);
  if ('skip' in facts) {
    console.log('github webhook: push skipped', { deliveryId, reason: facts.skip });
    return reply('skipped', { reason: facts.skip });
  }

  try {
    await forwardPush(facts, deliveryId);
    console.log('github webhook: push accepted', {
      deliveryId,
      repo: facts.repoFullName,
      branch: facts.branch,
      commit: facts.commitSha,
    });
    return reply('accepted', {
      repository: facts.repoFullName,
      branch: facts.branch,
      commit: facts.commitSha,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error('github webhook: could not act on push', {
      deliveryId,
      repo: facts.repoFullName,
      branch: facts.branch,
      error: message,
    });
    /**
     * Still a 200, with the failure in the body.
     *
     * A non-2xx here marks the delivery as failed in the repository owner's
     * App settings and tells them nothing about why. The CloudWatch log above
     * is where this is diagnosed, and the service's own history records that
     * the push arrived.
     */
    return reply('failed', { error: message });
  }
}

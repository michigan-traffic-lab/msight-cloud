import { randomBytes } from 'node:crypto';
import {
  GetSecretValueCommand,
  PutSecretValueCommand,
  SecretsManagerClient,
} from '@aws-sdk/client-secrets-manager';
import { HttpError } from '../../../shared/admin-api/http';
import {
  ensureMicroserviceSchema,
  INSTALL_INTENT_TTL_SECONDS,
} from '../../../shared/microservice-schema';
import type { GithubRepoInfo } from '../../../shared/github/rpc';
import { getPool } from './db';
import {
  convertManifest,
  deleteInstallation as deleteInstallationOnGithub,
  getInstallation,
  listInstallationRepos,
  verifyApp,
} from './github-client';

/**
 * The GitHub connection: the App this deployment authenticates as, and the
 * installations that grant it repositories.
 *
 * The design this implements is that no GitHub *account* is ever stored. One
 * admin installs the App once; what persists is an installation id owned by the
 * repository owner, plus a private key in Secrets Manager. Every later console
 * user works from those, with no GitHub account of their own and no GitHub
 * login anywhere in the flow.
 *
 * The install handshake is the one security-sensitive part. GitHub redirects a
 * *browser* back after the owner consents, and a browser redirect carries no
 * Cognito token — so the App's setup URL points at the console's static site,
 * which then calls this API normally. The `state` token is what binds the
 * `installation_id` in that redirect to the admin who started the flow; without
 * it, anything that could reach the completion route could attach an arbitrary
 * installation to this deployment.
 */

const secrets = new SecretsManagerClient({});

async function ensureSchema(): Promise<void> {
  await ensureMicroserviceSchema(await getPool());
}

function secretArn(): string {
  const arn = process.env.GITHUB_APP_SECRET_ARN;
  if (!arn) {
    throw new HttpError(
      500,
      'not_configured',
      'GITHUB_APP_SECRET_ARN is not set on the in-VPC admin function.'
    );
  }
  return arn;
}

export interface GithubAppRow {
  app_id: number;
  slug: string;
  name: string | null;
  html_url: string | null;
  /** Null on rows written before the owner was recorded. */
  owner_login: string | null;
  owner_type: string | null;
  configured_by: string;
  configured_at: string;
  updated_at: string;
}

function toAppRow(row: Record<string, unknown>): GithubAppRow {
  return {
    app_id: Number(row.app_id),
    slug: String(row.slug),
    name: row.name === null ? null : String(row.name),
    html_url: row.html_url === null ? null : String(row.html_url),
    owner_login: row.owner_login == null ? null : String(row.owner_login),
    owner_type: row.owner_type == null ? null : String(row.owner_type),
    configured_by: String(row.configured_by),
    configured_at: new Date(row.configured_at as string).toISOString(),
    updated_at: new Date(row.updated_at as string).toISOString(),
  };
}

export async function appRow(): Promise<GithubAppRow | null> {
  await ensureSchema();
  const pool = await getPool();
  const { rows } = await pool.query(
    `SELECT app_id, slug, name, html_url, owner_login, owner_type, configured_by,
            configured_at, updated_at
       FROM github_app WHERE id = 1`
  );
  return rows.length ? toAppRow(rows[0]) : null;
}

/**
 * Whether credentials are actually present in Secrets Manager.
 *
 * Reported separately from the database row because the two can disagree, and
 * the disagreement is diagnostic: a row with no secret means the key was
 * cleared out from under it, and a secret with no row means verification failed
 * after the write.
 */
async function secretPresent(): Promise<boolean> {
  try {
    const result = await secrets.send(new GetSecretValueCommand({ SecretId: secretArn() }));
    if (!result.SecretString) {
      return false;
    }
    const parsed = JSON.parse(result.SecretString) as { private_key?: unknown };
    return typeof parsed.private_key === 'string' && parsed.private_key.includes('-----BEGIN');
  } catch {
    return false;
  }
}

/**
 * The App's settings page on GitHub.
 *
 * Two different paths depending on who owns it, and getting it wrong matters
 * more than a broken link normally would: GitHub exposes **no API to delete a
 * GitHub App**, so this page is the only way to remove one — and removing one
 * is the only way to free its name, which is unique across all of GitHub.
 */
export function appSettingsUrl(app: GithubAppRow): string {
  return app.owner_type === 'Organization' && app.owner_login
    ? `https://github.com/organizations/${app.owner_login}/settings/apps/${app.slug}`
    : `https://github.com/settings/apps/${app.slug}`;
}

export interface GithubAppStatus {
  configured: boolean;
  secret_present: boolean;
  app: GithubAppRow | null;
  /** Where an admin goes to create or manage the App on GitHub. */
  app_settings_url: string | null;
  /**
   * The one place an App can actually be deleted. Surfaced because "Forget App"
   * here only clears local credentials — the App itself survives on GitHub,
   * still holding its globally-unique name.
   */
  app_delete_url: string | null;
  install_url: string | null;
  /**
   * What the App would be called if the operator does not name it. Sent so the
   * connect form can show it as a placeholder without the console having to
   * know the deployment name or re-derive the rule.
   */
  suggested_app_name: string;
}

export async function appStatus(): Promise<GithubAppStatus> {
  const [app, present] = await Promise.all([appRow(), secretPresent()]);
  return {
    configured: app !== null && present,
    secret_present: present,
    app,
    app_settings_url: app ? appSettingsUrl(app) : null,
    app_delete_url: app ? `${appSettingsUrl(app)}/advanced` : null,
    install_url: app ? `https://github.com/apps/${app.slug}/installations/new` : null,
    // Defaulted rather than required: this is a label, and appStatus must not
    // fail just because the deployment name is unset.
    suggested_app_name: manifestAppName(process.env.DEPLOYMENT_NAME ?? 'msight'),
  };
}

/**
 * Describes the App this deployment needs, for GitHub to create from.
 *
 * This is the whole reason an operator no longer registers the App by hand:
 * every field they would otherwise have to get right — the two permissions, the
 * setup and callback URLs, whether it is public — is stated here, and GitHub
 * creates the App from it with one click.
 *
 * `public: true` is what lets the account be chosen at install time rather than
 * before the redirect, and it is not the loose setting it sounds like.
 *
 * GitHub only allows a PRIVATE App to be installed on the account that owns it.
 * So a private App forces the whole decision up front: the operator has to name
 * the organisation before they have even signed in to GitHub, from memory,
 * because creating under an org is a different URL entirely and GitHub offers no
 * owner picker on the creation page. A public App can be installed anywhere,
 * which means GitHub's own installation page shows its native account picker —
 * personal account and every organisation the person can install on — and the
 * choice happens where the user expects it.
 *
 * "Public" governs who may install, not discoverability: the App is unlisted
 * unless it is submitted to the Marketplace, which nothing here does. What it
 * does expose is the App's page at github.com/apps/<slug>, so the name — and
 * with it the deployment name — becomes publicly readable. That is the whole
 * cost, and installing still requires the owner to consent and pick
 * repositories, while the private key never leaves this deployment.
 *
 * The webhook is declared but `active: false`. The endpoint exists in the API
 * but does not serve yet, and an App created with live webhooks would start
 * accumulating failed deliveries on the owner's account immediately. The URL is
 * filled in so turning it on later is a toggle rather than a lookup.
 */
export function buildManifest(input: {
  deployment: string;
  consoleUrl: string;
  webhookUrl: string;
  /** Overrides the derived default. Trimmed; blank falls back. */
  appName?: string | null | undefined;
}) {
  return {
    // Unique across the whole of GitHub, not just this account — so a collision
    // is ordinary rather than exceptional, and it is worth knowing that an App
    // deleted from this console still holds its name until it is deleted on
    // GitHub too. The console offers this as an editable field for that reason;
    // GitHub also lets it be corrected on its own creation page. Nothing here
    // depends on the value: the App's id and slug come back from the conversion.
    name: (input.appName ?? '').trim() || manifestAppName(input.deployment),
    url: input.consoleUrl,
    description:
      'Builds microservices for a self-hosted MSight cloud deployment. Reads repository ' +
      'contents to find Dockerfiles; makes no changes to any repository.',
    // `active: false` is the real gate on auto-rebuild, not the permissions —
    // the App is subscribed to `push` and entitled to it, but GitHub delivers
    // nothing while the webhook is off. Off until the receiver exists, because
    // an App created with live webhooks starts accruing failed deliveries on
    // the owner's account immediately. Unlike a permission, this is a plain
    // setting: flipping it needs no re-consent from anyone.
    hook_attributes: { url: input.webhookUrl, active: false },
    // Where GitHub sends the temporary code after creating the App, and where
    // it sends the browser after an install. Both point at the static console,
    // which then calls the admin API with a Cognito token — a GitHub redirect
    // carries none.
    redirect_url: `${input.consoleUrl}/settings/github/callback`,
    setup_url: `${input.consoleUrl}/settings/github/callback`,
    // So a repository added to an existing installation redirects back here and
    // the console can refresh what it was granted.
    setup_on_update: true,
    public: true,
    /**
     * Chosen once, deliberately, because widening this later is expensive in a
     * way nothing warns about: adding a permission to an App that already has
     * installations leaves every one of them on the OLD set until each owner
     * approves the change on GitHub. Until they do, the new feature is silently
     * dead for them. The cheap moment to decide is before anyone installs.
     */
    default_permissions: {
      // Reads a Dockerfile and resolves a branch — and, not obviously, is also
      // what entitles the App to receive `push`. Webhook events are gated on
      // the permission covering the data they carry, so no extra scope is
      // needed to watch a branch.
      contents: 'read',
      metadata: 'read',
      // The only write scope, and it writes nothing to the repository: check
      // runs are the ✅/❌ against a commit, which is how a build reports back.
      // Requested now rather than when builds land, so turning them on is not
      // gated on chasing every installation owner for re-approval.
      checks: 'write',
    },
    /**
     * `push` is the build trigger, and it is the ONLY thing that belongs here.
     *
     * `installation` and `installation_repositories` — how this deployment
     * learns it has been uninstalled or had its repositories changed — must NOT
     * be listed. GitHub delivers both to every App automatically ("All GitHub
     * Apps receive this event by default. You cannot manually subscribe to this
     * event"), so naming them is not belt-and-braces, it is invalid: the
     * manifest is rejected outright with "Default events unsupported:
     * installation and installation_repositories" and no App is created at all.
     *
     * The events still arrive once the webhook receiver exists and
     * `hook_attributes.active` is turned on. Nothing is lost by omitting them.
     */
    default_events: ['push'],
  };
}

function manifestConfig(): { deployment: string; consoleUrl: string; webhookUrl: string } {
  const required = (key: string) => {
    const value = process.env[key];
    if (!value) {
      throw new HttpError(
        500,
        'not_configured',
        `${key} is not set on the in-VPC admin function, so the GitHub App manifest ` +
          'cannot be built. This is a deployment problem, not a configuration one.'
      );
    }
    return value;
  };

  return {
    deployment: required('DEPLOYMENT_NAME'),
    consoleUrl: required('CONSOLE_URL'),
    webhookUrl: required('GITHUB_WEBHOOK_URL'),
  };
}

/**
 * Starts the one-click App creation.
 *
 * Returns the manifest and the URL a form posts it to; the browser does the
 * POST, because GitHub renders a consent page and only a human may create an
 * App. `state` binds the code that comes back to the admin who asked, exactly
 * as it does for installs.
 *
 * An org target changes only the URL — GitHub decides who may create an App
 * there, so passing an org this admin cannot publish to fails on GitHub's page
 * rather than here.
 */
/**
 * GitHub's own rule for an account login: alphanumeric and single hyphens, no
 * leading or trailing hyphen, at most 39 characters.
 *
 * Worth enforcing rather than passing through, because a wrong value does not
 * fail here — it produces a GitHub 404 page after the redirect, which reads as
 * "the console sent me somewhere broken" rather than "that organisation name is
 * wrong".
 */
const GITHUB_LOGIN_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9]|-(?=[A-Za-z0-9])){0,38}$/;

/**
 * The name GitHub shows for the App, built from the deployment name.
 *
 * Naively prefixing the product name produced "MSight msight-cloud", because
 * deployment names already tend to carry it. So the product name is added only
 * when it is not there already, and the hyphenated slug is turned into words:
 *
 *   msight-cloud  ->  MSight Cloud
 *   prod          ->  MSight Prod
 *   msight        ->  MSight
 *
 * This is a display name, not an identifier — the App's numeric id and slug
 * come back from GitHub — but it is the first thing the person approving the
 * install reads, so it should look deliberate. GitHub requires it to be unique
 * across all of GitHub and will say so on its own page if it is taken; the name
 * is editable there before the App is created.
 */
export function manifestAppName(deployment: string): string {
  const words = deployment
    .split(/[-_\s]+/)
    .filter(Boolean)
    .map((word) =>
      word.toLowerCase() === 'msight'
        ? 'MSight'
        : word.charAt(0).toUpperCase() + word.slice(1).toLowerCase()
    );

  const titled = words.join(' ');
  if (titled.length === 0) return 'MSight';
  return words.includes('MSight') ? titled : `MSight ${titled}`;
}

/**
 * Where the browser posts the manifest.
 *
 * Organisation and personal creation are different URLs entirely — there is no
 * parameter that switches an account, and GitHub puts no owner picker on the
 * creation page. That is precisely why `organization` is now optional and
 * normally omitted: the App is created under the signed-in account, it is
 * public, and *which* account or organisation to install it on is chosen on
 * GitHub's installation page afterwards, where GitHub lists them itself.
 *
 * Passing an organisation is the deliberate exception, for the one thing the
 * default gives up: an App owned by a person is deleted with that person's
 * GitHub account, taking its installations with it. A team that wants the App
 * to outlive whoever set it up names the organisation here and accepts having
 * to know it up front.
 */
export function manifestCreateUrl(state: string, organization?: string | null): string {
  const org = (organization ?? '').trim();

  if (org && !GITHUB_LOGIN_PATTERN.test(org)) {
    throw new HttpError(
      400,
      'invalid_organization',
      `"${org}" is not a GitHub organisation name. Use the name exactly as it appears in ` +
        'the URL of the organisation on GitHub — for example "msight-tech" from ' +
        'github.com/msight-tech — not its display name.'
    );
  }

  const url = new URL(
    org
      ? `https://github.com/organizations/${org}/settings/apps/new`
      : 'https://github.com/settings/apps/new'
  );
  url.searchParams.set('state', state);
  return url.toString();
}

export async function createManifestIntent(input: {
  actor: string;
  organization?: string | null;
  appName?: string | null;
}): Promise<{
  create_url: string;
  manifest: string;
  state: string;
  expires_at: string;
}> {
  await ensureSchema();
  const config = manifestConfig();

  // Validated before the state row is written, so a typo does not leave a spent
  // intent behind and does not send the browser to a GitHub 404.
  const state = randomBytes(32).toString('base64url');
  const createUrl = manifestCreateUrl(state, input.organization);

  const pool = await getPool();
  await pool.query(`DELETE FROM github_install_intents WHERE expires_at < NOW()`);

  const { rows } = await pool.query(
    `INSERT INTO github_install_intents (state, requested_by, purpose, expires_at)
          VALUES ($1, $2, 'manifest', NOW() + ($3 || ' seconds')::interval)
       RETURNING expires_at`,
    [state, input.actor, String(INSTALL_INTENT_TTL_SECONDS)]
  );

  return {
    create_url: createUrl,
    // Serialised here rather than in the browser so the console cannot alter
    // the permissions being asked for.
    manifest: JSON.stringify(buildManifest({ ...config, appName: input.appName })),
    state,
    expires_at: new Date(rows[0].expires_at as string).toISOString(),
  };
}

/**
 * Finishes App creation: redeems GitHub's code for the credentials and stores
 * them, replacing what an operator would otherwise paste in by hand.
 *
 * Refuses to overwrite an App that already has installations. Replacing the
 * credentials under them would leave every `github_installations` row naming a
 * grant issued to a different App, which authenticates but resolves to nothing.
 */
export async function completeManifest(input: {
  code: string;
  state: string;
  actor: string;
}): Promise<{ app: GithubAppRow; events: string[]; permissions: Record<string, string> }> {
  await ensureSchema();
  await redeemIntent(input.state, input.actor, 'manifest');

  const existing = await listInstallations();
  if (existing.length > 0) {
    throw new HttpError(
      409,
      'app_has_installations',
      `This deployment is already connected to a GitHub App with ${existing.length} ` +
        'installation(s). Disconnect those first — replacing the App underneath them ' +
        'would leave grants that authenticate but resolve to nothing.'
    );
  }

  const created = await convertManifest(input.code);

  // Straight from GitHub into Secrets Manager. The key is not returned, logged,
  // or written anywhere else, and this is the only moment GitHub will ever
  // disclose it.
  await secrets.send(
    new PutSecretValueCommand({
      SecretId: secretArn(),
      SecretString: JSON.stringify({
        app_id: String(created.app_id),
        private_key: created.pem,
        // GitHub generates one for a manifest App, so unlike the paste path
        // this is set from the start.
        webhook_secret: created.webhook_secret,
      }),
    })
  );

  // Same order as saveApp, for the same reason: prove the stored key works
  // before recording the App, so a failure leaves the console saying "not
  // configured" rather than showing a connection that cannot mint a token.
  const identity = await verifyApp();

  const pool = await getPool();
  const { rows } = await pool.query(
    `INSERT INTO github_app (id, app_id, slug, name, html_url, owner_login, owner_type, configured_by)
          VALUES (1, $1, $2, $3, $4, $5, $6, $7)
     ON CONFLICT (id) DO UPDATE
            SET app_id = EXCLUDED.app_id,
                slug = EXCLUDED.slug,
                name = EXCLUDED.name,
                html_url = EXCLUDED.html_url,
                owner_login = EXCLUDED.owner_login,
                owner_type = EXCLUDED.owner_type,
                configured_by = EXCLUDED.configured_by,
                updated_at = NOW()
       RETURNING app_id, slug, name, html_url, owner_login, owner_type, configured_by,
                 configured_at, updated_at`,
    [
      identity.app_id,
      identity.slug,
      identity.name,
      identity.html_url,
      identity.owner_login,
      identity.owner_type,
      input.actor,
    ]
  );

  console.log(
    JSON.stringify({
      event: 'github_app_created_from_manifest',
      actor: input.actor,
      app_id: identity.app_id,
      slug: identity.slug,
      owner: created.owner_login,
    })
  );

  return {
    app: toAppRow(rows[0]),
    events: identity.events,
    permissions: identity.permissions,
  };
}

export interface SaveAppInput {
  appId: number;
  privateKey: string;
  webhookSecret?: string | null;
  actor: string;
}

/**
 * Stores the App credentials and confirms they work.
 *
 * The order is forced: the transport function reads the key from Secrets
 * Manager, so the secret has to be written before anything can verify it. If
 * verification then fails the database row is deliberately NOT written, so the
 * console keeps reporting "not configured" rather than showing a connection
 * that cannot mint a token. The secret itself is left in place — it is the
 * thing being corrected, and the next save overwrites it.
 *
 * The private key is never read back out by any route.
 */
export async function saveApp(input: SaveAppInput): Promise<{ app: GithubAppRow; events: string[]; permissions: Record<string, string> }> {
  await ensureSchema();

  if (!input.privateKey.includes('-----BEGIN')) {
    throw new HttpError(
      400,
      'invalid_private_key',
      'That does not look like a PEM private key. Paste the whole contents of the .pem ' +
        'file GitHub gave you, including the BEGIN and END lines.'
    );
  }

  await secrets.send(
    new PutSecretValueCommand({
      SecretId: secretArn(),
      SecretString: JSON.stringify({
        app_id: String(input.appId),
        private_key: input.privateKey,
        // Kept whether or not it is set yet: the webhook that triggers builds
        // needs it later, and it lives with the key it belongs to.
        webhook_secret: input.webhookSecret ?? null,
      }),
    })
  );

  const identity = await verifyApp();

  if (identity.app_id !== input.appId) {
    throw new HttpError(
      400,
      'app_id_mismatch',
      `The private key belongs to App ${identity.app_id}, not ${input.appId}. Check that ` +
        `the App ID and the .pem came from the same App settings page.`
    );
  }

  const pool = await getPool();
  const { rows } = await pool.query(
    `INSERT INTO github_app (id, app_id, slug, name, html_url, owner_login, owner_type, configured_by)
          VALUES (1, $1, $2, $3, $4, $5, $6, $7)
     ON CONFLICT (id) DO UPDATE
            SET app_id = EXCLUDED.app_id,
                slug = EXCLUDED.slug,
                name = EXCLUDED.name,
                html_url = EXCLUDED.html_url,
                owner_login = EXCLUDED.owner_login,
                owner_type = EXCLUDED.owner_type,
                configured_by = EXCLUDED.configured_by,
                updated_at = NOW()
       RETURNING app_id, slug, name, html_url, owner_login, owner_type, configured_by,
                 configured_at, updated_at`,
    [
      identity.app_id,
      identity.slug,
      identity.name,
      identity.html_url,
      identity.owner_login,
      identity.owner_type,
      input.actor,
    ]
  );

  return {
    app: toAppRow(rows[0]),
    events: identity.events,
    permissions: identity.permissions,
  };
}

/**
 * Forgets the App.
 *
 * Refused while installations remain, because clearing the key would leave rows
 * naming grants nothing can authenticate against — the connection would look
 * present and fail on every use. Secrets Manager has no "unset", so the secret
 * is overwritten with an empty object rather than deleted.
 */
export async function forgetApp(actor: string): Promise<{ forgotten: boolean }> {
  await ensureSchema();
  const pool = await getPool();

  const { rows } = await pool.query(`SELECT COUNT(*)::int AS count FROM github_installations`);
  const installations = Number(rows[0]?.count ?? 0);
  if (installations > 0) {
    throw new HttpError(
      409,
      'installations_present',
      `${installations} installation(s) still use this App. Disconnect them first — ` +
        `otherwise they would remain listed with no way to authenticate.`
    );
  }

  await secrets.send(
    new PutSecretValueCommand({ SecretId: secretArn(), SecretString: JSON.stringify({}) })
  );
  await pool.query(`DELETE FROM github_app WHERE id = 1`);

  console.log('github app credentials cleared', { actor });
  return { forgotten: true };
}

/**
 * Starts an install handshake.
 *
 * The returned URL is GitHub's own installation page, which is where the
 * repository picker lives — this console deliberately does not build one, so it
 * never sees the repositories the owner chose not to grant.
 */
/**
 * Re-reads the App's own identity from GitHub and corrects the stored row.
 *
 * The App's name — and with it its slug — is editable on GitHub at any time,
 * both on the creation page and afterwards from its settings. Nothing about
 * authentication cares: that is the numeric `app_id` plus the private key, and
 * the App JWT's `iss` is the id. But the slug is what builds
 * `github.com/apps/<slug>/installations/new`, so a rename leaves this
 * deployment sending admins to a GitHub 404 with no hint as to why — and
 * nothing else in the system would ever notice.
 *
 * A failure to reach GitHub falls back to the stored slug rather than aborting.
 * This is rename *detection*, not a precondition: a stale slug is a possibility,
 * whereas failing the flow on a transient blip is a certainty.
 *
 * `app_id` is deliberately not updated. It is the stable key and cannot change;
 * a differing one would mean the secret now holds a different App's key, which
 * is a problem to surface rather than to quietly write over the row.
 */
async function refreshAppIdentity(stored: GithubAppRow): Promise<GithubAppRow> {
  let identity;
  try {
    identity = await verifyApp();
  } catch (error) {
    console.warn('github app identity refresh failed; using stored slug', {
      slug: stored.slug,
      message: error instanceof Error ? error.message : String(error),
    });
    return stored;
  }

  if (
    identity.slug === stored.slug &&
    identity.name === stored.name &&
    identity.html_url === stored.html_url
  ) {
    return stored;
  }

  console.log(
    JSON.stringify({
      event: 'github_app_renamed_on_github',
      app_id: stored.app_id,
      from_slug: stored.slug,
      to_slug: identity.slug,
    })
  );

  const pool = await getPool();
  const { rows } = await pool.query(
    `UPDATE github_app
        SET slug = $1, name = $2, html_url = $3, updated_at = NOW()
      WHERE id = 1
      RETURNING app_id, slug, name, html_url, owner_login, owner_type, configured_by,
                 configured_at, updated_at`,
    [identity.slug, identity.name, identity.html_url]
  );

  return rows.length ? toAppRow(rows[0]) : stored;
}

export async function createInstallIntent(
  actor: string
): Promise<{ install_url: string; state: string; expires_at: string }> {
  const status = await appStatus();
  if (!status.configured || !status.app) {
    throw new HttpError(
      409,
      'app_not_configured',
      'Save this deployment\'s GitHub App credentials before connecting a repository.'
    );
  }

  // Checked here rather than on every page load: this is the one place the slug
  // is load-bearing, because the browser is about to be sent to a URL built
  // from it. Refreshing in appStatus would put a GitHub round trip on every
  // render of the page and make it fail whenever GitHub is slow.
  const app = await refreshAppIdentity(status.app);

  const pool = await getPool();

  // Opportunistic sweep: intents are single-use and short-lived, so anything
  // expired is dead weight. Cheap here, and it means no scheduled cleanup.
  await pool.query(`DELETE FROM github_install_intents WHERE expires_at < NOW()`);

  // 32 bytes from the CSPRNG. This is the whole binding between the redirect
  // GitHub sends back and the admin who started the flow, so it must not be
  // guessable and must not be derived from anything about the caller.
  const state = randomBytes(32).toString('base64url');

  const { rows } = await pool.query(
    `INSERT INTO github_install_intents (state, requested_by, purpose, expires_at)
          VALUES ($1, $2, 'install', NOW() + ($3 || ' seconds')::interval)
       RETURNING expires_at`,
    [state, actor, String(INSTALL_INTENT_TTL_SECONDS)]
  );

  const installUrl = new URL(`https://github.com/apps/${app.slug}/installations/new`);
  installUrl.searchParams.set('state', state);

  return {
    install_url: installUrl.toString(),
    state,
    expires_at: new Date(rows[0].expires_at as string).toISOString(),
  };
}

export interface InstallationRow {
  installation_id: number;
  account_login: string;
  account_type: string | null;
  target_type: string | null;
  repository_selection: string | null;
  permissions: Record<string, string>;
  suspended: boolean;
  connected_by: string;
  connected_at: string;
  updated_at: string;
}

function toInstallationRow(row: Record<string, unknown>): InstallationRow {
  return {
    installation_id: Number(row.installation_id),
    account_login: String(row.account_login),
    account_type: row.account_type === null ? null : String(row.account_type),
    target_type: row.target_type === null ? null : String(row.target_type),
    repository_selection:
      row.repository_selection === null ? null : String(row.repository_selection),
    permissions: (row.permissions ?? {}) as Record<string, string>,
    suspended: Boolean(row.suspended),
    connected_by: String(row.connected_by),
    connected_at: new Date(row.connected_at as string).toISOString(),
    updated_at: new Date(row.updated_at as string).toISOString(),
  };
}

const INSTALLATION_COLUMNS = `installation_id, account_login, account_type, target_type,
                              repository_selection, permissions, suspended, connected_by,
                              connected_at, updated_at`;

/**
 * Redeems a `state` token, exactly once.
 *
 * `DELETE ... RETURNING` rather than select-then-delete: the read and the
 * consumption are one statement, so two browsers replaying the same redirect
 * cannot both succeed.
 */
async function redeemIntent(
  state: string,
  actor: string,
  purpose: 'install' | 'manifest'
): Promise<void> {
  const pool = await getPool();
  const { rows } = await pool.query(
    `DELETE FROM github_install_intents WHERE state = $1
       RETURNING requested_by, expires_at, purpose`,
    [state]
  );

  if (rows.length === 0) {
    throw new HttpError(
      400,
      'invalid_install_state',
      'This link has already been used or was never issued by this deployment. Start ' +
        'the connection again from the Microservices page.'
    );
  }

  const row = rows[0] as { requested_by: string; expires_at: string; purpose: string };

  // A token minted for one handshake must not be spendable on the other. The
  // dangerous direction is an install state redeeming a manifest code, which
  // would let whatever produced that code replace this deployment's App
  // credentials. The row is already consumed by the DELETE above, so a
  // mismatched attempt also burns the token rather than leaving it for a retry.
  if ((row.purpose ?? 'install') !== purpose) {
    throw new HttpError(
      400,
      'install_state_mismatch',
      'That link belongs to a different step of the GitHub setup. Start the connection ' +
        'again from the Microservices page.'
    );
  }

  if (new Date(row.expires_at).getTime() < Date.now()) {
    throw new HttpError(
      400,
      'install_state_expired',
      `The link expired after ${Math.round(INSTALL_INTENT_TTL_SECONDS / 60)} ` +
        `minutes. Start the connection again.`
    );
  }

  // Bound to the admin who started it. A completed install is a change to this
  // deployment's configuration, and the person finishing it should be the
  // person who asked for it.
  if (row.requested_by !== actor) {
    throw new HttpError(
      403,
      'install_state_mismatch',
      `This installation was started by ${row.requested_by}. Ask them to finish it, or ` +
        `start a new one yourself.`
    );
  }
}

export interface CompleteInstallInput {
  installationId: number;
  state: string;
  actor: string;
}

export async function completeInstall(input: CompleteInstallInput): Promise<{
  installation: InstallationRow;
  repositories: GithubRepoInfo[];
  truncated: boolean;
}> {
  await ensureSchema();
  await redeemIntent(input.state, input.actor, 'install');

  // Asked of GitHub rather than trusted from the redirect. The browser supplied
  // this id; the state token proves the flow was ours, not that the id is real.
  const info = await getInstallation(input.installationId);

  const pool = await getPool();
  const { rows } = await pool.query(
    `INSERT INTO github_installations
            (installation_id, account_login, account_type, target_type,
             repository_selection, permissions, suspended, connected_by)
          VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7, $8)
     ON CONFLICT (installation_id) DO UPDATE
            SET account_login = EXCLUDED.account_login,
                account_type = EXCLUDED.account_type,
                target_type = EXCLUDED.target_type,
                repository_selection = EXCLUDED.repository_selection,
                permissions = EXCLUDED.permissions,
                suspended = EXCLUDED.suspended,
                updated_at = NOW()
       RETURNING ${INSTALLATION_COLUMNS}`,
    [
      info.installation_id,
      info.account_login,
      info.account_type,
      info.target_type,
      info.repository_selection,
      JSON.stringify(info.permissions),
      info.suspended,
      input.actor,
    ]
  );

  const repos = await listInstallationRepos(info.installation_id);

  console.log('github installation connected', {
    installationId: info.installation_id,
    account: info.account_login,
    actor: input.actor,
    repositories: repos.repositories.length,
  });

  return {
    installation: toInstallationRow(rows[0]),
    repositories: repos.repositories,
    truncated: repos.truncated,
  };
}

export async function listInstallations(): Promise<InstallationRow[]> {
  await ensureSchema();
  const pool = await getPool();
  const { rows } = await pool.query(
    `SELECT ${INSTALLATION_COLUMNS} FROM github_installations ORDER BY account_login`
  );
  return rows.map(toInstallationRow);
}

async function requireInstallation(installationId: number): Promise<InstallationRow> {
  const pool = await getPool();
  const { rows } = await pool.query(
    `SELECT ${INSTALLATION_COLUMNS} FROM github_installations WHERE installation_id = $1`,
    [installationId]
  );
  if (rows.length === 0) {
    throw new HttpError(
      404,
      'installation_not_connected',
      `This deployment has no installation ${installationId}.`
    );
  }
  return toInstallationRow(rows[0]);
}

/**
 * The repositories one installation can see, refreshed from GitHub.
 *
 * Never cached in the database. The set changes on GitHub without telling us —
 * the owner adds a repo to the installation, renames one, makes one private —
 * and a stale picker offering a repo that is no longer granted produces a
 * failure at the least useful moment. Live also lets this call double as a
 * health check on the grant, which is why it refreshes the stored row.
 */
export async function installationRepositories(installationId: number): Promise<{
  installation: InstallationRow;
  repositories: GithubRepoInfo[];
  truncated: boolean;
}> {
  await ensureSchema();
  const stored = await requireInstallation(installationId);

  const info = await getInstallation(installationId);
  const repos = await listInstallationRepos(installationId);

  const pool = await getPool();
  const { rows } = await pool.query(
    `UPDATE github_installations
        SET account_login = $2, repository_selection = $3, permissions = $4::jsonb,
            suspended = $5, updated_at = NOW()
      WHERE installation_id = $1
      RETURNING ${INSTALLATION_COLUMNS}`,
    [
      installationId,
      info.account_login,
      info.repository_selection,
      JSON.stringify(info.permissions),
      info.suspended,
    ]
  );

  return {
    installation: rows.length ? toInstallationRow(rows[0]) : stored,
    repositories: repos.repositories,
    truncated: repos.truncated,
  };
}

export interface RemoveInstallationInput {
  installationId: number;
  /** Also uninstall the App on GitHub, so it stops appearing for the owner. */
  revoke: boolean;
  actor: string;
}

/**
 * Disconnects an installation.
 *
 * Refused while any microservice still names it — the foreign key would refuse
 * anyway, but a 409 naming the microservices is far more useful than a
 * constraint violation.
 *
 * `revoke` is what makes "detach the account" complete. Without it the App
 * stays installed on the owner's side, listed in their settings, with nothing
 * here able to see or remove it.
 */
export async function removeInstallation(
  input: RemoveInstallationInput
): Promise<{ removed: boolean; revoked: boolean; revoke_error: string | null }> {
  await ensureSchema();
  await requireInstallation(input.installationId);

  const pool = await getPool();
  const { rows } = await pool.query(
    `SELECT name FROM microservice_clusters WHERE installation_id = $1 ORDER BY name`,
    [input.installationId]
  );

  if (rows.length > 0) {
    const names = rows.map((row) => String(row.name));
    throw new HttpError(
      409,
      'installation_in_use',
      `${names.length} microservice(s) still build from this installation: ` +
        `${names.join(', ')}. Remove them first.`
    );
  }

  let revoked = false;
  let revokeError: string | null = null;

  if (input.revoke) {
    // Attempted before the local delete, but a failure here does not block it:
    // the owner may have already uninstalled, and refusing to forget a dead
    // grant would leave a row nobody can clear.
    try {
      await deleteInstallationOnGithub(input.installationId);
      revoked = true;
    } catch (error) {
      revokeError = error instanceof Error ? error.message : 'unknown error';
    }
  }

  await pool.query(`DELETE FROM github_installations WHERE installation_id = $1`, [
    input.installationId,
  ]);

  console.log('github installation disconnected', {
    installationId: input.installationId,
    actor: input.actor,
    revoked,
  });

  return { removed: true, revoked, revoke_error: revokeError };
}

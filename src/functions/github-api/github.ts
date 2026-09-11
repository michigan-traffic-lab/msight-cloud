import {
  cachedInstallationToken,
  forgetInstallationToken,
  GithubAuthError,
  loadCredentials,
  rememberInstallationToken,
  signAppJwt,
} from './app-auth';
import type {
  CloneToken,
  GithubAppIdentity,
  GithubInstallationInfo,
  GithubRepoInfo,
  InspectBuildResult,
  ManifestConversion,
} from '../../shared/github/rpc';

/**
 * The GitHub REST calls this deployment makes.
 *
 * Deliberately hand-rolled over `fetch` rather than pulling in Octokit: the
 * whole surface is six endpoints, and this function is bundled into every
 * deploy. What Octokit would buy — retries, pagination plugins, throttling — is
 * either handled here or not wanted.
 */

const API_ROOT = 'https://api.github.com';
const USER_AGENT = 'msight-cloud-console';

/** Pinned: GitHub dates its breaking REST changes and honours this header. */
const API_VERSION = '2022-11-28';

/** GitHub is a third party on the request path, so nothing waits on it forever. */
const REQUEST_TIMEOUT_MS = 8000;

interface GithubResponse {
  status: number;
  body: unknown;
  headers: Headers;
}

async function call(
  path: string,
  // Null for the one endpoint that takes no credentials: redeeming a manifest
  // code, which happens before this deployment has any.
  token: string | null,
  init: { method?: string; body?: unknown } = {}
): Promise<GithubResponse> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  try {
    const response = await fetch(`${API_ROOT}${path}`, {
      method: init.method ?? 'GET',
      headers: {
        accept: 'application/vnd.github+json',
        ...(token ? { authorization: `Bearer ${token}` } : {}),
        ...(init.body === undefined ? {} : { 'content-type': 'application/json' }),
        'x-github-api-version': API_VERSION,
        'user-agent': USER_AGENT,
      },
      ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
      signal: controller.signal,
    });

    const text = await response.text();
    let body: unknown = null;
    if (text) {
      try {
        body = JSON.parse(text);
      } catch {
        body = { message: text.slice(0, 500) };
      }
    }

    return { status: response.status, body, headers: response.headers };
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') {
      throw new GithubAuthError(
        'github_unavailable',
        `GitHub did not respond within ${REQUEST_TIMEOUT_MS / 1000}s.`
      );
    }
    throw new GithubAuthError(
      'github_unavailable',
      `Could not reach api.github.com: ${error instanceof Error ? error.message : 'unknown error'}`
    );
  } finally {
    clearTimeout(timer);
  }
}

function messageOf(body: unknown): string {
  const message = (body as { message?: unknown } | null)?.message;
  return typeof message === 'string' ? message : 'no detail';
}

/**
 * Turns a non-2xx into the specific reason, because the console shows this
 * sentence to whoever clicked and "GitHub returned 403" is not actionable.
 *
 * 403 is the interesting one: it is both "the App was never granted this
 * permission" and "you are being rate limited", and the remaining-quota header
 * is the only thing that separates them.
 */
function raiseFor(response: GithubResponse, context: string): never {
  const detail = messageOf(response.body);

  if (response.status === 401) {
    throw new GithubAuthError(
      'app_unauthorized',
      `GitHub rejected this deployment's App credentials (${context}). The App id and ` +
        `private key may not belong to the same App, or the key has been deleted. (${detail})`,
      401
    );
  }

  if (response.status === 403) {
    if (response.headers.get('x-ratelimit-remaining') === '0') {
      const resetAt = Number(response.headers.get('x-ratelimit-reset'));
      const when = Number.isFinite(resetAt) ? new Date(resetAt * 1000).toISOString() : 'shortly';
      throw new GithubAuthError(
        'rate_limited',
        `GitHub's rate limit for this installation is exhausted until ${when}.`,
        403
      );
    }
    throw new GithubAuthError(
      'insufficient_permission',
      `The GitHub App is not permitted to do this (${context}). The installation may ` +
        `predate a permission the App now requests, in which case the repository owner ` +
        `has to approve the new permissions on GitHub. (${detail})`,
      403
    );
  }

  if (response.status === 404) {
    throw new GithubAuthError(
      'repo_not_found',
      `GitHub has no such resource (${context}). It may have been renamed, made ` +
        `private, or removed from the App's installation. (${detail})`,
      404
    );
  }

  if (response.status === 429) {
    throw new GithubAuthError('rate_limited', 'GitHub is rate limiting this deployment.', 429);
  }

  throw new GithubAuthError(
    'github_unavailable',
    `GitHub returned ${response.status} (${context}): ${detail}`,
    response.status
  );
}

/**
 * Redeems the temporary code from a manifest-created App for its credentials.
 *
 * Unauthenticated, and necessarily so: this runs before the deployment has an
 * App at all. The code is the credential — single-use, valid for one hour — so
 * a failure here is normally a second attempt at a code already spent, and that
 * is worth saying rather than reporting as a generic GitHub error.
 *
 * Nothing from the response is logged. It carries the private key.
 */
export async function convertManifest(code: string): Promise<ManifestConversion> {
  const response = await call(`/app-manifests/${encodeURIComponent(code)}/conversions`, null, {
    method: 'POST',
  });

  if (response.status === 404 || response.status === 422) {
    throw new GithubAuthError(
      'bad_request',
      'GitHub would not redeem that App-creation code. It can only be used once and ' +
        'expires an hour after the App is created, so this usually means the page was ' +
        'reloaded or opened twice. Start the connection again.',
      response.status
    );
  }

  if (response.status < 200 || response.status >= 300) {
    raiseFor(response, 'converting the App manifest');
  }

  const body = (response.body ?? {}) as Record<string, unknown>;
  const appId = Number(body.id);
  const pem = typeof body.pem === 'string' ? body.pem : '';

  if (!Number.isInteger(appId) || appId <= 0 || !pem.includes('-----BEGIN')) {
    throw new GithubAuthError(
      'github_unavailable',
      'GitHub redeemed the code but did not return an App id and private key.',
      response.status
    );
  }

  const owner = body.owner as Record<string, unknown> | undefined;

  return {
    app_id: appId,
    slug: typeof body.slug === 'string' ? body.slug : '',
    name: typeof body.name === 'string' ? body.name : null,
    html_url: typeof body.html_url === 'string' ? body.html_url : null,
    owner_login: owner && typeof owner.login === 'string' ? owner.login : null,
    pem,
    webhook_secret: typeof body.webhook_secret === 'string' ? body.webhook_secret : null,
    permissions: (body.permissions ?? {}) as Record<string, string>,
    events: Array.isArray(body.events) ? (body.events as string[]) : [],
  };
}

/** Authenticated as the App itself. Cannot read any repository. */
async function callAsApp(
  path: string,
  method?: string,
  body?: unknown
): Promise<GithubResponse> {
  const credentials = await loadCredentials();
  const jwt = signAppJwt(credentials);
  return call(path, jwt, {
    ...(method ? { method } : {}),
    ...(body === undefined ? {} : { body }),
  });
}

async function installationToken(installationId: number): Promise<string> {
  const existing = cachedInstallationToken(installationId);
  if (existing) {
    return existing;
  }

  const response = await callAsApp(`/app/installations/${installationId}/access_tokens`, 'POST');

  if (response.status === 404) {
    forgetInstallationToken(installationId);
    throw new GithubAuthError(
      'installation_not_found',
      'This deployment holds an installation id GitHub no longer knows. Someone ' +
        'uninstalled the App from the repository owner, so the connection has to be ' +
        'made again.',
      404
    );
  }

  if (response.status === 403 && /suspend/i.test(messageOf(response.body))) {
    throw new GithubAuthError(
      'installation_suspended',
      'The repository owner has suspended this App installation. Nothing can be read ' +
        'until they unsuspend it on GitHub.',
      403
    );
  }

  if (response.status !== 201) {
    raiseFor(response, 'minting an installation token');
  }

  const body = response.body as { token?: unknown; expires_at?: unknown };
  if (typeof body.token !== 'string') {
    throw new GithubAuthError('github_unavailable', 'GitHub returned no installation token.');
  }

  rememberInstallationToken(
    installationId,
    body.token,
    typeof body.expires_at === 'string' ? body.expires_at : ''
  );
  return body.token;
}

/** Authenticated as one installation. This is what can read a repository. */
async function callAsInstallation(
  installationId: number,
  path: string,
  method?: string
): Promise<GithubResponse> {
  const token = await installationToken(installationId);
  const response = await call(path, token, method ? { method } : {});

  // A token rejected mid-life was revoked rather than expired, so the cached
  // copy is worthless. Drop it so the next attempt mints a fresh one instead of
  // replaying the dead one.
  if (response.status === 401) {
    forgetInstallationToken(installationId);
  }

  return response;
}

export async function verifyApp(): Promise<GithubAppIdentity> {
  const response = await callAsApp('/app');
  if (response.status !== 200) {
    raiseFor(response, 'reading the App identity');
  }

  const body = response.body as Record<string, unknown>;
  const owner = body.owner as Record<string, unknown> | undefined;
  return {
    app_id: Number(body.id),
    slug: String(body.slug ?? ''),
    name: typeof body.name === 'string' ? body.name : null,
    html_url: typeof body.html_url === 'string' ? body.html_url : null,
    owner_login: owner && typeof owner.login === 'string' ? owner.login : null,
    owner_type: owner && typeof owner.type === 'string' ? owner.type : null,
    permissions: (body.permissions ?? {}) as Record<string, string>,
    events: Array.isArray(body.events) ? body.events.map(String) : [],
  };
}

function toInstallation(body: Record<string, unknown>): GithubInstallationInfo {
  const account = (body.account ?? {}) as Record<string, unknown>;
  return {
    installation_id: Number(body.id),
    account_login: String(account.login ?? 'unknown'),
    account_type: typeof account.type === 'string' ? account.type : null,
    target_type: typeof body.target_type === 'string' ? body.target_type : null,
    repository_selection:
      typeof body.repository_selection === 'string' ? body.repository_selection : null,
    permissions: (body.permissions ?? {}) as Record<string, string>,
    suspended: body.suspended_at !== null && body.suspended_at !== undefined,
  };
}

export async function getInstallation(installationId: number): Promise<GithubInstallationInfo> {
  const response = await callAsApp(`/app/installations/${installationId}`);

  if (response.status === 404) {
    throw new GithubAuthError(
      'installation_not_found',
      `GitHub has no installation ${installationId} for this App. If the browser was ` +
        `sent back from a different App's install page, the id will not match.`,
      404
    );
  }

  if (response.status !== 200) {
    raiseFor(response, 'reading the installation');
  }

  return toInstallation(response.body as Record<string, unknown>);
}

/**
 * Mints a clone credential for one build.
 *
 * Deliberately NOT the cached token `callAsInstallation` uses. Two differences,
 * both of which matter:
 *
 * **Scope.** This asks GitHub to narrow the token to a single repository and to
 * `contents: read` alone. The cached token carries everything the installation
 * grants across every repository it grants, which is far more than a build
 * container needs and exactly what should not be sitting in a build
 * environment.
 *
 * **Freshness.** A cached token may have minutes left. A build cloning with an
 * almost-expired token fails partway through in a manner that looks like a
 * network fault, so this always mints a new one — a full hour, every time.
 *
 * The token is returned to the in-VPC caller, which passes it straight into one
 * StartBuild call. It is never logged, never stored, and never reaches a
 * browser.
 */
export async function cloneToken(input: {
  installationId: number;
  repository: string;
}): Promise<CloneToken> {
  const [, repoName = ''] = input.repository.split('/');
  if (!repoName) {
    throw new GithubAuthError(
      'bad_request',
      `"${input.repository}" is not an owner/repo pair, so a token cannot be scoped to it.`
    );
  }

  const response = await callAsApp(
    `/app/installations/${input.installationId}/access_tokens`,
    'POST',
    {
      // GitHub takes bare repository names here, not owner/repo — the owner is
      // already implied by the installation.
      repositories: [repoName],
      permissions: { contents: 'read' },
    }
  );

  if (response.status === 404) {
    forgetInstallationToken(input.installationId);
    throw new GithubAuthError(
      'installation_not_found',
      'GitHub no longer knows this installation, so no build token can be issued. ' +
        'Someone uninstalled the App from the repository owner.',
      404
    );
  }

  if (response.status === 422) {
    throw new GithubAuthError(
      'repo_not_found',
      `The installation does not grant ${input.repository}, so GitHub refused to issue a ` +
        'token for it. Add the repository to the App installation on GitHub.',
      422
    );
  }

  if (response.status !== 201) {
    raiseFor(response, 'minting a build token');
  }

  const body = response.body as { token?: unknown; expires_at?: unknown };
  if (typeof body.token !== 'string') {
    throw new GithubAuthError('github_unavailable', 'GitHub returned no build token.');
  }

  return {
    token: body.token,
    expires_at:
      typeof body.expires_at === 'string'
        ? body.expires_at
        : new Date(Date.now() + 3600_000).toISOString(),
  };
}

export async function deleteInstallation(installationId: number): Promise<{ deleted: boolean }> {
  const response = await callAsApp(`/app/installations/${installationId}`, 'DELETE');
  forgetInstallationToken(installationId);

  // Already gone is the desired end state, not a failure.
  if (response.status === 204 || response.status === 404) {
    return { deleted: true };
  }

  raiseFor(response, 'uninstalling the App');
}

function toRepo(body: Record<string, unknown>): GithubRepoInfo {
  const fullName = String(body.full_name ?? '');
  const [owner = '', name = ''] = fullName.split('/');
  return {
    repo_id: Number(body.id),
    full_name: fullName,
    owner,
    name,
    private: Boolean(body.private),
    default_branch: String(body.default_branch ?? 'main'),
    html_url: typeof body.html_url === 'string' ? body.html_url : null,
    archived: Boolean(body.archived),
  };
}

/**
 * Every repository the installation can see.
 *
 * Paginated with a hard page cap rather than following `next` to the end: an
 * org installed on "all repositories" can have thousands, and this list exists
 * to populate a picker. Hitting the cap is reported as `truncated` so the
 * console can say so instead of quietly showing a partial list.
 */
const MAX_REPO_PAGES = 5;
const REPOS_PER_PAGE = 100;

export async function listInstallationRepos(
  installationId: number
): Promise<{ repositories: GithubRepoInfo[]; truncated: boolean }> {
  const repositories: GithubRepoInfo[] = [];
  let truncated = false;

  for (let page = 1; page <= MAX_REPO_PAGES; page += 1) {
    const response = await callAsInstallation(
      installationId,
      `/installation/repositories?per_page=${REPOS_PER_PAGE}&page=${page}`
    );

    if (response.status !== 200) {
      raiseFor(response, 'listing the installation repositories');
    }

    const body = response.body as { repositories?: unknown; total_count?: unknown };
    const batch = Array.isArray(body.repositories) ? body.repositories : [];
    for (const entry of batch) {
      repositories.push(toRepo(entry as Record<string, unknown>));
    }

    if (batch.length < REPOS_PER_PAGE) {
      break;
    }

    if (page === MAX_REPO_PAGES) {
      truncated = Number(body.total_count ?? 0) > repositories.length;
    }
  }

  repositories.sort((a, b) => a.full_name.localeCompare(b.full_name));
  return { repositories, truncated };
}

/** GitHub wants each path segment encoded, but not the slashes between them. */
function encodePath(path: string): string {
  return path
    .split('/')
    .map((segment) => encodeURIComponent(segment))
    .join('/');
}

/**
 * Answers "can this be built?" against one branch.
 *
 * Three lookups, and each absence is reported rather than thrown, because
 * "there is no Dockerfile at that path" is the single most likely outcome of a
 * first attempt and the console has to explain it, not fail on it. Only a
 * genuine failure — no such repo, no permission, GitHub down — raises.
 */
export async function inspectBuild(request: {
  installation_id: number;
  owner: string;
  repo: string;
  branch: string;
  dockerfile_path: string;
  build_context: string;
}): Promise<InspectBuildResult> {
  const { installation_id: installationId, owner, repo } = request;
  const repoPath = `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`;

  const branchResponse = await callAsInstallation(
    installationId,
    `${repoPath}/branches/${encodePath(request.branch)}`
  );

  if (branchResponse.status === 404) {
    // Distinguishing a missing branch from a missing repo matters: one is a
    // typo in a form field, the other means the connection itself is broken.
    const repoResponse = await callAsInstallation(installationId, repoPath);
    if (repoResponse.status !== 200) {
      raiseFor(repoResponse, `reading ${owner}/${repo}`);
    }
    return { branch: null, dockerfile: null, build_context: 'missing' };
  }

  if (branchResponse.status !== 200) {
    raiseFor(branchResponse, `reading branch ${request.branch}`);
  }

  const branchBody = branchResponse.body as Record<string, unknown>;
  const commit = (branchBody.commit ?? {}) as Record<string, unknown>;
  const branch = {
    name: String(branchBody.name ?? request.branch),
    head_sha: String(commit.sha ?? ''),
  };

  // Pinned to the resolved sha rather than the branch name, so the Dockerfile
  // and the context are read from the same commit even if someone pushes
  // between the two calls.
  const ref = branch.head_sha || request.branch;

  const fileResponse = await callAsInstallation(
    installationId,
    `${repoPath}/contents/${encodePath(request.dockerfile_path)}?ref=${encodeURIComponent(ref)}`
  );

  let dockerfile: InspectBuildResult['dockerfile'] = null;
  if (fileResponse.status === 200) {
    const body = fileResponse.body as Record<string, unknown>;
    // A directory comes back as an array, which is a wrong path rather than a
    // Dockerfile — treated as absent, same as a 404.
    if (!Array.isArray(body) && body.type === 'file') {
      dockerfile = {
        path: String(body.path ?? request.dockerfile_path),
        sha: String(body.sha ?? ''),
        size: Number(body.size ?? 0),
      };
    }
  } else if (fileResponse.status !== 404) {
    raiseFor(fileResponse, `reading ${request.dockerfile_path}`);
  }

  let buildContext: InspectBuildResult['build_context'] = 'root';
  if (request.build_context !== '.' && request.build_context !== '') {
    const contextResponse = await callAsInstallation(
      installationId,
      `${repoPath}/contents/${encodePath(request.build_context)}?ref=${encodeURIComponent(ref)}`
    );

    if (contextResponse.status === 200) {
      buildContext = Array.isArray(contextResponse.body) ? 'directory' : 'not_a_directory';
    } else if (contextResponse.status === 404) {
      buildContext = 'missing';
    } else {
      raiseFor(contextResponse, `reading ${request.build_context}`);
    }
  }

  return { branch, dockerfile, build_context: buildContext };
}

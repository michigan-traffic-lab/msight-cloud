/**
 * The contract between the in-VPC admin function and the out-of-VPC
 * `github-api` function.
 *
 * Why two functions at all: this stack runs with `natGateways: 0` and its
 * Lambdas in PRIVATE_ISOLATED subnets, so the in-VPC function — the only one
 * that can reach Aurora — has no route to api.github.com and never will
 * without paying for a NAT gateway. The out-of-VPC function is the reverse: it
 * has internet and cannot reach the database.
 *
 * So the split follows the constraint rather than fighting it. The in-VPC
 * function owns every route, every table and every decision; this one is a
 * transport that holds the App private key, mints installation tokens, and
 * speaks HTTPS to GitHub. It is invoked over the Lambda interface endpoint the
 * stack already has and is never wired to API Gateway, so nothing outside the
 * VPC can call it.
 *
 * Keeping the ops coarse — one round trip per console action rather than one
 * per GitHub request — is deliberate: `inspect_build` answers "does this
 * Dockerfile exist on this branch" completely, in one invoke.
 */

/** Ops the transport understands. One per console action, not per GitHub call. */
export type GithubOp =
  | 'convert_manifest'
  | 'verify_app'
  | 'get_installation'
  | 'list_installation_repos'
  | 'inspect_build'
  | 'clone_token'
  | 'delete_installation';

/**
 * Redeems the temporary code GitHub returns after an App is created from a
 * manifest, which is what saves an operator from registering the App by hand.
 *
 * The only op that carries no App credentials, because at this point there are
 * none — the code itself is the credential, and GitHub answers it exactly once
 * within an hour. That is also why it must not be logged or returned anywhere.
 */
export interface ConvertManifestRequest {
  op: 'convert_manifest';
  code: string;
}

export interface VerifyAppRequest {
  op: 'verify_app';
}

export interface GetInstallationRequest {
  op: 'get_installation';
  installation_id: number;
}

export interface ListInstallationReposRequest {
  op: 'list_installation_repos';
  installation_id: number;
}

/**
 * Everything the "can we build this?" question needs, in one call: resolve the
 * branch, look for the Dockerfile at the given path, and confirm the build
 * context is a directory.
 */
export interface InspectBuildRequest {
  op: 'inspect_build';
  installation_id: number;
  owner: string;
  repo: string;
  branch: string;
  dockerfile_path: string;
  build_context: string;
}

/**
 * Mints a token CodeBuild can clone with.
 *
 * The one op whose result is a live credential, and the reason the build
 * pipeline needs no GitHub account of its own: an installation token is scoped
 * to exactly the repositories that installation grants, carries only the App's
 * permissions (here, `contents: read`), and expires in an hour whatever
 * happens. A build that outlives it fails on a fetch rather than holding
 * standing access.
 *
 * `repository` narrows it further where GitHub allows — a token issued for one
 * repository cannot read the installation's others, so a compromised build
 * container cannot walk sideways through the account.
 *
 * Never logged, never stored, never returned to a browser. It goes from here
 * into one StartBuild call's environment and nowhere else.
 */
export interface CloneTokenRequest {
  op: 'clone_token';
  installation_id: number;
  /** `owner/repo`. Scopes the token to this repository alone. */
  repository: string;
}

export interface DeleteInstallationRequest {
  op: 'delete_installation';
  installation_id: number;
}

export type GithubRpcRequest =
  | ConvertManifestRequest
  | VerifyAppRequest
  | GetInstallationRequest
  | ListInstallationReposRequest
  | InspectBuildRequest
  | CloneTokenRequest
  | DeleteInstallationRequest;

/**
 * What GitHub hands back when a manifest code is redeemed: the App's identity
 * and, once only, its credentials.
 *
 * `pem` and `webhook_secret` are the whole point — they are what an operator
 * would otherwise download and paste. They cross this boundary once, go
 * straight into Secrets Manager, and are never returned to a caller or written
 * to a log.
 */
export interface ManifestConversion {
  app_id: number;
  slug: string;
  name: string | null;
  html_url: string | null;
  owner_login: string | null;
  pem: string;
  webhook_secret: string | null;
  permissions: Record<string, string>;
  events: string[];
}

/** What `GET /app` reports back about the App the private key belongs to. */
export interface GithubAppIdentity {
  app_id: number;
  slug: string;
  name: string | null;
  html_url: string | null;
  /**
   * The account the App belongs to, and whether it is a user or an
   * organisation. Needed to build the App's settings URL, which lives under a
   * different path for each — and that URL is the only way to delete an App,
   * since GitHub exposes no API for it.
   */
  owner_login: string | null;
  owner_type: string | null;
  /** What the App requests. An installation may have been granted less. */
  permissions: Record<string, string>;
  events: string[];
}

export interface GithubInstallationInfo {
  installation_id: number;
  account_login: string;
  account_type: string | null;
  target_type: string | null;
  repository_selection: string | null;
  permissions: Record<string, string>;
  suspended: boolean;
}

export interface GithubRepoInfo {
  repo_id: number;
  full_name: string;
  owner: string;
  name: string;
  private: boolean;
  default_branch: string;
  html_url: string | null;
  archived: boolean;
}

export interface InspectBuildResult {
  /** Null when the branch does not exist on the repo. */
  branch: { name: string; head_sha: string } | null;
  /** Null when nothing is at `dockerfile_path` on that branch. */
  dockerfile: { path: string; sha: string; size: number } | null;
  /**
   * Whether the build context resolves to a directory. 'root' is the repo root,
   * which always exists and needs no lookup.
   */
  build_context: 'root' | 'directory' | 'missing' | 'not_a_directory';
}

/**
 * A live clone credential and when it dies.
 *
 * `expires_at` is returned so the caller can refuse to start a build it cannot
 * finish, rather than discovering the expiry as a mid-build fetch failure that
 * reads like a network fault.
 */
export interface CloneToken {
  token: string;
  expires_at: string;
}

export type GithubRpcData =
  | ManifestConversion
  | GithubAppIdentity
  | GithubInstallationInfo
  | { repositories: GithubRepoInfo[]; truncated: boolean }
  | InspectBuildResult
  | CloneToken
  | { deleted: boolean };

/**
 * Errors cross the boundary as data, never as a thrown Lambda failure.
 *
 * A thrown error would reach the caller as an opaque "Unhandled" with the
 * useful part — which of GitHub's refusals it was — buried in another
 * function's logs. These codes are what the console turns into a sentence an
 * operator can act on, so they distinguish "your key is wrong" from "the owner
 * suspended the install" from "there is no Dockerfile there".
 */
export type GithubErrorCode =
  | 'app_not_configured'
  | 'bad_private_key'
  | 'app_unauthorized'
  | 'installation_not_found'
  | 'installation_suspended'
  | 'insufficient_permission'
  | 'repo_not_found'
  | 'rate_limited'
  | 'github_unavailable'
  | 'bad_request';

export interface GithubRpcError {
  code: GithubErrorCode;
  message: string;
  /** GitHub's HTTP status, when the failure came from GitHub at all. */
  status: number | null;
}

export type GithubRpcResponse<T = GithubRpcData> =
  | { ok: true; data: T }
  | { ok: false; error: GithubRpcError };

/** HTTP status the console should see for each transport error. */
export const GITHUB_ERROR_STATUS: Record<GithubErrorCode, number> = {
  app_not_configured: 409,
  bad_private_key: 500,
  app_unauthorized: 502,
  installation_not_found: 404,
  installation_suspended: 409,
  insufficient_permission: 403,
  repo_not_found: 404,
  rate_limited: 429,
  github_unavailable: 502,
  bad_request: 400,
};

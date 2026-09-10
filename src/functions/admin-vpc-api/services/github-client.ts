import { InvokeCommand, LambdaClient } from '@aws-sdk/client-lambda';
import { HttpError } from '../../../shared/admin-api/http';
import {
  GITHUB_ERROR_STATUS,
  type GithubAppIdentity,
  type GithubInstallationInfo,
  type GithubRepoInfo,
  type GithubRpcRequest,
  type GithubRpcResponse,
  type InspectBuildResult,
  type ManifestConversion,
} from '../../../shared/github/rpc';

/**
 * Calls GitHub, from a function that cannot.
 *
 * The in-VPC admin function owns every route and every table but sits in an
 * isolated subnet with no NAT, so it has no route to api.github.com. It reaches
 * GitHub by invoking the out-of-VPC `github-api` function over the Lambda
 * interface endpoint the stack already provisions for exactly this kind of hop.
 *
 * From a route handler's point of view this module is GitHub: one call, a typed
 * result, and an {@link HttpError} carrying a sentence the console can show.
 */

const lambda = new LambdaClient({});

function functionName(): string {
  const name = process.env.GITHUB_API_FUNCTION_NAME;
  if (!name) {
    throw new HttpError(
      500,
      'not_configured',
      'GITHUB_API_FUNCTION_NAME is not set on the in-VPC admin function, so it cannot ' +
        'reach GitHub. This is a deployment problem, not a configuration one.'
    );
  }
  return name;
}

async function invoke<T>(request: GithubRpcRequest): Promise<T> {
  let raw: string;

  try {
    const result = await lambda.send(
      new InvokeCommand({
        FunctionName: functionName(),
        // Synchronous: every caller needs the answer. An async invoke would
        // return 202 and lose the result entirely.
        InvocationType: 'RequestResponse',
        Payload: Buffer.from(JSON.stringify(request)),
      })
    );

    // FunctionError is set when the transport threw rather than returning a
    // structured refusal. Its own handler catches everything, so this means the
    // function failed to run at all — a timeout, an out-of-memory, a bad bundle.
    if (result.FunctionError) {
      throw new HttpError(
        502,
        'github_transport_failed',
        'The GitHub transport function failed to run. Check its CloudWatch logs.'
      );
    }

    raw = result.Payload ? Buffer.from(result.Payload).toString('utf8') : '';
  } catch (error) {
    if (error instanceof HttpError) {
      throw error;
    }
    // Reaching the Lambda API itself failed. Worth distinguishing from GitHub
    // being down: the fix is in this account, not on github.com.
    throw new HttpError(
      502,
      'github_transport_unreachable',
      `Could not invoke the GitHub transport function: ${
        error instanceof Error ? error.message : 'unknown error'
      }`
    );
  }

  let response: GithubRpcResponse<T>;
  try {
    response = JSON.parse(raw) as GithubRpcResponse<T>;
  } catch {
    throw new HttpError(
      502,
      'github_transport_failed',
      'The GitHub transport function returned something that is not JSON.'
    );
  }

  if (!response || typeof response !== 'object' || !('ok' in response)) {
    throw new HttpError(
      502,
      'github_transport_failed',
      'The GitHub transport function returned an unrecognised payload.'
    );
  }

  if (!response.ok) {
    // The transport's codes are already the specific reason, so they are passed
    // through rather than flattened into one generic failure — the console
    // renders a different next step for each.
    throw new HttpError(
      GITHUB_ERROR_STATUS[response.error.code] ?? 502,
      response.error.code,
      response.error.message
    );
  }

  return response.data;
}

/** Reads `GET /app`: proves the stored private key belongs to the stored app id. */
export function verifyApp(): Promise<GithubAppIdentity> {
  return invoke<GithubAppIdentity>({ op: 'verify_app' });
}

export function getInstallation(installationId: number): Promise<GithubInstallationInfo> {
  return invoke<GithubInstallationInfo>({
    op: 'get_installation',
    installation_id: installationId,
  });
}

export function listInstallationRepos(
  installationId: number
): Promise<{ repositories: GithubRepoInfo[]; truncated: boolean }> {
  return invoke({ op: 'list_installation_repos', installation_id: installationId });
}

export function inspectBuild(request: {
  installationId: number;
  owner: string;
  repo: string;
  branch: string;
  dockerfilePath: string;
  buildContext: string;
}): Promise<InspectBuildResult> {
  return invoke<InspectBuildResult>({
    op: 'inspect_build',
    installation_id: request.installationId,
    owner: request.owner,
    repo: request.repo,
    branch: request.branch,
    dockerfile_path: request.dockerfilePath,
    build_context: request.buildContext,
  });
}

export function deleteInstallation(installationId: number): Promise<{ deleted: boolean }> {
  return invoke<{ deleted: boolean }>({
    op: 'delete_installation',
    installation_id: installationId,
  });
}

/**
 * Redeems the temporary code GitHub issues when an App is created from a
 * manifest. The one call that carries no App credentials — there are none yet.
 */
export function convertManifest(code: string): Promise<ManifestConversion> {
  return invoke<ManifestConversion>({ op: 'convert_manifest', code });
}

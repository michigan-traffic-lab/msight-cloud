import { GithubAuthError, newRequestId } from './app-auth';
import {
  cloneToken,
  convertManifest,
  deleteInstallation,
  getInstallation,
  inspectBuild,
  listInstallationRepos,
  verifyApp,
} from './github';
import type {
  GithubRpcData,
  GithubRpcRequest,
  GithubRpcResponse,
} from '../../shared/github/rpc';

/**
 * The out-of-VPC half of the GitHub integration.
 *
 * It exists for one reason: this stack runs `natGateways: 0` with its Lambdas
 * in isolated subnets, so the function that can reach Aurora cannot reach
 * api.github.com. This one is the mirror image, and holds nothing but the App
 * private key and the HTTP calls.
 *
 * It is invoked only by the in-VPC admin function, over the Lambda interface
 * endpoint, and is never attached to API Gateway — so there is no path to it
 * from outside the account. That is what allows it to skip authorization
 * entirely: it has no notion of a console user, and every decision about who
 * may do what has already been made by the caller.
 *
 * Nothing here logs a token, a private key, or a repository's contents.
 */

function fail(error: unknown, requestId: string): GithubRpcResponse {
  if (error instanceof GithubAuthError) {
    // Expected refusals — no key configured, no such branch, owner suspended
    // the install. Logged at warn without a stack, since the stack is noise.
    console.warn('github-api refused', {
      requestId,
      code: error.code,
      status: error.status,
      message: error.message,
    });
    return { ok: false, error: { code: error.code, message: error.message, status: error.status } };
  }

  console.error('github-api unhandled error', {
    requestId,
    name: error instanceof Error ? error.name : 'UnknownError',
    message: error instanceof Error ? error.message : String(error),
    stack: error instanceof Error ? error.stack : undefined,
  });

  return {
    ok: false,
    error: {
      code: 'github_unavailable',
      message: 'The GitHub transport failed unexpectedly. Check its CloudWatch logs.',
      status: null,
    },
  };
}

/** Rejects a malformed installation id before it reaches a URL. */
function installationIdOf(request: { installation_id?: unknown }): number {
  const id = Number(request.installation_id);
  if (!Number.isInteger(id) || id <= 0) {
    throw new GithubAuthError('bad_request', 'installation_id must be a positive integer.');
  }
  return id;
}

function requireString(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new GithubAuthError('bad_request', `${field} is required.`);
  }
  return value;
}

async function run(request: GithubRpcRequest): Promise<GithubRpcData> {
  switch (request.op) {
    case 'convert_manifest':
      return convertManifest(requireString(request.code, 'code'));

    case 'verify_app':
      return verifyApp();

    case 'get_installation':
      return getInstallation(installationIdOf(request));

    case 'list_installation_repos':
      return listInstallationRepos(installationIdOf(request));

    case 'inspect_build':
      return inspectBuild({
        installation_id: installationIdOf(request),
        owner: requireString(request.owner, 'owner'),
        repo: requireString(request.repo, 'repo'),
        branch: requireString(request.branch, 'branch'),
        dockerfile_path: requireString(request.dockerfile_path, 'dockerfile_path'),
        // '.' is meaningful (the repo root) so an empty context is not an error.
        build_context: typeof request.build_context === 'string' ? request.build_context : '.',
      });

    case 'clone_token':
      return cloneToken({
        installationId: installationIdOf(request),
        repository: requireString(request.repository, 'repository'),
      });

    case 'delete_installation':
      return deleteInstallation(installationIdOf(request));

    default:
      throw new GithubAuthError(
        'bad_request',
        `Unknown op "${(request as { op?: string }).op ?? ''}".`
      );
  }
}

export async function handler(event: GithubRpcRequest): Promise<GithubRpcResponse> {
  const requestId = newRequestId();

  if (!event || typeof event !== 'object' || typeof event.op !== 'string') {
    return fail(new GithubAuthError('bad_request', 'Payload must carry an "op".'), requestId);
  }

  console.log('github-api request', { requestId, op: event.op });

  try {
    return { ok: true, data: await run(event) };
  } catch (error) {
    return fail(error, requestId);
  }
}

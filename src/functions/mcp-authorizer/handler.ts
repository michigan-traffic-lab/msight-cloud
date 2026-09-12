import type { APIGatewayRequestAuthorizerEventV2, APIGatewaySimpleAuthorizerWithContextResult } from 'aws-lambda';
import { verifyMcpToken } from '../admin-vpc-api/services/mcp-tokens';

/**
 * Authorises the MCP endpoint against a long-lived token.
 *
 * The rest of this API authorises on a Cognito JWT, which is right for the
 * console and wrong for a desktop MCP client: that configuration is a file read
 * once at startup, and a one-hour token in it is stale before its second use.
 * So `/mcp` takes a credential issued for the purpose — checked here, against
 * the table that issued it.
 *
 * In the VPC because the token table is in Aurora, and Aurora is reachable from
 * nowhere else. That costs a cold start, which API Gateway's authorizer cache
 * absorbs: the same token presented again inside the TTL never reaches this
 * function at all.
 *
 * ## What it returns
 *
 * The role travels to the MCP function in the authorizer context, so that
 * function never has to look the token up again and never sees the token
 * itself. This is also the only place a token's plaintext is compared, which is
 * what keeps `mcp-api` free of database access entirely.
 */

/** The header the token arrives in. Not `Authorization` — see the stack. */
const TOKEN_HEADER = 'x-msight-token';

type Result = APIGatewaySimpleAuthorizerWithContextResult<{
  role: string;
  tokenName: string;
  createdBy: string;
}>;

const DENY: Result = {
  isAuthorized: false,
  context: { role: '', tokenName: '', createdBy: '' },
};

export async function handler(event: APIGatewayRequestAuthorizerEventV2): Promise<Result> {
  /**
   * The `Bearer ` prefix is optional here.
   *
   * API Gateway strips it from a JWT identity source, so a config written for
   * the old Cognito token carries it and one written from the console's
   * instructions does not. Accepting both removes a failure whose only symptom
   * would be a 401 that looks identical to a wrong token.
   */
  const raw =
    event.headers?.[TOKEN_HEADER] ??
    event.headers?.[TOKEN_HEADER.toUpperCase()] ??
    event.headers?.['X-Msight-Token'] ??
    '';
  const presented = raw.replace(/^Bearer\s+/i, '').trim();

  if (!presented) return DENY;

  try {
    const verified = await verifyMcpToken(presented);
    if (!verified) return DENY;

    return {
      isAuthorized: true,
      context: {
        role: verified.role,
        tokenName: verified.name,
        createdBy: verified.created_by,
      },
    };
  } catch (error) {
    /**
     * A database failure denies rather than throws.
     *
     * Throwing here produces a 500 from the gateway, which a client reads as
     * "the server is broken" and a person reads as "my token is fine". Denying
     * says the same thing the caller can act on, and the reason is logged where
     * it belongs.
     */
    console.error(
      JSON.stringify({
        event: 'mcp_authorizer_failed',
        error: error instanceof Error ? error.message : String(error),
      })
    );
    return DENY;
  }
}

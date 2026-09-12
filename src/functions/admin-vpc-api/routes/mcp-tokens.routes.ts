import { z } from 'zod';
import { created, ok, parseWith, readJsonBody } from '../../../shared/admin-api/http';
import { requireRole } from '../../../shared/admin-api/middleware/require-role';
import { Router } from '../../../shared/admin-api/router';
import {
  createMcpToken,
  listMcpTokens,
  revokeMcpToken,
  type McpRole,
} from '../services/mcp-tokens';

const CreateSchema = z.object({
  name: z.string().min(2).max(60),
  /**
   * Defaults to 'viewer', which is the read-only half of the tool set.
   *
   * A token is a credential somebody will paste into a file and forget, so the
   * default is the one that can do least. Asking for more is a deliberate act
   * and is capped at the issuer's own role by the service.
   */
  role: z.enum(['admin', 'operator', 'viewer']).optional(),
  /**
   * Null — the default — never expires.
   *
   * That is the point of the credential: the thing it replaces died hourly and
   * made the integration unusable. An expiry is offered for anyone who wants
   * one, not imposed on everyone who does not.
   */
  expires_in_days: z.number().int().min(1).max(3650).nullable().optional(),
});

/**
 * Credentials for the MCP endpoint.
 *
 * Operator-gated rather than admin-only: an operator can already do everything
 * an operator-scoped token could do, so requiring an admin to mint one adds a
 * gatekeeper without adding a boundary. The service refuses a token that would
 * outrank its issuer, which is where the real limit is.
 *
 * Listing never returns a token, only its metadata. There is nothing to return
 * — only the hash is kept, and the plaintext existed for exactly one response.
 */
export function mcpTokenRoutes(base: string): Router {
  const router = new Router();
  const operator = { middleware: [requireRole('operator')] };

  router.get(`${base}/mcp-tokens`, async () => ok({ tokens: await listMcpTokens() }), operator);

  router.post(
    `${base}/mcp-tokens`,
    async (ctx) => {
      const input = parseWith(CreateSchema, readJsonBody(ctx));
      const result = await createMcpToken({
        name: input.name,
        role: (input.role ?? 'viewer') as McpRole,
        expiresInDays: input.expires_in_days ?? null,
        actor: ctx.caller.username,
        actorRole: ctx.caller.role as McpRole,
      });

      /**
       * The only response that ever carries the token.
       *
       * Said explicitly in the payload as well as in the console, because a
       * client that stores this response is storing a credential and its author
       * should know that from the shape of it.
       */
      return created({
        token: result.token,
        token_shown_once: true,
        mcp_token: result.row,
      });
    },
    operator
  );

  router.delete(
    `${base}/mcp-tokens/:name`,
    async (ctx) =>
      ok({ mcp_token: await revokeMcpToken({ name: ctx.params.name, actor: ctx.caller.username }) }),
    operator
  );

  return router;
}

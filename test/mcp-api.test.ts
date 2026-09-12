process.env.ADMIN_VPC_API_FUNCTION_NAME = 'admin-vpc-api-for-tests';

import { handler } from '../src/functions/mcp-api/handler';

/**
 * The MCP server's transport layer.
 *
 * The tool bodies need the admin API and are not exercised here. What is, is
 * the part that broke in the field and produced only "server disconnected" in
 * a desktop client: where the caller's JWT is read from, and what a request
 * that is not a POST is answered with.
 */

type Event = Parameters<typeof handler>[0];

function request(overrides: {
  method?: string;
  headers?: Record<string, string>;
  body?: unknown;
  /** What the authorizer resolved from the presented MCP token. */
  role?: string;
}): Event {
  return {
    version: '2.0',
    routeKey: 'POST /mcp',
    rawPath: '/mcp',
    headers: overrides.headers ?? {},
    requestContext: {
      http: { method: overrides.method ?? 'POST', path: '/mcp' },
      authorizer: {
        lambda: {
          // `in` rather than `??`, so a test can pass undefined to mean "the
          // authorizer set no role" instead of silently getting the default.
          role: 'role' in overrides ? overrides.role : 'admin',
          tokenName: 'test-token',
          createdBy: 'tester',
        },
      },
    },
    body: overrides.body === undefined ? undefined : JSON.stringify(overrides.body),
    isBase64Encoded: false,
  } as unknown as Event;
}

const parse = (result: Awaited<ReturnType<typeof handler>>) =>
  JSON.parse((result as { body: string }).body);

const statusOf = (result: Awaited<ReturnType<typeof handler>>) =>
  (result as { statusCode: number }).statusCode;

describe('the MCP transport', () => {
  it('completes the handshake a client opens with', async () => {
    const result = await handler(
      request({
        body: { jsonrpc: '2.0', id: 1, method: 'initialize', params: {} },
      })
    );

    expect(statusOf(result)).toBe(200);
    expect(parse(result).result.protocolVersion).toBe('2024-11-05');
    expect(parse(result).result.serverInfo.name).toBe('msight-cloud');
  });

  it('lists tools', async () => {
    const result = await handler(
      request({ body: { jsonrpc: '2.0', id: 2, method: 'tools/list' } })
    );

    const tools = parse(result).result.tools;
    expect(Array.isArray(tools)).toBe(true);
    expect(tools.length).toBeGreaterThan(0);
    expect(tools.every((tool: { name: string }) => typeof tool.name === 'string')).toBe(true);
  });

  it('hides write tools from a viewer', async () => {
    const asViewer = await handler(
      request({ role: 'viewer', body: { jsonrpc: '2.0', id: 3, method: 'tools/list' } })
    );
    const asAdmin = await handler(
      request({ role: 'admin', body: { jsonrpc: '2.0', id: 3, method: 'tools/list' } })
    );

    expect(parse(asViewer).result.tools.length).toBeLessThan(
      parse(asAdmin).result.tools.length
    );
  });

  /**
   * A token whose role is missing or unrecognised reads as the least it could
   * be. The authorizer has already decided this caller may in; what it may do
   * is a separate question, and the safe answer to a malformed role is the one
   * that can do least.
   */
  it.each([undefined, '', 'superuser'])('treats role %j as viewer', async (role) => {
    const asUnknown = await handler(
      request({ role: role as string, body: { jsonrpc: '2.0', id: 4, method: 'tools/list' } })
    );
    const asViewer = await handler(
      request({ role: 'viewer', body: { jsonrpc: '2.0', id: 4, method: 'tools/list' } })
    );

    expect(parse(asUnknown).result.tools.map((t: { name: string }) => t.name)).toEqual(
      parse(asViewer).result.tools.map((t: { name: string }) => t.name)
    );
  });

  /**
   * Streamable HTTP lets a client open GET /mcp for a server-initiated stream.
   * This server has none, and the spec's answer for that is 405 — not the 404
   * an unrouted path produces, which reads as "wrong address" and sends the
   * client looking for an endpoint that never existed.
   */
  describe('methods it does not implement', () => {
    it.each(['GET', 'DELETE'])('answers %s with 405 and an Allow header', async (method) => {
      const result = await handler(request({ method }));

      expect(statusOf(result)).toBe(405);
      expect((result as { headers: Record<string, string> }).headers.allow).toBe('POST');
    });

    it('still answers POST', async () => {
      const result = await handler(
        request({ method: 'POST', body: { jsonrpc: '2.0', id: 1, method: 'initialize' } })
      );
      expect(statusOf(result)).toBe(200);
    });
  });

  describe('notifications', () => {
    it('are acknowledged with 202 and no body', async () => {
      const result = await handler(
        request({ body: { jsonrpc: '2.0', method: 'notifications/initialized' } })
      );

      expect(statusOf(result)).toBe(202);
      expect((result as { body: string }).body).toBe('');
    });
  });

  describe('malformed input', () => {
    it('reports a parse error rather than failing', async () => {
      const event = request({});
      (event as { body?: string }).body = '{not json';

      const result = await handler(event);
      expect(statusOf(result)).toBe(400);
      expect(parse(result).error.code).toBe(-32700);
    });

    it('reports an unknown method', async () => {
      const result = await handler(
        request({ body: { jsonrpc: '2.0', id: 9, method: 'no/such/method' } })
      );
      expect(parse(result).error.code).toBe(-32601);
    });
  });
});

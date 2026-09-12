/**
 * MCP (Model Context Protocol) server — Streamable HTTP transport.
 *
 * Implements the JSON-RPC 2.0 message layer of the MCP 2024-11-05 spec. Each
 * Lambda invocation handles one POST /mcp request, which is the stateless
 * model Streamable HTTP is designed for.
 *
 * Auth happens before this function runs, in a Lambda authorizer that checks a
 * long-lived MCP token against the table that issued it. The token arrives in
 * `X-Msight-Token` rather than `Authorization`, and that is not a style choice:
 * `mcp-remote`, which is how a desktop client reaches an HTTP MCP server,
 * attaches its own OAuth provider to the transport and that provider overwrites
 * the Authorization header on every request — a token passed as
 * `--header Authorization:Bearer …` arrives as the bare string "Bearer ". Any
 * other header name survives intact.
 *
 * ## Why this calls a Lambda rather than an HTTP API
 *
 * The caller holds an MCP token, not a Cognito JWT, so there is nothing to
 * forward to the admin API — its authorizer would refuse it, correctly. Every
 * admin path these tools use is served by the in-VPC function, so this invokes
 * that function directly and hands it the role the authorizer resolved.
 *
 * That keeps one credential in play instead of two. The alternative — a service
 * identity in Cognito whose password this function holds — would mean a
 * standing admin credential that every MCP request authenticates with, and the
 * role check below would be the only thing standing between a viewer's token
 * and it.
 *
 * Read tools are available to any signed-in user. Write tools (restart,
 * rollback, suppress) require the admin role, checked by reading the claims
 * API Gateway already validated.
 */

import { InvokeCommand, LambdaClient } from '@aws-sdk/client-lambda';
import type {
  APIGatewayProxyEventV2WithLambdaAuthorizer,
  APIGatewayProxyResultV2,
} from 'aws-lambda';

const ADMIN_FUNCTION_NAME = process.env.ADMIN_VPC_API_FUNCTION_NAME!;

const lambda = new LambdaClient({});

/** What the authorizer resolved from the presented token. */
interface McpAuthContext {
  role: string;
  tokenName: string;
  createdBy: string;
}

// ────────────────────────────────────────────────────────────────────────────
// JSON-RPC 2.0 types
// ────────────────────────────────────────────────────────────────────────────

interface JsonRpcRequest {
  jsonrpc: '2.0';
  id?: string | number | null;
  method: string;
  params?: Record<string, unknown>;
}

function ok(id: string | number | null | undefined, result: unknown) {
  return { jsonrpc: '2.0', id: id ?? null, result };
}

function err(id: string | number | null | undefined, code: number, message: string) {
  return { jsonrpc: '2.0', id: id ?? null, error: { code, message } };
}

// ────────────────────────────────────────────────────────────────────────────
// Auth helpers
// ────────────────────────────────────────────────────────────────────────────

/**
 * The role carried by the token, defaulting to the least it could be.
 *
 * An unrecognised value reads as 'viewer' rather than throwing: the authorizer
 * has already decided this caller is allowed in, and the safe reading of a
 * malformed role is the one that can do least.
 */
function roleFrom(context: Partial<McpAuthContext> | undefined): 'admin' | 'operator' | 'viewer' {
  const role = context?.role;
  if (role === 'admin' || role === 'operator') return role;
  return 'viewer';
}

// ────────────────────────────────────────────────────────────────────────────
// Tool definitions
// ────────────────────────────────────────────────────────────────────────────

interface ToolDef {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  minRole?: 'admin' | 'operator';
}

const TOOLS: ToolDef[] = [
  {
    name: 'list_microservices',
    description: 'List all registered microservices with their current provision, build, and launch state.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'get_microservice_status',
    description:
      'Get full status of one microservice: ECS running/desired counts, image, log summary, and whether the image is stale relative to the branch head.',
    inputSchema: {
      type: 'object',
      properties: { name: { type: 'string', description: 'Microservice name' } },
      required: ['name'],
    },
  },
  {
    name: 'get_microservice_logs',
    description:
      "Get recent log output from a microservice. source='container' returns runtime task logs; 'build' returns the last CodeBuild output.",
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Microservice name' },
        source: {
          type: 'string',
          enum: ['container', 'build'],
          description: "Which log to read: 'container' (default) or 'build'",
        },
        limit: {
          type: 'number',
          description: 'Lines to return (default 100, max 500)',
        },
      },
      required: ['name'],
    },
  },
  {
    name: 'get_microservice_metrics',
    description:
      'Get CPU utilization, memory utilization, and task counts for a deployed microservice over the last 3 hours (5-minute resolution).',
    inputSchema: {
      type: 'object',
      properties: { name: { type: 'string', description: 'Microservice name' } },
      required: ['name'],
    },
  },
  {
    name: 'list_microservice_images',
    description:
      'List all available ECR image tags for a microservice, newest push first. Use this to find tags before rolling back.',
    inputSchema: {
      type: 'object',
      properties: { name: { type: 'string', description: 'Microservice name' } },
      required: ['name'],
    },
  },
  {
    name: 'list_microservice_builds',
    description: 'List recent CodeBuild build history for a microservice — status, duration, commit SHA, and log location.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Microservice name' },
        limit: { type: 'number', description: 'Number of builds to return (default 10, max 50)' },
      },
      required: ['name'],
    },
  },
  {
    name: 'list_alarms',
    description: 'List CloudWatch alarms. Filter by alarm state or name prefix.',
    inputSchema: {
      type: 'object',
      properties: {
        state: {
          type: 'string',
          enum: ['OK', 'ALARM', 'INSUFFICIENT_DATA'],
          description: 'Filter to alarms in this state',
        },
        prefix: { type: 'string', description: 'Filter alarms whose name starts with this' },
      },
    },
  },
  {
    name: 'get_clients_summary',
    description: 'Get a count of currently connected WebSocket clients, broken down by app.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'list_sensors',
    description:
      'List all registered sensors with queue depth, consumer existence, and whether the streaming infrastructure is healthy.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'restart_microservice',
    description:
      'Perform a rolling restart of a deployed microservice — replaces running tasks one by one with no service interruption.',
    inputSchema: {
      type: 'object',
      properties: { name: { type: 'string', description: 'Microservice name' } },
      required: ['name'],
    },
    minRole: 'admin',
  },
  {
    name: 'rollback_microservice',
    description:
      'Deploy a specific previously-built image tag to a running microservice. Use list_microservice_images first to find available tags.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Microservice name' },
        image_tag: {
          type: 'string',
          description: 'Image tag to deploy (e.g. "abc123def456", visible in list_microservice_images)',
        },
      },
      required: ['name', 'image_tag'],
    },
    minRole: 'admin',
  },
  {
    name: 'suppress_alarm',
    description: 'Disable actions on a CloudWatch alarm to silence pages without deleting the alarm.',
    inputSchema: {
      type: 'object',
      properties: { name: { type: 'string', description: 'Exact CloudWatch alarm name' } },
      required: ['name'],
    },
    minRole: 'admin',
  },
  {
    name: 'unsuppress_alarm',
    description: 'Re-enable actions on a previously suppressed CloudWatch alarm.',
    inputSchema: {
      type: 'object',
      properties: { name: { type: 'string', description: 'Exact CloudWatch alarm name' } },
      required: ['name'],
    },
    minRole: 'admin',
  },
];

function toolsForRole(role: 'admin' | 'operator' | 'viewer') {
  return TOOLS.filter((t) => {
    if (!t.minRole) return true;
    if (t.minRole === 'admin') return role === 'admin';
    if (t.minRole === 'operator') return role === 'admin' || role === 'operator';
    return false;
  }).map(({ minRole: _, ...rest }) => rest);
}

// ────────────────────────────────────────────────────────────────────────────
// Admin API proxy
// ────────────────────────────────────────────────────────────────────────────

/**
 * Calls the in-VPC admin function as the MCP token's role.
 *
 * The event is shaped like the one API Gateway would have delivered, with the
 * claims the admin function's own middleware reads. That middleware resolves a
 * role from `cognito:groups` and refuses anyone holding none, so passing the
 * token's role there means the admin function applies exactly the same rules to
 * an MCP caller as to a console user — no second authorization model, and no
 * route that trusts this function more than it trusts a browser.
 *
 * `cognito:username` carries the token's name rather than a person's, so an
 * action taken through MCP is attributable to the credential that took it.
 */
async function adminCall(
  path: string,
  method: string,
  auth: { role: string; tokenName: string },
  body?: unknown
): Promise<unknown> {
  const [rawPath, rawQuery] = path.split('?');
  const query: Record<string, string> = {};
  if (rawQuery) {
    for (const [key, value] of new URLSearchParams(rawQuery)) query[key] = value;
  }

  const event = {
    version: '2.0',
    routeKey: `${method} ${rawPath}`,
    rawPath,
    rawQueryString: rawQuery ?? '',
    headers: { 'content-type': 'application/json' },
    ...(rawQuery ? { queryStringParameters: query } : {}),
    requestContext: {
      http: { method, path: rawPath, sourceIp: 'mcp', protocol: 'HTTP/1.1', userAgent: 'mcp-api' },
      authorizer: {
        jwt: {
          claims: {
            'cognito:groups': [auth.role],
            'cognito:username': `mcp:${auth.tokenName}`,
          },
          scopes: [],
        },
      },
      requestId: `mcp-${Date.now()}`,
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    isBase64Encoded: false,
  };

  const result = await lambda.send(
    new InvokeCommand({
      FunctionName: ADMIN_FUNCTION_NAME,
      Payload: Buffer.from(JSON.stringify(event)),
    })
  );

  if (result.FunctionError) {
    throw new Error(`The admin function failed: ${result.FunctionError}`);
  }

  const raw = result.Payload ? Buffer.from(result.Payload).toString('utf8') : '';
  const response = raw ? (JSON.parse(raw) as { statusCode?: number; body?: string }) : {};
  const parsed = response.body ? JSON.parse(response.body) : {};

  /**
   * A non-2xx is raised, not returned.
   *
   * The tool layer turns a thrown error into a JSON-RPC error the client can
   * show; returning the payload would hand the model a 403 body and let it
   * report it as data.
   */
  if ((response.statusCode ?? 500) >= 400) {
    const message =
      typeof parsed === 'object' && parsed !== null && 'message' in parsed
        ? String((parsed as { message: unknown }).message)
        : `request failed with ${response.statusCode}`;
    throw new Error(message);
  }

  return parsed;
}

// ────────────────────────────────────────────────────────────────────────────
// Tool executor
// ────────────────────────────────────────────────────────────────────────────

async function executeTool(
  name: string,
  args: Record<string, unknown>,
  auth: { role: string; tokenName: string },
  role: 'admin' | 'operator' | 'viewer'
): Promise<unknown> {
  const enc = (s: string) => encodeURIComponent(s);

  switch (name) {
    case 'list_microservices':
      return adminCall('/v1/admin/microservices', 'GET', auth);

    case 'get_microservice_status':
      return adminCall(`/v1/admin/microservices/${enc(String(args.name))}/status`, 'GET', auth);

    case 'get_microservice_logs': {
      const source = args.source === 'build' ? 'build' : 'container';
      const limit = args.limit ? Math.min(Math.trunc(Number(args.limit)), 500) : 100;
      return adminCall(
        `/v1/admin/microservices/${enc(String(args.name))}/logs?source=${source}&limit=${limit}`,
        'GET',
        auth
      );
    }

    case 'get_microservice_metrics':
      return adminCall(`/v1/admin/microservices/${enc(String(args.name))}/metrics`, 'GET', auth);

    case 'list_microservice_images':
      return adminCall(`/v1/admin/microservices/${enc(String(args.name))}/images`, 'GET', auth);

    case 'list_microservice_builds': {
      const limit = args.limit ? Math.min(Math.trunc(Number(args.limit)), 50) : 10;
      return adminCall(
        `/v1/admin/microservices/${enc(String(args.name))}/builds?limit=${limit}`,
        'GET',
        auth
      );
    }

    case 'list_alarms': {
      const qs = new URLSearchParams();
      if (args.state) qs.set('state', String(args.state));
      if (args.prefix) qs.set('prefix', String(args.prefix));
      const q = qs.toString();
      return adminCall(`/v1/admin/alarms${q ? `?${q}` : ''}`, 'GET', auth);
    }

    case 'get_clients_summary':
      return adminCall('/v1/admin/clients/summary', 'GET', auth);

    case 'list_sensors':
      return adminCall('/v1/admin/sensors', 'GET', auth);

    case 'restart_microservice':
      if (role !== 'admin') throw new Error('Admin role required to restart a microservice.');
      return adminCall(`/v1/admin/microservices/${enc(String(args.name))}/restart`, 'POST', auth);

    case 'rollback_microservice':
      if (role !== 'admin') throw new Error('Admin role required to roll back a microservice.');
      return adminCall(`/v1/admin/microservices/${enc(String(args.name))}/rollback`, 'POST', auth, {
        image_tag: String(args.image_tag),
      });

    case 'suppress_alarm':
      if (role !== 'admin') throw new Error('Admin role required to suppress an alarm.');
      return adminCall(`/v1/admin/alarms/${enc(String(args.name))}/suppress`, 'POST', auth);

    case 'unsuppress_alarm':
      if (role !== 'admin') throw new Error('Admin role required to unsuppress an alarm.');
      return adminCall(`/v1/admin/alarms/${enc(String(args.name))}/unsuppress`, 'POST', auth);

    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

// ────────────────────────────────────────────────────────────────────────────
// Handler
// ────────────────────────────────────────────────────────────────────────────

export async function handler(
  event: APIGatewayProxyEventV2WithLambdaAuthorizer<McpAuthContext>
): Promise<APIGatewayProxyResultV2> {
  /**
   * Streamable HTTP offers two optional extras this server does not implement.
   *
   * GET /mcp opens a server-initiated SSE stream and DELETE /mcp ends a
   * session; this server is stateless — one request per invocation — and has
   * neither. The spec says a server that does not offer them answers 405, and
   * the distinction matters to a client: 405 means "that feature is not on
   * offer", while the 404 an unrouted path produces means "wrong address", and
   * sends the client hunting for an endpoint that never existed.
   */
  const method = event.requestContext.http.method.toUpperCase();
  if (method !== 'POST') {
    return {
      statusCode: 405,
      headers: { 'content-type': 'application/json', allow: 'POST' },
      body: JSON.stringify(
        err(null, -32601, `${method} is not supported: this server is stateless and offers no SSE stream.`)
      ),
    };
  }

  /**
   * Who the caller is, according to the authorizer.
   *
   * The token itself never reaches this function — the authorizer compared it
   * and passed on what it resolved. That is deliberate: the one place a token's
   * plaintext is handled is the one that has to, and this function can be read
   * without wondering whether it leaks a credential into a log or a tool call.
   */
  const context = event.requestContext.authorizer?.lambda as Partial<McpAuthContext> | undefined;
  const role = roleFrom(context);
  const auth = { role, tokenName: context?.tokenName ?? 'unknown' };
  const tools = toolsForRole(role);

  let body: JsonRpcRequest | JsonRpcRequest[];
  try {
    body = JSON.parse(event.body ?? '{}') as JsonRpcRequest | JsonRpcRequest[];
  } catch {
    return reply(400, err(null, -32700, 'Parse error'));
  }

  const requests = Array.isArray(body) ? body : [body];
  const responses: unknown[] = [];

  for (const req of requests) {
    // Notifications have no id and expect no response.
    if (req.method?.startsWith('notifications/')) continue;

    switch (req.method) {
      case 'initialize':
        responses.push(
          ok(req.id, {
            protocolVersion: '2024-11-05',
            serverInfo: { name: 'msight-cloud', version: '1.0.0' },
            capabilities: { tools: {} },
          })
        );
        break;

      case 'tools/list':
        responses.push(ok(req.id, { tools }));
        break;

      case 'tools/call': {
        const params = req.params as { name?: string; arguments?: Record<string, unknown> } | undefined;
        const toolName = params?.name;
        const toolArgs = params?.arguments ?? {};

        if (!toolName) {
          responses.push(err(req.id, -32602, 'Missing tool name'));
          break;
        }

        if (!tools.find((t) => t.name === toolName)) {
          responses.push(err(req.id, -32602, `Tool not found or not available for your role: ${toolName}`));
          break;
        }

        try {
          const result = await executeTool(toolName, toolArgs, auth, role);
          responses.push(
            ok(req.id, {
              content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
            })
          );
        } catch (error) {
          responses.push(err(req.id, -32603, error instanceof Error ? error.message : String(error)));
        }
        break;
      }

      default:
        responses.push(err(req.id, -32601, `Method not found: ${req.method}`));
    }
  }

  // Notifications-only batch → 202 with no body.
  if (responses.length === 0) {
    return { statusCode: 202, body: '' };
  }

  const responseBody = Array.isArray(body) ? responses : responses[0];
  return reply(200, responseBody);
}

function reply(statusCode: number, body: unknown): APIGatewayProxyResultV2 {
  return {
    statusCode,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  };
}

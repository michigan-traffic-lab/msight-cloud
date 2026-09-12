/**
 * MCP (Model Context Protocol) server — Streamable HTTP transport.
 *
 * Implements the JSON-RPC 2.0 message layer of the MCP 2024-11-05 spec. Each
 * Lambda invocation handles one POST /mcp request, which is the stateless
 * model Streamable HTTP is designed for.
 *
 * Auth is handled by the API Gateway Cognito JWT authorizer before this
 * function runs. The original Authorization header is forwarded through, so
 * tool calls can forward it to the admin API without re-signing or re-minting.
 *
 * Read tools are available to any signed-in user. Write tools (restart,
 * rollback, suppress) require the admin role, checked by reading the claims
 * API Gateway already validated.
 */

import type { APIGatewayProxyEventV2WithJWTAuthorizer, APIGatewayProxyResultV2 } from 'aws-lambda';

const ADMIN_API_URL = process.env.ADMIN_API_URL!;

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

function roleFrom(claims: Record<string, unknown>): 'admin' | 'operator' | 'viewer' {
  const raw = claims['cognito:groups'];
  const groups: string[] = Array.isArray(raw)
    ? (raw as string[])
    : typeof raw === 'string'
      ? raw.split(',')
      : [];
  if (groups.includes('admin')) return 'admin';
  if (groups.includes('operator')) return 'operator';
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

async function adminFetch(path: string, method: string, token: string, body?: unknown): Promise<unknown> {
  const response = await fetch(`${ADMIN_API_URL}${path}`, {
    method,
    headers: {
      authorization: token,
      ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  const text = await response.text();
  return text ? JSON.parse(text) : {};
}

// ────────────────────────────────────────────────────────────────────────────
// Tool executor
// ────────────────────────────────────────────────────────────────────────────

async function executeTool(
  name: string,
  args: Record<string, unknown>,
  token: string,
  role: 'admin' | 'operator' | 'viewer'
): Promise<unknown> {
  const enc = (s: string) => encodeURIComponent(s);

  switch (name) {
    case 'list_microservices':
      return adminFetch('/v1/admin/microservices', 'GET', token);

    case 'get_microservice_status':
      return adminFetch(`/v1/admin/microservices/${enc(String(args.name))}/status`, 'GET', token);

    case 'get_microservice_logs': {
      const source = args.source === 'build' ? 'build' : 'container';
      const limit = args.limit ? Math.min(Math.trunc(Number(args.limit)), 500) : 100;
      return adminFetch(
        `/v1/admin/microservices/${enc(String(args.name))}/logs?source=${source}&limit=${limit}`,
        'GET',
        token
      );
    }

    case 'get_microservice_metrics':
      return adminFetch(`/v1/admin/microservices/${enc(String(args.name))}/metrics`, 'GET', token);

    case 'list_microservice_images':
      return adminFetch(`/v1/admin/microservices/${enc(String(args.name))}/images`, 'GET', token);

    case 'list_microservice_builds': {
      const limit = args.limit ? Math.min(Math.trunc(Number(args.limit)), 50) : 10;
      return adminFetch(
        `/v1/admin/microservices/${enc(String(args.name))}/builds?limit=${limit}`,
        'GET',
        token
      );
    }

    case 'list_alarms': {
      const qs = new URLSearchParams();
      if (args.state) qs.set('state', String(args.state));
      if (args.prefix) qs.set('prefix', String(args.prefix));
      const q = qs.toString();
      return adminFetch(`/v1/admin/alarms${q ? `?${q}` : ''}`, 'GET', token);
    }

    case 'get_clients_summary':
      return adminFetch('/v1/admin/clients/summary', 'GET', token);

    case 'list_sensors':
      return adminFetch('/v1/admin/sensors', 'GET', token);

    case 'restart_microservice':
      if (role !== 'admin') throw new Error('Admin role required to restart a microservice.');
      return adminFetch(`/v1/admin/microservices/${enc(String(args.name))}/restart`, 'POST', token);

    case 'rollback_microservice':
      if (role !== 'admin') throw new Error('Admin role required to roll back a microservice.');
      return adminFetch(`/v1/admin/microservices/${enc(String(args.name))}/rollback`, 'POST', token, {
        image_tag: String(args.image_tag),
      });

    case 'suppress_alarm':
      if (role !== 'admin') throw new Error('Admin role required to suppress an alarm.');
      return adminFetch(`/v1/admin/alarms/${enc(String(args.name))}/suppress`, 'POST', token);

    case 'unsuppress_alarm':
      if (role !== 'admin') throw new Error('Admin role required to unsuppress an alarm.');
      return adminFetch(`/v1/admin/alarms/${enc(String(args.name))}/unsuppress`, 'POST', token);

    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

// ────────────────────────────────────────────────────────────────────────────
// Handler
// ────────────────────────────────────────────────────────────────────────────

export async function handler(
  event: APIGatewayProxyEventV2WithJWTAuthorizer
): Promise<APIGatewayProxyResultV2> {
  const claims = event.requestContext.authorizer.jwt.claims as Record<string, unknown>;
  const role = roleFrom(claims);
  const token =
    event.headers['authorization'] ?? event.headers['Authorization'] ?? '';
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
          const result = await executeTool(toolName, toolArgs, token, role);
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

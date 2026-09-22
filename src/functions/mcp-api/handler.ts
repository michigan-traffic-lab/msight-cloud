/**
 * MCP (Model Context Protocol) server — Streamable HTTP transport.
 *
 * Implements JSON-RPC 2.0 over the MCP 2024-11-05 spec. Each Lambda invocation
 * handles one POST /mcp request.
 *
 * Auth happens in a Lambda authorizer that validates an X-Msight-Token header
 * against the table that issued it. Authorization is NOT used: mcp-remote
 * overwrites that header with its own OAuth challenge on every request.
 *
 * Two Lambda targets are invoked directly (no HTTP round-trip through the API):
 *   - admin-vpc-api  → routes under VPC_ROUTE_PREFIXES (Aurora, Valkey, clients,
 *                       clusters, sensors, apps, storages, maps, microservices,
 *                       alarms, mcp-tokens, github)
 *   - admin-api      → cost, logs, users, network, system/me, identity
 *
 * Invoking directly means the caller's MCP token (not a Cognito JWT) never has
 * to satisfy the HTTP API's JWT authorizer. The role the MCP authorizer resolved
 * is injected into the synthetic event's claims slot so the admin function's own
 * middleware sees it as a normal Cognito role.
 */

import { InvokeCommand, LambdaClient } from '@aws-sdk/client-lambda';
import type {
  APIGatewayProxyEventV2WithLambdaAuthorizer,
  APIGatewayProxyResultV2,
} from 'aws-lambda';

const ADMIN_VPC_FUNCTION = process.env.ADMIN_VPC_API_FUNCTION_NAME!;
const ADMIN_API_FUNCTION = process.env.ADMIN_API_FUNCTION_NAME!;

const lambdaClient = new LambdaClient({});

interface McpAuthContext {
  role: string;
  tokenName: string;
  createdBy: string;
}

// ────────────────────────────────────────────────────────────────────────────
// JSON-RPC helpers
// ────────────────────────────────────────────────────────────────────────────

interface JsonRpcRequest {
  jsonrpc: '2.0';
  id?: string | number | null;
  method: string;
  params?: Record<string, unknown>;
}

const ok = (id: string | number | null | undefined, result: unknown) =>
  ({ jsonrpc: '2.0', id: id ?? null, result });

const err = (id: string | number | null | undefined, code: number, message: string) =>
  ({ jsonrpc: '2.0', id: id ?? null, error: { code, message } });

// ────────────────────────────────────────────────────────────────────────────
// Role helpers
// ────────────────────────────────────────────────────────────────────────────

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
  // ── System ────────────────────────────────────────────────────────────────
  {
    name: 'get_system_info',
    description: 'Stack build info: deployment name, version, and environment URLs, including the admin console (dashboard) URL.',
    inputSchema: { type: 'object', properties: {} },
  },

  // ── Microservices — reads ─────────────────────────────────────────────────
  {
    name: 'list_microservices',
    description: 'List all microservices with provision, build, and launch state.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'get_microservice_status',
    description: 'Full status of one microservice: ECS counts, image, log summary, and staleness.',
    inputSchema: {
      type: 'object',
      properties: { name: { type: 'string' } },
      required: ['name'],
    },
    minRole: 'operator',
  },
  {
    name: 'get_microservice_events',
    description: 'Audit trail for a microservice — builds, deploys, restarts, and config changes, newest first.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string' },
        limit: { type: 'number', description: 'Default 20, max 100' },
      },
      required: ['name'],
    },
    minRole: 'operator',
  },
  {
    name: 'get_microservice_logs',
    description: "Recent log output. source='container' (default) or 'build'.",
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string' },
        source: { type: 'string', enum: ['container', 'build'] },
        limit: { type: 'number', description: 'Default 100, max 500' },
      },
      required: ['name'],
    },
    minRole: 'operator',
  },
  {
    name: 'get_microservice_metrics',
    description: 'CPU, memory utilization, and task counts over the last 3 hours.',
    inputSchema: {
      type: 'object',
      properties: { name: { type: 'string' } },
      required: ['name'],
    },
    minRole: 'operator',
  },
  {
    name: 'list_microservice_images',
    description: 'Available ECR image tags, newest first. Use before rolling back.',
    inputSchema: {
      type: 'object',
      properties: { name: { type: 'string' } },
      required: ['name'],
    },
    minRole: 'operator',
  },
  {
    name: 'list_microservice_builds',
    description: 'CodeBuild history — status, duration, commit SHA, and log location.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string' },
        limit: { type: 'number', description: 'Default 10, max 50' },
      },
      required: ['name'],
    },
    minRole: 'operator',
  },

  // ── Microservices — mutations ─────────────────────────────────────────────
  {
    name: 'create_microservice',
    description: 'Register a new microservice. Requires a GitHub installation and repository.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Unique service name (slug)' },
        display_name: { type: 'string' },
        installation_id: { type: 'number', description: 'GitHub App installation ID (from list_github_installations)' },
        repo_full_name: { type: 'string', description: 'e.g. "org/repo"' },
        cluster_name: { type: 'string', description: 'Compute cluster to run on (from list_clusters)' },
        branch: { type: 'string', description: 'Git branch to build from' },
        dockerfile_path: { type: 'string', description: 'Path to Dockerfile in the repo' },
        build_context: { type: 'string', description: 'Docker build context path (default ".")' },
        cpu: { type: 'number', description: 'Fargate CPU units: 256, 512, 1024, 2048, 4096, 8192, or 16384' },
        memory: { type: 'number', description: 'Memory in MiB (512–122880)' },
        desired_count: { type: 'number', description: 'Initial task count (default 1)' },
        container_port: { type: 'number', description: 'Port the container listens on (optional)' },
      },
      required: ['name', 'installation_id', 'repo_full_name', 'cluster_name', 'branch', 'dockerfile_path', 'cpu', 'memory'],
    },
    minRole: 'admin',
  },
  {
    name: 'update_microservice',
    description: 'Update a microservice config (branch, resource sizes, scaling, etc.).',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string' },
        display_name: { type: 'string' },
        branch: { type: 'string' },
        dockerfile_path: { type: 'string' },
        build_context: { type: 'string' },
        cpu: { type: 'number' },
        memory: { type: 'number' },
        desired_count: { type: 'number' },
        container_port: { type: 'number' },
        auto_deploy: { type: 'boolean', description: 'Deploy automatically on push' },
        scaling: {
          type: 'object',
          description: 'Auto-scaling policy',
          properties: {
            mode: { type: 'string', enum: ['fixed', 'auto'] },
            min_tasks: { type: 'number' },
            max_tasks: { type: 'number' },
            metric: { type: 'string', enum: ['cpu', 'memory'] },
            target: { type: 'number', description: 'Target utilization %' },
          },
        },
      },
      required: ['name'],
    },
    minRole: 'admin',
  },
  {
    name: 'build_microservice',
    description: 'Trigger a CodeBuild image build from the configured branch.',
    inputSchema: {
      type: 'object',
      properties: { name: { type: 'string' } },
      required: ['name'],
    },
    minRole: 'admin',
  },
  {
    name: 'stop_build',
    description: 'Cancel a currently running CodeBuild build.',
    inputSchema: {
      type: 'object',
      properties: { name: { type: 'string' } },
      required: ['name'],
    },
    minRole: 'admin',
  },
  {
    name: 'deploy_microservice',
    description: 'Deploy the most recently built image to ECS (does not rebuild).',
    inputSchema: {
      type: 'object',
      properties: { name: { type: 'string' } },
      required: ['name'],
    },
    minRole: 'admin',
  },
  {
    name: 'restart_microservice',
    description: 'Rolling restart — replaces running tasks one by one with no downtime.',
    inputSchema: {
      type: 'object',
      properties: { name: { type: 'string' } },
      required: ['name'],
    },
    minRole: 'admin',
  },
  {
    name: 'rollback_microservice',
    description: 'Deploy a specific previously-built image tag. Use list_microservice_images to find tags.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string' },
        image_tag: { type: 'string' },
      },
      required: ['name', 'image_tag'],
    },
    minRole: 'admin',
  },
  {
    name: 'delete_microservice',
    description: 'Full teardown: deprovisions ECS, deletes cluster and registry row. Irreversible.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string' },
        delete_images: { type: 'boolean', description: 'Also delete ECR images (default false)' },
        delete_logs: { type: 'boolean', description: 'Also delete CloudWatch logs (default false)' },
      },
      required: ['name'],
    },
    minRole: 'admin',
  },

  // ── Sensors ───────────────────────────────────────────────────────────────
  {
    name: 'list_sensors',
    description: 'All sensors with queue depth, consumer status, and streaming health.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'create_sensor',
    description: 'Register a new sensor and provision its ingest infrastructure.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Unique sensor name (2–64 chars)' },
        display_name: { type: 'string' },
        stream_enabled: { type: 'boolean', description: 'Enable live streaming queue (default true)' },
        archive_enabled: { type: 'boolean', description: 'Enable S3 archival' },
        storage_bucket: { type: 'string', description: 'Bucket name if archive_enabled' },
        storage_prefix: { type: 'string', description: 'Key prefix for archived data' },
      },
      required: ['name'],
    },
    minRole: 'admin',
  },
  {
    name: 'set_sensor_enabled',
    description: 'Enable or disable a sensor and reconcile its infrastructure.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string' },
        enabled: { type: 'boolean' },
      },
      required: ['name', 'enabled'],
    },
    minRole: 'admin',
  },
  {
    name: 'update_sensor_ingest',
    description: 'Change a sensor\'s streaming and archive settings.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string' },
        stream_enabled: { type: 'boolean' },
        archive_enabled: { type: 'boolean' },
        storage_bucket: { type: 'string' },
        storage_prefix: { type: 'string' },
      },
      required: ['name'],
    },
    minRole: 'admin',
  },
  {
    name: 'delete_sensor',
    description: 'Remove a sensor and tear down its queue, subscription, and Fargate consumer.',
    inputSchema: {
      type: 'object',
      properties: { name: { type: 'string' } },
      required: ['name'],
    },
    minRole: 'admin',
  },
  {
    name: 'reconcile_sensors',
    description: 'Reconcile all sensor infrastructure — use to fix drift or retry a partial failure.',
    inputSchema: { type: 'object', properties: {} },
    minRole: 'admin',
  },

  // ── Apps ──────────────────────────────────────────────────────────────────
  {
    name: 'list_apps',
    description: 'All consumer apps and their subscription flags (SDSM, SPaT, critical SPaT).',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'create_app',
    description: 'Register a consumer app.',
    inputSchema: {
      type: 'object',
      properties: {
        app_id: { type: 'string', description: 'Unique app identifier' },
        display_name: { type: 'string' },
        receive_sdsm: { type: 'boolean' },
        receive_spat: { type: 'boolean' },
        receive_critical_spat: { type: 'boolean' },
      },
      required: ['app_id', 'display_name'],
    },
    minRole: 'admin',
  },
  {
    name: 'update_app',
    description: 'Update an app\'s display name or subscription flags.',
    inputSchema: {
      type: 'object',
      properties: {
        app_id: { type: 'string' },
        display_name: { type: 'string' },
        receive_sdsm: { type: 'boolean' },
        receive_spat: { type: 'boolean' },
        receive_critical_spat: { type: 'boolean' },
      },
      required: ['app_id'],
    },
    minRole: 'admin',
  },
  {
    name: 'delete_app',
    description: 'Remove an app from the registry.',
    inputSchema: {
      type: 'object',
      properties: { app_id: { type: 'string' } },
      required: ['app_id'],
    },
    minRole: 'admin',
  },

  // ── Alarms ────────────────────────────────────────────────────────────────
  {
    name: 'list_alarms',
    description: 'CloudWatch alarms, filterable by state or name prefix.',
    inputSchema: {
      type: 'object',
      properties: {
        state: { type: 'string', enum: ['OK', 'ALARM', 'INSUFFICIENT_DATA'] },
        prefix: { type: 'string' },
      },
    },
  },
  {
    name: 'suppress_alarm',
    description: 'Disable actions on a CloudWatch alarm (silences pages without deleting it).',
    inputSchema: {
      type: 'object',
      properties: { name: { type: 'string', description: 'Exact alarm name' } },
      required: ['name'],
    },
    minRole: 'admin',
  },
  {
    name: 'unsuppress_alarm',
    description: 'Re-enable actions on a suppressed CloudWatch alarm.',
    inputSchema: {
      type: 'object',
      properties: { name: { type: 'string' } },
      required: ['name'],
    },
    minRole: 'admin',
  },

  // ── Clients ───────────────────────────────────────────────────────────────
  {
    name: 'get_clients_summary',
    description: 'Count of connected WebSocket clients broken down by app.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'list_clients',
    description: 'Page through connected WebSocket clients, optionally filtered by app.',
    inputSchema: {
      type: 'object',
      properties: {
        app_id: { type: 'string' },
        limit: { type: 'number', description: 'Default 20, max 100' },
      },
    },
  },
  {
    name: 'lookup_client',
    description: 'Look up one connected client by app and client ID.',
    inputSchema: {
      type: 'object',
      properties: {
        app_id: { type: 'string' },
        client_id: { type: 'string' },
      },
      required: ['app_id', 'client_id'],
    },
  },

  // ── Storage ───────────────────────────────────────────────────────────────
  {
    name: 'list_storages',
    description: 'Registered S3 storage buckets and their cost-tracking status.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'list_storage_objects',
    description: 'Browse objects in a registered S3 bucket.',
    inputSchema: {
      type: 'object',
      properties: {
        bucket: { type: 'string' },
        prefix: { type: 'string' },
        limit: { type: 'number', description: 'Default 50, max 200' },
      },
      required: ['bucket'],
    },
  },
  {
    name: 'register_storage',
    description: 'Register an S3 bucket with this deployment.',
    inputSchema: {
      type: 'object',
      properties: {
        bucket: { type: 'string', description: 'Bucket name' },
        display_name: { type: 'string' },
        create: { type: 'boolean', description: 'Create the bucket if it does not exist (default false = adopt existing)' },
        cost_tracked: { type: 'boolean', description: 'Include in cost reports' },
      },
      required: ['bucket', 'display_name'],
    },
    minRole: 'admin',
  },
  {
    name: 'update_storage',
    description: 'Update a storage bucket registration.',
    inputSchema: {
      type: 'object',
      properties: {
        bucket: { type: 'string' },
        display_name: { type: 'string' },
        cost_tracked: { type: 'boolean' },
      },
      required: ['bucket'],
    },
    minRole: 'admin',
  },
  {
    name: 'unregister_storage',
    description: 'Remove a bucket from the registry (bucket and contents are not deleted).',
    inputSchema: {
      type: 'object',
      properties: { bucket: { type: 'string' } },
      required: ['bucket'],
    },
    minRole: 'admin',
  },

  // ── Clusters ──────────────────────────────────────────────────────────────
  {
    name: 'list_clusters',
    description: 'All compute clusters (ECS capacity behind each microservice).',
    inputSchema: { type: 'object', properties: {} },
    minRole: 'operator',
  },
  {
    name: 'get_cluster_health',
    description: 'Live ECS health for a cluster: container instances, GPU visibility, and running tasks.',
    inputSchema: {
      type: 'object',
      properties: { name: { type: 'string' } },
      required: ['name'],
    },
    minRole: 'operator',
  },
  {
    name: 'provision_cluster',
    description: 'Provision the AWS ECS cluster and ASG (or Fargate capacity) behind a cluster record.',
    inputSchema: {
      type: 'object',
      properties: { name: { type: 'string' } },
      required: ['name'],
    },
    minRole: 'admin',
  },
  {
    name: 'deprovision_cluster',
    description: 'Tear down the AWS resources behind a cluster (ECS cluster, ASG, launch template).',
    inputSchema: {
      type: 'object',
      properties: { name: { type: 'string' } },
      required: ['name'],
    },
    minRole: 'admin',
  },

  // ── Valkey (cache) ────────────────────────────────────────────────────────
  {
    name: 'get_valkey_overview',
    description: 'Valkey server info, memory stats, and key-space summary.',
    inputSchema: { type: 'object', properties: {} },
    minRole: 'operator',
  },
  {
    name: 'get_valkey_key',
    description: 'Inspect a single Valkey key: type, TTL, and value.',
    inputSchema: {
      type: 'object',
      properties: { key: { type: 'string' } },
      required: ['key'],
    },
    minRole: 'operator',
  },
  {
    name: 'delete_valkey_key',
    description: 'Delete a Valkey key.',
    inputSchema: {
      type: 'object',
      properties: { key: { type: 'string' } },
      required: ['key'],
    },
    minRole: 'admin',
  },

  // ── Aurora ────────────────────────────────────────────────────────────────
  {
    name: 'list_aurora_tables',
    description: 'List the Aurora tables that can be browsed or queried.',
    inputSchema: { type: 'object', properties: {} },
    minRole: 'operator',
  },
  {
    name: 'query_aurora',
    description: 'Run a read-only SQL SELECT against Aurora (max 200 rows).',
    inputSchema: {
      type: 'object',
      properties: {
        sql: { type: 'string', description: 'A SELECT statement — writes are refused' },
        limit: { type: 'number', description: 'Row limit (default 50, max 200)' },
      },
      required: ['sql'],
    },
    minRole: 'operator',
  },

  // ── Maps ──────────────────────────────────────────────────────────────────
  {
    name: 'list_maps',
    description: 'Intersection MAP records with geometry validation status.',
    inputSchema: { type: 'object', properties: {} },
    minRole: 'operator',
  },
  {
    name: 'get_map',
    description: 'One MAP record by name, including validation findings.',
    inputSchema: {
      type: 'object',
      properties: { name: { type: 'string' } },
      required: ['name'],
    },
    minRole: 'operator',
  },

  // ── GitHub ────────────────────────────────────────────────────────────────
  {
    name: 'get_github_app',
    description: 'Current GitHub App registration status.',
    inputSchema: { type: 'object', properties: {} },
    minRole: 'operator',
  },
  {
    name: 'list_github_installations',
    description: 'GitHub App installations and the repositories accessible under each.',
    inputSchema: { type: 'object', properties: {} },
    minRole: 'operator',
  },

  // ── Logs ──────────────────────────────────────────────────────────────────
  {
    name: 'query_logs',
    description:
      'Run a CloudWatch Insights query and wait for results (up to ~16 s). ' +
      'For quick tailing use get_microservice_logs. For structured search use this.',
    inputSchema: {
      type: 'object',
      properties: {
        groups: { type: 'array', items: { type: 'string' }, description: 'Log group names' },
        query: { type: 'string', description: 'CloudWatch Insights query string' },
        start: { type: 'string', description: 'ISO 8601 start time (default: 1 hour ago)' },
        end: { type: 'string', description: 'ISO 8601 end time (default: now)' },
        limit: { type: 'number', description: 'Max results (default 100, max 500)' },
      },
      required: ['groups', 'query'],
    },
    minRole: 'operator',
  },

  // ── Network ───────────────────────────────────────────────────────────────
  {
    name: 'get_network_topology',
    description: 'VPC topology: subnets, routing, security groups, endpoints, NAT gateway.',
    inputSchema: { type: 'object', properties: {} },
    minRole: 'operator',
  },

  // ── Users ─────────────────────────────────────────────────────────────────
  {
    name: 'list_users',
    description: 'All admin console users with roles and enabled status.',
    inputSchema: { type: 'object', properties: {} },
    minRole: 'admin',
  },
  {
    name: 'create_user',
    description: 'Create a new admin console user.',
    inputSchema: {
      type: 'object',
      properties: {
        username: { type: 'string' },
        email: { type: 'string' },
        role: { type: 'string', enum: ['viewer', 'operator', 'admin'] },
        temporary_password: { type: 'string', description: 'Must meet Cognito password policy' },
      },
      required: ['username', 'email', 'role', 'temporary_password'],
    },
    minRole: 'admin',
  },
  {
    name: 'set_user_role',
    description: 'Change a user\'s role. Cannot promote above your own role.',
    inputSchema: {
      type: 'object',
      properties: {
        username: { type: 'string' },
        role: { type: 'string', enum: ['viewer', 'operator', 'admin'] },
      },
      required: ['username', 'role'],
    },
    minRole: 'admin',
  },
  {
    name: 'set_user_enabled',
    description: 'Enable or disable a console user. Cannot disable yourself.',
    inputSchema: {
      type: 'object',
      properties: {
        username: { type: 'string' },
        enabled: { type: 'boolean' },
      },
      required: ['username', 'enabled'],
    },
    minRole: 'admin',
  },
  {
    name: 'delete_user',
    description: 'Delete a console user. Cannot delete yourself.',
    inputSchema: {
      type: 'object',
      properties: { username: { type: 'string' } },
      required: ['username'],
    },
    minRole: 'admin',
  },

  // ── Cost ──────────────────────────────────────────────────────────────────
  {
    name: 'get_cost_summary',
    description: 'Tagged AWS spend for this deployment, broken down by service.',
    inputSchema: {
      type: 'object',
      properties: {
        start: { type: 'string', description: 'ISO 8601 date (default: start of current month)' },
        end: { type: 'string', description: 'ISO 8601 date (default: today)' },
      },
    },
    minRole: 'admin',
  },

  // ── Microservice lifecycle ────────────────────────────────────────────────
  //
  // `launch_microservice` is the one that matters. Creating a service and then
  // building and deploying it are three separate tools above, which mirrors
  // how the console used to work and not how it works now: launch does the
  // whole sequence, tolerates every step having already been done, and is what
  // the console's own primary button calls. Without it an assistant has to
  // reproduce the sequence by hand and gets the order wrong.
  {
    name: 'launch_microservice',
    description:
      'Bring a microservice up end to end: create its cluster and scaffolding, build the ' +
      'image from the tracked branch, and deploy when the build lands. Idempotent — safe to ' +
      'call on a service that is already up, where it rebuilds and redeploys instead.',
    inputSchema: {
      type: 'object',
      properties: { name: { type: 'string' } },
      required: ['name'],
    },
    minRole: 'admin',
  },
  {
    name: 'dismiss_launch',
    description:
      'Stop waiting on a launch that failed, without touching anything AWS has. Clears the ' +
      'banner only; the service is left exactly as the failure left it.',
    inputSchema: {
      type: 'object',
      properties: { name: { type: 'string' } },
      required: ['name'],
    },
    minRole: 'operator',
  },
  {
    name: 'check_microservice_source',
    description:
      'Re-read the repository: confirm the branch exists, the Dockerfile is where it should ' +
      'be, and record the branch head. Reports a bad result rather than failing on it.',
    inputSchema: {
      type: 'object',
      properties: { name: { type: 'string' } },
      required: ['name'],
    },
    minRole: 'operator',
  },
  {
    name: 'provision_microservice',
    description:
      'Create only the scaffolding — image repository, log groups, build project — without ' +
      'building or deploying. Usually a step of launch_microservice rather than a thing to ' +
      'call on its own.',
    inputSchema: {
      type: 'object',
      properties: { name: { type: 'string' } },
      required: ['name'],
    },
    minRole: 'admin',
  },
  {
    name: 'deprovision_microservice',
    description:
      'Take the AWS resources down but keep the registry row, so the service can be launched ' +
      'again later. Images and logs are kept unless asked for.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string' },
        delete_images: { type: 'boolean', description: 'Also delete ECR images (default false)' },
        delete_logs: { type: 'boolean', description: 'Also delete log groups (default false)' },
      },
      required: ['name'],
    },
    minRole: 'admin',
  },
  {
    name: 'set_log_retention',
    description:
      "How long a microservice's container and build logs are kept. Null never expires, which " +
      'bills forever.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string' },
        days: {
          type: ['number', 'null'],
          description: 'Retention in days, or null to keep forever',
        },
      },
      required: ['name', 'days'],
    },
    minRole: 'operator',
  },
  {
    name: 'clear_microservice_logs',
    description:
      "Delete and recreate a microservice's log groups, discarding everything in them. " +
      'Irreversible, and the usual reason to want it is storage cost.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string' },
        source: { type: 'string', enum: ['container', 'build', 'both'] },
      },
      required: ['name'],
    },
    minRole: 'operator',
  },

  // ── Clusters — the half that was missing ──────────────────────────────────
  //
  // provision and deprovision were already here; creating, resizing and
  // deleting a cluster were not, so an assistant could turn capacity on and off
  // but never change what the capacity is.
  {
    name: 'create_cluster',
    description:
      'Create a compute cluster. A cluster carries exactly one microservice, so this is only ' +
      'for the recovery case of a service whose cluster was deleted — new services get one ' +
      'automatically.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string' },
        display_name: { type: 'string' },
        capacity_type: { type: 'string', enum: ['fargate', 'ec2'] },
        instance_type: { type: 'string', description: 'EC2 only, e.g. g5.xlarge' },
        scaling_mode: { type: 'string', enum: ['fixed', 'auto'] },
        min_instances: { type: 'number' },
        max_instances: { type: 'number' },
        target_capacity: { type: 'number' },
        gpu_mode: { type: 'string', enum: ['none', 'exclusive', 'shared'] },
      },
      required: ['name', 'capacity_type'],
    },
    minRole: 'admin',
  },
  {
    name: 'update_cluster',
    description:
      'Change a cluster\'s capacity. On EC2 this replaces instances, so it is a restart of ' +
      'whatever runs there rather than a setting change.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string' },
        display_name: { type: 'string' },
        instance_type: { type: 'string' },
        scaling_mode: { type: 'string', enum: ['fixed', 'auto'] },
        min_instances: { type: 'number' },
        max_instances: { type: 'number' },
        target_capacity: { type: 'number' },
        gpu_mode: { type: 'string', enum: ['none', 'exclusive', 'shared'] },
      },
      required: ['name'],
    },
    minRole: 'admin',
  },
  {
    name: 'delete_cluster',
    description:
      'Remove a cluster from the registry. Refused while a microservice still names it.',
    inputSchema: {
      type: 'object',
      properties: { name: { type: 'string' } },
      required: ['name'],
    },
    minRole: 'admin',
  },

  // ── Logs ──────────────────────────────────────────────────────────────────
  {
    name: 'list_log_groups',
    description:
      'Every log group in the deployment, with its stored size and retention, and whether ' +
      'anything still writes to it. query_logs needs these names, so this is what makes that ' +
      'tool usable without guessing.',
    inputSchema: { type: 'object', properties: {} },
    minRole: 'operator',
  },

  // ── Storage ───────────────────────────────────────────────────────────────
  {
    name: 'list_available_storages',
    description:
      'Buckets in the account that are not registered with this deployment — the candidates ' +
      'for register_storage.',
    inputSchema: { type: 'object', properties: {} },
    minRole: 'admin',
  },
  {
    name: 'reconcile_storages',
    description:
      'Re-apply the notification configuration on every registered bucket, so a bucket edited ' +
      'outside this console is put back the way the registry says.',
    inputSchema: { type: 'object', properties: {} },
    minRole: 'admin',
  },

  // ── Aurora rows ───────────────────────────────────────────────────────────
  {
    name: 'list_aurora_rows',
    description:
      'Read a page of rows from one table. Keyset paginated — pass the cursor from the ' +
      'previous page rather than an offset.',
    inputSchema: {
      type: 'object',
      properties: {
        table: { type: 'string' },
        cursor: { type: 'string', description: 'next_cursor from the previous page' },
        limit: { type: 'number', description: 'Default 50, max 200' },
      },
      required: ['table'],
    },
    minRole: 'operator',
  },
  {
    name: 'update_aurora_row',
    description:
      'Change fields on one row, addressed by its primary key. These tables drive live ' +
      'behaviour and the change takes effect immediately.',
    inputSchema: {
      type: 'object',
      properties: {
        table: { type: 'string' },
        pk: { type: 'string', description: "The row's primary key value" },
        values: { type: 'object', description: 'Column name to new value' },
      },
      required: ['table', 'pk', 'values'],
    },
    minRole: 'admin',
  },
  {
    name: 'delete_aurora_row',
    description: 'Delete one row by primary key. Irreversible, and only on deletable tables.',
    inputSchema: {
      type: 'object',
      properties: {
        table: { type: 'string' },
        pk: { type: 'string' },
      },
      required: ['table', 'pk'],
    },
    minRole: 'admin',
  },

  // ── Valkey writes ─────────────────────────────────────────────────────────
  //
  // delete_valkey_key was already exposed, so withholding the setters made the
  // destructive half of the surface available and the repairable half not.
  {
    name: 'set_valkey_value',
    description:
      'Set a key\'s string value, optionally with a TTL. This cache is on the live SPaT ' +
      'broadcast path — the change takes effect immediately.',
    inputSchema: {
      type: 'object',
      properties: {
        key: { type: 'string', description: 'Fully qualified key; no patterns' },
        value: { type: 'string' },
        ttl_seconds: { type: ['number', 'null'] },
      },
      required: ['key', 'value'],
    },
    minRole: 'admin',
  },
  {
    name: 'set_valkey_field',
    description: "Set one field of a hash key, leaving the rest of the hash alone.",
    inputSchema: {
      type: 'object',
      properties: {
        key: { type: 'string' },
        field: { type: 'string' },
        value: { type: 'string' },
      },
      required: ['key', 'field', 'value'],
    },
    minRole: 'admin',
  },
  {
    name: 'set_valkey_ttl',
    description: "Change a key's expiry, or remove it entirely with null.",
    inputSchema: {
      type: 'object',
      properties: {
        key: { type: 'string' },
        ttl_seconds: { type: ['number', 'null'] },
      },
      required: ['key', 'ttl_seconds'],
    },
    minRole: 'admin',
  },

  // ── Cost ──────────────────────────────────────────────────────────────────
  {
    name: 'get_cost_by_service',
    description:
      'Spend broken down by AWS service over a period, for the deployment\'s own cost tag.',
    inputSchema: {
      type: 'object',
      properties: {
        start: { type: 'string', description: 'ISO 8601 date' },
        end: { type: 'string', description: 'ISO 8601 date' },
      },
    },
    minRole: 'admin',
  },

  // ── Clients ───────────────────────────────────────────────────────────────
  {
    name: 'search_clients_nearby',
    description:
      'Connected clients within a radius of a point. The geospatial question the console\'s ' +
      'map answers — "who is near this intersection right now".',
    inputSchema: {
      type: 'object',
      properties: {
        app_id: { type: 'string' },
        lat: { type: 'number' },
        lon: { type: 'number' },
        radius_m: { type: 'number', description: 'Radius in metres' },
        limit: { type: 'number' },
      },
      required: ['lat', 'lon', 'radius_m'],
    },
    minRole: 'operator',
  },

  // ── Identity ──────────────────────────────────────────────────────────────
  {
    name: 'whoami',
    description:
      'Who this token acts as and what role it carries. Worth calling first when a tool is ' +
      'refused: the answer is usually that the token holds less than the tool needs.',
    inputSchema: { type: 'object', properties: {} },
  },
];

function toolsForRole(role: 'admin' | 'operator' | 'viewer') {
  return TOOLS.filter((t) => {
    if (!t.minRole) return true;
    if (t.minRole === 'operator') return role === 'admin' || role === 'operator';
    if (t.minRole === 'admin') return role === 'admin';
    return false;
  }).map(({ minRole: _, ...rest }) => rest);
}

// ────────────────────────────────────────────────────────────────────────────
// Lambda invocation
// ────────────────────────────────────────────────────────────────────────────

async function adminCall(
  functionName: string,
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

  const result = await lambdaClient.send(
    new InvokeCommand({
      FunctionName: functionName,
      Payload: Buffer.from(JSON.stringify(event)),
    })
  );

  if (result.FunctionError) {
    throw new Error(`Admin function failed: ${result.FunctionError}`);
  }

  const raw = result.Payload ? Buffer.from(result.Payload).toString('utf8') : '';
  const response = raw ? (JSON.parse(raw) as { statusCode?: number; body?: string }) : {};
  const parsed = response.body ? JSON.parse(response.body) : {};

  if ((response.statusCode ?? 500) >= 400) {
    const message =
      typeof parsed === 'object' && parsed !== null && 'message' in parsed
        ? String((parsed as { message: unknown }).message)
        : `request failed with ${response.statusCode}`;
    throw new Error(message);
  }

  return parsed;
}

// Routes in VPC_ROUTE_PREFIXES go to the in-VPC function; everything else goes
// to the out-of-VPC function (cost, logs, users, network, system).
const vpc = (path: string, method: string, auth: { role: string; tokenName: string }, body?: unknown) =>
  adminCall(ADMIN_VPC_FUNCTION, path, method, auth, body);

const api = (path: string, method: string, auth: { role: string; tokenName: string }, body?: unknown) =>
  adminCall(ADMIN_API_FUNCTION, path, method, auth, body);

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

// ────────────────────────────────────────────────────────────────────────────
// Tool executor
// ────────────────────────────────────────────────────────────────────────────

async function executeTool(
  name: string,
  args: Record<string, unknown>,
  /**
   * The whole authorizer context, not just the two fields the admin call needs
   * — `whoami` reports who the token belongs to, and that is the third.
   */
  auth: { role: string; tokenName: string; createdBy?: string }
): Promise<unknown> {
  const enc = (s: string) => encodeURIComponent(s);
  const n = () => enc(String(args.name));

  switch (name) {

    // ── System ──────────────────────────────────────────────────────────────
    case 'get_system_info':
      return api('/v1/admin/system/info', 'GET', auth);

    // ── Microservices — reads ────────────────────────────────────────────────
    case 'list_microservices':
      return vpc('/v1/admin/microservices', 'GET', auth);

    case 'get_microservice_status':
      return vpc(`/v1/admin/microservices/${n()}/status`, 'GET', auth);

    case 'get_microservice_events': {
      const limit = Math.min(Math.trunc(Number(args.limit ?? 20)), 100);
      return vpc(`/v1/admin/microservices/${n()}/events?limit=${limit}`, 'GET', auth);
    }

    case 'get_microservice_logs': {
      const source = args.source === 'build' ? 'build' : 'container';
      const limit = Math.min(Math.trunc(Number(args.limit ?? 100)), 500);
      return vpc(`/v1/admin/microservices/${n()}/logs?source=${source}&limit=${limit}`, 'GET', auth);
    }

    case 'get_microservice_metrics':
      return vpc(`/v1/admin/microservices/${n()}/metrics`, 'GET', auth);

    case 'list_microservice_images':
      return vpc(`/v1/admin/microservices/${n()}/images`, 'GET', auth);

    case 'list_microservice_builds': {
      const limit = Math.min(Math.trunc(Number(args.limit ?? 10)), 50);
      return vpc(`/v1/admin/microservices/${n()}/builds?limit=${limit}`, 'GET', auth);
    }

    // ── Microservices — mutations ────────────────────────────────────────────
    case 'create_microservice':
      return vpc('/v1/admin/microservices', 'POST', auth, args);

    case 'update_microservice': {
      const { name: _name, ...patch } = args;
      return vpc(`/v1/admin/microservices/${n()}`, 'PATCH', auth, patch);
    }

    case 'build_microservice':
      return vpc(`/v1/admin/microservices/${n()}/build`, 'POST', auth);

    case 'stop_build':
      return vpc(`/v1/admin/microservices/${n()}/build/stop`, 'POST', auth);

    case 'deploy_microservice':
      return vpc(`/v1/admin/microservices/${n()}/deploy`, 'POST', auth);

    case 'restart_microservice':
      return vpc(`/v1/admin/microservices/${n()}/restart`, 'POST', auth);

    case 'rollback_microservice':
      return vpc(`/v1/admin/microservices/${n()}/rollback`, 'POST', auth, {
        image_tag: String(args.image_tag),
      });

    case 'delete_microservice':
      return vpc(
        `/v1/admin/microservices/${n()}?delete_images=${!!args.delete_images}&delete_logs=${!!args.delete_logs}`,
        'DELETE',
        auth
      );

    // ── Sensors ──────────────────────────────────────────────────────────────
    case 'list_sensors':
      return vpc('/v1/admin/sensors', 'GET', auth);

    case 'create_sensor':
      return vpc('/v1/admin/sensors', 'POST', auth, args);

    case 'set_sensor_enabled':
      return vpc(`/v1/admin/sensors/${n()}/enabled`, 'POST', auth, { enabled: args.enabled });

    case 'update_sensor_ingest': {
      const { name: _name, ...body } = args;
      return vpc(`/v1/admin/sensors/${n()}/ingest`, 'POST', auth, body);
    }

    case 'delete_sensor':
      return vpc(`/v1/admin/sensors/${n()}`, 'DELETE', auth);

    case 'reconcile_sensors':
      return vpc('/v1/admin/sensors/reconcile', 'POST', auth);

    // ── Apps ─────────────────────────────────────────────────────────────────
    case 'list_apps':
      return vpc('/v1/admin/apps', 'GET', auth);

    case 'create_app':
      return vpc('/v1/admin/apps', 'POST', auth, args);

    case 'update_app': {
      const appId = enc(String(args.app_id));
      const { app_id: _, ...patch } = args;
      return vpc(`/v1/admin/apps/${appId}`, 'PATCH', auth, patch);
    }

    case 'delete_app':
      return vpc(`/v1/admin/apps/${enc(String(args.app_id))}`, 'DELETE', auth);

    // ── Alarms ────────────────────────────────────────────────────────────────
    case 'list_alarms': {
      const qs = new URLSearchParams();
      if (args.state) qs.set('state', String(args.state));
      if (args.prefix) qs.set('prefix', String(args.prefix));
      const q = qs.toString();
      return vpc(`/v1/admin/alarms${q ? `?${q}` : ''}`, 'GET', auth);
    }

    case 'suppress_alarm':
      return vpc(`/v1/admin/alarms/${n()}/suppress`, 'POST', auth);

    case 'unsuppress_alarm':
      return vpc(`/v1/admin/alarms/${n()}/unsuppress`, 'POST', auth);

    // ── Clients ───────────────────────────────────────────────────────────────
    case 'get_clients_summary':
      return vpc('/v1/admin/clients/summary', 'GET', auth);

    case 'list_clients': {
      const qs = new URLSearchParams();
      if (args.app_id) qs.set('app_id', String(args.app_id));
      qs.set('limit', String(Math.min(Math.trunc(Number(args.limit ?? 20)), 100)));
      return vpc(`/v1/admin/clients/sample?${qs.toString()}`, 'GET', auth);
    }

    case 'lookup_client':
      return vpc(
        `/v1/admin/clients/lookup?app_id=${enc(String(args.app_id))}&client_id=${enc(String(args.client_id))}`,
        'GET',
        auth
      );

    // ── Storage ───────────────────────────────────────────────────────────────
    case 'list_storages':
      return vpc('/v1/admin/storages', 'GET', auth);

    case 'list_storage_objects': {
      const qs = new URLSearchParams();
      if (args.prefix) qs.set('prefix', String(args.prefix));
      qs.set('limit', String(Math.min(Math.trunc(Number(args.limit ?? 50)), 200)));
      return vpc(`/v1/admin/storages/${enc(String(args.bucket))}/objects?${qs.toString()}`, 'GET', auth);
    }

    case 'register_storage':
      return vpc('/v1/admin/storages', 'POST', auth, args);

    case 'update_storage': {
      const bucket = enc(String(args.bucket));
      const { bucket: _, ...patch } = args;
      return vpc(`/v1/admin/storages/${bucket}`, 'PATCH', auth, patch);
    }

    case 'unregister_storage':
      return vpc(`/v1/admin/storages/${enc(String(args.bucket))}`, 'DELETE', auth);

    // ── Clusters ──────────────────────────────────────────────────────────────
    case 'list_clusters':
      return vpc('/v1/admin/clusters', 'GET', auth);

    case 'get_cluster_health':
      return vpc(`/v1/admin/clusters/${n()}/health`, 'GET', auth);

    case 'provision_cluster':
      return vpc(`/v1/admin/clusters/${n()}/provision`, 'POST', auth);

    case 'deprovision_cluster':
      return vpc(`/v1/admin/clusters/${n()}/deprovision`, 'POST', auth);

    // ── Valkey ────────────────────────────────────────────────────────────────
    case 'get_valkey_overview':
      return vpc('/v1/admin/db/valkey/overview', 'GET', auth);

    case 'get_valkey_key':
      return vpc(`/v1/admin/db/valkey/key?key=${enc(String(args.key))}`, 'GET', auth);

    case 'delete_valkey_key':
      return vpc(`/v1/admin/db/valkey/key?key=${enc(String(args.key))}`, 'DELETE', auth);

    // ── Aurora ────────────────────────────────────────────────────────────────
    case 'list_aurora_tables':
      return vpc('/v1/admin/db/aurora/tables', 'GET', auth);

    case 'query_aurora':
      return vpc('/v1/admin/db/aurora/query', 'POST', auth, {
        sql: args.sql,
        limit: Math.min(Math.trunc(Number(args.limit ?? 50)), 200),
      });

    // ── Maps ──────────────────────────────────────────────────────────────────
    case 'list_maps':
      return vpc('/v1/admin/maps', 'GET', auth);

    case 'get_map':
      return vpc(`/v1/admin/maps/${n()}`, 'GET', auth);

    // ── GitHub ────────────────────────────────────────────────────────────────
    case 'get_github_app':
      return vpc('/v1/admin/github/app', 'GET', auth);

    case 'list_github_installations':
      return vpc('/v1/admin/github/installations', 'GET', auth);

    // ── Logs ──────────────────────────────────────────────────────────────────
    case 'query_logs': {
      const started = (await api('/v1/admin/logs/query', 'POST', auth, {
        groups: args.groups,
        query: args.query,
        ...(args.start ? { start: args.start } : {}),
        ...(args.end ? { end: args.end } : {}),
        limit: Math.min(Math.trunc(Number(args.limit ?? 100)), 500),
      })) as { queryId: string };

      for (let i = 0; i < 8; i++) {
        await sleep(2000);
        const poll = (await api(
          `/v1/admin/logs/query/${enc(started.queryId)}`,
          'GET',
          auth
        )) as { status: string; results?: unknown[] };
        if (poll.status === 'Complete' || poll.status === 'Failed' || poll.status === 'Cancelled') {
          return poll;
        }
      }
      return { status: 'Timeout', queryId: started.queryId, message: 'Still running after 16 s; try again.' };
    }

    // ── Network ───────────────────────────────────────────────────────────────
    case 'get_network_topology':
      return api('/v1/admin/network/topology', 'GET', auth);

    // ── Users ─────────────────────────────────────────────────────────────────
    case 'list_users':
      return api('/v1/admin/users', 'GET', auth);

    case 'create_user':
      return api('/v1/admin/users', 'POST', auth, args);

    case 'set_user_role':
      return api(`/v1/admin/users/${enc(String(args.username))}/role`, 'POST', auth, { role: args.role });

    case 'set_user_enabled':
      return api(`/v1/admin/users/${enc(String(args.username))}/enabled`, 'POST', auth, { enabled: args.enabled });

    case 'delete_user':
      return api(`/v1/admin/users/${enc(String(args.username))}`, 'DELETE', auth);

    // ── Cost ──────────────────────────────────────────────────────────────────
    case 'get_cost_summary': {
      const qs = new URLSearchParams();
      if (args.start) qs.set('start', String(args.start));
      if (args.end) qs.set('end', String(args.end));
      const q = qs.toString();
      return api(`/v1/admin/cost/summary${q ? `?${q}` : ''}`, 'GET', auth);
    }

    // ── Microservice lifecycle ───────────────────────────────────────────────
    case 'launch_microservice':
      return vpc(`/v1/admin/microservices/${n()}/launch`, 'POST', auth);

    case 'dismiss_launch':
      return vpc(`/v1/admin/microservices/${n()}/launch/dismiss`, 'POST', auth);

    case 'check_microservice_source':
      return vpc(`/v1/admin/microservices/${n()}/check`, 'POST', auth);

    case 'provision_microservice':
      return vpc(`/v1/admin/microservices/${n()}/provision`, 'POST', auth);

    case 'deprovision_microservice':
      return vpc(
        `/v1/admin/microservices/${n()}/deprovision?delete_images=${!!args.delete_images}&delete_logs=${!!args.delete_logs}`,
        'POST',
        auth
      );

    case 'set_log_retention':
      // Null is a value here, not an omission: it means "never expires".
      return vpc(`/v1/admin/microservices/${n()}/logs/retention`, 'PUT', auth, {
        days: args.days === null ? null : Math.trunc(Number(args.days)),
      });

    case 'clear_microservice_logs':
      return vpc(`/v1/admin/microservices/${n()}/logs/clear`, 'POST', auth, {
        source: args.source === 'build' || args.source === 'both' ? args.source : 'container',
      });

    // ── Clusters ─────────────────────────────────────────────────────────────
    case 'create_cluster':
      return vpc('/v1/admin/clusters', 'POST', auth, args);

    case 'update_cluster': {
      const { name: _clusterName, ...patch } = args;
      return vpc(`/v1/admin/clusters/${n()}`, 'PATCH', auth, patch);
    }

    case 'delete_cluster':
      return vpc(`/v1/admin/clusters/${n()}`, 'DELETE', auth);

    // ── Logs ─────────────────────────────────────────────────────────────────
    case 'list_log_groups':
      return api('/v1/admin/logs/groups', 'GET', auth);

    // ── Storage ──────────────────────────────────────────────────────────────
    case 'list_available_storages':
      return vpc('/v1/admin/storages/available', 'GET', auth);

    case 'reconcile_storages':
      return vpc('/v1/admin/storages/reconcile', 'POST', auth);

    // ── Aurora rows ──────────────────────────────────────────────────────────
    case 'list_aurora_rows': {
      const qs = new URLSearchParams();
      if (args.cursor) qs.set('cursor', String(args.cursor));
      qs.set('limit', String(Math.min(Math.trunc(Number(args.limit ?? 50)), 200)));
      return vpc(
        `/v1/admin/db/aurora/tables/${enc(String(args.table))}/rows?${qs.toString()}`,
        'GET',
        auth
      );
    }

    case 'update_aurora_row':
      return vpc(
        `/v1/admin/db/aurora/tables/${enc(String(args.table))}/rows/${enc(String(args.pk))}`,
        'PATCH',
        auth,
        args.values
      );

    case 'delete_aurora_row':
      return vpc(
        `/v1/admin/db/aurora/tables/${enc(String(args.table))}/rows/${enc(String(args.pk))}`,
        'DELETE',
        auth
      );

    // ── Valkey writes ────────────────────────────────────────────────────────
    case 'set_valkey_value':
      return vpc('/v1/admin/db/valkey/key/value', 'POST', auth, {
        key: args.key,
        value: args.value,
        ttl_seconds: args.ttl_seconds ?? null,
      });

    case 'set_valkey_field':
      return vpc('/v1/admin/db/valkey/key/field', 'POST', auth, {
        key: args.key,
        field: args.field,
        value: args.value,
      });

    case 'set_valkey_ttl':
      return vpc('/v1/admin/db/valkey/key/ttl', 'POST', auth, {
        key: args.key,
        ttl_seconds: args.ttl_seconds ?? null,
      });

    // ── Cost ─────────────────────────────────────────────────────────────────
    case 'get_cost_by_service': {
      const qs = new URLSearchParams();
      if (args.start) qs.set('start', String(args.start));
      if (args.end) qs.set('end', String(args.end));
      const q = qs.toString();
      return api(`/v1/admin/cost/service${q ? `?${q}` : ''}`, 'GET', auth);
    }

    // ── Clients ──────────────────────────────────────────────────────────────
    case 'search_clients_nearby': {
      const qs = new URLSearchParams();
      if (args.app_id) qs.set('app_id', String(args.app_id));
      qs.set('lat', String(Number(args.lat)));
      qs.set('lon', String(Number(args.lon)));
      qs.set('radius_m', String(Number(args.radius_m)));
      qs.set('limit', String(Math.min(Math.trunc(Number(args.limit ?? 50)), 200)));
      return vpc(`/v1/admin/clients/search?${qs.toString()}`, 'GET', auth);
    }

    // ── Identity ─────────────────────────────────────────────────────────────
    //
    // Answered from the authorizer's own context rather than by calling the
    // admin API: /v1/admin/me would report the synthesized caller this server
    // presents, which is the token's role either way but says nothing about
    // which token. The question being asked is "what am I allowed to do", and
    // the honest answer includes the tool count that follows from it.
    case 'whoami':
      return {
        token_name: auth.tokenName,
        role: auth.role,
        created_by: auth.createdBy,
        tools_available: toolsForRole(auth.role as 'admin' | 'operator' | 'viewer').length,
        tools_total: TOOLS.length,
      };

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
  const method = event.requestContext.http.method.toUpperCase();
  if (method !== 'POST') {
    return {
      statusCode: 405,
      headers: { 'content-type': 'application/json', allow: 'POST' },
      body: JSON.stringify(
        err(null, -32601, `${method} not supported — this server is stateless and has no SSE stream.`)
      ),
    };
  }

  const context = event.requestContext.authorizer?.lambda as Partial<McpAuthContext> | undefined;
  const role = roleFrom(context);
  const auth = {
    role,
    tokenName: context?.tokenName ?? 'unknown',
    createdBy: context?.createdBy ?? 'unknown',
  };
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

        if (!toolName) { responses.push(err(req.id, -32602, 'Missing tool name')); break; }
        if (!tools.find((t) => t.name === toolName)) {
          responses.push(err(req.id, -32602, `Tool not found or not available for your role: ${toolName}`));
          break;
        }

        try {
          const result = await executeTool(toolName, toolArgs, auth);
          responses.push(ok(req.id, { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] }));
        } catch (error) {
          responses.push(err(req.id, -32603, error instanceof Error ? error.message : String(error)));
        }
        break;
      }

      default:
        responses.push(err(req.id, -32601, `Method not found: ${req.method}`));
    }
  }

  if (responses.length === 0) return { statusCode: 202, body: '' };

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

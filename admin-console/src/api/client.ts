import { config } from '@/config';
import { idToken } from '@/auth/cognito';

export type AdminRole = 'admin' | 'operator' | 'viewer';

export interface AdminUser {
  username: string;
  email?: string;
  role: AdminRole | null;
  enabled: boolean;
  status: string;
  created_at: string | null;
  last_modified_at: string | null;
}

export interface ComponentStatus {
  name: string;
  status: 'ok' | 'degraded' | 'unknown';
  detail: string | null;
  latency_ms: number | null;
}

export interface SystemInfo {
  service: string;
  api_version: string;
  build_id: string;
  region: string;
  server_timestamp: string;
  endpoints: {
    http_api: string | null;
    sensor_http_api: string | null;
    websocket_api: string | null;
  };
  topics: {
    sensor: string | null;
    spat: string | null;
    control: string | null;
  };
}

export interface CostPeriod {
  start: string;
  end: string;
  is_current_month: boolean;
}

export interface CostComponent {
  service: string;
  amount: number;
  share: number;
}

export interface CostSummary {
  period: CostPeriod;
  currency: string;
  total: number;
  projected_month_total: number | null;
  previous_period_total: number | null;
  components: CostComponent[];
  filter: { tag_key: string; tag_value: string };
  fetched_at: string;
  cached: boolean;
}

export interface CostServiceDetail {
  service: string;
  period: CostPeriod;
  currency: string;
  total: number;
  usage_types: Array<{ usage_type: string; amount: number; share: number }>;
  daily: Array<{ date: string; amount: number }>;
  fetched_at: string;
  cached: boolean;
}

export interface MapListEntry {
  id: number;
  name: string;
  center_lat: number;
  center_lon: number;
  intersection_name: string | null;
  lane_count: number;
  created_at: string;
  updated_at: string;
}

export interface MapLane {
  lane_id: number;
  arm_id: number | null;
  kind: string;
  direction: 'ingress' | 'egress' | 'both' | 'unknown';
  ingress_approach: number | null;
  egress_approach: number | null;
  maneuvers: number[];
  node_count: number;
  length_m: number;
  points: Array<{ x: number; y: number; lat: number; lon: number }>;
}

export interface MapDetail {
  id: number;
  name: string;
  center_lat: number;
  center_lon: number;
  created_at: string;
  updated_at: string;
  intersection: {
    name: string | null;
    intersection_id: number;
    region: number;
    revision: number;
    ref_lat: number;
    ref_lon: number;
    elevation: number | null;
    lane_width_m: number | null;
    speed_limit_mps: number | null;
  };
  lanes: MapLane[];
  findings: Array<{ severity: 'info' | 'warning' | 'critical'; title: string; detail: string }>;
  fetched_at: string;
}

export interface ValkeyOverview {
  cluster: {
    used_memory: string;
    connected_clients: number;
    evicted_keys: number;
    keyspace_hits: number;
    keyspace_misses: number;
    hit_rate: number | null;
    total_keys: number;
  };
  apps: Array<{
    app_id: string;
    geo_key: string;
    connected: number;
    expired_not_reaped: number;
  }>;
  sensors: Array<{
    sensor: string;
    key: string;
    last_seen_epoch: number | null;
    seconds_ago: number | null;
    ttl_seconds: number;
  }>;
  approx_accounted_keys: number;
  fetched_at: string;
}

export interface ValkeyKey {
  key: string;
  type: string;
  exists: boolean;
  ttl_seconds: number;
  string_value: string | null;
  entries: Array<{ member: string; value: string | null }>;
  truncated: boolean;
  fetched_at: string;
}

export interface AuroraColumn {
  name: string;
  data_type: string;
  nullable: boolean;
  default_value: string | null;
  is_primary_key: boolean;
  editable: boolean;
}

export interface AuroraTablesResponse {
  tables: Array<{
    name: string;
    estimated_rows: number;
    total_bytes: number;
    column_count: number;
    editable_columns: string[];
    deletable: boolean;
  }>;
  fetched_at: string;
}

export interface AuroraRowsResponse {
  table: string;
  primary_key: string;
  deletable: boolean;
  columns: AuroraColumn[];
  rows: Array<Record<string, string | null>>;
  next_cursor: string | null;
  limit: number;
  fetched_at: string;
}

export interface AuroraQueryResponse {
  columns: string[];
  rows: Array<Record<string, string | null>>;
  row_count: number;
  capped: boolean;
  limit: number;
  duration_ms: number;
  fetched_at: string;
}

export interface LogGroup {
  name: string;
  category: 'lambda' | 'container' | 'insights' | 'api' | 'other';
  stored_bytes: number;
  retention_days: number | null;
  created_at: string | null;
  orphaned: boolean;
}

export interface LogGroupsResponse {
  groups: LogGroup[];
  total_stored_bytes: number;
  orphaned_count: number;
  fetched_at: string;
}

export interface LogQueryStarted {
  query_id: string;
  groups: string[];
  limit: number;
  started_at: string;
}

export interface LogQueryResults {
  query_id: string;
  status: string;
  rows: Array<Record<string, string>>;
  scanned_bytes: number | null;
  matched_records: number | null;
  fetched_at: string;
}

export interface LiveClient {
  client_id: string;
  app_id: string;
  lat: number | null;
  lon: number | null;
  distance_m: number | null;
  fields: Record<string, string>;
}

export interface LiveClientsSummary {
  zone_id: string;
  apps: Array<{
    app_id: string;
    connected: number;
    expiring_within_60s: number;
    expired_not_yet_reaped: number;
  }>;
  total_connected: number;
  fetched_at: string;
}

export interface LiveClientsQuery {
  app_id: string;
  mode: 'radius' | 'sample' | 'lookup';
  limit: number;
  capped: boolean;
  clients: LiveClient[];
  next_cursor: string | null;
  fetched_at: string;
}

export interface SensorEntry {
  name: string;
  display_name: string | null;
  enabled: boolean;
  created_at: string;
  updated_at: string;
  queue_name: string;
  /** Actual infrastructure state, not what the registry asks for. */
  queue_exists: boolean;
  service_exists: boolean;
  messages_available: number | null;
  messages_in_flight: number | null;
}

export interface ReconcileAction {
  sensor: string;
  action: 'create' | 'delete' | 'none';
  steps: string[];
  error: string | null;
}

export interface ReconcileResult {
  desired: string[];
  created: string[];
  deleted: string[];
  actions: ReconcileAction[];
  failed: number;
  reconciled_at: string;
}

export interface SensorsResponse {
  sensors: SensorEntry[];
  /** Queues with no registry row — removed rows, or a half-failed reconcile. */
  orphaned_queues: string[];
  topic_arn: string;
  routing_attribute: string;
  cluster: string;
  fetched_at: string;
}

export type SubnetTier = 'public' | 'private-egress' | 'isolated';

export interface NetworkRoute {
  destination: string;
  target: string;
  target_type: string;
  state: string;
}

export interface NetworkSubnet {
  id: string;
  name: string;
  cidr: string;
  az: string;
  tier: SubnetTier;
  available_ips: number;
  route_table_id: string;
  routes: NetworkRoute[];
  egress: string;
  resources: Array<{ kind: string; name: string; count: number }>;
}

export interface SecurityGroupRule {
  direction: 'ingress' | 'egress';
  protocol: string;
  ports: string;
  peer: string;
  peer_is_group: boolean;
  description: string | null;
}

export interface NetworkFinding {
  severity: 'info' | 'warning' | 'critical';
  title: string;
  detail: string;
}

export interface NetworkTopology {
  vpc: { id: string; cidr: string; azs: string[] };
  internet_gateways: Array<{ id: string }>;
  nat_gateways: Array<{
    id: string;
    subnet_id: string;
    az: string;
    public_ip: string | null;
    state: string;
  }>;
  subnets: NetworkSubnet[];
  endpoints: Array<{ id: string; service: string; type: string; subnet_ids: string[] }>;
  security_groups: Array<{
    id: string;
    name: string;
    description: string;
    rules: SecurityGroupRule[];
  }>;
  outside_vpc: Array<{ kind: string; name: string }>;
  findings: NetworkFinding[];
  fetched_at: string;
  cached: boolean;
}

export interface Me {
  username: string;
  email: string | null;
  role: AdminRole | null;
  groups: string[];
}

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

async function request<T>(
  method: string,
  path: string,
  body?: unknown,
  signal?: AbortSignal
): Promise<T> {
  const token = await idToken();
  if (!token) {
    throw new ApiError(401, 'not_signed_in', 'Your session has expired. Sign in again.');
  }

  const response = await fetch(`${config.adminApiUrl}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${token}`,
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal,
  });

  const text = await response.text();
  const payload = text ? JSON.parse(text) : {};

  if (!response.ok) {
    throw new ApiError(
      response.status,
      payload.error ?? 'request_failed',
      payload.message ?? `Request failed with status ${response.status}.`
    );
  }

  return payload as T;
}

function costQuery(params: Record<string, string | boolean | undefined>): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== false) {
      search.set(key, String(value));
    }
  }
  const query = search.toString();
  return query ? `?${query}` : '';
}

export const api = {
  me: () => request<Me>('GET', '/v1/admin/me'),

  /** Deploy-time facts. No upstream calls server-side, so this returns fast. */
  systemInfo: (signal?: AbortSignal) =>
    request<SystemInfo>('GET', '/v1/admin/system/info', undefined, signal),

  mapsList: (signal?: AbortSignal) =>
    request<{ maps: MapListEntry[]; fetched_at: string }>(
      'GET',
      '/v1/admin/maps',
      undefined,
      signal
    ),

  mapDetail: (name: string, signal?: AbortSignal) =>
    request<MapDetail>('GET', `/v1/admin/maps/${encodeURIComponent(name)}`, undefined, signal),

  valkeyOverview: (signal?: AbortSignal) =>
    request<ValkeyOverview>('GET', '/v1/admin/db/valkey/overview', undefined, signal),

  valkeyKey: (key: string, signal?: AbortSignal) =>
    request<ValkeyKey>(
      'GET',
      `/v1/admin/db/valkey/key?key=${encodeURIComponent(key)}`,
      undefined,
      signal
    ),

  valkeySetValue: (key: string, value: string, ttlSeconds: number | null) =>
    request<{ applied: string }>('POST', '/v1/admin/db/valkey/key/value', {
      key,
      value,
      ttl_seconds: ttlSeconds,
    }),

  valkeySetField: (key: string, field: string, value: string) =>
    request<{ applied: string }>('POST', '/v1/admin/db/valkey/key/field', { key, field, value }),

  valkeySetTtl: (key: string, seconds: number | null) =>
    request<{ applied: string }>('POST', '/v1/admin/db/valkey/key/ttl', { key, seconds }),

  valkeyDeleteKey: (key: string) =>
    request<{ applied: string }>(
      'DELETE',
      `/v1/admin/db/valkey/key?key=${encodeURIComponent(key)}`
    ),

  auroraTables: (signal?: AbortSignal) =>
    request<AuroraTablesResponse>('GET', '/v1/admin/db/aurora/tables', undefined, signal),

  auroraRows: (
    table: string,
    params: { cursor?: string; limit?: number } = {},
    signal?: AbortSignal
  ) =>
    request<AuroraRowsResponse>(
      'GET',
      `/v1/admin/db/aurora/tables/${encodeURIComponent(table)}/rows${costQuery({
        cursor: params.cursor,
        limit: params.limit ? String(params.limit) : undefined,
      })}`,
      undefined,
      signal
    ),

  auroraQuery: (sql: string, limit?: number) =>
    request<AuroraQueryResponse>('POST', '/v1/admin/db/aurora/query', { sql, limit }),

  auroraUpdateRow: (table: string, pk: string, changes: Record<string, unknown>) =>
    request<{ updated: string[] }>(
      'PATCH',
      `/v1/admin/db/aurora/tables/${encodeURIComponent(table)}/rows/${encodeURIComponent(pk)}`,
      { changes }
    ),

  auroraDeleteRow: (table: string, pk: string) =>
    request<{ deleted: boolean }>(
      'DELETE',
      `/v1/admin/db/aurora/tables/${encodeURIComponent(table)}/rows/${encodeURIComponent(pk)}`
    ),

  logGroups: (signal?: AbortSignal) =>
    request<LogGroupsResponse>('GET', '/v1/admin/logs/groups', undefined, signal),

  logQueryStart: (input: {
    groups: string[];
    query?: string;
    start?: string;
    end?: string;
    limit?: number;
  }) => request<LogQueryStarted>('POST', '/v1/admin/logs/query', input),

  logQueryResults: (queryId: string, signal?: AbortSignal) =>
    request<LogQueryResults>(
      'GET',
      `/v1/admin/logs/query/${encodeURIComponent(queryId)}`,
      undefined,
      signal
    ),

  logQueryStop: (queryId: string) =>
    request<{ stopped: boolean }>(
      'DELETE',
      `/v1/admin/logs/query/${encodeURIComponent(queryId)}`
    ),

  clientsSummary: (signal?: AbortSignal) =>
    request<LiveClientsSummary>('GET', '/v1/admin/clients/summary', undefined, signal),

  clientsSearch: (
    params: { app_id: string; lat: number; lon: number; radius_m: number; limit?: number },
    signal?: AbortSignal
  ) =>
    request<LiveClientsQuery>(
      'GET',
      `/v1/admin/clients/search${costQuery({
        app_id: params.app_id,
        lat: String(params.lat),
        lon: String(params.lon),
        radius_m: String(params.radius_m),
        limit: params.limit ? String(params.limit) : undefined,
      })}`,
      undefined,
      signal
    ),

  clientsSample: (params: { app_id: string; cursor?: string; limit?: number }, signal?: AbortSignal) =>
    request<LiveClientsQuery>(
      'GET',
      `/v1/admin/clients/sample${costQuery({
        app_id: params.app_id,
        cursor: params.cursor,
        limit: params.limit ? String(params.limit) : undefined,
      })}`,
      undefined,
      signal
    ),

  clientsLookup: (params: { app_id: string; client_id: string }, signal?: AbortSignal) =>
    request<LiveClientsQuery>(
      'GET',
      `/v1/admin/clients/lookup${costQuery(params)}`,
      undefined,
      signal
    ),

  sensors: (signal?: AbortSignal) =>
    request<SensorsResponse>('GET', '/v1/admin/sensors', undefined, signal),

  sensorAdd: (name: string, displayName: string | null) =>
    request<{ reconcile: ReconcileResult }>('POST', '/v1/admin/sensors', {
      name,
      display_name: displayName,
    }),

  sensorSetEnabled: (name: string, enabled: boolean) =>
    request<{ reconcile: ReconcileResult }>(
      'POST',
      `/v1/admin/sensors/${encodeURIComponent(name)}/enabled`,
      { enabled }
    ),

  sensorRemove: (name: string) =>
    request<{ reconcile: ReconcileResult }>(
      'DELETE',
      `/v1/admin/sensors/${encodeURIComponent(name)}`
    ),

  sensorReconcile: () => request<ReconcileResult>('POST', '/v1/admin/sensors/reconcile'),

  networkTopology: (refresh = false, signal?: AbortSignal) =>
    request<NetworkTopology>(
      'GET',
      `/v1/admin/network/topology${refresh ? '?refresh=true' : ''}`,
      undefined,
      signal
    ),

  /** Omit start/end for the current month to date. */
  costSummary: (
    params: { start?: string; end?: string; refresh?: boolean } = {},
    signal?: AbortSignal
  ) => request<CostSummary>('GET', `/v1/admin/cost/summary${costQuery(params)}`, undefined, signal),

  costServiceDetail: (
    service: string,
    params: { start?: string; end?: string; refresh?: boolean } = {},
    signal?: AbortSignal
  ) =>
    request<CostServiceDetail>(
      'GET',
      `/v1/admin/cost/service${costQuery({ ...params, service })}`,
      undefined,
      signal
    ),

  listUsers: () => request<{ users: AdminUser[] }>('GET', '/v1/admin/users'),

  createUser: (input: {
    username: string;
    email: string;
    role: AdminRole;
    temporary_password?: string;
  }) => request<{ username: string }>('POST', '/v1/admin/users', input),

  deleteUser: (username: string) =>
    request<{ deleted: boolean }>('DELETE', `/v1/admin/users/${encodeURIComponent(username)}`),

  setRole: (username: string, role: AdminRole) =>
    request<{ role: AdminRole }>(
      'POST',
      `/v1/admin/users/${encodeURIComponent(username)}/role`,
      { role }
    ),

  setEnabled: (username: string, enabled: boolean) =>
    request<{ enabled: boolean }>(
      'POST',
      `/v1/admin/users/${encodeURIComponent(username)}/enabled`,
      { enabled }
    ),

  resetPassword: (username: string, password: string, temporary = false) =>
    request<{ password_reset: boolean }>(
      'POST',
      `/v1/admin/users/${encodeURIComponent(username)}/password`,
      { password, temporary }
    ),
};

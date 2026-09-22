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
    admin_console: string | null;
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
  /** Real-time path: SNS topic to a per-sensor SQS queue to a Fargate consumer. */
  stream_enabled: boolean;
  /** Aggregated path: the edge device writes files straight to S3. */
  archive_enabled: boolean;
  storage_bucket: string | null;
  storage_prefix: string;
  created_at: string;
  updated_at: string;
  /** enabled AND stream_enabled — whether streaming infrastructure should exist. */
  streaming_desired: boolean;
  queue_name: string;
  /** Actual infrastructure state, not what the registry asks for. */
  queue_exists: boolean;
  service_exists: boolean;
  messages_available: number | null;
  messages_in_flight: number | null;
}

export interface BucketFacts {
  name: string;
  exists: boolean;
  region: string | null;
  tags: Record<string, string>;
  versioning: string | null;
  /** This deployment's ObjectCreated rule is present on the bucket. */
  notifies_control_topic: boolean;
  /** Key prefixes the listener filters on. Empty string means the whole bucket. */
  notification_prefixes: string[];
  foreign_notification_ids: string[];
  access_error: string | null;
}

export interface StorageEntry {
  bucket: string;
  display_name: string | null;
  region: string | null;
  /** Whether this deployment created the bucket or adopted an existing one. */
  origin: 'created' | 'adopted';
  /**
   * Whether the bucket SHOULD have an upload listener. Derived, not chosen: it
   * is true exactly when at least one sensor archives here. The reconciler
   * writes it; `facts.notifies_control_topic` says what S3 actually has.
   */
  notify: boolean;
  created_at: string;
  updated_at: string;
  facts: BucketFacts;
  sensors: Array<{ name: string; archive_enabled: boolean; prefix: string }>;
  /**
   * The bucket carries the cost allocation tag, read from S3 rather than from
   * the registry — S3 is where the tag has to be for Cost Explorer to see it.
   */
  cost_tracked: boolean;
}

/**
 * A credential for the MCP endpoint.
 *
 * The token itself is absent, and not by omission: only its hash is stored, so
 * there is nothing to return. The plaintext exists in exactly one response —
 * the one that created it.
 */
export interface McpToken {
  name: string;
  role: AdminRole;
  /** The first characters of the token, for matching a row to a config file. */
  hint: string;
  created_by: string;
  created_at: string;
  /** Null never expires, which is the point of the credential. */
  expires_at: string | null;
  last_used_at: string | null;
  revoked_at: string | null;
  /** Derived server-side, so the console does not re-implement the comparison. */
  active: boolean;
}

export interface StoragesResponse {
  storages: StorageEntry[];
  /** The stack's own console-hosting bucket. Never a sensor target. */
  console_bucket: string | null;
  control_topic_arn: string;
  /** The tag the Cost page filters on, so the console can name it exactly. */
  cost_tag: { key: string; value: string };
  region: string;
  fetched_at: string;
}

export interface NotificationAction {
  bucket: string;
  action: 'installed' | 'updated' | 'removed' | 'none';
  archiving_sensors: number;
  /** The key prefixes S3 now filters this bucket's uploads on. */
  prefixes: string[];
  error: string | null;
}

/** Result of converging each bucket's upload listener to its sensor count. */
export interface StorageNotifyResult {
  buckets: number;
  installed: string[];
  /** Rules existed but filtered on a different set of prefixes. */
  updated: string[];
  removed: string[];
  actions: NotificationAction[];
  failed: number;
  reconciled_at: string;
}

export interface BucketListing {
  bucket: string;
  objects: Array<{
    key: string;
    size: number;
    last_modified: string | null;
    storage_class: string | null;
  }>;
  next_cursor: string | null;
  limit: number;
  fetched_at: string;
}

/**
 * What every sensor mutation returns.
 *
 * Two reconciles, because one sensor edit can move both: `reconcile` is the
 * sensor infrastructure (queue, subscription, consumer), and `storage` is the
 * per-bucket S3 upload listener, whose lifecycle is a count of the sensors
 * archiving into that bucket. Turning a sensor's archive off can be what
 * removes a listener.
 */
export interface SensorMutation {
  reconcile: ReconcileResult;
  storage: StorageNotifyResult;
}

/** Fields a sensor's ingest configuration accepts. Omitted means unchanged. */
export interface SensorIngestPatch {
  stream_enabled?: boolean;
  archive_enabled?: boolean;
  storage_bucket?: string | null;
  storage_prefix?: string | null;
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
  /** Existing sensors whose queue and service were brought up to the current tags. */
  retagged: string[];
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

/**
 * A consumer fleet. The three `receive_*` flags are read on hot paths by the
 * SDSM and SPaT consumers, so each one decides what real clients are sent.
 */
export interface AppEntry {
  app_id: string;
  display_name: string | null;
  receive_sdsm: boolean;
  receive_spat: boolean;
  receive_critical_spat: boolean;
  created_at: string;
  updated_at: string;
  /** The Live clients page can drill into this app's fleet. */
  inspectable: boolean;
  /** Null when the fleet count was not fetched (past the per-page cap). */
  connected: number | null;
  expiring_within_60s: number | null;
  expired_not_yet_reaped: number | null;
  /** Registered, connectable, and subscribed to nothing. */
  receives_nothing: boolean;
}

export interface AppsResponse {
  apps: AppEntry[];
  /** Configured for live-client inspection but with no registry row. */
  unregistered_app_ids: string[];
  total_connected: number;
  counts_capped: boolean;
  /**
   * Set when the live fleet counts could not be read from Valkey. The registry
   * itself is still accurate — only the "connected" numbers are missing.
   */
  counts_error: string | null;
  /** How long a subscription change takes to reach the consumers. */
  config_cache_ttl_seconds: number;
  fetched_at: string;
}

/** Fields an app accepts. Omitted means unchanged. */
export interface AppPatch {
  display_name?: string | null;
  receive_sdsm?: boolean;
  receive_spat?: boolean;
  receive_critical_spat?: boolean;
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

/**
 * The GitHub App this deployment authenticates as.
 *
 * `configured` requires both halves: a database row AND a private key present
 * in Secrets Manager. They can disagree — a key cleared out from under the row,
 * or a save whose verification failed — and the page says which.
 */
export interface GithubApp {
  app_id: number;
  slug: string;
  name: string | null;
  html_url: string | null;
  /** Console username. No GitHub identity is stored, so this is the audit trail. */
  configured_by: string;
  configured_at: string;
  updated_at: string;
}

export interface GithubAppStatus {
  configured: boolean;
  secret_present: boolean;
  app: GithubApp | null;
  app_settings_url: string | null;
  /**
   * The only place a GitHub App can be deleted — GitHub has no API for it. What
   * 'Forget App' does here is clear local credentials; the App survives there,
   * still holding its globally-unique name.
   */
  app_delete_url: string | null;
  /** What the App is called if the operator does not name it. */
  suggested_app_name: string;
  install_url: string | null;
  /**
   * Where GitHub delivers pushes. Shown because an App created before the
   * receiver existed has its webhook switched off on GitHub's side, and no API
   * can turn it back on — that one is a checkbox in the App's settings.
   */
  webhook_url: string;
}

/**
 * One grant. Belongs to the repository owner, not to whoever clicked Install —
 * which is what lets every later console user work without a GitHub account.
 */
export interface GithubInstallation {
  installation_id: number;
  account_login: string;
  account_type: string | null;
  target_type: string | null;
  /** 'all' means a repo added later is reachable without anyone re-consenting. */
  repository_selection: string | null;
  permissions: Record<string, string>;
  suspended: boolean;
  connected_by: string;
  connected_at: string;
  updated_at: string;
}

export interface GithubRepo {
  repo_id: number;
  full_name: string;
  owner: string;
  name: string;
  private: boolean;
  default_branch: string;
  html_url: string | null;
  archived: boolean;
}

export interface GithubInstallationRepos {
  installation: GithubInstallation;
  repositories: GithubRepo[];
  /** The installation grants more repos than could be read in one go. */
  truncated: boolean;
}

export type MicroserviceCheckState =
  | 'unchecked'
  | 'ok'
  | 'dockerfile_missing'
  | 'branch_missing'
  | 'context_missing'
  | 'error';

export type CapacityType = 'fargate' | 'ec2';
export type ClusterScalingMode = 'fixed' | 'auto';
/**
 * 'exclusive' pins a whole GPU per task, enforced by ECS. 'shared' declares no
 * GPU requirement so tasks pack by CPU and memory and all see the card — the
 * only way to get finer granularity than one whole GPU, at the cost of VRAM
 * being unguarded.
 */
export type GpuMode = 'shared' | 'exclusive';

export interface ClusterUsage {
  /** At most one — a cluster carries exactly one service. */
  services: number;
  /** The service occupying it, or null if it is free to be assigned. */
  service_name: string | null;
  max_tasks: number;
  committed_vram_mb: number;
  available_vram_mb: number;
  /** Services promised more video memory than one card holds. */
  vram_overcommitted: boolean;
}

export interface ComputeCluster {
  name: string;
  display_name: string | null;
  capacity_type: CapacityType;
  /** Null on Fargate, where there is no instance to name. */
  instance_type: string | null;
  /** How the INSTANCE count is decided. Meaningless on Fargate. */
  scaling_mode: ClusterScalingMode;
  min_instances: number;
  max_instances: number;
  target_capacity: number;
  gpus_per_instance: number;
  gpu_vram_mb: number;
  gpu_mode: GpuMode;
  /**
   * 'not_provisioned' | 'provisioned' | 'drifted' | 'failed'.
   *
   * 'drifted' means the row was edited after being provisioned. Applying that
   * edit replaces instances, so the console asks rather than doing it as a side
   * effect of saving a form.
   */
  provision_state: ProvisionState;
  // ── What provisioning created. All null on Fargate, which has no instances. ──
  cluster_arn: string | null;
  launch_template_id: string | null;
  asg_name: string | null;
  capacity_provider_name: string | null;
  /** The AMI the launch template was built with, and when it was resolved. */
  image_id: string | null;
  image_resolved_at: string | null;
  provision_detail: string | null;
  provisioned_at: string | null;
  created_by: string;
  created_at: string;
  updated_at: string;
  usage: ClusterUsage;
}

export interface ClusterCapacityInput {
  capacity_type: CapacityType;
  instance_type?: string | null;
  scaling_mode?: ClusterScalingMode;
  min_instances?: number;
  max_instances?: number;
  target_capacity?: number;
  gpus_per_instance?: number;
  gpu_vram_mb?: number;
  gpu_mode?: GpuMode;
}

/**
 * The hardware a microservice runs on, sent as part of creating it.
 *
 * Not a cluster to pick. A cluster carries exactly one service, so it is a
 * property of the service: one is created automatically, named after the
 * service, and provisioned along with it. There is deliberately no field here
 * to name or select an existing cluster.
 *
 * Omitted means Fargate — nothing to manage, no cost when idle.
 */
export type ComputeInput = ClusterCapacityInput;

export type ScalingMode = 'fixed' | 'auto';
export type ScalingMetric = 'cpu' | 'memory';

/**
 * The scaling policy, sent as one object because its rules are between the
 * fields — a maximum below the minimum never settles, and a target at 0 or 100
 * percent never stops scaling one way. The server validates it as a whole.
 */
export interface ScalingPolicy {
  mode?: ScalingMode;
  min_tasks?: number;
  max_tasks?: number;
  metric?: ScalingMetric;
  target?: number;
  scale_out_cooldown?: number;
  scale_in_cooldown?: number;
}

export interface Microservice {
  name: string;
  display_name: string | null;
  installation_id: number;
  repo_id: number;
  repo_full_name: string;
  branch: string;
  dockerfile_path: string;
  build_context: string;
  check_state: MicroserviceCheckState;
  check_detail: string | null;
  checked_at: string | null;
  checked_commit_sha: string | null;
  dockerfile_sha: string | null;
  dockerfile_size: number | null;
  /**
   * 'not_provisioned' | 'scaffolded' | 'provisioned' | 'failed'.
   *
   * The lifecycle is deliberately four explicit steps: provisioning creates a
   * repository and log groups and costs nothing, building spends CodeBuild
   * minutes, deploying starts instances that bill by the second.
   */
  provision_state: ProvisionState;
  desired_count: number;
  cpu: number;
  memory: number;
  container_port: number | null;
  /** 'fixed' runs exactly desired_count; 'auto' scales between min and max. */
  scaling_mode: ScalingMode;
  min_tasks: number;
  max_tasks: number;
  scaling_metric: ScalingMetric;
  scaling_target: number;
  scale_out_cooldown: number;
  scale_in_cooldown: number;
  /** Null until assigned — a service with no cluster has nowhere to run. */
  cluster_name: string | null;
  gpu_vram_mb: number;
  // ── What provisioning created. Null until it has run. ──────────────────
  ecr_repository_name: string | null;
  ecr_repository_uri: string | null;
  build_project_name: string | null;
  log_group_name: string | null;
  /** Null means never expire. */
  log_retention_days: number | null;
  service_arn: string | null;
  task_definition_arn: string | null;
  image_tag: string | null;
  image_digest: string | null;
  provision_detail: string | null;
  provisioned_at: string | null;
  // ── The last image build. ──────────────────────────────────────────────
  build_id: string | null;
  build_state: BuildState;
  build_detail: string | null;
  /**
   * The commit the running image was built from. Against `checked_commit_sha`
   * — the branch head as of the last look at GitHub — this is what separates
   * "deployed" from "up to date".
   */
  build_commit_sha: string | null;
  build_started_at: string | null;
  build_finished_at: string | null;
  build_log_group: string | null;
  build_log_stream: string | null;
  // ── The standing instruction to get this running. ──────────────────────
  /**
   * How far an automatic bring-up has got. A different axis from
   * `provision_state`, which says what exists on AWS: this says whether anyone
   * is still waiting for the service to come up.
   */
  launch_state: LaunchState;
  launch_detail: string | null;
  launch_requested_by: string | null;
  launch_requested_at: string | null;
  launch_finished_at: string | null;
  /** Whether this bring-up is the first one or a redeploy over a live service. */
  launch_kind: LaunchKind;
  /** What asked for it, as opposed to who. */
  launch_trigger: LaunchTrigger;
  /**
   * Whether a push to the tracked branch rebuilds and redeploys on its own.
   * On by default: a service wired to a branch is usually meant to follow it.
   */
  auto_deploy: boolean;
  created_by: string;
  created_at: string;
  updated_at: string;
}

export type ProvisionState = 'not_provisioned' | 'scaffolded' | 'provisioned' | 'failed' | 'drifted';

export type BuildState = 'never' | 'queued' | 'building' | 'succeeded' | 'failed' | 'stopped';

/** A build that has neither finished nor failed — the console keeps polling. */
export function buildRunning(state: BuildState): boolean {
  return state === 'queued' || state === 'building';
}

/**
 * How far an automatic bring-up has got.
 *
 * Creating a service asks its questions once and then takes every step those
 * answers were for: the cluster, the image repository and log groups, the image
 * build, and the ECS service. This is where in that sequence it is.
 */
export type LaunchState =
  | 'none'
  | 'requested'
  | 'provisioning'
  | 'building'
  | 'deploying'
  | 'running'
  | 'failed';

/**
 * A launch still in progress — the console polls while this is true.
 *
 * 'running' and 'failed' are both finished; 'none' is a service nobody asked to
 * launch. Everything else is waiting on something.
 */
export function launchInFlight(state: LaunchState): boolean {
  return (
    state === 'requested' ||
    state === 'provisioning' ||
    state === 'building' ||
    state === 'deploying'
  );
}

/**
 * Whether a bring-up is the first one or a redeploy over something already up.
 *
 * The states are identical either way; what differs is what is true while they
 * run. A rebuild keeps serving from the old image until the new one is
 * deployed, so calling it "Launching" would be simply wrong.
 */
export type LaunchKind = 'launch' | 'rebuild';

/** What asked for a launch: someone in the console, or a push to the branch. */
export type LaunchTrigger = 'console' | 'push';

/** Where a launch got to, and what it did on the way. */
export interface LaunchStatus {
  name: string;
  launch_state: LaunchState;
  launch_detail: string | null;
  launch_kind: LaunchKind;
  launch_trigger: LaunchTrigger;
  provision_state: ProvisionState;
  build_state: BuildState;
  steps: string[];
  error: string | null;
}

/**
 * One thing that happened to a microservice.
 *
 * Everything else the console shows about a service is a snapshot that the next
 * change overwrites. This is the record that survives it — and the only place
 * a deployment can be traced back to the commit that caused it, which matters
 * now that a push can deploy with nobody watching.
 */
export interface MicroserviceEvent {
  id: string;
  microservice: string;
  at: string;
  kind: MicroserviceEventKind;
  /** A console username, or `push:<github-login>` for a webhook. */
  actor: string;
  trigger: LaunchTrigger | 'reconcile';
  detail: string | null;
  commit_sha: string | null;
  image_tag: string | null;
  build_id: string | null;
}

export type MicroserviceEventKind =
  | 'launch'
  | 'rebuild'
  | 'build_started'
  | 'build_succeeded'
  | 'build_failed'
  | 'deployed'
  | 'deploy_failed'
  | 'restarted'
  | 'rolled_back'
  /** A push arrived for a service with automatic deployment turned off. */
  | 'push_ignored';

/** One entry from the server-held instance catalog. */
export interface InstanceType {
  name: string;
  family: string;
  vcpu: number;
  memoryMib: number;
  gpus: number;
  /** Per card, not the total across cards. */
  gpuVramMb: number;
  gpuModel: string | null;
  note?: string;
  /**
   * The largest task memory this type can actually run: the agent and the OS
   * take the rest, and a task sized past this sits PENDING forever.
   */
  task_memory_ceiling: number;
}

/** What ECS actually has, as opposed to what the cluster row asked for. */
export interface ClusterHealth {
  exists: boolean;
  status: string | null;
  registered_instances: number;
  disconnected_instances: number;
  running_tasks: number;
  pending_tasks: number;
  registered_cpu: number;
  remaining_cpu: number;
  registered_memory_mib: number;
  remaining_memory_mib: number;
  registered_gpus: number;
  remaining_gpus: number;
  instances: ClusterNode[];
}

/**
 * One container instance, with what it has and what is left of it.
 *
 * Both halves, because neither is usable alone: "3072 CPU units remaining" says
 * nothing without the size of the box it is remaining on.
 */
export interface ClusterNode {
  id: string;
  ec2_instance_id: string | null;
  status: string | null;
  agent_connected: boolean;
  agent_version: string | null;
  running_tasks: number;
  pending_tasks: number;
  registered_cpu: number;
  remaining_cpu: number;
  registered_memory_mib: number;
  remaining_memory_mib: number;
  registered_gpus: number;
  remaining_gpus: number;
}

/**
 * One logged line.
 *
 * stdout and stderr are not distinguished, because CloudWatch does not
 * distinguish them: the awslogs driver and CodeBuild both write one interleaved
 * stream in the order the process produced it. That interleaving is the useful
 * part — it shows which output the failure followed.
 */
export interface LogEvent {
  timestamp: string;
  message: string;
  /** The stream it came from: one per task on a container log. */
  stream: string | null;
}

/** One stream in the group, for choosing between them without reading them. */
export interface LogStreamInfo {
  name: string;
  last_event_at: string | null;
}

export interface LogTail {
  source: 'container' | 'build';
  log_group: string | null;
  /** The streams actually read. */
  streams: string[];
  /**
   * Every stream in the group — not the same as the ones read. A container log
   * has one stream per container per task, so this is the list of tasks that
   * have ever written, newest first.
   */
  available: LogStreamInfo[];
  /** Oldest first, so it reads like a terminal. */
  events: LogEvent[];
  /** Older lines exist before the first one here. */
  truncated: boolean;
}

export interface ClusterHealthResponse {
  cluster: ComputeCluster;
  ecs_cluster_name: string;
  health: ClusterHealth | null;
  instance: InstanceType | null;
  /**
   * Whether ECS sees the GPUs the row promises. False means the instances are
   * up but nothing GPU-bound will ever place on them — almost always the wrong
   * AMI. Null when the cluster has no GPUs or is not provisioned.
   */
  gpu_visible: boolean | null;
  fetched_at: string;
}

/** What a deployed service is doing right now. */
export interface ServiceRuntime {
  exists: boolean;
  status: string | null;
  desired_count: number;
  running_count: number;
  pending_count: number;
  task_definition: string | null;
  rollout_state: string | null;
  rollout_detail: string | null;
  /**
   * ECS service events, newest first. The only place a placement failure is
   * ever explained — "unable to place a task because no container instance met
   * all of its requirements" exists nowhere else.
   */
  events: Array<{ at: string; message: string }>;
  tasks: Array<{
    arn: string;
    last_status: string | null;
    health_status: string | null;
    started_at: string | null;
    stopped_reason: string | null;
    /**
     * Null on Fargate, which has no instances. This is what attributes a log
     * stream to a machine: a stream is named after the task, never the host, so
     * "which node wrote this" is a join through here.
     */
    container_instance: string | null;
    availability_zone: string | null;
  }>;
}

export interface LogGroupSummary {
  name: string;
  stored_bytes: number;
  retention_days: number | null;
  created_at: string | null;
}

export interface MicroserviceStatus {
  microservice: Microservice;
  runtime: ServiceRuntime | null;
  image: { digest: string | null; size_bytes: number | null; pushed_at: string | null } | null;
  logs: LogGroupSummary | null;
  build_logs: LogGroupSummary | null;
  ecs_service_name: string;
  ecs_cluster_name: string | null;
  /**
   * The branch has commits the running image does not contain. Null when either
   * sha is unknown — "we cannot tell" and "it is current" are different answers
   * and only one justifies prompting for a rebuild.
   */
  image_stale: boolean | null;
  fetched_at: string;
}

/** What a provision/deprovision attempt did, step by step. */
export interface ProvisionResult {
  name: string;
  provision_state: ProvisionState;
  steps: string[];
  error: string | null;
}

export interface MicroserviceSource {
  branch?: string;
  dockerfile_path?: string;
  build_context?: string;
}

export interface MicroserviceRuntime {
  desired_count?: number;
  cpu?: number;
  memory?: number;
  container_port?: number | null;
  scaling?: ScalingPolicy;
  cluster_name?: string | null;
  gpu_vram_mb?: number;
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

  // body and signal are spread in only when present rather than set to
  // undefined: RequestInit types them as `BodyInit | null` and
  // `AbortSignal | null`, which under exactOptionalPropertyTypes reject an
  // explicit undefined.
  const response = await fetch(`${config.adminApiUrl}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${token}`,
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    ...(signal ? { signal } : {}),
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

  sensorAdd: (name: string, displayName: string | null, ingest: SensorIngestPatch = {}) =>
    request<SensorMutation>('POST', '/v1/admin/sensors', {
      name,
      display_name: displayName,
      ...ingest,
    }),

  /** Only the fields present are changed; the rest are left as they are. */
  sensorSetIngest: (name: string, patch: SensorIngestPatch) =>
    request<SensorMutation & { sensor: SensorEntry }>(
      'POST',
      `/v1/admin/sensors/${encodeURIComponent(name)}/ingest`,
      patch
    ),

  sensorSetEnabled: (name: string, enabled: boolean) =>
    request<SensorMutation>(
      'POST',
      `/v1/admin/sensors/${encodeURIComponent(name)}/enabled`,
      { enabled }
    ),

  sensorRemove: (name: string) =>
    request<SensorMutation>('DELETE', `/v1/admin/sensors/${encodeURIComponent(name)}`),

  sensorReconcile: () => request<SensorMutation>('POST', '/v1/admin/sensors/reconcile'),

  apps: (signal?: AbortSignal) =>
    request<AppsResponse>('GET', '/v1/admin/apps', undefined, signal),

  appAdd: (appId: string, displayName: string | null, subscriptions: AppPatch = {}) =>
    request<{ app: AppEntry }>('POST', '/v1/admin/apps', {
      app_id: appId,
      display_name: displayName,
      ...subscriptions,
    }),

  appUpdate: (appId: string, patch: AppPatch) =>
    request<{ app: AppEntry }>('PATCH', `/v1/admin/apps/${encodeURIComponent(appId)}`, patch),

  appRemove: (appId: string) =>
    request<{ removed: boolean }>('DELETE', `/v1/admin/apps/${encodeURIComponent(appId)}`),

  // ── MCP access tokens ───────────────────────────────────────────────────

  mcpTokens: (signal?: AbortSignal) =>
    request<{ tokens: McpToken[] }>('GET', '/v1/admin/mcp-tokens', undefined, signal),

  /**
   * Issues a token. The plaintext comes back once and is never recoverable —
   * the caller must show it immediately and say so.
   */
  mcpTokenCreate: (input: {
    name: string;
    role?: AdminRole;
    expires_in_days?: number | null;
  }) =>
    request<{ token: string; token_shown_once: boolean; mcp_token: McpToken }>(
      'POST',
      '/v1/admin/mcp-tokens',
      input
    ),

  mcpTokenRevoke: (name: string) =>
    request<{ mcp_token: McpToken }>(
      'DELETE',
      `/v1/admin/mcp-tokens/${encodeURIComponent(name)}`
    ),

  storages: (signal?: AbortSignal) =>
    request<StoragesResponse>('GET', '/v1/admin/storages', undefined, signal),

  /** Buckets in the account that are not registered yet. */
  storagesAvailable: (signal?: AbortSignal) =>
    request<{ buckets: Array<{ name: string; created_at: string | null }>; fetched_at: string }>(
      'GET',
      '/v1/admin/storages/available',
      undefined,
      signal
    ),

  storageAdd: (input: {
    bucket: string;
    display_name: string | null;
    create: boolean;
    cost_tracked: boolean;
  }) =>
    request<{ storage: StorageEntry; steps: string[]; warnings: string[] }>(
      'POST',
      '/v1/admin/storages',
      input
    ),

  /**
   * Converges every bucket's upload listener to its archiving-sensor count.
   * Runs on its own after every sensor change; this is for drift.
   */
  storageReconcile: () =>
    request<StorageNotifyResult>('POST', '/v1/admin/storages/reconcile'),

  storageUpdate: (
    bucket: string,
    patch: { display_name?: string | null; cost_tracked?: boolean }
  ) =>
    request<{ storage: StorageEntry; cost_tracked: boolean }>(
      'PATCH',
      `/v1/admin/storages/${encodeURIComponent(bucket)}`,
      patch
    ),

  /** Unregisters only. The bucket and everything in it survive. */
  storageRemove: (bucket: string) =>
    request<{ detached_sensors: string[]; notification_removed: boolean; bucket_deleted: boolean }>(
      'DELETE',
      `/v1/admin/storages/${encodeURIComponent(bucket)}`
    ),

  storageObjects: (
    bucket: string,
    params: { prefix?: string; cursor?: string; limit?: number } = {},
    signal?: AbortSignal
  ) =>
    request<BucketListing>(
      'GET',
      `/v1/admin/storages/${encodeURIComponent(bucket)}/objects${costQuery({
        prefix: params.prefix,
        cursor: params.cursor,
        limit: params.limit ? String(params.limit) : undefined,
      })}`,
      undefined,
      signal
    ),

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

  githubApp: (signal?: AbortSignal) =>
    request<GithubAppStatus>('GET', '/v1/admin/github/app', undefined, signal),

  /**
   * Saves the App credentials. The private key goes up and never comes back —
   * no route returns it.
   */
  githubSaveApp: (input: { app_id: number; private_key: string; webhook_secret?: string | null }) =>
    request<{ app: GithubApp; events: string[]; permissions: Record<string, string> }>(
      'POST',
      '/v1/admin/github/app',
      input
    ),

  /**
   * Starts one-click App creation: returns the manifest describing the App this
   * deployment needs, and the GitHub URL a form posts it to.
   *
   * The browser does the POST because GitHub renders a consent page — only a
   * person may create an App, so there is no server-to-server equivalent. The
   * manifest is serialised server-side so the console cannot alter the
   * permissions being requested.
   */
  githubManifestIntent: (organization?: string | null, appName?: string | null) =>
    request<{ create_url: string; manifest: string; state: string; expires_at: string }>(
      'POST',
      '/v1/admin/github/app/manifest-intent',
      { organization: organization ?? null, app_name: appName ?? null }
    ),

  /**
   * Redeems GitHub's App-creation code for the credentials and stores them.
   * The code is single-use and expires in an hour.
   */
  githubCompleteManifest: (input: { code: string; state: string }) =>
    request<{ app: GithubApp; events: string[]; permissions: Record<string, string> }>(
      'POST',
      '/v1/admin/github/app/from-manifest',
      input
    ),

  githubForgetApp: () =>
    request<{ forgotten: boolean }>('DELETE', '/v1/admin/github/app'),

  /**
   * Starts an install handshake and returns GitHub's own installation URL.
   *
   * The `state` in that URL is single-use and expires; GitHub hands it back on
   * the redirect, and it is what proves the installation being claimed came
   * from a flow this deployment started.
   */
  githubInstallIntent: () =>
    request<{ install_url: string; state: string; expires_at: string }>(
      'POST',
      '/v1/admin/github/install-intent'
    ),

  githubInstallations: (signal?: AbortSignal) =>
    request<{ installations: GithubInstallation[] }>(
      'GET',
      '/v1/admin/github/installations',
      undefined,
      signal
    ),

  /** Completes the handshake. Called by the callback page, with a live session. */
  githubCompleteInstall: (input: { installation_id: number; state: string }) =>
    request<GithubInstallationRepos>('POST', '/v1/admin/github/installations', input),

  githubInstallationRepos: (installationId: number, signal?: AbortSignal) =>
    request<GithubInstallationRepos>(
      'GET',
      `/v1/admin/github/installations/${installationId}/repositories`,
      undefined,
      signal
    ),

  /** `revoke` also uninstalls the App on GitHub, so it stops appearing there. */
  githubRemoveInstallation: (installationId: number, revoke = false) =>
    request<{ removed: boolean; revoked: boolean; revoke_error: string | null }>(
      'DELETE',
      `/v1/admin/github/installations/${installationId}${revoke ? '?revoke=true' : ''}`
    ),

  clusters: (signal?: AbortSignal) =>
    request<{ clusters: ComputeCluster[]; fetched_at: string }>(
      'GET',
      '/v1/admin/clusters',
      undefined,
      signal
    ),

  clusterCreate: (input: {
    name: string;
    display_name: string | null;
    capacity: ClusterCapacityInput;
  }) => request<{ cluster: ComputeCluster }>('POST', '/v1/admin/clusters', input),

  clusterUpdate: (
    name: string,
    input: { display_name?: string | null; capacity: ClusterCapacityInput }
  ) =>
    request<{ cluster: ComputeCluster }>(
      'PATCH',
      `/v1/admin/clusters/${encodeURIComponent(name)}`,
      input
    ),

  clusterRemove: (name: string) =>
    request<{ removed: boolean }>('DELETE', `/v1/admin/clusters/${encodeURIComponent(name)}`),

  microservices: (signal?: AbortSignal) =>
    request<{ microservices: Microservice[] }>(
      'GET',
      '/v1/admin/microservices',
      undefined,
      signal
    ),

  /**
   * Registers a microservice. Refused unless the Dockerfile is actually there —
   * the source is checked against GitHub before anything is stored.
   */
  /**
   * Registers a microservice and creates its dedicated cluster.
   *
   * The cluster is not optional and not chosen: it is named after the service
   * and created in the same transaction, so a service that fails to save leaves
   * nothing behind. `compute` says what hardware it gets; omitted means
   * Fargate.
   */
  microserviceCreate: (
    input: {
      name: string;
      display_name?: string | null;
      installation_id: number;
      repo_id: number;
      compute?: ComputeInput;
      /**
       * Bring it up as well as register it.
       *
       * Records the decision on the row, which is what makes it survive this
       * tab: the server's reconcile starts anything left waiting. It does not
       * do the work inside this request — call `microserviceLaunch` next for
       * that, which is the same work without the five-minute wait.
       */
      launch?: boolean;
    } & MicroserviceSource &
      MicroserviceRuntime
  ) =>
    request<{ microservice: Microservice; repo: GithubRepo; cluster: ComputeCluster }>(
      'POST',
      '/v1/admin/microservices',
      input
    ),

  /** Anything omitted is left alone. A failed re-check leaves the row unchanged. */
  microserviceUpdate: (
    name: string,
    changes: {
      display_name?: string | null;
      repo_id?: number;
      /** Absent leaves it as it is; false is a value, not an omission. */
      auto_deploy?: boolean;
    } & MicroserviceSource &
      MicroserviceRuntime
  ) =>
    request<{ microservice: Microservice; rechecked: boolean }>(
      'PATCH',
      `/v1/admin/microservices/${encodeURIComponent(name)}`,
      changes
    ),

  /** Re-reads the source. Reports a bad result rather than failing on it. */
  microserviceCheck: (name: string) =>
    request<{ microservice: Microservice }>(
      'POST',
      `/v1/admin/microservices/${encodeURIComponent(name)}/check`
    ),

  /**
   * Deletes the service outright: AWS resources, its cluster, and both rows.
   *
   * Both extras default to false server-side. Deleting the images throws away
   * every build; deleting the logs throws away the record of why the service
   * was being deleted.
   */
  microserviceRemove: (
    name: string,
    options: { delete_images?: boolean; delete_logs?: boolean } = {}
  ) =>
    request<{
      name: string;
      removed: boolean;
      steps: string[];
      deleted_images: boolean;
      deleted_logs: boolean;
    }>(
      'DELETE',
      `/v1/admin/microservices/${encodeURIComponent(name)}` +
        `?delete_images=${options.delete_images === true}` +
        `&delete_logs=${options.delete_logs === true}`
    ),

  // ── Provisioning ────────────────────────────────────────────────────────

  /** The instance catalog, served rather than duplicated in the console. */
  instanceTypes: (signal?: AbortSignal) =>
    request<{ instance_types: InstanceType[]; memory_overhead_mib: number }>(
      'GET',
      '/v1/admin/clusters/instance-types',
      undefined,
      signal
    ),

  clusterHealth: (name: string, signal?: AbortSignal) =>
    request<ClusterHealthResponse>(
      'GET',
      `/v1/admin/clusters/${encodeURIComponent(name)}/health`,
      undefined,
      signal
    ),

  clusterProvision: (name: string) =>
    request<ProvisionResult>('POST', `/v1/admin/clusters/${encodeURIComponent(name)}/provision`),

  clusterDeprovision: (name: string) =>
    request<ProvisionResult>('POST', `/v1/admin/clusters/${encodeURIComponent(name)}/deprovision`),

  /**
   * One service's registry row, live ECS state, image and logs.
   *
   * Also advances the recorded build state as a side effect: CodeBuild has no
   * callback wired up, so the state moves when something asks.
   */
  microserviceStatus: (name: string, signal?: AbortSignal) =>
    request<MicroserviceStatus>(
      'GET',
      `/v1/admin/microservices/${encodeURIComponent(name)}/status`,
      undefined,
      signal
    ),

  /**
   * Everything at once: cluster, scaffolding, image build, and the service.
   *
   * Returns as soon as the build is running — the deploy happens when the build
   * lands, driven by `microserviceStatus` while the console is open and by the
   * server's own five-minute reconcile when it is not. So a launch finishes
   * even if this tab is closed.
   */
  microserviceLaunch: (name: string) =>
    request<LaunchStatus>('POST', `/v1/admin/microservices/${encodeURIComponent(name)}/launch`),

  /**
   * What has happened to this service, newest first.
   *
   * The one view that outlives the thing it describes: ECS keeps its service
   * events for about an hour and the registry row only ever holds the latest
   * state, so without this there is no way to ask when a service last deployed
   * or what commit it was running before today.
   */
  microserviceEvents: (name: string, limit = 50, signal?: AbortSignal) =>
    request<{ events: MicroserviceEvent[] }>(
      'GET',
      `/v1/admin/microservices/${encodeURIComponent(name)}/events?limit=${limit}`,
      undefined,
      signal
    ),

  /** Stops waiting on a launch. Changes nothing AWS has. */
  microserviceLaunchDismiss: (name: string) =>
    request<{ microservice: Microservice }>(
      'POST',
      `/v1/admin/microservices/${encodeURIComponent(name)}/launch/dismiss`
    ),

  /**
   * The last lines of one of a service's two logs.
   *
   * A tail, not a search: the Logs page owns search, and an Insights query
   * takes seconds to answer "what did the build just print". 'build' reads the
   * exact stream the last build wrote; 'container' merges the newest task
   * streams.
   */
  microserviceLogs: (
    name: string,
    source: 'container' | 'build',
    limit = 200,
    /**
     * One task's stream, by name. Omitted merges the newest few, which is right
     * while tasks are being replaced and wrong when one task is misbehaving.
     */
    stream?: string | null,
    signal?: AbortSignal
  ) =>
    request<LogTail>(
      'GET',
      `/v1/admin/microservices/${encodeURIComponent(name)}/logs` +
        `?source=${source}&limit=${limit}` +
        (stream ? `&stream=${encodeURIComponent(stream)}` : ''),
      undefined,
      signal
    ),

  microserviceProvision: (name: string) =>
    request<ProvisionResult & { repository_uri: string | null }>(
      'POST',
      `/v1/admin/microservices/${encodeURIComponent(name)}/provision`
    ),

  microserviceBuild: (name: string) =>
    request<{ name: string; build_id: string; image_tag: string; build_state: BuildState }>(
      'POST',
      `/v1/admin/microservices/${encodeURIComponent(name)}/build`
    ),

  microserviceBuildStop: (name: string) =>
    request<{ steps: string[]; error: string | null }>(
      'POST',
      `/v1/admin/microservices/${encodeURIComponent(name)}/build/stop`
    ),

  microserviceDeploy: (name: string) =>
    request<ProvisionResult>('POST', `/v1/admin/microservices/${encodeURIComponent(name)}/deploy`),

  microserviceRestart: (name: string) =>
    request<{ steps: string[]; error: string | null }>(
      'POST',
      `/v1/admin/microservices/${encodeURIComponent(name)}/restart`
    ),

  /**
   * Both destructive extras default to false server-side: deleting the images
   * throws away every build, and deleting the logs throws away the record of
   * why the service was misbehaving.
   */
  microserviceDeprovision: (
    name: string,
    input: { delete_images?: boolean; delete_logs?: boolean } = {}
  ) =>
    request<ProvisionResult>(
      'POST',
      `/v1/admin/microservices/${encodeURIComponent(name)}/deprovision`,
      input
    ),

  /** `null` retention means never expire. */
  microserviceLogRetention: (name: string, retentionDays: number | null) =>
    request<{ steps: string[]; error: string | null }>(
      'PUT',
      `/v1/admin/microservices/${encodeURIComponent(name)}/logs/retention`,
      { retention_days: retentionDays }
    ),

  microserviceLogsClear: (name: string, scope: 'container' | 'build' | 'both' = 'both') =>
    request<{ steps: string[]; error: string | null }>(
      'POST',
      `/v1/admin/microservices/${encodeURIComponent(name)}/logs/clear`,
      { scope }
    ),
};

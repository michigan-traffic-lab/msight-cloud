import { z } from 'zod';

/**
 * Access levels for the management console, in descending order of privilege.
 * These map 1:1 onto Cognito groups of the same name.
 *
 *   admin    — full control, including user management
 *   operator — may perform operational actions, may not manage users
 *   viewer   — read-only
 */
export const ADMIN_ROLES = ['admin', 'operator', 'viewer'] as const;

export const AdminRoleSchema = z.enum(ADMIN_ROLES);
export type AdminRole = z.infer<typeof AdminRoleSchema>;

/** Lower number == more privilege. Used for "at least this role" checks. */
export const ROLE_PRECEDENCE: Record<AdminRole, number> = {
  admin: 1,
  operator: 2,
  viewer: 3,
};

export const AdminUserSchema = z.object({
  username: z.string(),
  email: z.string().optional(),
  role: AdminRoleSchema.nullable(),
  enabled: z.boolean(),
  status: z.string(),
  created_at: z.string().nullable(),
  last_modified_at: z.string().nullable(),
});
export type AdminUser = z.infer<typeof AdminUserSchema>;

export const CreateUserRequestSchema = z.object({
  username: z
    .string()
    .min(1)
    .max(128)
    // Cognito usernames may not contain spaces; keep it conservative.
    .regex(/^[A-Za-z0-9._@+-]+$/, 'username contains unsupported characters'),
  email: z.string().email(),
  role: AdminRoleSchema,
  /**
   * Omit to have Cognito email a temporary password. When supplied, the
   * password is set as permanent and the user signs in with it directly.
   */
  temporary_password: z.string().min(8).max(256).optional(),
});
export type CreateUserRequest = z.infer<typeof CreateUserRequestSchema>;

export const SetRoleRequestSchema = z.object({
  role: AdminRoleSchema,
});

export const SetEnabledRequestSchema = z.object({
  enabled: z.boolean(),
});

export const ResetPasswordRequestSchema = z.object({
  password: z.string().min(8).max(256),
  /** When true the user must change it at next sign-in. */
  temporary: z.boolean().optional(),
});

export const MeResponseSchema = z.object({
  username: z.string(),
  email: z.string().nullable(),
  role: AdminRoleSchema.nullable(),
  groups: z.array(z.string()),
});

/**
 * Deploy-time facts about the stack. Deliberately excludes health probes so it
 * can be served without any network call — the console renders these values
 * immediately while probes are still in flight.
 */
export const SystemInfoResponseSchema = z.object({
  service: z.string(),
  api_version: z.string(),
  build_id: z.string(),
  region: z.string(),
  server_timestamp: z.string(),
  endpoints: z.object({
    http_api: z.string().nullable(),
    sensor_http_api: z.string().nullable(),
    websocket_api: z.string().nullable(),
  }),
  topics: z.object({
    sensor: z.string().nullable(),
    spat: z.string().nullable(),
    control: z.string().nullable(),
  }),
  sensors: z.object({
    configured_count: z.number(),
    names: z.array(z.string()),
  }),
});

const LiveClientSchema = z.object({
  client_id: z.string(),
  app_id: z.string(),
  lat: z.number().nullable(),
  lon: z.number().nullable(),
  /** Metres from the query point; present only for a radius search. */
  distance_m: z.number().nullable(),
  fields: z.record(z.string(), z.string()),
});

/**
 * Counts only. Every figure here comes from an O(1) or O(log N) Valkey command,
 * so this response costs the same whether ten clients are connected or ten
 * million. Nothing on this path enumerates keys.
 */
export const LiveClientsSummaryResponseSchema = z.object({
  zone_id: z.string(),
  apps: z.array(
    z.object({
      app_id: z.string(),
      /** ZCARD of the app's geo set — exact, constant time. */
      connected: z.number(),
      /** ZCOUNT buckets over the expiry set: how fresh the fleet is. */
      expiring_within_60s: z.number(),
      expired_not_yet_reaped: z.number(),
    })
  ),
  total_connected: z.number(),
  fetched_at: z.string(),
});

/** Bounded query result. `capped` says the limit truncated the answer. */
export const LiveClientsQueryResponseSchema = z.object({
  app_id: z.string(),
  mode: z.enum(['radius', 'sample', 'lookup']),
  limit: z.number(),
  capped: z.boolean(),
  clients: z.array(LiveClientSchema),
  /** Cursor for the next page, sample mode only. */
  next_cursor: z.string().nullable(),
  fetched_at: z.string(),
});

const AuroraColumnSchema = z.object({
  name: z.string(),
  data_type: z.string(),
  nullable: z.boolean(),
  default_value: z.string().nullable(),
  is_primary_key: z.boolean(),
  /** True only for columns on the server-side editable allowlist. */
  editable: z.boolean(),
});

export const AuroraTablesResponseSchema = z.object({
  tables: z.array(
    z.object({
      name: z.string(),
      estimated_rows: z.number(),
      total_bytes: z.number(),
      column_count: z.number(),
      editable_columns: z.array(z.string()),
      /** Whether whole rows may be removed — a separate privilege from editing. */
      deletable: z.boolean(),
    })
  ),
  fetched_at: z.string(),
});

export const AuroraRowsResponseSchema = z.object({
  table: z.string(),
  primary_key: z.string(),
  deletable: z.boolean(),
  columns: z.array(AuroraColumnSchema),
  /** Values are stringified so the console renders any type without guessing. */
  rows: z.array(z.record(z.string(), z.string().nullable())),
  /** Keyset cursor: the last primary key on this page, or null at the end. */
  next_cursor: z.string().nullable(),
  limit: z.number(),
  fetched_at: z.string(),
});

export const AuroraQueryResponseSchema = z.object({
  columns: z.array(z.string()),
  rows: z.array(z.record(z.string(), z.string().nullable())),
  row_count: z.number(),
  capped: z.boolean(),
  limit: z.number(),
  duration_ms: z.number(),
  fetched_at: z.string(),
});

export const MapListResponseSchema = z.object({
  maps: z.array(
    z.object({
      id: z.number(),
      name: z.string(),
      center_lat: z.number(),
      center_lon: z.number(),
      /** Name inside the MAP message; must equal `name` or SPaT lookups fail. */
      intersection_name: z.string().nullable(),
      lane_count: z.number(),
      created_at: z.string(),
      updated_at: z.string(),
    })
  ),
  fetched_at: z.string(),
});

const LaneSchema = z.object({
  lane_id: z.number(),
  arm_id: z.number().nullable(),
  /** vehicle, crosswalk, or whatever the decoder named it. */
  kind: z.string(),
  direction: z.enum(['ingress', 'egress', 'both', 'unknown']),
  ingress_approach: z.number().nullable(),
  egress_approach: z.number().nullable(),
  maneuvers: z.array(z.number()),
  node_count: z.number(),
  length_m: z.number(),
  /** Cumulative node positions: local metres from refPoint, plus lat/lon. */
  points: z.array(
    z.object({ x: z.number(), y: z.number(), lat: z.number(), lon: z.number() })
  ),
});

export const MapDetailResponseSchema = z.object({
  id: z.number(),
  name: z.string(),
  center_lat: z.number(),
  center_lon: z.number(),
  created_at: z.string(),
  updated_at: z.string(),
  intersection: z.object({
    name: z.string().nullable(),
    intersection_id: z.number(),
    region: z.number(),
    revision: z.number(),
    ref_lat: z.number(),
    ref_lon: z.number(),
    elevation: z.number().nullable(),
    lane_width_m: z.number().nullable(),
    speed_limit_mps: z.number().nullable(),
  }),
  lanes: z.array(LaneSchema),
  findings: z.array(
    z.object({
      severity: z.enum(['info', 'warning', 'critical']),
      title: z.string(),
      detail: z.string(),
    })
  ),
  fetched_at: z.string(),
});

export const ValkeyOverviewResponseSchema = z.object({
  cluster: z.object({
    used_memory: z.string(),
    connected_clients: z.number(),
    evicted_keys: z.number(),
    keyspace_hits: z.number(),
    keyspace_misses: z.number(),
    hit_rate: z.number().nullable(),
    /** DBSIZE — exact and O(1), whatever the keyspace size. */
    total_keys: z.number(),
  }),
  apps: z.array(
    z.object({
      app_id: z.string(),
      geo_key: z.string(),
      connected: z.number(),
      expired_not_reaped: z.number(),
    })
  ),
  /** The SPaT rate-limiter key doubles as a per-sensor last-seen timestamp. */
  sensors: z.array(
    z.object({
      sensor: z.string(),
      key: z.string(),
      last_seen_epoch: z.number().nullable(),
      seconds_ago: z.number().nullable(),
      ttl_seconds: z.number(),
    })
  ),
  approx_accounted_keys: z.number(),
  fetched_at: z.string(),
});

export const ValkeyKeyResponseSchema = z.object({
  key: z.string(),
  /** Reported by TYPE; 'none' when the key does not exist. */
  type: z.string(),
  exists: z.boolean(),
  /** -1 means no expiry, -2 means the key is gone. */
  ttl_seconds: z.number(),
  string_value: z.string().nullable(),
  /** Bounded sample of members for collection types. */
  entries: z.array(z.object({ member: z.string(), value: z.string().nullable() })),
  truncated: z.boolean(),
  fetched_at: z.string(),
});

export const LogGroupsResponseSchema = z.object({
  groups: z.array(
    z.object({
      name: z.string(),
      category: z.enum(['lambda', 'container', 'insights', 'api', 'other']),
      stored_bytes: z.number(),
      retention_days: z.number().nullable(),
      created_at: z.string().nullable(),
      /** Lambda group whose function no longer exists — costs storage for nothing. */
      orphaned: z.boolean(),
    })
  ),
  total_stored_bytes: z.number(),
  orphaned_count: z.number(),
  fetched_at: z.string(),
});

/** Insights runs asynchronously; the caller polls with this id. */
export const LogQueryStartedResponseSchema = z.object({
  query_id: z.string(),
  groups: z.array(z.string()),
  limit: z.number(),
  started_at: z.string(),
});

export const LogQueryResultsResponseSchema = z.object({
  query_id: z.string(),
  /** Scheduled | Running | Complete | Failed | Cancelled | Timeout | Unknown */
  status: z.string(),
  rows: z.array(z.record(z.string(), z.string())),
  /** Insights bills per GB scanned; surfaced so a costly query is visible. */
  scanned_bytes: z.number().nullable(),
  matched_records: z.number().nullable(),
  fetched_at: z.string(),
});

export const SensorsResponseSchema = z.object({
  topic: z.object({
    arn: z.string(),
    name: z.string(),
    fifo: z.boolean(),
    /** Message attribute publishers must set for routing to work. */
    routing_attribute: z.string(),
    content_based_deduplication: z.boolean(),
  }),
  sensors: z.array(
    z.object({
      name: z.string(),
      queue: z
        .object({
          name: z.string(),
          url: z.string(),
          arn: z.string(),
          messages_available: z.number(),
          messages_in_flight: z.number(),
        })
        .nullable(),
      subscription: z
        .object({ arn: z.string(), values: z.array(z.string()) })
        .nullable(),
      /** Queue exists, is subscribed, and the filter admits this sensor name. */
      wired: z.boolean(),
    })
  ),
  fetched_at: z.string(),
});

/**
 * How a subnet actually behaves, derived from its route table rather than from
 * its name. A subnet named "app" that routes 0.0.0.0/0 at a NAT gateway is
 * private-with-egress no matter what anyone called it.
 */
export const SubnetTierSchema = z.enum(['public', 'private-egress', 'isolated']);

const NetworkRouteSchema = z.object({
  destination: z.string(),
  /** Friendly name where one is known, otherwise the raw target id. */
  target: z.string(),
  target_type: z.string(),
  state: z.string(),
});

const PlacedResourceSchema = z.object({
  kind: z.string(),
  name: z.string(),
  /** Present when several of the same thing sit in one subnet. */
  count: z.number(),
});

const NetworkSubnetSchema = z.object({
  id: z.string(),
  name: z.string(),
  cidr: z.string(),
  az: z.string(),
  tier: SubnetTierSchema,
  available_ips: z.number(),
  route_table_id: z.string(),
  routes: z.array(NetworkRouteSchema),
  /** How this subnet reaches the internet, in words. */
  egress: z.string(),
  resources: z.array(PlacedResourceSchema),
});

const SecurityGroupRuleSchema = z.object({
  direction: z.enum(['ingress', 'egress']),
  protocol: z.string(),
  ports: z.string(),
  /** Peer security group name, or a CIDR. */
  peer: z.string(),
  peer_is_group: z.boolean(),
  description: z.string().nullable(),
});

const NetworkFindingSchema = z.object({
  severity: z.enum(['info', 'warning', 'critical']),
  title: z.string(),
  detail: z.string(),
});

export const NetworkTopologyResponseSchema = z.object({
  vpc: z.object({
    id: z.string(),
    cidr: z.string(),
    azs: z.array(z.string()),
  }),
  internet_gateways: z.array(z.object({ id: z.string() })),
  nat_gateways: z.array(
    z.object({
      id: z.string(),
      subnet_id: z.string(),
      az: z.string(),
      public_ip: z.string().nullable(),
      state: z.string(),
    })
  ),
  subnets: z.array(NetworkSubnetSchema),
  endpoints: z.array(
    z.object({
      id: z.string(),
      service: z.string(),
      type: z.string(),
      subnet_ids: z.array(z.string()),
    })
  ),
  security_groups: z.array(
    z.object({
      id: z.string(),
      name: z.string(),
      description: z.string(),
      rules: z.array(SecurityGroupRuleSchema),
    })
  ),
  /** Lambdas that run outside the VPC and therefore cannot reach Aurora or Valkey. */
  outside_vpc: z.array(z.object({ kind: z.string(), name: z.string() })),
  findings: z.array(NetworkFindingSchema),
  fetched_at: z.string(),
  cached: z.boolean(),
});

const CostPeriodSchema = z.object({
  /** Inclusive. */
  start: z.string(),
  /** Exclusive, matching Cost Explorer's own convention. */
  end: z.string(),
  is_current_month: z.boolean(),
});

const CostComponentSchema = z.object({
  /** AWS service name as Cost Explorer reports it. */
  service: z.string(),
  amount: z.number(),
  /** Fraction of the period total, 0..1. Precomputed so the chart cannot
   * disagree with the list beside it. */
  share: z.number(),
});

export const CostSummaryResponseSchema = z.object({
  period: CostPeriodSchema,
  currency: z.string(),
  total: z.number(),
  /**
   * Projected total for the whole month, actuals plus forecast remainder.
   * Null when Cost Explorer has too little history to forecast, or when the
   * period is not the current month.
   */
  projected_month_total: z.number().nullable(),
  /** Same-length previous period, for a like-for-like comparison. */
  previous_period_total: z.number().nullable(),
  components: z.array(CostComponentSchema),
  /** The tag this stack's spend was filtered by. */
  filter: z.object({ tag_key: z.string(), tag_value: z.string() }),
  /** When these figures were fetched from Cost Explorer, not when served. */
  fetched_at: z.string(),
  /** True when served from cache rather than a fresh Cost Explorer call. */
  cached: z.boolean(),
});

export const CostServiceDetailResponseSchema = z.object({
  service: z.string(),
  period: CostPeriodSchema,
  currency: z.string(),
  total: z.number(),
  /** Cost broken down by usage type within this service. */
  usage_types: z.array(
    z.object({ usage_type: z.string(), amount: z.number(), share: z.number() })
  ),
  /** Daily series for this service across the period. */
  daily: z.array(z.object({ date: z.string(), amount: z.number() })),
  fetched_at: z.string(),
  cached: z.boolean(),
});


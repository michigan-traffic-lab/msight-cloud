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

const ComponentStatusSchema = z.object({
  name: z.string(),
  status: z.enum(['ok', 'degraded', 'unknown']),
  detail: z.string().nullable(),
  latency_ms: z.number().nullable(),
});

export const SystemOverviewResponseSchema = z.object({
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
  components: z.array(ComponentStatusSchema),
});

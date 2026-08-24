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

export interface SystemOverview {
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
  sensors: {
    configured_count: number;
    names: string[];
  };
  components: ComponentStatus[];
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
  body?: unknown
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

export const api = {
  me: () => request<Me>('GET', '/v1/admin/me'),

  systemOverview: () => request<SystemOverview>('GET', '/v1/admin/system/overview'),

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

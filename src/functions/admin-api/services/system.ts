import { SystemOverviewResponseSchema } from '../../../shared/schemas/admin';

const PROBE_TIMEOUT_MS = 3000;

interface ComponentStatus {
  name: string;
  status: 'ok' | 'degraded' | 'unknown';
  detail: string | null;
  latency_ms: number | null;
}

/** Single health probe. Never throws — a failed probe is a reported status. */
async function probe(name: string, url: string | undefined): Promise<ComponentStatus> {
  if (!url) {
    return { name, status: 'unknown', detail: 'No endpoint configured.', latency_ms: null };
  }

  const startedAt = Date.now();
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(PROBE_TIMEOUT_MS) });
    return {
      name,
      status: response.ok ? 'ok' : 'degraded',
      detail: response.ok ? null : `HTTP ${response.status}`,
      latency_ms: Date.now() - startedAt,
    };
  } catch (error) {
    return {
      name,
      status: 'degraded',
      detail: error instanceof Error ? error.message : 'Request failed.',
      latency_ms: Date.now() - startedAt,
    };
  }
}

function sensorNames(): string[] {
  return (process.env.SENSOR_NAMES ?? '')
    .split(',')
    .map((name) => name.trim())
    .filter((name) => name.length > 0);
}

/**
 * Assembles the console's landing-page view of the stack: static wiring from
 * the function's environment, plus live probes of the public endpoints.
 */
export async function buildOverview() {
  const httpApiUrl = process.env.HTTP_API_URL || null;
  const names = sensorNames();

  const components = await Promise.all([
    probe('Public HTTP API', httpApiUrl ? `${httpApiUrl}/system/health` : undefined),
    probe('Location API', httpApiUrl ? `${httpApiUrl}/v1/clients/location/health` : undefined),
    probe(
      'Radius broadcast API',
      httpApiUrl ? `${httpApiUrl}/v1/clients/notify/radius/health` : undefined
    ),
  ]);

  return SystemOverviewResponseSchema.parse({
    service: process.env.SERVICE_NAME ?? 'admin-api',
    api_version: process.env.API_VERSION ?? 'v1',
    build_id: process.env.BUILD_ID ?? 'unknown',
    region: process.env.AWS_REGION ?? 'unknown',
    server_timestamp: new Date().toISOString(),
    endpoints: {
      http_api: httpApiUrl,
      sensor_http_api: process.env.SENSOR_HTTP_API_URL || null,
      websocket_api: process.env.WS_API_URL || null,
    },
    topics: {
      sensor: process.env.SENSOR_TOPIC_ARN || null,
      spat: process.env.SPAT_TOPIC_ARN || null,
      control: process.env.CONTROL_TOPIC_ARN || null,
    },
    sensors: {
      configured_count: names.length,
      names,
    },
    components,
  });
}

import { SystemInfoResponseSchema } from '../../../shared/schemas/admin';

/**
 * Deploy-time facts about the stack, read straight from the function's
 * environment. No network calls, so this always returns fast — which is the
 * point of keeping it separate from the health probes.
 *
 * Sensor counts are deliberately absent: sensors live in an Aurora table this
 * function cannot reach, and reporting a deploy-config number here would drift
 * from what the Sensors tab shows the moment anyone added one.
 */
export function buildInfo() {
  return SystemInfoResponseSchema.parse({
    service: process.env.SERVICE_NAME ?? 'admin-api',
    api_version: process.env.API_VERSION ?? 'v1',
    build_id: process.env.BUILD_ID ?? 'unknown',
    region: process.env.AWS_REGION ?? 'unknown',
    server_timestamp: new Date().toISOString(),
    endpoints: {
      http_api: process.env.HTTP_API_URL || null,
      sensor_http_api: process.env.SENSOR_HTTP_API_URL || null,
      websocket_api: process.env.WS_API_URL || null,
      admin_console: process.env.CONSOLE_URL || null,
    },
    topics: {
      sensor: process.env.SENSOR_TOPIC_ARN || null,
      spat: process.env.SPAT_TOPIC_ARN || null,
      control: process.env.CONTROL_TOPIC_ARN || null,
    },
  });
}


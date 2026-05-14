import { z } from 'zod';
import { extendZodWithOpenApi } from '@asteasolutions/zod-to-openapi';

extendZodWithOpenApi(z);

export const RadiusBroadcastRequestSchema = z
  .object({
    app_id: z.string().min(1).max(128).regex(/^[a-zA-Z0-9._-]+$/).openapi({
      example: 'msight-internal-testing-app',
    }),
    origin: z
      .object({
        lat: z.number().min(-90).max(90).openapi({ example: 42.2808 }),
        lon: z.number().min(-180).max(180).openapi({ example: -83.743 }),
      })
      .openapi('RadiusBroadcastOrigin'),
    radius_m: z.number().positive().openapi({
      example: 1000,
      description: 'Radius in meters for nearby client search.',
    }),
    limit: z.number().int().positive().max(5000).optional().openapi({
      example: 500,
      description: 'Maximum number of nearby clients to evaluate.',
    }),
    event_id: z.string().min(1).max(128).optional().openapi({
      example: 'evt-20260514-abc123',
      description:
        'Optional caller-supplied event identifier. Auto-generated (UUID v4) when omitted. ' +
        'The same event_id may be broadcast multiple times; clients decide how to handle duplicates.',
    }),
    message: z.unknown().openapi({
      description: 'Arbitrary client-defined message payload sent over websocket.',
      example: { type: 'alert', title: 'Hello from control plane' },
    }),
  })
  .openapi('RadiusBroadcastRequest');

export const RadiusBroadcastResponseSchema = z
  .object({
    status: z.enum(['ok']).openapi({ example: 'ok' }),
    app_id: z.string().openapi({ example: 'msight-internal-testing-app' }),
    event_id: z.string().openapi({ example: 'evt-20260514-abc123' }),
    radius_m: z.number().openapi({ example: 1000 }),
    nearby_client_count: z.number().int().openapi({ example: 12 }),
    websocket_candidate_count: z.number().int().openapi({ example: 8 }),
    delivered_count: z.number().int().openapi({ example: 7 }),
    failed_count: z.number().int().openapi({ example: 1 }),
    server_timestamp: z.iso.datetime({ offset: true }).openapi({
      example: '2026-04-04T15:45:00.000Z',
    }),
    api_version: z.string().openapi({ example: 'v1' }),
  })
  .openapi('RadiusBroadcastResponse');

export type RadiusBroadcastRequest = z.infer<typeof RadiusBroadcastRequestSchema>;
export type RadiusBroadcastResponse = z.infer<typeof RadiusBroadcastResponseSchema>;

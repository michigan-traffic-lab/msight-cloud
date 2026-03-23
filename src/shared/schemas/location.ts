import { z } from 'zod';
import { extendZodWithOpenApi } from '@asteasolutions/zod-to-openapi';

extendZodWithOpenApi(z);

export const FixTypeSchema = z
  .enum(['unknown', '2d', '3d', 'dgps', 'rtk_float', 'rtk_fixed', 'ppp'])
  .openapi('FixType');

export const LocationSourceSchema = z
  .enum(['gps', 'network', 'fused', 'manual', 'unknown'])
  .openapi('LocationSource');

export const LocationSchema = z
  .object({
    lat: z.number().min(-90).max(90).openapi({
      example: 42.2808,
      description: 'Latitude in decimal degrees.',
    }),

    lon: z.number().min(-180).max(180).openapi({
      example: -83.743,
      description: 'Longitude in decimal degrees.',
    }),

    alt: z.number().optional().openapi({
      example: 255.4,
      description: 'Altitude in meters above mean sea level.',
    }),

    horizontal_accuracy_m: z.number().positive().optional().openapi({
      example: 3.5,
      description: 'Estimated horizontal accuracy in meters.',
    }),

    vertical_accuracy_m: z.number().positive().optional().openapi({
      example: 5.2,
      description: 'Estimated vertical accuracy in meters.',
    }),

    confidence: z.number().min(0).max(1).optional().openapi({
      example: 0.94,
      description: 'Normalized confidence score from 0 to 1.',
    }),

    speed_mps: z.number().min(0).optional().openapi({
      example: 12.1,
      description: 'Ground speed in meters per second.',
    }),

    speed_accuracy_mps: z.number().min(0).optional().openapi({
      example: 0.8,
      description: 'Estimated speed accuracy in meters per second.',
    }),

    heading_deg: z.number().min(0).max(360).optional().openapi({
      example: 87.2,
      description: 'Heading in degrees clockwise from north.',
    }),

    heading_accuracy_deg: z.number().min(0).optional().openapi({
      example: 4.0,
      description: 'Estimated heading accuracy in degrees.',
    }),

    fix_type: FixTypeSchema.optional().openapi({
      example: '3d',
      description: 'GNSS fix quality classification.',
    }),

    satellites_visible: z.number().int().min(0).optional().openapi({
      example: 14,
      description: 'Number of visible satellites.',
    }),

    hdop: z.number().min(0).optional().openapi({
      example: 0.9,
      description: 'Horizontal dilution of precision.',
    }),

    vdop: z.number().min(0).optional().openapi({
      example: 1.2,
      description: 'Vertical dilution of precision.',
    }),

    pdop: z.number().min(0).optional().openapi({
      example: 1.5,
      description: 'Position dilution of precision.',
    }),

    source: LocationSourceSchema.optional().openapi({
      example: 'gps',
      description: 'Source of the location solution.',
    }),
  })
  .openapi('Location');

export const LocationUpdateRequestSchema = z
  .object({
    app_id: z.string().min(1).max(128).regex(/^[a-zA-Z0-9._-]+$/).openapi({
      example: 'msight-demo',
    }),

    client_id: z
      .string()
      .min(1)
      .max(128)
      .regex(/^[a-zA-Z0-9._:-]+$/)
      .openapi({
        example: 'client-001',
      }),

    timestamp: z.iso.datetime({ offset: true }).openapi({
      example: '2026-03-22T18:30:00.000Z',
      description: 'Client-generated event timestamp in ISO 8601 format.',
    }),

    location: LocationSchema,
  })
  .openapi('LocationUpdateRequest');

export const AckResponseSchema = z
  .object({
    status: z.enum(['accepted']).openapi({
      example: 'accepted',
    }),
    message: z.string().openapi({
      example: 'Location update accepted.',
    }),
    request_id: z.uuid().openapi({
      example: 'b7d4d44f-3c5f-4fd4-a503-0e7e4bcb6b74',
    }),
    server_timestamp: z.iso.datetime({ offset: true }).openapi({
      example: '2026-03-22T18:30:00.123Z',
    }),
    api_version: z.string().openapi({
      example: 'v1',
    }),
  })
  .openapi('AckResponse');

export const HealthResponseSchema = z
  .object({
    status: z.enum(['ok']).openapi({
      example: 'ok',
    }),
    message: z.string().openapi({
      example: 'Service is healthy.',
    }),
    service: z.string().openapi({
      example: 'location-api',
    }),
    api_version: z.string().openapi({
      example: 'v1',
    }),
    server_timestamp: z.iso.datetime({ offset: true }).openapi({
      example: '2026-03-22T18:30:00.123Z',
    }),
  })
  .openapi('HealthResponse');

export type LocationUpdateRequest = z.infer<typeof LocationUpdateRequestSchema>;
export type AckResponse = z.infer<typeof AckResponseSchema>;
export type HealthResponse = z.infer<typeof HealthResponseSchema>;
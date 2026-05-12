import { z } from 'zod';
import { extendZodWithOpenApi } from '@asteasolutions/zod-to-openapi';

extendZodWithOpenApi(z);

export const MapRecordSchema = z
  .object({
    id: z.number().int().openapi({ example: 1 }),
    name: z.string().openapi({ example: 'downtown-ann-arbor' }),
    data: z.unknown().openapi({
      description: 'Full map message payload as stored.',
      example: { type: 'intersection', lanes: 4 },
    }),
    center_lat: z.number().openapi({ example: 42.302615 }),
    center_lon: z.number().openapi({ example: -83.704366 }),
    created_at: z.string().openapi({ example: '2026-05-13T00:00:00.000Z' }),
    updated_at: z.string().openapi({ example: '2026-05-13T00:00:00.000Z' }),
  })
  .openapi('MapRecord');

export const MapsByNameResponseSchema = z
  .object({
    status: z.enum(['ok']).openapi({ example: 'ok' }),
    map: MapRecordSchema,
    server_timestamp: z.string().openapi({ example: '2026-05-13T00:00:00.000Z' }),
  })
  .openapi('MapsByNameResponse');

export const MapsSearchQuerySchema = z
  .object({
    lat: z.coerce
      .number()
      .min(-90)
      .max(90)
      .openapi({ description: 'Latitude of the search origin.', example: 42.302615 }),
    lon: z.coerce
      .number()
      .min(-180)
      .max(180)
      .openapi({ description: 'Longitude of the search origin.', example: -83.704366 }),
    radius: z.coerce
      .number()
      .positive()
      .default(30)
      .openapi({
        description: 'Search radius in meters. Defaults to 30.',
        example: 500,
      }),
  })
  .openapi('MapsSearchQuery');

export const MapsSearchResponseSchema = z
  .object({
    status: z.enum(['ok']).openapi({ example: 'ok' }),
    count: z.number().int().openapi({ example: 3 }),
    maps: z.array(MapRecordSchema),
    query: z.object({
      lat: z.number(),
      lon: z.number(),
      radius_m: z.number(),
    }),
    server_timestamp: z.string().openapi({ example: '2026-05-13T00:00:00.000Z' }),
  })
  .openapi('MapsSearchResponse');

export type MapRecord = z.infer<typeof MapRecordSchema>;
export type MapsByNameResponse = z.infer<typeof MapsByNameResponseSchema>;
export type MapsSearchQuery = z.infer<typeof MapsSearchQuerySchema>;
export type MapsSearchResponse = z.infer<typeof MapsSearchResponseSchema>;

import { z } from 'zod';
import { extendZodWithOpenApi } from '@asteasolutions/zod-to-openapi';

extendZodWithOpenApi(z);

export const VersionResponseSchema = z
  .object({
    service: z.string().openapi({
      example: 'system-api',
    }),
    api_version: z.string().openapi({
      example: 'v1',
    }),
    build_id: z.string().openapi({
      example: '5a11f8c4b31e',
    }),
    server_timestamp: z.iso.datetime({ offset: true }).openapi({
      example: '2026-04-02T01:23:45.678Z',
    }),
  })
  .openapi('VersionResponse');

export type VersionResponse = z.infer<typeof VersionResponseSchema>;
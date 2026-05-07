import { z } from 'zod';
import { extendZodWithOpenApi } from '@asteasolutions/zod-to-openapi';

extendZodWithOpenApi(z);

export const SdsmRefPosSchema = z
  .object({
    lat: z.number().openapi({ example: 42.30259 }),
    long: z.number().openapi({ example: -83.704376 }),
  })
  .openapi('SdsmRefPos');

export const SdsmTimestampSchema = z
  .object({
    year: z.number().int(),
    month: z.number().int(),
    day: z.number().int(),
    hour: z.number().int(),
    minute: z.number().int(),
    second: z.number(),
    offset: z.number(),
  })
  .openapi('SdsmTimestamp');

export const SdsmMessageSchema = z
  .object({
    type: z.literal('sdsm').openapi({ example: 'sdsm' }),
    sensor_name: z.string().min(1).openapi({ example: 'ouster_huronPkwy_plymouth' }),
    device_name: z.string().min(1).openapi({ example: 'sip_edge_server_1' }),
    capture_timestamp: z.number().openapi({ example: 1778139886.965926 }),
    creation_timestamp: z.number().openapi({ example: 1778139886.965926 }),
    frame_id: z.string().openapi({ example: '7458059240456851457' }),
    sdsm: z
      .object({
        msgCnt: z.number().int().optional(),
        sourceID: z.string().optional(),
        equipmentType: z.string().optional(),
        sDSMTimeStamp: SdsmTimestampSchema.optional(),
        refPos: SdsmRefPosSchema,
        refPosXYConf: z.record(z.string(), z.unknown()).optional(),
        objects: z.array(z.record(z.string(), z.unknown())).optional(),
      })
      .passthrough()
      .openapi('SdsmPayload'),
  })
  .openapi('SdsmMessage');

export type SdsmMessage = z.infer<typeof SdsmMessageSchema>;

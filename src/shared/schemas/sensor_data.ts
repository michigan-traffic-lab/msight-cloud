import { z } from 'zod';
import { extendZodWithOpenApi } from '@asteasolutions/zod-to-openapi';

extendZodWithOpenApi(z);

export const SensorDataSchema = z
  .object({
    sensor_name: z.string().min(1).openapi({
      example: 'temperature-sensor-01',
      description: 'Unique name identifying the sensor.',
    }),
    capture_time: z.string().min(1).openapi({
      example: '2026-05-06T12:00:00.000Z',
      description: 'ISO 8601 timestamp when the sensor reading was captured.',
    }),
    creation_time: z.string().min(1).openapi({
      example: '2026-05-06T12:00:00.123Z',
      description: 'ISO 8601 timestamp when the data payload was created.',
    }),
    device_name: z.string().min(1).openapi({
      example: 'device-node-42',
      description: 'Identifier of the device that produced the sensor reading.',
    }),
  })
  .passthrough()
  .openapi('SensorData');

export type SensorData = z.infer<typeof SensorDataSchema>;

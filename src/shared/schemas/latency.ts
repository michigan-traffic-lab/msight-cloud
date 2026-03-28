import { z } from 'zod';
import { extendZodWithOpenApi } from '@asteasolutions/zod-to-openapi';

extendZodWithOpenApi(z);

export const LatencyProbeResponseSchema = z
  .object({
    status: z.enum(['ok']).openapi({
      example: 'ok',
    }),
    message: z.string().openapi({
      example: 'Latency probe response generated.',
    }),
    request_id: z.string().openapi({
      example: 'M92tbjliIAMEM6A=',
    }),
    service: z.string().openapi({
      example: 'latency-api',
    }),
    api_version: z.string().openapi({
      example: 'v1',
    }),
    build_id: z.string().openapi({
      example: '5a11f8c4b31e',
    }),
    server_received_timestamp: z.iso.datetime({ offset: true }).openapi({
      example: '2026-03-28T14:40:01.120Z',
      description: 'Timestamp captured when the request was received.',
    }),
    server_response_timestamp: z.iso.datetime({ offset: true }).openapi({
      example: '2026-03-28T14:40:01.122Z',
      description: 'Timestamp captured right before the response is sent.',
    }),
    connectivity: z
      .object({
        source_ip: z.string().openapi({
          example: '198.51.100.24',
        }),
        user_agent: z.string().openapi({
          example: 'curl/8.7.1',
        }),
        protocol: z.string().openapi({
          example: 'HTTP/1.1',
        }),
        stage: z.string().openapi({
          example: '$default',
        }),
        domain_name: z.string().openapi({
          example: 'abc123.execute-api.us-east-1.amazonaws.com',
        }),
      })
      .openapi('LatencyConnectivity'),
    echo: z
      .object({
        client_sent_at: z.string().optional().openapi({
          example: '2026-03-28T14:40:01.095Z',
          description: 'Optional query value from client for RTT calculations.',
        }),
        seq: z.string().optional().openapi({
          example: '42',
          description: 'Optional sequence id echoed back from query string.',
        }),
      })
      .openapi('LatencyEcho'),
  })
  .openapi('LatencyProbeResponse');

export type LatencyProbeResponse = z.infer<typeof LatencyProbeResponseSchema>;
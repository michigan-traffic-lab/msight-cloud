import type {
  APIGatewayProxyEventV2,
  APIGatewayProxyStructuredResultV2,
} from 'aws-lambda';
import { SensorDataSchema } from '../../shared/schemas/sensor_data';

function jsonResponse(
  statusCode: number,
  body: unknown
): APIGatewayProxyStructuredResultV2 {
  return {
    statusCode,
    headers: {
      'content-type': 'application/json',
    },
    body: JSON.stringify(body),
  };
}

export async function handler(
  event: APIGatewayProxyEventV2
): Promise<APIGatewayProxyStructuredResultV2> {
  const partitionKey = event.queryStringParameters?.['partition_key'] ?? null;

  const parsedJson = (() => {
    try {
      return JSON.parse(event.body ?? '{}');
    } catch {
      return null;
    }
  })();

  if (!parsedJson) {
    return jsonResponse(400, {
      error: 'invalid_json',
      message: 'Request body must be valid JSON.',
    });
  }

  const parsed = SensorDataSchema.safeParse(parsedJson);

  if (!parsed.success) {
    return jsonResponse(400, {
      error: 'validation_error',
      message: 'Request body failed schema validation.',
      details: parsed.error.flatten(),
    });
  }

  console.log('Received sensor data', {
    partition_key: partitionKey,
    payload: parsed.data,
  });

  return jsonResponse(200, {
    status: 'ok',
    message: 'Sensor data received.',
  });
}

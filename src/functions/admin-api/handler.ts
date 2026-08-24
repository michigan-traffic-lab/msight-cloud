import type {
  APIGatewayProxyEventV2WithJWTAuthorizer,
  APIGatewayProxyStructuredResultV2,
} from 'aws-lambda';
import {
  HttpError,
  json,
  type Middleware,
  type MutableContext,
} from './http';
import { authenticate } from './middleware/auth';
import { buildRouter } from './routes';
import { runMiddleware } from './router';

const API_VERSION = process.env.API_VERSION ?? 'v1';
const SERVICE_NAME = process.env.SERVICE_NAME ?? 'admin-api';

// Built once per container, not per request.
const router = buildRouter(API_VERSION);

/**
 * Middleware applied to every route, in order.
 *
 * `authenticate` runs first and unconditionally: there is no public route on
 * this API, and adding one would mean adding a route module that opts out
 * explicitly rather than forgetting to opt in.
 */
const globalMiddleware: Middleware[] = [authenticate];

function buildContext(
  event: APIGatewayProxyEventV2WithJWTAuthorizer
): MutableContext {
  const rawBody = event.body
    ? event.isBase64Encoded
      ? Buffer.from(event.body, 'base64').toString('utf8')
      : event.body
    : null;

  return {
    method: event.requestContext.http.method.toUpperCase(),
    path: event.rawPath.replace(/\/+$/, '') || '/',
    params: {},
    query: event.queryStringParameters ?? {},
    rawBody,
    event,
    caller: null,
  };
}

export async function handler(
  event: APIGatewayProxyEventV2WithJWTAuthorizer
): Promise<APIGatewayProxyStructuredResultV2> {
  const ctx = buildContext(event);

  try {
    return await runMiddleware(globalMiddleware, ctx, (finalCtx) =>
      router.dispatch(finalCtx)
    );
  } catch (error) {
    if (error instanceof HttpError) {
      return json(error.status, { error: error.code, message: error.message });
    }

    // Anything else is a bug on our side: log it with context, tell the caller
    // nothing beyond the fact that it failed.
    console.error('admin-api unhandled error', {
      service: SERVICE_NAME,
      method: ctx.method,
      path: ctx.path,
      caller: ctx.caller?.username ?? null,
      name: error instanceof Error ? error.name : 'UnknownError',
      message: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined,
    });

    return json(500, {
      error: 'internal_error',
      message: 'The request could not be completed.',
    });
  }
}

/** Exported for tests and diagnostics: every route this function serves. */
export function registeredRoutes(): string[] {
  return router.list();
}

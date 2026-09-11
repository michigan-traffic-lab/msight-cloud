import type {
  APIGatewayProxyEventV2WithJWTAuthorizer,
  APIGatewayProxyStructuredResultV2,
} from 'aws-lambda';
import {
  HttpError,
  json,
  type Middleware,
  type MutableContext,
} from '../../shared/admin-api/http';
import { authenticate } from '../../shared/admin-api/middleware/auth';
import { buildVpcRouter } from './routes';
import { reconcileAll } from './services/reconcile';
import { reconcileLaunches } from './services/provisioning';
import { runMiddleware } from '../../shared/admin-api/router';

const API_VERSION = process.env.API_VERSION ?? 'v1';
const SERVICE_NAME = process.env.SERVICE_NAME ?? 'admin-vpc-api';

// Built once per container, not per request.
const router = buildVpcRouter(API_VERSION);

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

/**
 * EventBridge invokes this function on a schedule to converge sensor
 * infrastructure with the registry, and to finish any microservice launch that
 * is mid-flight. That arrives as a bare object rather than an API Gateway
 * event, so it is handled before the router — which would otherwise fail
 * trying to read HTTP fields that are not there.
 */
function isScheduledReconcile(event: unknown): boolean {
  return (
    typeof event === 'object' &&
    event !== null &&
    (event as { action?: unknown }).action === 'reconcile'
  );
}

export async function handler(
  event: APIGatewayProxyEventV2WithJWTAuthorizer
): Promise<APIGatewayProxyStructuredResultV2> {
  if (isScheduledReconcile(event)) {
    /**
     * Three things converge here, and each one's failure is isolated.
     *
     * They share nothing but the schedule: sensor queues and consumers, the
     * per-bucket S3 upload listeners whose lifecycle is a count of the sensors
     * archiving there, and microservice launches waiting on a build. A GitHub
     * outage that fails a launch must not be the reason sensor ingest stops
     * converging, so neither half can throw past the other.
     */
    const result: Record<string, unknown> = {};
    let failed = false;

    try {
      Object.assign(result, await reconcileAll());
    } catch (error) {
      failed = true;
      result.sensors_error = error instanceof Error ? error.message : String(error);
      console.error('scheduled reconcile failed', error);
    }

    try {
      /**
       * The half that makes a launch survive a closed tab.
       *
       * The console polls the status endpoint while it is open, which advances
       * a launch within seconds. This is what advances it when nobody is
       * looking, and what repairs one whose request died mid-step.
       */
      Object.assign(result, await reconcileLaunches());
    } catch (error) {
      failed = true;
      result.launches_error = error instanceof Error ? error.message : String(error);
      console.error('scheduled launch reconcile failed', error);
    }

    return json(failed ? 500 : 200, result);
  }

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

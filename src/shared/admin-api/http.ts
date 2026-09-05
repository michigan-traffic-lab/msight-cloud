import type {
  APIGatewayProxyEventV2WithJWTAuthorizer,
  APIGatewayProxyStructuredResultV2,
} from 'aws-lambda';
import type { AdminRole } from '../../shared/schemas/admin';

/** The signed-in caller, resolved from JWT claims by the auth middleware. */
export interface Caller {
  username: string;
  email: string | null;
  groups: string[];
  role: AdminRole;
}

/**
 * Context threaded through middleware and into route handlers.
 *
 * `caller` is null only between the start of the middleware chain and the auth
 * middleware that populates it. Route handlers receive {@link RequestContext},
 * where it is guaranteed present.
 */
export interface MutableContext {
  method: string;
  /** Path with any trailing slash removed. */
  path: string;
  /** Values captured from `:name` segments in the matched route pattern. */
  params: Record<string, string>;
  query: Record<string, string | undefined>;
  rawBody: string | null;
  event: APIGatewayProxyEventV2WithJWTAuthorizer;
  caller: Caller | null;
}

export interface RequestContext extends MutableContext {
  caller: Caller;
}

export type HttpResult = APIGatewayProxyStructuredResultV2;
export type Next = () => Promise<HttpResult>;
export type Middleware = (ctx: MutableContext, next: Next) => Promise<HttpResult>;
export type RouteHandler = (ctx: RequestContext) => Promise<HttpResult>;

/**
 * Thrown anywhere in the stack to produce a structured error response. Anything
 * else that escapes a handler becomes a 500 with no detail leaked.
 */
export class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string
  ) {
    super(message);
    this.name = 'HttpError';
  }
}

export function json(statusCode: number, body: unknown): HttpResult {
  return {
    statusCode,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  };
}

export function ok(body: unknown): HttpResult {
  return json(200, body);
}

export function created(body: unknown): HttpResult {
  return json(201, body);
}

export function errorBody(code: string, message: string): HttpResult['body'] {
  return JSON.stringify({ error: code, message });
}

/** Parses the request body as JSON. Absent bodies become `{}`. */
export function readJsonBody(ctx: MutableContext): unknown {
  if (!ctx.rawBody) {
    return {};
  }
  try {
    return JSON.parse(ctx.rawBody);
  } catch {
    throw new HttpError(400, 'invalid_json', 'The request body is not valid JSON.');
  }
}

/**
 * Validates a body against a zod schema, turning the first issue into a 400.
 * Typed loosely so route modules can pass any schema without a generic dance.
 */
export function parseWith<T>(
  schema: { safeParse: (input: unknown) => { success: true; data: T } | { success: false; error: { issues: Array<{ message: string }> } } },
  input: unknown
): T {
  const result = schema.safeParse(input);
  if (!result.success) {
    throw new HttpError(400, 'invalid_request', result.error.issues[0].message);
  }
  return result.data;
}

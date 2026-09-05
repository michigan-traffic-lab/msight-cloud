import {
  HttpError,
  type Middleware,
  type MutableContext,
  type HttpResult,
  type Next,
  type RequestContext,
  type RouteHandler,
} from './http';

interface Route {
  method: string;
  /** Pattern split into segments; `:name` segments capture a parameter. */
  segments: string[];
  handler: RouteHandler;
  middleware: Middleware[];
  description: string;
}

export interface RouteOptions {
  /** Middleware applied to this route only, after any global middleware. */
  middleware?: Middleware[];
  description?: string;
}

/**
 * Runs a middleware chain, onion style: each middleware may act before and
 * after calling `next`, and may short-circuit by not calling it at all.
 */
export async function runMiddleware(
  middleware: Middleware[],
  ctx: MutableContext,
  terminal: (ctx: MutableContext) => Promise<HttpResult>
): Promise<HttpResult> {
  let index = -1;

  const dispatch = async (position: number): Promise<HttpResult> => {
    if (position <= index) {
      throw new Error('next() called more than once in the same middleware');
    }
    index = position;

    const fn = middleware[position];
    if (!fn) {
      return terminal(ctx);
    }

    const next: Next = () => dispatch(position + 1);
    return fn(ctx, next);
  };

  return dispatch(0);
}

function splitPath(path: string): string[] {
  return path.split('/').filter((segment) => segment.length > 0);
}

/**
 * Small path router. Patterns use `:name` for a single captured segment, e.g.
 * `/v1/admin/users/:username/role`. Routes are matched in registration order,
 * so register more specific patterns first when two could both match.
 */
export class Router {
  private readonly routes: Route[] = [];

  register(
    method: string,
    pattern: string,
    handler: RouteHandler,
    options: RouteOptions = {}
  ): this {
    this.routes.push({
      method: method.toUpperCase(),
      segments: splitPath(pattern),
      handler,
      middleware: options.middleware ?? [],
      description: options.description ?? `${method.toUpperCase()} ${pattern}`,
    });
    return this;
  }

  get(pattern: string, handler: RouteHandler, options?: RouteOptions): this {
    return this.register('GET', pattern, handler, options);
  }

  post(pattern: string, handler: RouteHandler, options?: RouteOptions): this {
    return this.register('POST', pattern, handler, options);
  }

  put(pattern: string, handler: RouteHandler, options?: RouteOptions): this {
    return this.register('PUT', pattern, handler, options);
  }

  patch(pattern: string, handler: RouteHandler, options?: RouteOptions): this {
    return this.register('PATCH', pattern, handler, options);
  }

  delete(pattern: string, handler: RouteHandler, options?: RouteOptions): this {
    return this.register('DELETE', pattern, handler, options);
  }

  /** Merges another router's routes in, so route modules stay in their own files. */
  merge(other: Router): this {
    this.routes.push(...other.exportRoutes());
    return this;
  }

  exportRoutes(): Route[] {
    return this.routes;
  }

  /** Every registered route, for diagnostics and tests. */
  list(): string[] {
    return this.routes.map((route) => route.description);
  }

  private match(
    method: string,
    segments: string[]
  ): { route: Route; params: Record<string, string> } | null {
    let pathMatchedButMethodDidNot = false;

    for (const route of this.routes) {
      if (route.segments.length !== segments.length) {
        continue;
      }

      const params: Record<string, string> = {};
      let matched = true;

      for (let i = 0; i < route.segments.length; i += 1) {
        const patternSegment = route.segments[i];
        const actualSegment = segments[i];

        if (patternSegment.startsWith(':')) {
          const value = decodeURIComponent(actualSegment);
          if (value.length === 0) {
            matched = false;
            break;
          }
          params[patternSegment.slice(1)] = value;
          continue;
        }

        if (patternSegment !== actualSegment) {
          matched = false;
          break;
        }
      }

      if (!matched) {
        continue;
      }

      if (route.method !== method) {
        pathMatchedButMethodDidNot = true;
        continue;
      }

      return { route, params };
    }

    if (pathMatchedButMethodDidNot) {
      throw new HttpError(
        405,
        'method_not_allowed',
        `${method} is not supported for this path.`
      );
    }

    return null;
  }

  async dispatch(ctx: MutableContext): Promise<HttpResult> {
    const found = this.match(ctx.method, splitPath(ctx.path));

    if (!found) {
      throw new HttpError(
        404,
        'not_found',
        `No route for ${ctx.method} ${ctx.path}.`
      );
    }

    if (!ctx.caller) {
      // The auth middleware is registered globally; reaching a route without a
      // caller means the chain was mis-assembled, not that the request is bad.
      throw new HttpError(
        500,
        'auth_middleware_missing',
        'Request reached a route without an authenticated caller.'
      );
    }

    ctx.params = found.params;

    return runMiddleware(found.route.middleware, ctx, (finalCtx) =>
      found.route.handler(finalCtx as RequestContext)
    );
  }
}

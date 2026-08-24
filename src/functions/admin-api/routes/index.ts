import { Router } from '../router';
import { identityRoutes } from './identity.routes';
import { systemRoutes } from './system.routes';
import { userRoutes } from './users.routes';

/**
 * Assembles every route module into one router.
 *
 * To add a feature area: create `<area>.routes.ts` next to this file, export a
 * `(base: string) => Router` factory, and merge it below. API Gateway forwards
 * the whole `/v1/admin/*` prefix to this function, so no CDK change is needed.
 */
export function buildRouter(apiVersion: string): Router {
  const base = `/${apiVersion}/admin`;

  return new Router()
    .merge(identityRoutes(base))
    .merge(systemRoutes(base))
    .merge(userRoutes(base));
}

import { Router } from '../../../shared/admin-api/router';
import { auroraRoutes } from './aurora.routes';
import { clientRoutes } from './clients.routes';
import { mapRoutes } from './maps.routes';
import { valkeyRoutes } from './valkey.routes';

/**
 * Routes served by the in-VPC admin function.
 *
 * This function exists because Valkey and Aurora are reachable only from inside
 * the VPC. Everything that does not need them stays on the out-of-VPC function,
 * which starts faster and reaches AWS APIs directly.
 */
export function buildVpcRouter(apiVersion: string): Router {
  const base = `/${apiVersion}/admin`;
  return new Router().merge(clientRoutes(base)).merge(auroraRoutes(base)).merge(valkeyRoutes(base)).merge(mapRoutes(base));
}

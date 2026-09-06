import { Router } from '../../../shared/admin-api/router';
import { auroraRoutes } from './aurora.routes';
import { clientRoutes } from './clients.routes';
import { mapRoutes } from './maps.routes';
import { sensorRoutes } from './sensors.routes';
import { valkeyRoutes } from './valkey.routes';

/**
 * Routes served by the in-VPC admin function.
 *
 * This function exists because Valkey and Aurora are reachable only from inside
 * the VPC. Everything that does not need them stays on the out-of-VPC function,
 * which starts faster and reaches AWS APIs directly.
 *
 * Sensors live here rather than on the other function because the sensor
 * registry is an Aurora table.
 */
export function buildVpcRouter(apiVersion: string): Router {
  const base = `/${apiVersion}/admin`;
  return new Router()
    .merge(clientRoutes(base))
    .merge(auroraRoutes(base))
    .merge(valkeyRoutes(base))
    .merge(mapRoutes(base))
    .merge(sensorRoutes(base));
}

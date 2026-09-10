import { Router } from '../../../shared/admin-api/router';
import { appRoutes } from './apps.routes';
import { auroraRoutes } from './aurora.routes';
import { clientRoutes } from './clients.routes';
import { clusterRoutes } from './clusters.routes';
import { githubRoutes } from './github.routes';
import { mapRoutes } from './maps.routes';
import { microserviceRoutes } from './microservices.routes';
import { sensorRoutes } from './sensors.routes';
import { storageRoutes } from './storage.routes';
import { valkeyRoutes } from './valkey.routes';

/**
 * Routes served by the in-VPC admin function.
 *
 * This function exists because Valkey and Aurora are reachable only from inside
 * the VPC. Everything that does not need them stays on the out-of-VPC function,
 * which starts faster and reaches AWS APIs directly.
 *
 * Microservices and the GitHub connection are here for the same reason: the
 * registry and the installation records are Aurora tables. GitHub itself is
 * NOT reachable from in here — this stack runs `natGateways: 0` with isolated
 * subnets — so those routes reach it by invoking the out-of-VPC `github-api`
 * function, which has internet and no database.
 *
 * Sensors live here rather than on the other function because the sensor
 * registry is an Aurora table. Storage is here for the same reason — the bucket
 * registry and the upload catalog are Aurora tables, even though S3 itself is
 * reachable from anywhere.
 */
export function buildVpcRouter(apiVersion: string): Router {
  const base = `/${apiVersion}/admin`;
  return new Router()
    .merge(clientRoutes(base))
    .merge(clusterRoutes(base))
    .merge(auroraRoutes(base))
    .merge(valkeyRoutes(base))
    .merge(mapRoutes(base))
    .merge(sensorRoutes(base))
    .merge(appRoutes(base))
    .merge(storageRoutes(base))
    .merge(githubRoutes(base))
    .merge(microserviceRoutes(base));
}

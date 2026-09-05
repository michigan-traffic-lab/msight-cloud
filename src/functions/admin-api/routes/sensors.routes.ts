import { ok } from '../../../shared/admin-api/http';
import { Router } from '../../../shared/admin-api/router';
import { getSensors } from '../services/sensors';

/**
 * Sensor inventory and the wiring each one depends on.
 *
 * Readable by any signed-in user: knowing which sensors exist and how to
 * publish to them is onboarding information, not privileged operational access.
 */
export function sensorRoutes(base: string): Router {
  const router = new Router();

  router.get(`${base}/sensors`, async () => ok(await getSensors()));

  return router;
}

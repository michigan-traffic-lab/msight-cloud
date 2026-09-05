import { ok } from '../../../shared/admin-api/http';
import { Router } from '../../../shared/admin-api/router';
import { getSummary, lookupClient, sampleClients, searchRadius } from '../services/clients';

/**
 * Live WebSocket clients.
 *
 * There is deliberately no "list all clients" route. Counts come from constant
 * time commands; anything returning rows is bounded by an explicit limit. That
 * keeps the page's cost independent of how many clients are connected, and
 * keeps console traffic off the critical path of the SPaT broadcast, which
 * shares this Valkey.
 */
export function clientRoutes(base: string): Router {
  const router = new Router();

  router.get(`${base}/clients/summary`, async () => ok(await getSummary()));

  router.get(`${base}/clients/search`, async (ctx) =>
    ok(
      await searchRadius({
        appId: ctx.query.app_id,
        lat: ctx.query.lat,
        lon: ctx.query.lon,
        radiusM: ctx.query.radius_m,
        limit: ctx.query.limit,
      })
    )
  );

  router.get(`${base}/clients/sample`, async (ctx) =>
    ok(
      await sampleClients({
        appId: ctx.query.app_id,
        cursor: ctx.query.cursor,
        limit: ctx.query.limit,
      })
    )
  );

  router.get(`${base}/clients/lookup`, async (ctx) =>
    ok(await lookupClient({ appId: ctx.query.app_id, clientId: ctx.query.client_id }))
  );

  return router;
}

import { ok } from '../../../shared/admin-api/http';
import { requireRole } from '../../../shared/admin-api/middleware/require-role';
import { Router } from '../../../shared/admin-api/router';
import { listAlarms, suppressAlarm, unsuppressAlarm } from '../services/alarms';

export function alarmRoutes(base: string): Router {
  const router = new Router();
  const admin = { middleware: [requireRole('admin')] };
  const operator = { middleware: [requireRole('operator')] };

  router.get(
    `${base}/alarms`,
    async (ctx) =>
      ok({
        alarms: await listAlarms({
          ...(ctx.query.state ? { state: ctx.query.state } : {}),
          ...(ctx.query.prefix ? { prefix: ctx.query.prefix } : {}),
        }),
      }),
    operator
  );

  router.post(
    `${base}/alarms/:name/suppress`,
    async (ctx) => {
      await suppressAlarm(ctx.params.name);
      return ok({ name: ctx.params.name, suppressed: true });
    },
    admin
  );

  router.post(
    `${base}/alarms/:name/unsuppress`,
    async (ctx) => {
      await unsuppressAlarm(ctx.params.name);
      return ok({ name: ctx.params.name, suppressed: false });
    },
    admin
  );

  return router;
}

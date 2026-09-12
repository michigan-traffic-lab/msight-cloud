import { HttpError, ok } from '../../../shared/admin-api/http';
import { requireRole } from '../../../shared/admin-api/middleware/require-role';
import { Router } from '../../../shared/admin-api/router';
import { getMicroserviceMetrics } from '../services/metrics';
import { microserviceNames } from '../../../shared/deployment-naming';
import { infraConfig } from '../services/provisioning';
import { requireMicroservice } from '../services/microservices';
import { computeClusterNames } from '../../../shared/deployment-naming';
import { requireCluster } from '../services/clusters';

const MAX_PERIOD = 86400;
const MIN_PERIOD = 60;

export function metricsRoutes(base: string): Router {
  const router = new Router();
  const operator = { middleware: [requireRole('operator')] };

  router.get(
    `${base}/microservices/:name/metrics`,
    async (ctx) => {
      const row = await requireMicroservice(ctx.params.name);

      if (!row.cluster_name || row.provision_state !== 'provisioned') {
        throw new HttpError(
          409,
          'not_deployed',
          `"${ctx.params.name}" is not deployed, so there are no metrics to read.`
        );
      }

      const config = infraConfig();
      const cluster = await requireCluster(row.cluster_name);
      const ecsClusterName = computeClusterNames(config.prefix, cluster.name).cluster;
      const ecsServiceName = microserviceNames(config.prefix, row.name).service;

      let period: number | undefined;
      let start: Date | undefined;
      let end: Date | undefined;

      if (ctx.query.period) {
        const p = Number(ctx.query.period);
        if (!Number.isFinite(p) || p < MIN_PERIOD || p > MAX_PERIOD) {
          throw new HttpError(
            400,
            'invalid_period',
            `period must be between ${MIN_PERIOD} and ${MAX_PERIOD} seconds.`
          );
        }
        period = Math.trunc(p);
      }

      if (ctx.query.start) {
        const d = new Date(ctx.query.start);
        if (isNaN(d.getTime())) {
          throw new HttpError(400, 'invalid_start', 'start must be an ISO 8601 timestamp.');
        }
        start = d;
      }

      if (ctx.query.end) {
        const d = new Date(ctx.query.end);
        if (isNaN(d.getTime())) {
          throw new HttpError(400, 'invalid_end', 'end must be an ISO 8601 timestamp.');
        }
        end = d;
      }

      return ok(
        await getMicroserviceMetrics({ ecsClusterName, ecsServiceName, period, start, end })
      );
    },
    operator
  );

  return router;
}

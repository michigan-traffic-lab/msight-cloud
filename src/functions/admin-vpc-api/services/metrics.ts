import {
  CloudWatchClient,
  GetMetricDataCommand,
  type MetricDataQuery,
} from '@aws-sdk/client-cloudwatch';

const cw = new CloudWatchClient({});

const DEFAULT_PERIOD = 300;
const DEFAULT_WINDOW_HOURS = 3;

export async function getMicroserviceMetrics(input: {
  ecsClusterName: string;
  ecsServiceName: string;
  period?: number;
  start?: Date;
  end?: Date;
}) {
  const end = input.end ?? new Date();
  const start =
    input.start ?? new Date(end.getTime() - DEFAULT_WINDOW_HOURS * 60 * 60 * 1000);
  const period = input.period ?? DEFAULT_PERIOD;

  const dimensions = [
    { Name: 'ClusterName', Value: input.ecsClusterName },
    { Name: 'ServiceName', Value: input.ecsServiceName },
  ];

  const queries: MetricDataQuery[] = [
    {
      Id: 'cpu',
      MetricStat: {
        Metric: { Namespace: 'AWS/ECS', MetricName: 'CPUUtilization', Dimensions: dimensions },
        Period: period,
        Stat: 'Average',
      },
    },
    {
      Id: 'memory',
      MetricStat: {
        Metric: {
          Namespace: 'AWS/ECS',
          MetricName: 'MemoryUtilization',
          Dimensions: dimensions,
        },
        Period: period,
        Stat: 'Average',
      },
    },
    {
      Id: 'running',
      MetricStat: {
        Metric: {
          Namespace: 'ECS/ContainerInsights',
          MetricName: 'RunningTaskCount',
          Dimensions: dimensions,
        },
        Period: period,
        Stat: 'Average',
      },
    },
    {
      Id: 'desired',
      MetricStat: {
        Metric: {
          Namespace: 'ECS/ContainerInsights',
          MetricName: 'DesiredTaskCount',
          Dimensions: dimensions,
        },
        Period: period,
        Stat: 'Average',
      },
    },
  ];

  const result = await cw.send(
    new GetMetricDataCommand({
      MetricDataQueries: queries,
      StartTime: start,
      EndTime: end,
      ScanBy: 'TimestampDescending',
    })
  );

  const byId = new Map(
    (result.MetricDataResults ?? []).map((r) => [r.Id ?? '', r])
  );

  const format = (id: string) => {
    const r = byId.get(id);
    if (!r) return [];
    return (r.Timestamps ?? []).map((ts, i) => ({
      timestamp: new Date(ts).toISOString(),
      value: r.Values?.[i] ?? null,
    }));
  };

  return {
    cpu_utilization: format('cpu'),
    memory_utilization: format('memory'),
    running_task_count: format('running'),
    desired_task_count: format('desired'),
    period_seconds: period,
    start: start.toISOString(),
    end: end.toISOString(),
  };
}

import {
  CloudWatchClient,
  DescribeAlarmsCommand,
  DisableAlarmActionsCommand,
  EnableAlarmActionsCommand,
  StateValue,
} from '@aws-sdk/client-cloudwatch';
import { HttpError } from '../../../shared/admin-api/http';

const cw = new CloudWatchClient({});

export async function listAlarms(filter?: { state?: string; prefix?: string }) {
  const params: {
    StateValue?: StateValue;
    AlarmNamePrefix?: string;
    MaxRecords?: number;
  } = { MaxRecords: 100 };

  if (filter?.state) {
    const valid: string[] = ['OK', 'ALARM', 'INSUFFICIENT_DATA'];
    if (!valid.includes(filter.state.toUpperCase())) {
      throw new HttpError(400, 'invalid_state', `state must be one of: ${valid.join(', ')}`);
    }
    params.StateValue = filter.state.toUpperCase() as StateValue;
  }
  if (filter?.prefix) {
    params.AlarmNamePrefix = filter.prefix;
  }

  const result = await cw.send(new DescribeAlarmsCommand(params));

  return (result.MetricAlarms ?? []).map((alarm) => ({
    name: alarm.AlarmName ?? null,
    description: alarm.AlarmDescription ?? null,
    state: alarm.StateValue ?? null,
    state_reason: alarm.StateReason ?? null,
    state_updated_at: alarm.StateUpdatedTimestamp
      ? new Date(alarm.StateUpdatedTimestamp).toISOString()
      : null,
    metric_name: alarm.MetricName ?? null,
    namespace: alarm.Namespace ?? null,
    dimensions:
      alarm.Dimensions?.map((d) => ({ name: d.Name ?? null, value: d.Value ?? null })) ?? [],
    threshold: alarm.Threshold ?? null,
    comparison_operator: alarm.ComparisonOperator ?? null,
    evaluation_periods: alarm.EvaluationPeriods ?? null,
    period: alarm.Period ?? null,
    statistic: alarm.Statistic ?? null,
    actions_enabled: alarm.ActionsEnabled ?? true,
    alarm_actions: alarm.AlarmActions ?? [],
  }));
}

export async function suppressAlarm(name: string): Promise<void> {
  await cw.send(new DisableAlarmActionsCommand({ AlarmNames: [name] }));
}

export async function unsuppressAlarm(name: string): Promise<void> {
  await cw.send(new EnableAlarmActionsCommand({ AlarmNames: [name] }));
}

/**
 * Queue naming for a sensor, shared by the CDK stack that creates the queue and
 * the admin API that looks it up. Deriving the name in two places would let
 * them drift, and the failure mode is silent: the console would report a
 * correctly-wired sensor as missing.
 */
export function sensorQueueName(sensorName: string): string {
  return `msight-sensor-${sensorName.replace(/_/g, '-').toLowerCase()}.fifo`;
}

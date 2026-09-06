/**
 * Tears down the sensor resources CloudFormation does not own.
 *
 * Sensor queues, subscriptions and ECS services are created at runtime by the
 * admin API, so `cdk destroy` knows nothing about them. Left alone they would
 * survive the stack: orphaned queues billing forever, and — worse — ECS
 * services still holding the cluster, which makes the cluster deletion fail and
 * the whole destroy stall in DELETE_FAILED.
 *
 * This is a CloudFormation custom resource that the stack deletes *first*, by
 * making the cluster and the topic depend on it. Its Delete converges the
 * deployment to an empty sensor list; Create and Update do nothing.
 *
 * Three properties matter here and each is deliberate:
 *
 * - **Idempotent.** CloudFormation retries a Delete that timed out, and the
 *   convergence is defined by an end state rather than by a sequence of steps,
 *   so a retry after a half-finished run finishes the job.
 * - **Never throws on a resource failure.** Throwing marks the custom resource
 *   DELETE_FAILED, which strands the entire stack and forces a manual retry
 *   with the resource skipped. A queue that will not delete is worth logging
 *   and leaving behind; it is not worth blocking teardown over.
 * - **Scoped by the deployment tag.** In an account with two MSight stacks,
 *   name prefixes may legitimately overlap. Only resources tagged with *this*
 *   deployment are touched.
 *
 * It runs outside the VPC on purpose. During a destroy the NAT gateway and
 * subnets are themselves being deleted, and a VPC-attached function would be
 * racing its own network path; the public SQS, SNS and ECS endpoints are not.
 */

import { DescribeServicesCommand } from '@aws-sdk/client-ecs';
import {
  converge,
  ecs,
  listClusterServices,
  listOwnedQueues,
  type SensorInfraConfig,
} from '../../shared/sensor-infrastructure';

interface CustomResourceEvent {
  RequestType: 'Create' | 'Update' | 'Delete';
  PhysicalResourceId?: string;
  ResourceProperties?: Record<string, unknown>;
}

const PHYSICAL_ID = 'msight-sensor-reaper';

function config(): SensorInfraConfig {
  const required = (key: string) => {
    const value = process.env[key];
    if (!value) throw new Error(`${key} is not set on the sensor reaper.`);
    return value;
  };

  return {
    deployment: required('DEPLOYMENT_NAME'),
    prefix: required('SENSOR_RESOURCE_PREFIX'),
    topicArn: required('SENSOR_TOPIC_ARN'),
    cluster: required('SENSOR_CLUSTER_NAME'),
    // Teardown never registers a task definition, so this is unused on the
    // delete path; it is required by the shared config shape.
    templateTaskDefinition: process.env.SENSOR_TASK_DEFINITION ?? 'unused',
    subnetIds: [],
    securityGroupIds: [],
  };
}

export async function onEvent(event: CustomResourceEvent) {
  if (event.RequestType !== 'Delete') {
    return { PhysicalResourceId: PHYSICAL_ID };
  }

  try {
    const result = await converge(config(), []);
    console.log(
      JSON.stringify({
        event: 'sensor_reaper_delete',
        deleted: result.deleted,
        failed: result.failed,
        actions: result.actions,
      })
    );
  } catch (error) {
    // Configuration or permission problems land here. Still not fatal: a
    // stranded stack is a worse outcome than a stranded queue, and the log
    // says exactly what was left behind.
    console.error(
      JSON.stringify({
        event: 'sensor_reaper_failed',
        message: error instanceof Error ? error.message : String(error),
      })
    );
  }

  return { PhysicalResourceId: PHYSICAL_ID };
}

/**
 * Polled by the provider framework until teardown has actually settled.
 *
 * `DeleteService` returns immediately but the service lingers in DRAINING while
 * its tasks stop, and CloudFormation cannot delete a cluster that still holds
 * one. Reporting complete too early would just move the failure downstream.
 */
export async function isComplete(event: CustomResourceEvent) {
  if (event.RequestType !== 'Delete') return { IsComplete: true };

  try {
    const settings = config();
    const queues = await listOwnedQueues(settings);
    if (queues.size > 0) {
      console.log(JSON.stringify({ event: 'sensor_reaper_waiting', queues: [...queues] }));
      return { IsComplete: false };
    }

    const services = [...(await listClusterServices(settings))].filter((serviceName) =>
      serviceName.startsWith(`${settings.prefix}-`)
    );
    if (services.length === 0) return { IsComplete: true };

    const described = await ecs.send(
      new DescribeServicesCommand({ cluster: settings.cluster, services })
    );
    const lingering = (described.services ?? [])
      .filter((service) => service.status !== 'INACTIVE')
      .map((service) => service.serviceName ?? '');

    if (lingering.length > 0) {
      console.log(JSON.stringify({ event: 'sensor_reaper_draining', services: lingering }));
      return { IsComplete: false };
    }

    return { IsComplete: true };
  } catch (error) {
    // The cluster may already be gone, in which case there is nothing left to
    // wait for. Treat any inability to look as done rather than looping until
    // the provider's total timeout.
    console.error(
      JSON.stringify({
        event: 'sensor_reaper_poll_failed',
        message: error instanceof Error ? error.message : String(error),
      })
    );
    return { IsComplete: true };
  }
}

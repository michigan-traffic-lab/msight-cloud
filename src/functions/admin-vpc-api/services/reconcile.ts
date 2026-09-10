import type { ConvergeResult } from '../../../shared/sensor-infrastructure';
import { reconcile as reconcileSensors } from './sensor-registry';
import { reconcileNotifications, type StorageNotifyResult } from './storage';

/**
 * Everything this deployment converges, in one call.
 *
 * The two halves are independent — sensor queues and consumers on one side, S3
 * upload listeners on the other — but they are driven by the same table and
 * therefore have to run together. Changing a sensor's ingest settings can
 * simultaneously mean "tear down a queue" and "this was the last sensor
 * archiving to that bucket, remove its listener", and a caller that remembered
 * only one of those would leave the other permanently wrong.
 *
 * Sensors converge first. If a sensor's teardown fails, its row is still the
 * desired state, so the storage half is computing from the same registry either
 * way — the order only decides which failure is reported first.
 */
export interface FullReconcileResult {
  sensors: ConvergeResult;
  storage: StorageNotifyResult;
}

export async function reconcileAll(): Promise<FullReconcileResult> {
  const sensors = await reconcileSensors();
  const storage = await reconcileNotifications();
  return { sensors, storage };
}

<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { useQuasar } from 'quasar';
import {
  api,
  type ReconcileResult,
  type SensorEntry,
  type SensorIngestPatch,
  type SensorMutation,
  type SensorsResponse,
  type StorageEntry,
} from '@/api/client';
import { useAsyncValue } from '@/composables/useAsyncValue';
import PageHeader from '@/components/PageHeader.vue';
import AsyncValue from '@/components/AsyncValue.vue';
import InfoHint from '@/components/InfoHint.vue';
import { useAuthStore } from '@/stores/auth';
import SectionCard from '@/components/SectionCard.vue';

const $q = useQuasar();

/**
 * Wording shared between tooltips and dialogs. Defined once because the same
 * question — "does this reconcile for me?" — is asked in three places, and
 * three separately-worded answers is how they end up contradicting each other.
 */
const HINTS = {
  registered:
    'Sensors in the registry table. This is the desired state — what should ' +
    'exist, not what does.',
  streaming:
    'Sensors set to stream in real time and not paused. Each one runs an SQS ' +
    'queue and a container that bill continuously, whether data is flowing or ' +
    'not.',
  archiving:
    'Sensors that upload aggregated files to an S3 bucket. Nothing runs between ' +
    'the edge device and the bucket, so an archive-only sensor costs storage ' +
    'and nothing else — which is why it is the default.',
  waiting:
    'Messages sitting in the SQS queues, summed across sensors. A steady number ' +
    'near zero is healthy — the consumers keep up. A number that only climbs ' +
    'means messages are arriving with nothing processing them.',
  drift:
    'Sensors where AWS does not match what you asked for: set to stream but ' +
    'missing a queue or consumer, or not streaming with resources still up. ' +
    'This is the only status that means something is wrong — an archive-only ' +
    'sensor with no queue is correct, not out of sync. Also counts queues with ' +
    'no registry row. Reconcile fixes these.',
  reconcile:
    'Compares the registry against AWS and makes AWS match: creates what is ' +
    'missing, deletes what should not exist, and installs or removes each ' +
    'bucket\'s upload listener according to how many sensors archive there. ' +
    'Safe to run any time — it does nothing when the two already agree. This ' +
    'also runs automatically every 5 minutes and after every change.',
  add:
    'Registers a sensor. An archive-only sensor needs no infrastructure at all ' +
    'and is ready immediately. Adding real-time streaming creates its SQS ' +
    'queue, topic subscription and consumer service within seconds — no ' +
    'redeploy.',
  pause:
    'Pause: tears down the queue, subscription and consumer, but keeps the ' +
    'sensor configured for streaming so it can be resumed. Queued messages are ' +
    'discarded and anything the field sensor publishes meanwhile is dropped. ' +
    'This affects real time only — S3 uploads go straight from the device to ' +
    'the bucket and nothing here can stop them.',
  resume:
    'Rebuilds the queue, subscription and consumer. Takes a minute or two ' +
    'before it starts processing.',
  remove:
    'Delete: removes the registry row AND all its infrastructure. The name is ' +
    'freed for reuse. Not reversible. Files already in S3 are untouched, and if ' +
    'this was the last sensor archiving to its bucket, that bucket\'s upload ' +
    'listener is removed too.',
  stream:
    'Real time: the device publishes to the SNS topic, which fans out to this ' +
    'sensor\'s SQS queue and a container that decodes and broadcasts each ' +
    'message. Low latency, and billed continuously for the queue and the ' +
    'container whether data flows or not. Turning it off tears both down.',
  archive:
    'Aggregated: the device writes files straight to an S3 bucket. Nothing runs ' +
    'in between, so it costs storage and nothing else — but the data is only ' +
    'available later, not live. This is the usual choice.',
  prefix:
    'The key prefix this sensor writes under, e.g. plymouth_barton/. S3 filters ' +
    'on it, so only uploads under this path are announced — and it maps a key ' +
    'back to this sensor later. Several sensors can share one bucket under ' +
    'different prefixes, but one prefix may not sit inside another: S3 refuses ' +
    'to filter on both. Leave it empty only if this sensor owns the bucket.',
  listener:
    'S3 gets one notification rule per archiving sensor, filtered to that ' +
    'sensor\'s prefix, so only what this sensor wrote is announced. The ' +
    'reconciler writes the rules from the registry, so changing a prefix ' +
    'rewires S3 and the order of your edits does not matter.',
};

const auth = useAuthStore();
// Pinia unwraps store computeds on access, so `auth.isAdmin` is a plain boolean.
// Capturing it in a const would freeze it at setup time and hide every admin
// control for anyone whose profile loads after this page mounts.
const isAdmin = computed(() => auth.isAdmin);

const sensors = useAsyncValue<SensorsResponse>((signal) => api.sensors(signal), {
  timeoutMs: 30000,
});

const selectedName = ref<string | null>(null);
const busy = ref(false);
const lastReconcile = ref<ReconcileResult | null>(null);

const list = computed<SensorEntry[]>(() => sensors.data.value?.sensors ?? []);

const selected = computed<SensorEntry | null>(
  () => list.value.find((sensor) => sensor.name === selectedName.value) ?? null
);

const backlog = computed(() =>
  list.value.reduce((sum, sensor) => sum + (sensor.messages_available ?? 0), 0)
);

/**
 * Registered storage buckets, loaded lazily.
 *
 * Only the archive controls need them, and the list is unchanged by most
 * visits — so this stays off the initial render path rather than making every
 * load wait on a second request.
 */
const buckets = ref<StorageEntry[]>([]);
const bucketsLoaded = ref(false);

async function ensureBuckets() {
  if (bucketsLoaded.value) return;
  try {
    buckets.value = (await api.storages()).storages;
    bucketsLoaded.value = true;
  } catch {
    // Left unloaded so the next attempt retries. The select shows an empty list
    // with an explanatory hint rather than an error dialog over the page.
    buckets.value = [];
  }
}

const bucketOptions = computed(() =>
  buckets.value.map((storage) => ({
    label: storage.display_name ? `${storage.display_name} (${storage.bucket})` : storage.bucket,
    value: storage.bucket,
  }))
);

/**
 * A sensor is drifted when the registry and AWS disagree about its STREAMING
 * infrastructure.
 *
 * Keyed on `streaming_desired`, not on `enabled`: an archive-only sensor is
 * correct with no queue, and keying on `enabled` would report every one of them
 * as broken forever. The archive path has no per-sensor infrastructure to drift
 * from — its wiring lives on the bucket, shared with every other sensor there.
 */
function isDrifted(sensor: SensorEntry): boolean {
  return sensor.streaming_desired
    ? !sensor.queue_exists || !sensor.service_exists
    : sensor.queue_exists || sensor.service_exists;
}

const driftCount = computed(
  () => list.value.filter(isDrifted).length + (sensors.data.value?.orphaned_queues.length ?? 0)
);

const streamingCount = computed(() => list.value.filter((sensor) => sensor.streaming_desired).length);
const archivingCount = computed(() => list.value.filter((sensor) => sensor.archive_enabled).length);

/**
 * Three independent facts decide a sensor's status, and conflating them is what
 * makes "archive-only" and "broken" look the same:
 *
 *   which paths it uses    — streaming, archiving, or both
 *   paused / not paused    — a streaming sensor temporarily torn down
 *   in sync / out of sync  — whether AWS matches what you asked for
 *
 * Drift is checked first because it is the only status that means something
 * needs fixing, and it is measured against the streaming half only. `paused`
 * is deliberately not shown for a sensor that does not stream: pausing is a
 * real-time concept and says nothing about S3 uploads, which continue either
 * way.
 */
function statusOf(sensor: SensorEntry): 'streaming' | 'paused' | 'archive' | 'drift' {
  if (isDrifted(sensor)) return 'drift';
  if (!sensor.stream_enabled) return 'archive';
  return sensor.enabled ? 'streaming' : 'paused';
}

const STATUS_COLOR = {
  streaming: 'positive',
  archive: 'info',
  paused: 'grey-6',
  drift: 'negative',
} as const;

/** A full sentence for this specific sensor, naming what is missing or left over. */
function statusDetail(sensor: SensorEntry): string {
  if (!isDrifted(sensor)) {
    if (!sensor.stream_enabled) {
      return (
        'Archive only. It uploads aggregated files to S3 and runs no queue or ' +
        'consumer, which is the point — nothing is billed until data arrives.'
      );
    }
    if (!sensor.enabled) {
      return (
        'Streaming is paused. Its queue and consumer have been torn down and ' +
        'nothing is billed for them, but the sensor is still configured to ' +
        'stream, so Resume rebuilds it.' +
        (sensor.archive_enabled ? ' Its S3 uploads are unaffected.' : '')
      );
    }
    return sensor.archive_enabled
      ? 'Streaming and archiving. Its queue and consumer both exist, matching the registry.'
      : 'Streaming. Its queue and consumer both exist, matching the registry.';
  }

  const parts: string[] = [];
  if (sensor.streaming_desired) {
    if (!sensor.queue_exists) parts.push('queue');
    if (!sensor.service_exists) parts.push('consumer');
    const noun = parts.join(' and ');
    return (
      `Out of sync. It is set to stream, so its ${noun} should exist, but ` +
      `${parts.length > 1 ? 'they are' : 'it is'} missing. Reconcile will create ` +
      `${parts.length > 1 ? 'them' : 'it'}.`
    );
  }

  if (sensor.queue_exists) parts.push('queue');
  if (sensor.service_exists) parts.push('consumer');
  const noun = parts.join(' and ');
  const because = sensor.stream_enabled ? 'streaming is paused' : 'it does not stream';
  return (
    `Out of sync. ${because.charAt(0).toUpperCase()}${because.slice(1)}, so nothing should ` +
    `exist, but its ${noun} ${parts.length > 1 ? 'are' : 'is'} still up. Reconcile will ` +
    `remove ${parts.length > 1 ? 'them' : 'it'}.`
  );
}

/** Short form for the list row: which half is wrong. */
function driftSummary(sensor: SensorEntry): string {
  const missing = sensor.streaming_desired
    ? [!sensor.queue_exists && 'queue', !sensor.service_exists && 'consumer']
    : [sensor.queue_exists && 'queue', sensor.service_exists && 'consumer'];
  const parts = missing.filter(Boolean).join(' + ');
  return `${sensor.streaming_desired ? 'missing' : 'leftover'} ${parts}`;
}

function reload() {
  void sensors.reload();
}

/** QDialog is callback-based; this adapts it to the await style used below. */
function confirm(options: {
  title: string;
  message: string;
  okLabel: string;
  color?: string;
}): Promise<boolean> {
  return new Promise((resolve) => {
    $q.dialog({
      title: options.title,
      message: options.message,
      html: false,
      cancel: { label: 'Cancel', flat: true, color: 'grey-8' },
      ok: { label: options.okLabel, color: options.color ?? 'primary', unelevated: true },
      persistent: true,
    })
      .onOk(() => resolve(true))
      .onCancel(() => resolve(false))
      .onDismiss(() => resolve(false));
  });
}

/**
 * Every mutation returns both reconciles. Surfacing them rather than a bare
 * "saved" matters: the row is written first and the infrastructure after, so a
 * failure leaves the registry correct and AWS behind.
 *
 * The storage half is reported only when it did something, because most sensor
 * edits do not touch a bucket listener — but the ones that do are exactly the
 * surprising ones, since the effect lands on a bucket rather than the sensor
 * being edited.
 */
function reportMutation(result: SensorMutation, verb: string) {
  lastReconcile.value = result.reconcile;

  const listeners: string[] = [];
  for (const bucket of result.storage.installed) listeners.push(`listener installed on ${bucket}`);
  for (const bucket of result.storage.removed) listeners.push(`listener removed from ${bucket}`);

  const failed = result.reconcile.failed + result.storage.failed;
  if (failed > 0) {
    const first =
      result.reconcile.actions.find((action) => action.error !== null)?.error ??
      result.storage.actions.find((action) => action.error !== null)?.error;
    $q.notify({
      type: 'negative',
      message: `${verb}, but reconcile reported ${failed} failure(s)`,
      // Spread rather than `caption: x ?? undefined`: exactOptionalPropertyTypes
      // rejects an explicitly-undefined optional property.
      ...(first ? { caption: first } : {}),
      timeout: 0,
      actions: [{ label: 'Dismiss', color: 'white' }],
      position: 'top',
    });
  } else {
    $q.notify({
      type: 'positive',
      message: verb,
      ...(listeners.length ? { caption: listeners.join(' · ') } : {}),
      position: 'top',
    });
  }
}

async function run(verb: string, action: () => Promise<SensorMutation>) {
  busy.value = true;
  try {
    reportMutation(await action(), verb);
    await sensors.reload();
  } catch (error) {
    $q.notify({
      type: 'negative',
      message: error instanceof Error ? error.message : 'Request failed.',
      timeout: 0,
      actions: [{ label: 'Dismiss', color: 'white' }],
      position: 'top',
    });
  } finally {
    busy.value = false;
  }
}

// --- Add sensor ------------------------------------------------------------

const addOpen = ref(false);
const addName = ref('');
const addDisplayName = ref('');
// S3 archive is the default and real time is the opt-in: streaming bills for a
// queue and a container continuously, and most sensors do not need it.
const addArchive = ref(true);
const addStream = ref(false);
const addBucket = ref<string | null>(null);
const addPrefix = ref('');

function openAdd() {
  addName.value = '';
  addDisplayName.value = '';
  addArchive.value = true;
  addStream.value = false;
  addBucket.value = null;
  addPrefix.value = '';
  addOpen.value = true;
  void ensureBuckets();
}

// A sensible default prefix, so the common case needs no typing. Only while the
// field is untouched — it stops following the name as soon as it is edited.
const prefixTouched = ref(false);
watch(addName, (name) => {
  if (!prefixTouched.value) addPrefix.value = name ? `${name}/` : '';
});

async function submitAdd() {
  const name = addName.value.trim();
  if (!name) {
    $q.notify({ type: 'warning', message: 'A sensor name is required.', position: 'top' });
    return;
  }
  if (!addArchive.value && !addStream.value) {
    $q.notify({
      type: 'warning',
      message: 'Pick at least one ingest path — otherwise nothing this sensor sends arrives.',
      position: 'top',
    });
    return;
  }
  if (addArchive.value && !addBucket.value) {
    $q.notify({ type: 'warning', message: 'Choose a bucket to archive into.', position: 'top' });
    return;
  }

  addOpen.value = false;
  await run(`Sensor ${name} added`, () =>
    api.sensorAdd(name, addDisplayName.value.trim() || null, {
      stream_enabled: addStream.value,
      archive_enabled: addArchive.value,
      storage_bucket: addArchive.value ? addBucket.value : null,
      storage_prefix: addArchive.value ? addPrefix.value.trim() : '',
    })
  );
  selectedName.value = name;
}

// --- Per-path controls -----------------------------------------------------

const sensorTab = ref<'realtime' | 'archive'>('archive');

// Open on whichever path the sensor actually uses, so the common archive-only
// sensor does not land on a tab that is switched off.
watch(selected, (sensor) => {
  if (!sensor) return;
  sensorTab.value = sensor.stream_enabled && !sensor.archive_enabled ? 'realtime' : 'archive';
  archiveBucket.value = sensor.storage_bucket;
  archivePrefix.value = sensor.storage_prefix;
  void ensureBuckets();
});

async function setIngest(sensor: SensorEntry, patch: SensorIngestPatch, verb: string) {
  await run(verb, () => api.sensorSetIngest(sensor.name, patch));
}

/** Real-time streaming on or off. Turning it off is a teardown, so it confirms. */
async function toggleStream(sensor: SensorEntry) {
  const next = !sensor.stream_enabled;

  if (!next) {
    if (!sensor.archive_enabled) {
      $q.notify({
        type: 'warning',
        message:
          'This sensor would then have no ingest path at all. Set up its S3 archive first, ' +
          'or remove the sensor.',
        timeout: 7000,
        position: 'top',
      });
      return;
    }
    const ok = await confirm({
      title: 'Stop real-time streaming',
      message:
        `This deletes ${sensor.name}'s SQS queue, its topic subscription and its consumer ` +
        'container. Queued messages are discarded and anything published to the topic ' +
        'afterwards is dropped. Turning streaming back on rebuilds all of it.',
      okLabel: 'Stop streaming',
      color: 'warning',
    });
    if (!ok) return;
  }

  await setIngest(
    sensor,
    { stream_enabled: next },
    `Real-time streaming ${next ? 'enabled' : 'disabled'} for ${sensor.name}`
  );
}

/** Pause is a streaming concept only: it tears the queue and consumer down. */
async function togglePause(sensor: SensorEntry) {
  const next = !sensor.enabled;
  if (!next) {
    const ok = await confirm({
      title: 'Pause streaming',
      message:
        `Pausing ${sensor.name} tears down its queue and consumer. Messages still queued are ` +
        'discarded, and anything the field sensor publishes while it is paused is dropped. ' +
        'S3 uploads are not affected — they go straight from the device to the bucket. ' +
        'Resuming rebuilds the infrastructure.',
      okLabel: 'Pause',
      color: 'warning',
    });
    if (!ok) return;
  }
  await run(`Streaming ${next ? 'resumed' : 'paused'} for ${sensor.name}`, () =>
    api.sensorSetEnabled(sensor.name, next)
  );
}

// Archive settings are inputs rather than a switch, so they are drafted locally
// and saved explicitly. The toggle itself applies immediately.
const archiveBucket = ref<string | null>(null);
const archivePrefix = ref('');

const archiveDirty = computed(() => {
  const sensor = selected.value;
  if (!sensor) return false;
  return (
    archiveBucket.value !== sensor.storage_bucket ||
    archivePrefix.value.trim() !== sensor.storage_prefix
  );
});

async function toggleArchive(sensor: SensorEntry) {
  const next = !sensor.archive_enabled;

  if (!next) {
    if (!sensor.stream_enabled) {
      $q.notify({
        type: 'warning',
        message:
          'This sensor would then have no ingest path at all. Turn on real-time streaming ' +
          'first, or remove the sensor.',
        timeout: 7000,
        position: 'top',
      });
      return;
    }
    await setIngest(sensor, { archive_enabled: false }, `S3 archive disabled for ${sensor.name}`);
    return;
  }

  if (!archiveBucket.value) {
    $q.notify({ type: 'warning', message: 'Choose a bucket first.', position: 'top' });
    return;
  }
  await setIngest(
    sensor,
    {
      archive_enabled: true,
      storage_bucket: archiveBucket.value,
      storage_prefix: archivePrefix.value.trim(),
    },
    `S3 archive enabled for ${sensor.name}`
  );
}

async function saveArchive(sensor: SensorEntry) {
  if (!archiveBucket.value) {
    $q.notify({ type: 'warning', message: 'Choose a bucket first.', position: 'top' });
    return;
  }
  await setIngest(
    sensor,
    {
      archive_enabled: sensor.archive_enabled,
      storage_bucket: archiveBucket.value,
      storage_prefix: archivePrefix.value.trim(),
    },
    `Archive settings saved for ${sensor.name}`
  );
}

async function removeSensor(sensor: SensorEntry) {
  const ok = await confirm({
    title: 'Remove sensor',
    message:
      `Permanently remove ${sensor.name}? Its registry row, SQS queue, topic subscription ` +
      'and ECS service are all deleted, and queued messages are discarded. Files it has ' +
      'already uploaded to S3 are left where they are, though if this was the last sensor ' +
      'archiving to its bucket, that bucket\'s upload listener is removed. This cannot be ' +
      'undone.',
    okLabel: 'Remove',
    color: 'negative',
  });
  if (!ok) return;

  await run(`Sensor ${sensor.name} removed`, () => api.sensorRemove(sensor.name));
  if (selectedName.value === sensor.name) selectedName.value = null;
}

async function reconcileNow() {
  await run('Reconciled', () => api.sensorReconcile());
}

async function copy(text: string | null | undefined) {
  if (!text) return;
  try {
    await navigator.clipboard.writeText(text);
    $q.notify({ type: 'positive', message: 'Copied', timeout: 1200, position: 'top' });
  } catch {
    $q.notify({ type: 'negative', message: 'Clipboard unavailable.', position: 'top' });
  }
}
</script>

<template>
  <q-page padding>
    <PageHeader title="Sensors">
      <template #subtitle>
        Sensors live in the <code>sensors</code> table, not in the deploy config. Each one
        uploads aggregated files to S3, streams in real time, or both — archiving is the
        default because streaming bills for a queue and a container continuously.
      </template>
      <template #actions>
        <q-btn
          outline
          color="primary"
          icon="refresh"
          label="Refresh"
          :loading="sensors.state.value === 'loading'"
          @click="reload"
          />
          <q-btn v-if="isAdmin" outline color="primary" label="Reconcile" :loading="busy" @click="reconcileNow">
          <q-tooltip class="hint-tooltip">{{ HINTS.reconcile }}</q-tooltip>
        </q-btn>
        <q-btn v-if="isAdmin" unelevated color="primary" icon="add" label="Add sensor" :disable="busy" @click="openAdd">
        <q-tooltip class="hint-tooltip">{{ HINTS.add }}</q-tooltip>
        </q-btn>
      </template>
    </PageHeader>

    <!-- Stats -->
    <div class="row q-col-gutter-md q-mb-md">
      <div class="col-6 col-md-3">
        <q-card flat bordered>
          <q-card-section>
            <div class="text-caption text-grey-7 text-uppercase row items-center">
              Registered<InfoHint :text="HINTS.registered" />
            </div>
            <div class="text-h6 q-mt-xs">
              <AsyncValue :state="sensors.state.value" :error="sensors.error.value">
                {{ list.length }}
              </AsyncValue>
            </div>
          </q-card-section>
        </q-card>
      </div>
      <div class="col-6 col-md-3">
        <q-card flat bordered>
          <q-card-section>
            <div class="text-caption text-grey-7 text-uppercase row items-center">
              Archiving<InfoHint :text="HINTS.archiving" />
            </div>
            <div class="text-h6 q-mt-xs">
              <AsyncValue :state="sensors.state.value" :error="sensors.error.value">
                {{ archivingCount }}
              </AsyncValue>
            </div>
          </q-card-section>
        </q-card>
      </div>
      <div class="col-6 col-md-3">
        <q-card flat bordered>
          <q-card-section>
            <div class="text-caption text-grey-7 text-uppercase row items-center">
              Streaming<InfoHint :text="HINTS.streaming" />
            </div>
            <div class="text-h6 q-mt-xs">
              <AsyncValue :state="sensors.state.value" :error="sensors.error.value">
                {{ streamingCount }}
              </AsyncValue>
            </div>
          </q-card-section>
        </q-card>
      </div>
      <div class="col-6 col-md-3">
        <q-card flat bordered>
          <q-card-section>
            <div class="text-caption text-grey-7 text-uppercase row items-center">
              Out of sync<InfoHint :text="HINTS.drift" />
            </div>
            <div class="text-h6 q-mt-xs" :class="driftCount > 0 ? 'text-negative' : ''">
              <AsyncValue :state="sensors.state.value" :error="sensors.error.value">
                {{ driftCount }}
              </AsyncValue>
            </div>
          </q-card-section>
        </q-card>
      </div>
    </div>

    <AsyncValue :state="sensors.state.value" :error="sensors.error.value">
      <q-banner
        v-if="sensors.data.value?.orphaned_queues.length"
        rounded
        class="bg-orange-1 text-grey-9 q-mb-md"
      >
        <template #avatar><q-icon name="warning" color="warning" /></template>
        <div class="text-weight-medium">Queues with no registry row</div>
        <div class="text-body2">
          {{ sensors.data.value.orphaned_queues.join(', ') }} — a sensor was removed while its
          teardown failed, or a reconcile stopped halfway. Running
          <strong>Reconcile</strong> deletes them.
        </div>
      </q-banner>

      <div class="row q-col-gutter-md">
        <!-- Registry -->
        <div class="col-12 col-md-5">
          <SectionCard title="Registry" flush>
            <q-card-section v-if="!list.length" class="text-body2 text-grey-7">
              No sensors are registered.
              <template v-if="isAdmin">Use <strong>Add sensor</strong> to create the first one.</template>
            </q-card-section>

            <q-list v-else separator>
              <q-item
                v-for="sensor in list"
                :key="sensor.name"
                v-ripple
                clickable
                :active="selectedName === sensor.name"
                active-class="bg-blue-grey-1"
                @click="selectedName = sensor.name"
              >
                <q-item-section avatar style="min-width: 26px">
                  <q-icon name="circle" size="10px" :color="STATUS_COLOR[statusOf(sensor)]">
                    <q-tooltip class="hint-tooltip">{{ statusDetail(sensor) }}</q-tooltip>
                  </q-icon>
                </q-item-section>

                <q-item-section>
                  <q-item-label>{{ sensor.display_name || sensor.name }}</q-item-label>
                  <q-item-label caption class="mono">
                    <template v-if="sensor.display_name">{{ sensor.name }} · </template>
                    <template v-if="sensor.stream_enabled && sensor.archive_enabled">S3 + stream</template>
                    <template v-else-if="sensor.archive_enabled">S3</template>
                    <template v-else>stream</template>
                  </q-item-label>
                </q-item-section>

                <q-item-section side>
                  <q-item-label caption :class="isDrifted(sensor) ? 'text-negative' : ''">
                    <template v-if="isDrifted(sensor)">{{ driftSummary(sensor) }}</template>
                    <template v-else-if="statusOf(sensor) === 'paused'">paused</template>
                    <template v-else-if="!sensor.stream_enabled">no queue</template>
                    <template v-else>{{ sensor.messages_available ?? 0 }} waiting</template>
                  </q-item-label>
                </q-item-section>

                <!-- Row actions, so a sensor can be managed without selecting
                     it first. .stop keeps the menu from also changing selection. -->
                <q-item-section v-if="isAdmin" side @click.stop>
                  <q-btn flat dense round icon="more_vert" size="sm" aria-label="Actions">
                    <q-menu auto-close>
                      <q-list style="min-width: 180px">
                        <q-item
                          v-if="sensor.stream_enabled"
                          clickable
                          :disable="busy"
                          @click="togglePause(sensor)"
                        >
                          <q-item-section>
                            {{ sensor.enabled ? 'Pause streaming' : 'Resume streaming' }}
                          </q-item-section>
                        </q-item>
                        <q-item clickable :disable="busy" @click="reconcileNow">
                          <q-item-section>Reconcile now</q-item-section>
                        </q-item>
                        <q-separator />
                        <q-item clickable :disable="busy" class="text-negative" @click="removeSensor(sensor)">
                          <q-item-section>Remove</q-item-section>
                        </q-item>
                      </q-list>
                    </q-menu>
                  </q-btn>
                </q-item-section>
              </q-item>
            </q-list>

            <q-card-section class="text-caption text-grey-7">
              <div class="legend">
              <div class="legend__row">
                <q-icon name="circle" size="9px" color="info" class="legend__dot" />
                <span>
                  <strong>archive only</strong> — uploads to S3 and runs no queue or consumer.
                  Correct, not incomplete
                </span>
              </div>
              <div class="legend__row">
                <q-icon name="circle" size="9px" color="positive" class="legend__dot" />
                <span><strong>streaming</strong> — queue and consumer both up, matching the registry</span>
              </div>
              <div class="legend__row">
                <q-icon name="circle" size="9px" color="grey-6" class="legend__dot" />
                <span>
                  <strong>paused</strong> — configured to stream, torn down on purpose. S3
                  uploads carry on
                </span>
              </div>
              <div class="legend__row">
                <q-icon name="circle" size="9px" color="negative" class="legend__dot" />
                <span><strong>out of sync</strong> — AWS does not match what you asked for</span>
              </div>
            </div>
          </q-card-section>
          </SectionCard>
        </div>

        <!-- Detail -->
        <div class="col-12 col-md-7">
          <SectionCard :title="selected ? selected.display_name || selected.name : 'Connect a field sensor'" flush>
            <template #actions>
              <!-- Only whole-sensor actions live here. Pausing belongs to the
                   real-time path and lives in its tab, not above both of them. -->
              <div v-if="selected && isAdmin">
                <q-btn outline dense size="sm" color="negative" label="Remove" :disable="busy" @click="removeSensor(selected)">
                  <q-tooltip class="hint-tooltip">{{ HINTS.remove }}</q-tooltip>
                </q-btn>
              </div>
            </template>

            <q-card-section v-if="!selected" class="text-body2 text-grey-7">
              Select a sensor to configure its two ingest paths: an S3 archive for aggregated
              files, and real-time streaming for live broadcast.
            </q-card-section>

            <template v-else>
              <q-card-section v-if="isDrifted(selected)" class="q-pt-md q-pb-none">
                <q-banner rounded dense class="bg-orange-1 text-grey-9">
                  <template #avatar><q-icon name="warning" color="warning" /></template>
                  <div class="text-weight-medium">Out of sync</div>
                  <div class="text-body2">{{ statusDetail(selected) }}</div>
                </q-banner>
              </q-card-section>

              <q-tabs
                v-model="sensorTab"
                dense
                align="left"
                class="text-grey-7"
                active-color="primary"
                indicator-color="primary"
                narrow-indicator
              >
                <q-tab name="archive">
                  <div class="row items-center no-wrap">
                    <q-icon
                      name="inventory_2"
                      size="16px"
                      class="q-mr-xs"
                      :color="selected.archive_enabled ? 'info' : 'grey-5'"
                    />
                    S3 archive
                  </div>
                </q-tab>
                <q-tab name="realtime">
                  <div class="row items-center no-wrap">
                    <q-icon
                      name="bolt"
                      size="16px"
                      class="q-mr-xs"
                      :color="selected.streaming_desired ? 'positive' : 'grey-5'"
                    />
                    Real time
                  </div>
                </q-tab>
              </q-tabs>

              <q-separator />

              <q-tab-panels v-model="sensorTab" animated>
                <!-- S3 archive -->
                <q-tab-panel name="archive" class="q-pa-none">
                  <q-card-section>
                    <div class="row items-center no-wrap q-mb-xs">
                      <div class="col">
                        <div class="text-body2 text-weight-medium">Archive aggregated files</div>
                        <div class="text-caption text-grey-7">{{ HINTS.archive }}</div>
                      </div>
                      <q-toggle
                        :model-value="selected.archive_enabled"
                        color="info"
                        :disable="!isAdmin || busy"
                        @update:model-value="toggleArchive(selected)"
                      />
                    </div>
                  </q-card-section>

                  <q-separator />

                  <q-card-section>
                    <div class="q-gutter-sm">
                      <q-select
                        v-model="archiveBucket"
                        outlined
                        dense
                        emit-value
                        map-options
                        label="Bucket"
                        :disable="!isAdmin || busy"
                        :options="bucketOptions"
                        :hint="bucketOptions.length ? 'Several sensors can share one bucket under different prefixes.' : 'No storage buckets are registered yet — add one on the Storage page first.'"
                      />
                      <q-input
                        v-model="archivePrefix"
                        outlined
                        dense
                        label="Prefix"
                        :disable="!isAdmin || busy"
                        :placeholder="`${selected.name}/`"
                        :hint="HINTS.prefix"
                      />
                    </div>

                    <div v-if="isAdmin" class="row justify-end q-mt-md">
                      <q-btn
                        unelevated
                        dense
                        color="primary"
                        label="Save"
                        :disable="!archiveDirty || busy"
                        :loading="busy"
                        @click="saveArchive(selected)"
                      />
                    </div>

                    <q-list v-if="selected.archive_enabled" dense class="q-mt-sm">
                      <q-item class="q-px-none">
                        <q-item-section>
                          <q-item-label caption>Upload to</q-item-label>
                          <q-item-label class="mono">
                            s3://{{ selected.storage_bucket }}/{{ selected.storage_prefix }}
                          </q-item-label>
                        </q-item-section>
                        <q-item-section side>
                          <q-btn
                            flat
                            dense
                            round
                            size="sm"
                            icon="content_copy"
                            @click="copy(`s3://${selected.storage_bucket}/${selected.storage_prefix}`)"
                          >
                            <q-tooltip>Copy</q-tooltip>
                          </q-btn>
                        </q-item-section>
                      </q-item>
                    </q-list>
                  </q-card-section>

                  <q-separator />

                  <q-card-section v-if="selected.archive_enabled">
                    <div class="text-subtitle2 q-mb-sm">How to upload</div>
                    <ol class="q-pl-md q-ma-none text-body2" style="line-height: 1.7">
                      <li class="q-mb-sm">
                        Give the edge device's IAM role permission to write to
                        <code>{{ selected.storage_bucket }}</code>. The console mints no
                        credentials — the <strong>Storage</strong> page shows the minimum policy
                        to copy.
                      </li>
                      <li class="q-mb-sm">
                        Upload under
                        <code>{{ selected.storage_prefix || '(the bucket root)' }}</code> with any
                        S3 client. The prefix is recorded here so a key can be mapped back to
                        this sensor later; it is not enforced.
                      </li>
                      <li>
                        Nothing else has to be set up.
                        <InfoHint :text="HINTS.listener" />
                        The bucket's upload listener is installed automatically because this
                        sensor archives there, and removed once no sensor does.
                      </li>
                    </ol>
                  </q-card-section>
                </q-tab-panel>

                <!-- Real time -->
                <q-tab-panel name="realtime" class="q-pa-none">
                  <q-card-section>
                    <div class="row items-center no-wrap q-mb-xs">
                      <div class="col">
                        <div class="text-body2 text-weight-medium">Stream in real time</div>
                        <div class="text-caption text-grey-7">{{ HINTS.stream }}</div>
                      </div>
                      <q-toggle
                        :model-value="selected.stream_enabled"
                        color="positive"
                        :disable="!isAdmin || busy"
                        @update:model-value="toggleStream(selected)"
                      />
                    </div>
                  </q-card-section>

                  <template v-if="selected.stream_enabled">
                    <q-separator />

                    <!-- Pause lives here: it tears down the queue and consumer
                         and does nothing to S3 uploads, so it is a property of
                         this path rather than of the sensor. -->
                    <q-card-section>
                      <div class="row items-center no-wrap">
                        <div class="col">
                          <div class="text-body2 text-weight-medium">
                            {{ selected.enabled ? 'Running' : 'Paused' }}
                          </div>
                          <div class="text-caption text-grey-7">
                            {{ selected.enabled ? HINTS.pause : HINTS.resume }}
                          </div>
                        </div>
                        <q-btn
                          v-if="isAdmin"
                          outline
                          dense
                          size="sm"
                          :color="selected.enabled ? 'warning' : 'primary'"
                          :label="selected.enabled ? 'Pause' : 'Resume'"
                          :disable="busy"
                          @click="togglePause(selected)"
                        />
                      </div>
                    </q-card-section>

                    <q-separator />

                    <q-card-section>
                      <q-list dense>
                        <q-item class="q-px-none">
                          <q-item-section>
                            <q-item-label caption>Publish to</q-item-label>
                            <q-item-label class="mono">{{ sensors.data.value?.topic_arn }}</q-item-label>
                          </q-item-section>
                          <q-item-section side>
                            <q-btn flat dense round size="sm" icon="content_copy" @click="copy(sensors.data.value?.topic_arn)">
                              <q-tooltip>Copy</q-tooltip>
                            </q-btn>
                          </q-item-section>
                        </q-item>
                        <q-item class="q-px-none">
                          <q-item-section>
                            <q-item-label caption>Routing attribute</q-item-label>
                            <q-item-label class="mono">
                              {{ sensors.data.value?.routing_attribute }} = {{ selected.name }}
                            </q-item-label>
                          </q-item-section>
                        </q-item>
                        <q-item class="q-px-none">
                          <q-item-section>
                            <q-item-label caption>Queue</q-item-label>
                            <q-item-label>
                              <template v-if="selected.queue_exists">
                                {{ selected.messages_available ?? 0 }} waiting ·
                                {{ selected.messages_in_flight ?? 0 }} in flight
                              </template>
                              <template v-else>not created</template>
                            </q-item-label>
                          </q-item-section>
                          <q-item-section side>
                            <q-item-label caption>Consumer</q-item-label>
                            <q-item-label>{{ selected.service_exists ? 'running' : 'not running' }}</q-item-label>
                          </q-item-section>
                        </q-item>
                      </q-list>
                    </q-card-section>

                    <q-separator />

                    <q-card-section>
                      <div class="text-subtitle2 q-mb-sm">How to hook up the field sensor</div>
                      <ol class="q-pl-md q-ma-none text-body2" style="line-height: 1.7">
                        <li class="q-mb-sm">
                          Publish to the topic above. The sensor does not write to SQS directly —
                          the topic fans out to the right queue.
                        </li>
                        <li class="q-mb-sm">
                          Set the message attribute
                          <code>{{ sensors.data.value?.routing_attribute }}</code> to exactly
                          <code>{{ selected.name }}</code>. This is what routes the message. A
                          missing or misspelled value matches no subscription and is dropped
                          <strong>without an error</strong>.
                        </li>
                        <li class="q-mb-sm">
                          Set a <code>MessageGroupId</code> — required on a FIFO topic. Ordering
                          holds within a group, so use one group per sensor.
                        </li>
                        <li class="q-mb-sm">
                          Body is JSON with <code>capture_timestamp</code> (epoch seconds) and
                          <code>data</code>: base64 of a <code>Type=SDSM</code> /
                          <code>Payload=&lt;hex&gt;</code> text block. Anything whose type is not
                          <code>SDSM</code> is logged and skipped.
                        </li>
                        <li>
                          Content-based deduplication is on. Two identical bodies published within
                          five minutes are treated as one — vary the payload or set an explicit
                          <code>MessageDeduplicationId</code> when replaying test data.
                        </li>
                      </ol>
                    </q-card-section>
                  </template>

                  <q-card-section v-else class="text-body2 text-grey-7">
                    Real-time streaming is off, so this sensor runs no SQS queue and no consumer
                    container — and is billed for neither. Turn it on to broadcast live; the
                    queue, subscription and consumer are built within a minute or two.
                  </q-card-section>
                </q-tab-panel>
              </q-tab-panels>
            </template>
          </SectionCard>
        </div>
      </div>

      <!-- Last reconcile -->
      <q-card v-if="lastReconcile" flat bordered class="q-mt-md">
        <q-card-section class="q-pb-xs">
          <div class="text-caption text-grey-7 text-uppercase text-weight-medium">
            Last reconcile
          </div>
          <div class="text-caption text-grey-7 q-mt-xs">
            {{ new Date(lastReconcile.reconciled_at).toLocaleString() }} ·
            {{ lastReconcile.created.length }} created ·
            {{ lastReconcile.deleted.length }} deleted ·
            {{ lastReconcile.retagged.length }} retagged ·
            <span :class="lastReconcile.failed > 0 ? 'text-negative' : ''">
              {{ lastReconcile.failed }} failed
            </span>
          </div>
        </q-card-section>

        <q-card-section v-if="!lastReconcile.actions.length" class="text-body2 text-grey-7 q-pt-none">
          Nothing to change — AWS already matched the registry.
        </q-card-section>

        <q-list v-else separator>
          <q-item v-for="action in lastReconcile.actions" :key="`${action.action}-${action.sensor}`">
            <q-item-section avatar style="min-width: 26px">
              <q-icon name="circle" size="10px" :color="action.error ? 'negative' : 'positive'" />
            </q-item-section>
            <q-item-section>
              <q-item-label class="mono">{{ action.sensor }}</q-item-label>
              <q-item-label caption>
                {{ action.action }} · {{ action.steps.join(' → ') || 'no steps' }}
              </q-item-label>
              <q-item-label v-if="action.error" caption class="text-negative">
                {{ action.error }}
              </q-item-label>
            </q-item-section>
          </q-item>
        </q-list>
      </q-card>
    </AsyncValue>

    <!-- Add sensor -->
    <q-dialog v-model="addOpen">
      <q-card style="min-width: min(500px, 92vw)">
        <q-card-section>
          <div class="text-h6">Add sensor</div>
        </q-card-section>

        <q-card-section class="q-gutter-md q-pt-none">
          <q-input v-model="addName" outlined dense label="Sensor name" placeholder="e.g. plymouth_barton" autofocus>
            <template #hint>
              Letters, digits, underscore and hyphen only, and it cannot be changed later. If
              this sensor ever streams, it must match the
              <code>{{ sensors.data.value?.routing_attribute }}</code> attribute the field
              sensor publishes, because the name becomes part of the SQS queue name.
            </template>
          </q-input>
          <q-input
            v-model="addDisplayName"
            outlined
            dense
            label="Display name (optional)"
            placeholder="Plymouth Rd & Barton Dr"
            hint="Shown in the console instead of the raw name. Safe to change."
          />
        </q-card-section>

        <q-separator />

        <q-card-section>
          <div class="text-caption text-grey-7 text-uppercase text-weight-medium q-mb-sm">
            Ingest paths
          </div>

          <!-- Archive first, and on by default: it is the cheaper path and the
               one most sensors want. Streaming is the deliberate opt-in. -->
          <q-toggle v-model="addArchive" color="info" label="Archive aggregated files to S3" />
          <div class="text-caption text-grey-7 q-mb-md" style="margin-top: -4px">
            {{ HINTS.archive }}
          </div>

          <div v-if="addArchive" class="q-mb-md q-gutter-sm">
            <q-select
              v-model="addBucket"
              outlined
              dense
              emit-value
              map-options
              label="Bucket"
              :options="bucketOptions"
              :hint="bucketOptions.length ? 'Several sensors can share one bucket under different prefixes.' : 'No storage buckets are registered yet — add one on the Storage page first.'"
            />
            <q-input
              v-model="addPrefix"
              outlined
              dense
              label="Prefix"
              :placeholder="`${addName || 'sensor'}/`"
              :hint="HINTS.prefix"
              @update:model-value="prefixTouched = true"
            />
          </div>

          <q-toggle v-model="addStream" color="positive" label="Also stream in real time" />
          <div class="text-caption text-grey-7" style="margin-top: -4px">{{ HINTS.stream }}</div>
        </q-card-section>

        <q-banner dense class="bg-blue-1 text-grey-9 q-mx-md q-mb-md" rounded>
          <template #avatar><q-icon name="info" color="info" /></template>
          <div class="text-body2">
            <template v-if="addStream">
              Streaming builds this sensor's queue, subscription and consumer straight away — no
              separate Reconcile and no <code>cdk deploy</code>. It normally starts processing
              within a minute or two; until then it shows as out of sync.
            </template>
            <template v-else>
              An archive-only sensor needs no infrastructure at all. It is ready as soon as the
              edge device has permission to write to the bucket.
            </template>
          </div>
        </q-banner>

        <q-card-actions align="right" class="q-pa-md q-pt-none">
          <q-btn flat label="Cancel" color="grey-8" @click="addOpen = false" />
          <q-btn unelevated color="primary" label="Create" :loading="busy" @click="submitAdd" />
        </q-card-actions>
      </q-card>
    </q-dialog>
  </q-page>
</template>

<style scoped>
/* The marker stays on the first line of its description rather than wrapping
   onto a line of its own, which is what a plain flex row does once the text
   needs two lines. */
.legend__row {
  display: flex;
  align-items: flex-start;
  gap: 7px;
  line-height: 1.55;
}

.legend__row + .legend__row {
  margin-top: 4px;
}

.legend__dot {
  margin-top: 5px;
  flex-shrink: 0;
}

code {
  background: rgba(0, 0, 0, 0.05);
  padding: 1px 5px;
  border-radius: 4px;
  font-size: 0.92em;
}
</style>

<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { useQuasar } from 'quasar';
import {
  api,
  type BucketListing,
  type StorageEntry,
  type StoragesResponse,
} from '@/api/client';
import { useAsyncValue } from '@/composables/useAsyncValue';
import AwsLink from '@/components/AwsLink.vue';
import PageHeader from '@/components/PageHeader.vue';
import { aws } from '@/aws-links';
import AsyncValue from '@/components/AsyncValue.vue';
import InfoHint from '@/components/InfoHint.vue';
import SectionCard from '@/components/SectionCard.vue';
import { useAuthStore } from '@/stores/auth';

const $q = useQuasar();

/**
 * Wording shared between tooltips, dialogs and empty states.
 *
 * Storage is the half of ingest an operator meets least often, and the two
 * questions it always raises — "does removing this delete my data?" and "why
 * would I use this instead of streaming?" — have to be answered the same way
 * everywhere they are asked.
 */
const HINTS = {
  registered:
    'Buckets this deployment knows about. Registering one makes it available as ' +
    'a sensor\'s archive target; it gets its upload listener only once a sensor ' +
    'actually archives there.',
  publishing:
    'Buckets where S3 is currently announcing new files on the control topic. ' +
    'This follows the sensor count — a bucket with nothing archiving to it does ' +
    'not need a listener, and does not get one. Nothing in this stack subscribes ' +
    'to those announcements yet; this is the publishing side only.',
  attached:
    'Sensors currently set to archive into one of these buckets. A sensor can ' +
    'archive, stream in real time, or do both, and several can share one bucket ' +
    'under different prefixes.',
  attention:
    'Buckets that are unreachable, or where S3 does not match the sensor count. ' +
    'Anything else is fine — a bucket with no archiving sensors and no listener ' +
    'is a correct state, not a fault.',
  create:
    'Creates a new S3 bucket, private and encrypted, and registers it. The name ' +
    'has to be globally unique across all of AWS, not just your account.',
  adopt:
    'Registers a bucket that already exists in this account. Its contents are ' +
    'left alone; the only change made to it is this deployment\'s tags, plus an ' +
    'upload listener later if a sensor archives here.',
  reconcile:
    'Counts the sensors archiving into each registered bucket and makes S3 ' +
    'match: a listener where the count is above zero, none where it is zero. ' +
    'Safe to run any time — it does nothing when the two already agree. This ' +
    'also runs after every sensor change and on the schedule.',
  notify:
    'S3 gets one rule per archiving sensor, each filtered to that sensor\'s ' +
    'prefix, so only what a sensor actually wrote is announced. It is not a ' +
    'setting: the reconciler writes the rules from the sensors, installs them ' +
    'with the first one, rewrites them when a prefix changes, and removes them ' +
    'after the last one stops. Note SNS does not buffer — an event with no ' +
    'subscriber is discarded, not queued.',
  remove:
    'Unregisters the bucket and detaches any sensors archiving to it. The bucket ' +
    'and every file in it are left exactly as they are — the console cannot ' +
    'delete a bucket at all. Delete it in the S3 console if you really mean to.',
  origin:
    'Whether this deployment created the bucket or adopted one that already ' +
    'existed. Adopted buckets may hold data that has nothing to do with MSight.',
  cost:
    'Whether the bucket carries the cost allocation tag the Cost page filters ' +
    'on. Buckets are created outside CloudFormation, so they do not inherit the ' +
    'stack\'s tags — without this their storage and request charges are absent ' +
    'from the cost breakdown entirely. Cost Explorer attributes ALL of a ' +
    'bucket\'s spend to its tags, so leave it off for an adopted bucket that ' +
    'also holds data belonging to something else.',
  costTracked:
    'Tracked buckets appear in the Cost page breakdown. Attribution is not ' +
    'retroactive — spend counts from the moment the tag is applied — and the tag ' +
    'must be activated as a cost allocation tag in the billing account before ' +
    'any of it shows up.',
  wired:
    'Whether S3 currently has this deployment\'s upload notification on the ' +
    'bucket. If the registry says it should and S3 says it does not, someone ' +
    'changed the bucket outside the console.',
};

const auth = useAuthStore();
const isAdmin = computed(() => auth.isAdmin);

const storages = useAsyncValue<StoragesResponse>((signal) => api.storages(signal), {
  timeoutMs: 30000,
});

const selectedBucket = ref<string | null>(null);
const busy = ref(false);

const list = computed<StorageEntry[]>(() => storages.data.value?.storages ?? []);

const selected = computed<StorageEntry | null>(
  () => list.value.find((storage) => storage.bucket === selectedBucket.value) ?? null
);

const publishingCount = computed(
  () => list.value.filter((storage) => storage.facts.notifies_control_topic).length
);
const attachedSensors = computed(() =>
  list.value.reduce(
    (sum, storage) => sum + storage.sensors.filter((sensor) => sensor.archive_enabled).length,
    0
  )
);

function formatBytes(bytes: number): string {
  if (bytes <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB', 'PB'];
  const exponent = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  const value = bytes / 1024 ** exponent;
  return `${value >= 100 || exponent === 0 ? Math.round(value) : value.toFixed(1)} ${units[exponent]}`;
}

/** Sensors actually archiving here — what the listener's rules are built from. */
function archivingSensors(storage: StorageEntry) {
  return storage.sensors.filter((sensor) => sensor.archive_enabled);
}

function archivingCount(storage: StorageEntry): number {
  return archivingSensors(storage).length;
}

/**
 * The prefixes S3 should be filtering on: one per archiving sensor, deduped and
 * sorted so it compares directly with what the bucket reports.
 */
function desiredPrefixes(storage: StorageEntry): string[] {
  return [...new Set(archivingSensors(storage).map((sensor) => sensor.prefix))].sort();
}

function samePrefixes(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((value, index) => value === b[index]);
}

/**
 * A bucket is drifted when S3's prefix filters do not match the sensors.
 *
 * Compared as a set rather than as presence: a sensor whose prefix changed
 * leaves the listener installed but filtering on the old path, so uploads to
 * the new one are silently never announced — which "a listener exists" would
 * report as healthy.
 *
 * Kept separate from "unreachable": a bucket that was deleted or whose
 * permissions changed needs a different fix from one whose rules are stale,
 * and collapsing both into "unhealthy" would say which neither.
 */
function isDrifted(storage: StorageEntry): boolean {
  if (!storage.facts.exists || storage.facts.access_error) return false;
  return !samePrefixes(desiredPrefixes(storage), storage.facts.notification_prefixes);
}

function statusOf(storage: StorageEntry): 'ok' | 'quiet' | 'drift' | 'unreachable' {
  if (!storage.facts.exists || storage.facts.access_error) return 'unreachable';
  if (isDrifted(storage)) return 'drift';
  return storage.facts.notifies_control_topic ? 'ok' : 'quiet';
}

const attentionCount = computed(
  () => list.value.filter((storage) => statusOf(storage) !== 'ok' && statusOf(storage) !== 'quiet').length
);

const STATUS_COLOR = {
  ok: 'positive',
  quiet: 'grey-6',
  drift: 'negative',
  unreachable: 'negative',
} as const;

function statusDetail(storage: StorageEntry): string {
  const status = statusOf(storage);
  if (status === 'unreachable') {
    return storage.facts.access_error
      ? `S3 will not let this deployment inspect the bucket: ${storage.facts.access_error}`
      : 'The bucket no longer exists, or is no longer visible to this account. ' +
          'Unregister it, or restore the bucket.';
  }
  const archiving = archivingCount(storage);
  const wanted = desiredPrefixes(storage);
  const actual = storage.facts.notification_prefixes;

  if (status === 'drift') {
    if (archiving === 0) {
      return 'No sensor archives here any more, but S3 still has upload rules, so events are ' +
        'still being published. Reconcile removes them.';
    }
    if (actual.length === 0) {
      return `${archiving} sensor(s) archive here, so S3 should be watching ` +
        `${wanted.map((prefix) => prefix || '(the whole bucket)').join(', ')} — and it is ` +
        'watching nothing, so those uploads land unannounced. Reconcile installs the rules.';
    }
    return 'The prefixes S3 filters on do not match the sensors: it watches ' +
      `${actual.map((prefix) => prefix || '(the whole bucket)').join(', ')} but should watch ` +
      `${wanted.map((prefix) => prefix || '(the whole bucket)').join(', ')}. Uploads outside ` +
      'those paths are not announced. Reconcile rewrites them.';
  }
  if (status === 'quiet') {
    return 'Registered and ready, with no sensor archiving here yet — so it needs no upload ' +
      'rules and has none. Point a sensor at it and they are installed automatically.';
  }
  return `Watching ${actual.map((prefix) => prefix || '(the whole bucket)').join(', ')} for the ` +
    `${archiving} sensor(s) archiving here. Anything landing outside those paths is ignored.`;
}

function reload() {
  void storages.reload();
}

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

async function run(verb: string, action: () => Promise<unknown>) {
  busy.value = true;
  try {
    await action();
    $q.notify({ type: 'positive', message: verb, position: 'top' });
    await storages.reload();
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

// --- Add bucket ------------------------------------------------------------

const addOpen = ref(false);
const addMode = ref<'create' | 'adopt'>('create');
const addBucket = ref('');
const addDisplayName = ref('');
const addCostTracked = ref(true);
const adoptable = ref<Array<{ name: string; created_at: string | null }>>([]);
const adoptableState = ref<'idle' | 'loading' | 'error'>('idle');

function openAdd() {
  addMode.value = 'create';
  addBucket.value = '';
  addDisplayName.value = '';
  addCostTracked.value = true;
  addOpen.value = true;
}

/**
 * The picker is loaded only when the adopt tab is actually opened.
 * ListAllMyBuckets is an account-wide call and irrelevant to the create path,
 * so making every visit to this dialog pay for it would be waste.
 */
watch([addOpen, addMode], async ([open, mode]) => {
  if (!open || mode !== 'adopt' || adoptableState.value === 'loading') return;
  adoptableState.value = 'loading';
  try {
    adoptable.value = (await api.storagesAvailable()).buckets;
    adoptableState.value = 'idle';
  } catch {
    adoptable.value = [];
    adoptableState.value = 'error';
  }
});

async function submitAdd() {
  const bucket = addBucket.value.trim().toLowerCase();
  if (!bucket) {
    $q.notify({ type: 'warning', message: 'A bucket name is required.', position: 'top' });
    return;
  }
  addOpen.value = false;
  await run(`Bucket ${bucket} registered`, async () => {
    const result = await api.storageAdd({
      bucket,
      display_name: addDisplayName.value.trim() || null,
      create: addMode.value === 'create',
      cost_tracked: addCostTracked.value,
    });
    // Server-side warnings are things the operator asked for that had a
    // consequence worth naming — taking over another report's cost tag, above
    // all. Shown as their own sticky notice rather than folded into the success
    // toast, which is dismissed before it is read.
    for (const warning of result.warnings ?? []) {
      $q.notify({
        type: 'warning',
        message: warning,
        timeout: 0,
        actions: [{ label: 'Dismiss', color: 'white' }],
        position: 'top',
      });
    }
    return result;
  });
  selectedBucket.value = bucket;
}

/**
 * Converges every bucket's listener to its archiving-sensor count.
 *
 * There is no per-bucket switch to offer instead: one listener serves a whole
 * bucket and several sensors can share it, so its presence is a reference count
 * rather than a preference. This exists for drift — a listener someone removed
 * by hand, or one whose install failed while the bucket was unreachable.
 */
async function reconcileListeners() {
  busy.value = true;
  try {
    const result = await api.storageReconcile();
    const changed = [
      ...result.installed.map((bucket) => `installed on ${bucket}`),
      ...result.updated.map((bucket) => `prefixes rewritten on ${bucket}`),
      ...result.removed.map((bucket) => `removed from ${bucket}`),
    ];
    $q.notify({
      type: result.failed > 0 ? 'negative' : 'positive',
      message:
        result.failed > 0
          ? `Reconciled, but ${result.failed} bucket(s) failed`
          : changed.length
            ? 'Listeners reconciled'
            : 'Already in sync',
      ...(changed.length ? { caption: changed.join(' · ') } : {}),
      ...(result.failed > 0
        ? { timeout: 0, actions: [{ label: 'Dismiss', color: 'white' }] }
        : {}),
      position: 'top',
    });
    await storages.reload();
  } catch (error) {
    $q.notify({
      type: 'negative',
      message: error instanceof Error ? error.message : 'Reconcile failed.',
      position: 'top',
    });
  } finally {
    busy.value = false;
  }
}

async function toggleCostTracked(storage: StorageEntry) {
  const next = !storage.cost_tracked;
  const tag = storages.data.value?.cost_tag;

  if (!next) {
    const ok = await confirm({
      title: 'Stop tracking cost',
      message:
        `Removes ${tag ? `${tag.key}=${tag.value}` : 'the cost allocation tag'} from ` +
        `${storage.bucket}. Its storage and request charges will disappear from the Cost ` +
        'page from that point on. Spend already attributed stays attributed — Cost Explorer ' +
        'does not rewrite history either way.',
      okLabel: 'Stop tracking',
      color: 'warning',
    });
    if (!ok) return;
  }

  await run(
    `${storage.bucket} ${next ? 'now tracked on the Cost page' : 'no longer tracked'}`,
    () => api.storageUpdate(storage.bucket, { cost_tracked: next })
  );
}

async function removeStorage(storage: StorageEntry) {
  const archiving = storage.sensors.filter((sensor) => sensor.archive_enabled);
  const ok = await confirm({
    title: 'Unregister bucket',
    message:
      `Unregister ${storage.bucket}? The bucket and every file in it are left untouched — ` +
      'this only removes it from the console and stops the upload notification.' +
      (archiving.length
        ? ` ${archiving.length} sensor(s) archiving to it (${archiving
            .map((sensor) => sensor.name)
            .join(', ')}) will stop archiving and need a new bucket.`
        : ''),
    okLabel: 'Unregister',
    color: 'warning',
  });
  if (!ok) return;

  await run(`${storage.bucket} unregistered`, () => api.storageRemove(storage.bucket));
  if (selectedBucket.value === storage.bucket) selectedBucket.value = null;
}

// --- Detail tabs -----------------------------------------------------------

const detailTab = ref<'browse' | 'connect'>('browse');

const listing = ref<BucketListing | null>(null);
const listingState = ref<'idle' | 'loading' | 'error'>('idle');
const listingError = ref<string | null>(null);

async function loadListing(bucket: string) {
  listingState.value = 'loading';
  listingError.value = null;
  try {
    listing.value = await api.storageObjects(bucket, { limit: 50 });
    listingState.value = 'idle';
  } catch (error) {
    listing.value = null;
    listingError.value = error instanceof Error ? error.message : 'Request failed.';
    listingState.value = 'error';
  }
}

// Reloads on selection change, not on mount: the listing is per-bucket and
// meaningless without one.
watch([selectedBucket, detailTab], ([bucket, tab]) => {
  if (bucket && tab === 'browse') void loadListing(bucket);
});

/**
 * The policy an edge device's role needs to upload into this bucket.
 *
 * Shown rather than created. An edge device's role carries far more than S3
 * rights, so minting one here would mean the console owning a credential it has
 * no business owning — that belongs in its own feature, with its own review.
 */
function uploadPolicy(storage: StorageEntry): string {
  return JSON.stringify(
    {
      Version: '2012-10-17',
      Statement: [
        {
          Sid: 'MsightSensorUpload',
          Effect: 'Allow',
          Action: ['s3:PutObject'],
          Resource: `arn:aws:s3:::${storage.bucket}/*`,
        },
      ],
    },
    null,
    2
  );
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
    <PageHeader title="Storage">
      <template #subtitle>
        S3 buckets holding aggregated sensor data. A sensor that does not need real-time
        streaming writes files here from the edge instead — no queue, no consumer, and no
        cost until data actually arrives.
      </template>
      <template #actions>
        <q-btn
          outline
          color="primary"
          icon="refresh"
          label="Refresh"
          :loading="storages.state.value === 'loading'"
          @click="reload"
        />
        <q-btn
          v-if="isAdmin"
          outline
          color="primary"
          label="Reconcile"
          :loading="busy"
          @click="reconcileListeners"
        >
          <q-tooltip class="hint-tooltip">{{ HINTS.reconcile }}</q-tooltip>
        </q-btn>
        <q-btn
          v-if="isAdmin"
          unelevated
          color="primary"
          icon="add"
          label="Add bucket"
          :disable="busy"
          @click="openAdd"
        />
      </template>
    </PageHeader>

    <div class="row q-col-gutter-md q-mb-md">
      <div class="col-6 col-md-3">
        <q-card flat bordered>
          <q-card-section>
            <div class="text-caption text-grey-7 text-uppercase row items-center">
              Buckets<InfoHint :text="HINTS.registered" />
            </div>
            <div class="text-h6 q-mt-xs">
              <AsyncValue :state="storages.state.value" :error="storages.error.value">
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
              Archiving sensors<InfoHint :text="HINTS.attached" />
            </div>
            <div class="text-h6 q-mt-xs">
              <AsyncValue :state="storages.state.value" :error="storages.error.value">
                {{ attachedSensors }}
              </AsyncValue>
            </div>
          </q-card-section>
        </q-card>
      </div>
      <div class="col-6 col-md-3">
        <q-card flat bordered>
          <q-card-section>
            <div class="text-caption text-grey-7 text-uppercase row items-center">
              Listening<InfoHint :text="HINTS.publishing" />
            </div>
            <div class="text-h6 q-mt-xs">
              <AsyncValue :state="storages.state.value" :error="storages.error.value">
                {{ publishingCount }}
              </AsyncValue>
            </div>
          </q-card-section>
        </q-card>
      </div>
      <div class="col-6 col-md-3">
        <q-card flat bordered>
          <q-card-section>
            <div class="text-caption text-grey-7 text-uppercase row items-center">
              Needs attention<InfoHint :text="HINTS.attention" />
            </div>
            <div class="text-h6 q-mt-xs" :class="attentionCount > 0 ? 'text-negative' : ''">
              <AsyncValue :state="storages.state.value" :error="storages.error.value">
                {{ attentionCount }}
              </AsyncValue>
            </div>
          </q-card-section>
        </q-card>
      </div>
    </div>

    <AsyncValue :state="storages.state.value" :error="storages.error.value">
      <div class="row q-col-gutter-md">
        <!-- Registry -->
        <div class="col-12 col-md-5">
          <SectionCard title="Buckets" flush>
            <q-card-section v-if="!list.length" class="text-body2 text-grey-7">
              No storage buckets are registered.
              <template v-if="isAdmin">
                Use <strong>Add bucket</strong> to create one, or to register a bucket you
                already have.
              </template>
            </q-card-section>

            <q-list v-else separator>
              <q-item
                v-for="storage in list"
                :key="storage.bucket"
                v-ripple
                clickable
                :active="selectedBucket === storage.bucket"
                active-class="bg-blue-grey-1"
                @click="selectedBucket = storage.bucket"
              >
                <q-item-section avatar style="min-width: 26px">
                  <q-icon name="circle" size="10px" :color="STATUS_COLOR[statusOf(storage)]">
                    <q-tooltip class="hint-tooltip">{{ statusDetail(storage) }}</q-tooltip>
                  </q-icon>
                </q-item-section>

                <q-item-section>
                  <q-item-label>{{ storage.display_name || storage.bucket }}</q-item-label>
                  <q-item-label v-if="storage.display_name" caption class="mono">
                    {{ storage.bucket }}
                  </q-item-label>
                </q-item-section>

                <q-item-section side>
                  <q-item-label caption>
                    <template v-if="archivingCount(storage)">
                      {{ archivingCount(storage) }} archiving
                    </template>
                    <template v-else>no sensors</template>
                  </q-item-label>
                </q-item-section>

                <q-item-section v-if="isAdmin" side @click.stop>
                  <q-btn flat dense round icon="more_vert" size="sm" aria-label="Actions">
                    <q-menu auto-close>
                      <q-list style="min-width: 200px">
                        <q-item clickable :disable="busy" @click="toggleCostTracked(storage)">
                          <q-item-section>
                            {{ storage.cost_tracked ? 'Stop tracking cost' : 'Track cost' }}
                          </q-item-section>
                        </q-item>
                        <q-separator />
                        <q-item
                          clickable
                          :disable="busy"
                          class="text-negative"
                          @click="removeStorage(storage)"
                        >
                          <q-item-section>Unregister</q-item-section>
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
                  <q-icon name="circle" size="9px" color="positive" class="legend__dot" />
                  <span>
                    <strong>listening</strong> — a sensor archives here, so S3 announces every
                    file that lands
                  </span>
                </div>
                <div class="legend__row">
                  <q-icon name="circle" size="9px" color="grey-6" class="legend__dot" />
                  <span>
                    <strong>idle</strong> — registered with nothing archiving here yet, so it
                    needs no listener. A correct state, not a fault
                  </span>
                </div>
                <div class="legend__row">
                  <q-icon name="circle" size="9px" color="negative" class="legend__dot" />
                  <span>
                    <strong>needs attention</strong> — the bucket is unreachable, or its listener
                    does not match the number of sensors archiving here
                  </span>
                </div>
              </div>
            </q-card-section>

            <q-card-section
              v-if="storages.data.value?.console_bucket"
              class="text-caption text-grey-7 q-pt-none"
            >
              <q-separator class="q-mb-sm" />
              <div class="text-weight-medium">Also in this account</div>
              <div class="mono q-mt-xs">{{ storages.data.value.console_bucket }}</div>
              <div class="q-mt-xs">
                Hosts this console. Owned by CloudFormation and emptied when the stack is
                destroyed, so it is not offered as a sensor target.
              </div>
            </q-card-section>
          </SectionCard>
        </div>

        <!-- Detail -->
        <div class="col-12 col-md-7">
          <SectionCard
            :title="selected ? selected.display_name || selected.bucket : 'How storage works'"
            flush
          >
            <template #actions>
              <div v-if="selected && isAdmin" class="q-gutter-sm">
                <q-btn
                  outline
                  dense
                  size="sm"
                  color="negative"
                  label="Unregister"
                  :disable="busy"
                  @click="removeStorage(selected)"
                >
                  <q-tooltip class="hint-tooltip">{{ HINTS.remove }}</q-tooltip>
                </q-btn>
              </div>
            </template>

            <q-card-section v-if="!selected" class="text-body2 text-grey-7">
              <p class="q-mb-sm">
                Real-time streaming runs a queue and a container per sensor and bills for both
                continuously, whether data is flowing or not. For a sensor whose data is only
                ever analysed later, that is spend for nothing.
              </p>
              <p class="q-mb-sm">
                Those sensors upload aggregated files straight to S3 from the edge instead.
                Registering a bucket here makes it available as an archive target; several
                sensors can share one under different prefixes.
              </p>
              <p class="q-mb-sm">
                Its upload listener is not a setting. One listener serves the whole bucket, so
                its presence is a count: installed when the first sensor starts archiving here,
                removed after the last one stops.
              </p>
              <p class="q-ma-none">Select a bucket to see what is in it.</p>
            </q-card-section>

            <template v-else>
              <q-card-section class="q-pt-md">
                <q-banner
                  v-if="statusOf(selected) !== 'ok'"
                  rounded
                  dense
                  class="q-mb-md"
                  :class="statusOf(selected) === 'quiet' ? 'bg-blue-1 text-grey-9' : 'bg-orange-1 text-grey-9'"
                >
                  <template #avatar>
                    <q-icon
                      :name="statusOf(selected) === 'quiet' ? 'info' : 'warning'"
                      :color="statusOf(selected) === 'quiet' ? 'info' : 'warning'"
                    />
                  </template>
                  <div class="text-body2">{{ statusDetail(selected) }}</div>
                </q-banner>

                <q-list dense>
                  <q-item class="q-px-none">
                    <q-item-section>
                      <q-item-label caption>Bucket</q-item-label>
                      <q-item-label class="mono">
                        {{ selected.bucket }}
                        <!-- Objects, lifecycle rules and the policy are S3's.
                             This page describes the bucket; it does not browse
                             it. -->
                        <AwsLink :href="aws.s3Bucket(selected.bucket)" class="q-ml-xs" />
                      </q-item-label>
                    </q-item-section>
                    <q-item-section side>
                      <q-btn
                        flat
                        dense
                        round
                        size="sm"
                        icon="content_copy"
                        @click="copy(selected.bucket)"
                      >
                        <q-tooltip>Copy</q-tooltip>
                      </q-btn>
                    </q-item-section>
                  </q-item>
                  <q-item class="q-px-none">
                    <q-item-section>
                      <q-item-label caption>
                        Origin<InfoHint :text="HINTS.origin" />
                      </q-item-label>
                      <q-item-label>
                        {{ selected.origin === 'created' ? 'Created by this deployment' : 'Adopted — existed already' }}
                      </q-item-label>
                    </q-item-section>
                    <q-item-section side>
                      <q-item-label caption>Region</q-item-label>
                      <q-item-label>{{ selected.facts.region ?? storages.data.value?.region ?? 'unknown' }}</q-item-label>
                    </q-item-section>
                  </q-item>
                  <q-item class="q-px-none">
                    <q-item-section>
                      <q-item-label caption>
                        Upload listener<InfoHint :text="HINTS.notify" />
                      </q-item-label>
                      <q-item-label
                        :class="selected.facts.notifies_control_topic ? '' : 'text-grey-7'"
                      >
                        <template v-if="selected.facts.notification_prefixes.length">
                          watching
                          <span
                            v-for="prefix in selected.facts.notification_prefixes"
                            :key="prefix"
                            class="mono q-ml-xs"
                          >{{ prefix || '(whole bucket)' }}</span>
                        </template>
                        <template v-else-if="archivingCount(selected) > 0">
                          none — {{ archivingCount(selected) }} sensor(s) archiving here are
                          unannounced
                        </template>
                        <template v-else>
                          not needed — nothing archives here
                        </template>
                      </q-item-label>
                    </q-item-section>
                    <q-item-section side>
                      <q-item-label caption>Versioning</q-item-label>
                      <q-item-label>{{ selected.facts.versioning ?? 'unknown' }}</q-item-label>
                    </q-item-section>
                  </q-item>
                  <q-item class="q-px-none">
                    <q-item-section>
                      <q-item-label caption>
                        Cost tracking<InfoHint :text="HINTS.cost" />
                      </q-item-label>
                      <q-item-label :class="selected.cost_tracked ? '' : 'text-grey-7'">
                        <template v-if="selected.cost_tracked">
                          tagged
                          <span class="mono">
                            {{ storages.data.value?.cost_tag.key }}={{ storages.data.value?.cost_tag.value }}
                          </span>
                        </template>
                        <template v-else>
                          not tagged — absent from the Cost page
                        </template>
                      </q-item-label>
                    </q-item-section>
                    <q-item-section v-if="isAdmin" side>
                      <q-btn
                        flat
                        dense
                        size="sm"
                        no-caps
                        :disable="busy"
                        :label="selected.cost_tracked ? 'Stop tracking' : 'Track cost'"
                        @click="toggleCostTracked(selected)"
                      />
                    </q-item-section>
                  </q-item>
                  <q-item v-if="selected.facts.notifies_control_topic" class="q-px-none">
                    <q-item-section>
                      <q-item-label caption>Events go to</q-item-label>
                      <q-item-label class="mono ellipsis">
                        {{ storages.data.value?.control_topic_arn }}
                      </q-item-label>
                    </q-item-section>
                    <q-item-section side>
                      <q-btn
                        flat
                        dense
                        round
                        size="sm"
                        icon="content_copy"
                        @click="copy(storages.data.value?.control_topic_arn)"
                      >
                        <q-tooltip>Copy</q-tooltip>
                      </q-btn>
                    </q-item-section>
                  </q-item>
                  <q-item v-if="selected.sensors.length" class="q-px-none">
                    <q-item-section>
                      <q-item-label caption>Sensors</q-item-label>
                      <q-item-label>
                        <span
                          v-for="sensor in selected.sensors"
                          :key="sensor.name"
                          class="q-mr-sm"
                          :class="sensor.archive_enabled ? '' : 'text-grey-6'"
                        >
                          {{ sensor.name }}<template v-if="sensor.archive_enabled">
                            <span class="mono text-grey-7">
                              → {{ sensor.prefix || '(whole bucket)' }}</span></template><template
                            v-else
                          > (not archiving)</template>
                        </span>
                      </q-item-label>
                    </q-item-section>
                  </q-item>
                </q-list>

                <q-banner
                  v-if="selected.facts.foreign_notification_ids.length"
                  rounded
                  dense
                  class="bg-blue-1 text-grey-9 q-mt-md"
                >
                  <template #avatar><q-icon name="info" color="info" /></template>
                  <div class="text-body2">
                    This bucket also notifies something outside MSight
                    ({{ selected.facts.foreign_notification_ids.join(', ') }}). Those rules are
                    left alone — the console only ever adds or removes its own.
                  </div>
                </q-banner>
              </q-card-section>

              <q-separator />

              <q-tabs
                v-model="detailTab"
                dense
                align="left"
                class="text-grey-7"
                active-color="primary"
                indicator-color="primary"
                narrow-indicator
              >
                <q-tab name="browse" label="Contents" />
                <q-tab name="connect" label="Connect a device" />
              </q-tabs>

              <q-separator />

              <q-tab-panels v-model="detailTab" animated>
                <!-- Live S3 listing. Nothing records uploads, so S3 is the only source. -->
                <q-tab-panel name="browse" class="q-pa-none">
                  <q-card-section v-if="listingState === 'loading'" class="text-body2 text-grey-7">
                    <q-spinner size="16px" class="q-mr-sm" />Loading
                  </q-card-section>
                  <q-card-section v-else-if="listingState === 'error'" class="text-body2 text-negative">
                    {{ listingError }}
                  </q-card-section>
                  <q-card-section v-else-if="!listing?.objects.length" class="text-body2 text-grey-7">
                    The bucket is empty.
                  </q-card-section>
                  <template v-else>
                    <q-list separator dense>
                      <q-item v-for="object in listing.objects" :key="object.key">
                        <q-item-section>
                          <q-item-label class="mono ellipsis">{{ object.key }}</q-item-label>
                          <q-item-label caption>
                            {{ object.last_modified ? new Date(object.last_modified).toLocaleString() : 'unknown time' }}
                          </q-item-label>
                        </q-item-section>
                        <q-item-section side>
                          <q-item-label caption>{{ formatBytes(object.size) }}</q-item-label>
                        </q-item-section>
                      </q-item>
                    </q-list>
                    <q-card-section v-if="listing.next_cursor" class="text-caption text-grey-7">
                      Showing the first {{ listing.limit }} keys. This is a live listing straight
                      from S3, not a record kept here.
                    </q-card-section>
                  </template>
                </q-tab-panel>

                <!-- Upload instructions -->
                <q-tab-panel name="connect">
                  <div class="text-body2">
                    <p>
                      Edge devices upload straight to S3 with their own credentials. The console
                      does not create those — an edge role usually needs far more than S3 access,
                      so it is configured outside the console for now.
                    </p>
                    <ol class="q-pl-md q-ma-none" style="line-height: 1.7">
                      <li class="q-mb-sm">
                        Give the device's IAM role or user permission to write to this bucket.
                        The minimum is below; narrow <code>Resource</code> to the sensor's own
                        prefix if the device only ever writes there.
                      </li>
                      <li class="q-mb-sm">
                        On the <strong>Sensors</strong> page, set the sensor's archive bucket to
                        <code>{{ selected.bucket }}</code> and give it a prefix. That prefix is
                        what maps an uploaded key back to a sensor — the registry is the lookup
                        table anything downstream uses to do that.
                      </li>
                      <li>
                        Upload with any S3 client. If this bucket announces uploads, each file
                        publishes an event on the control topic; subscribe to that topic to act
                        on them. Nothing in this stack subscribes today, and SNS does not buffer —
                        events with no subscriber are dropped.
                      </li>
                    </ol>

                    <div class="row items-center q-mt-md q-mb-xs">
                      <div class="text-caption text-grey-7 text-uppercase">Minimum policy</div>
                      <q-space />
                      <q-btn
                        flat
                        dense
                        size="sm"
                        icon="content_copy"
                        label="Copy"
                        @click="copy(uploadPolicy(selected))"
                      />
                    </div>
                    <pre class="policy mono">{{ uploadPolicy(selected) }}</pre>
                  </div>
                </q-tab-panel>
              </q-tab-panels>
            </template>
          </SectionCard>
        </div>
      </div>
    </AsyncValue>

    <!-- Add bucket -->
    <q-dialog v-model="addOpen">
      <q-card style="min-width: min(520px, 92vw)">
        <q-card-section>
          <div class="text-h6">Add storage bucket</div>
        </q-card-section>

        <q-card-section class="q-pt-none">
          <q-btn-toggle
            v-model="addMode"
            spread
            no-caps
            unelevated
            toggle-color="primary"
            :options="[
              { label: 'Create new bucket', value: 'create' },
              { label: 'Use existing bucket', value: 'adopt' },
            ]"
          />
          <div class="text-caption text-grey-7 q-mt-sm">
            {{ addMode === 'create' ? HINTS.create : HINTS.adopt }}
          </div>
        </q-card-section>

        <q-card-section class="q-gutter-md q-pt-none">
          <q-input
            v-if="addMode === 'create'"
            v-model="addBucket"
            outlined
            dense
            label="Bucket name"
            placeholder="e.g. msight-sensor-archive"
            autofocus
            hint="3-63 characters, lowercase letters, digits, hyphens or dots. Globally unique across all of AWS."
          />
          <q-select
            v-else
            v-model="addBucket"
            outlined
            dense
            use-input
            fill-input
            hide-selected
            input-debounce="0"
            label="Bucket"
            :loading="adoptableState === 'loading'"
            :options="adoptable.map((bucket) => bucket.name)"
            @filter="(value: string, update: (fn: () => void) => void) => update(() => {})"
          >
            <template #hint>
              <template v-if="adoptableState === 'error'">
                The bucket list could not be loaded — type the name instead.
              </template>
              <template v-else>
                Buckets in this account that are not registered yet. It must be in
                {{ storages.data.value?.region }}: S3 only notifies a topic in the bucket's own
                region.
              </template>
            </template>
          </q-select>

          <q-input
            v-model="addDisplayName"
            outlined
            dense
            label="Display name (optional)"
            placeholder="Aggregated SDSM archive"
            hint="Shown in the console instead of the raw bucket name. Safe to change."
          />

          <q-toggle v-model="addCostTracked">
            <template #default>
              Track cost as
              <span class="mono">
                {{ storages.data.value?.cost_tag.key }}={{ storages.data.value?.cost_tag.value }}
              </span>
            </template>
          </q-toggle>
          <div class="text-caption text-grey-7" style="margin-top: -8px">
            {{ HINTS.costTracked }}
            <template v-if="addMode === 'adopt'">
              Cost Explorer attributes <strong>all</strong> of a bucket's spend to its tags, so
              leave this off if the bucket also holds data belonging to something else. If it
              already carries this tag with a different value, that value is replaced.
            </template>
          </div>
        </q-card-section>

        <q-banner dense class="bg-blue-1 text-grey-9 q-mx-md q-mb-md" rounded>
          <template #avatar><q-icon name="info" color="info" /></template>
          <div class="text-body2">
            <template v-if="addMode === 'create'">
              The bucket is created private and encrypted. Nothing can write to it until you
              give an edge device's role permission — the console mints no credentials.
            </template>
            <template v-else>
              Existing contents are left alone. The only changes made to the bucket are this
              deployment's tags. An upload listener is added later, and only if a sensor
              actually archives here, and it is filtered to that sensor's prefix — so anything
              else already in the bucket is left entirely alone.
            </template>
          </div>
        </q-banner>

        <q-card-actions align="right" class="q-pa-md q-pt-none">
          <q-btn flat label="Cancel" color="grey-8" @click="addOpen = false" />
          <q-btn
            unelevated
            color="primary"
            :label="addMode === 'create' ? 'Create' : 'Register'"
            :loading="busy"
            @click="submitAdd"
          />
        </q-card-actions>
      </q-card>
    </q-dialog>
  </q-page>
</template>

<style scoped>
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

/* The policy is wide; let it scroll on its own rather than stretching the card. */
.policy {
  margin: 0;
  padding: 12px;
  background: #f5f6f9;
  border-radius: 6px;
  font-size: 12px;
  line-height: 1.5;
  overflow-x: auto;
}
</style>

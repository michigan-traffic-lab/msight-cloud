<script setup lang="ts">
import { computed, ref } from 'vue';
import { useQuasar } from 'quasar';
import {
  api,
  type ReconcileResult,
  type SensorEntry,
  type SensorsResponse,
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
    'Sensors in the registry table, enabled or not. This is the desired state — ' +
    'what should exist, not what does.',
  enabled:
    'How many sensors you have asked to be live. Enabled is a setting, not a ' +
    'health check — a sensor can be enabled and still not running yet, which is ' +
    'what Out of sync counts. Disabling tears the infrastructure down on purpose ' +
    'but keeps the registry row, so it can be switched back on later.',
  waiting:
    'Messages sitting in the SQS queues, summed across sensors. A steady number ' +
    'near zero is healthy — the consumers keep up. A number that only climbs ' +
    'means messages are arriving with nothing processing them.',
  drift:
    'Sensors where AWS does not match what you asked for: enabled but missing a ' +
    'queue or consumer, or disabled with resources still up. This is the only ' +
    'status that means something is wrong — a disabled sensor with nothing ' +
    'running is correct, not out of sync. Also counts queues with no registry ' +
    'row. Reconcile fixes these.',
  reconcile:
    'Compares the registry against AWS and makes AWS match: creates what is ' +
    'missing, deletes what should not exist. Safe to run any time — it does ' +
    'nothing when the two already agree. This also runs automatically every 5 ' +
    'minutes and after every change, so you rarely need it by hand.',
  add:
    'Registers a sensor and immediately creates its SQS queue, topic ' +
    'subscription and consumer service. No separate Reconcile needed, and no ' +
    'redeploy — it is usually processing messages within a minute or two.',
  disable:
    'Pause: tears down the queue, subscription and consumer, but keeps the ' +
    'registry row and its name. Queued messages are discarded and anything the ' +
    'field sensor publishes meanwhile is dropped. Reversible — Enable rebuilds it.',
  enable:
    'Rebuilds the queue, subscription and consumer for this sensor. Takes a ' +
    'minute or two before it starts processing.',
  remove:
    'Delete: removes the registry row AND all its infrastructure. The name is ' +
    'freed for reuse. Not reversible — to pause a sensor without losing its ' +
    'configuration, use Disable instead.',
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
const addOpen = ref(false);
const addName = ref('');
const addDisplayName = ref('');
const lastReconcile = ref<ReconcileResult | null>(null);

const list = computed<SensorEntry[]>(() => sensors.data.value?.sensors ?? []);

const selected = computed<SensorEntry | null>(
  () => list.value.find((sensor) => sensor.name === selectedName.value) ?? null
);

const backlog = computed(() =>
  list.value.reduce((sum, sensor) => sum + (sensor.messages_available ?? 0), 0)
);

/**
 * A sensor is drifted when the registry and AWS disagree: enabled but missing
 * its queue or service, or disabled while its infrastructure is still up.
 */
function isDrifted(sensor: SensorEntry): boolean {
  return sensor.enabled
    ? !sensor.queue_exists || !sensor.service_exists
    : sensor.queue_exists || sensor.service_exists;
}

const driftCount = computed(
  () => list.value.filter(isDrifted).length + (sensors.data.value?.orphaned_queues.length ?? 0)
);

/**
 * Two independent facts decide a sensor's status, and conflating them is what
 * makes "disabled" and "out of sync" look like the same thing:
 *
 *   enabled / disabled    — what you asked for
 *   in sync / out of sync — whether AWS matches what you asked for
 *
 * A disabled sensor with no queue is CORRECT, not broken. A disabled sensor
 * whose queue is still up is out of sync in the opposite direction. So drift is
 * checked first: it is the only status that means something needs fixing.
 */
function statusOf(sensor: SensorEntry): 'ok' | 'disabled' | 'drift' {
  if (isDrifted(sensor)) return 'drift';
  return sensor.enabled ? 'ok' : 'disabled';
}

const STATUS_COLOR = { ok: 'positive', disabled: 'grey-6', drift: 'negative' } as const;

/** A full sentence for this specific sensor, naming what is missing or left over. */
function statusDetail(sensor: SensorEntry): string {
  if (!isDrifted(sensor)) {
    return sensor.enabled
      ? 'Running. Its queue and consumer both exist, matching the registry.'
      : 'Off on purpose. The registry row is kept so it can be switched back on, ' +
          'but its queue and consumer have been removed — nothing is processed or billed.';
  }

  const parts: string[] = [];
  if (sensor.enabled) {
    if (!sensor.queue_exists) parts.push('queue');
    if (!sensor.service_exists) parts.push('consumer');
    const noun = parts.join(' and ');
    return (
      `Out of sync. It is enabled, so its ${noun} should exist, but ` +
      `${parts.length > 1 ? 'they are' : 'it is'} missing. Reconcile will create ` +
      `${parts.length > 1 ? 'them' : 'it'}.`
    );
  }

  if (sensor.queue_exists) parts.push('queue');
  if (sensor.service_exists) parts.push('consumer');
  const noun = parts.join(' and ');
  return (
    `Out of sync. It is disabled, so nothing should exist, but its ${noun} ` +
    `${parts.length > 1 ? 'are' : 'is'} still up. Reconcile will remove ` +
    `${parts.length > 1 ? 'them' : 'it'}.`
  );
}

/** Short form for the list row: which half is wrong. */
function driftSummary(sensor: SensorEntry): string {
  const missing = sensor.enabled
    ? [!sensor.queue_exists && 'queue', !sensor.service_exists && 'consumer']
    : [sensor.queue_exists && 'queue', sensor.service_exists && 'consumer'];
  const parts = missing.filter(Boolean).join(' + ');
  return `${sensor.enabled ? 'missing' : 'leftover'} ${parts}`;
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
 * Every mutation returns the reconcile it triggered. Surfacing that rather than
 * a bare "saved" matters: the row is written first and the infrastructure after,
 * so a per-sensor failure leaves the registry correct and AWS behind.
 */
function reportReconcile(result: ReconcileResult, verb: string) {
  lastReconcile.value = result;
  if (result.failed > 0) {
    const first = result.actions.find((action) => action.error !== null);
    $q.notify({
      type: 'negative',
      message: `${verb}, but reconcile reported ${result.failed} failure(s)`,
      // Spread rather than `caption: x ?? undefined`: exactOptionalPropertyTypes
      // rejects an explicitly-undefined optional property.
      ...(first?.error ? { caption: first.error } : {}),
      timeout: 0,
      actions: [{ label: 'Dismiss', color: 'white' }],
      position: 'top',
    });
  } else {
    $q.notify({ type: 'positive', message: verb, position: 'top' });
  }
}

async function run(verb: string, action: () => Promise<{ reconcile: ReconcileResult }>) {
  busy.value = true;
  try {
    const response = await action();
    reportReconcile(response.reconcile, verb);
    await sensors.reload();
  } catch (error) {
    $q.notify({
      type: 'negative',
      message: error instanceof Error ? error.message : 'Request failed.',
      position: 'top',
    });
  } finally {
    busy.value = false;
  }
}

function openAdd() {
  addName.value = '';
  addDisplayName.value = '';
  addOpen.value = true;
}

async function submitAdd() {
  const name = addName.value.trim();
  if (!name) {
    $q.notify({ type: 'warning', message: 'A sensor name is required.', position: 'top' });
    return;
  }
  addOpen.value = false;
  await run(`Sensor ${name} added`, () => api.sensorAdd(name, addDisplayName.value.trim() || null));
  selectedName.value = name;
}

async function toggleEnabled(sensor: SensorEntry) {
  const next = !sensor.enabled;
  if (!next) {
    const ok = await confirm({
      title: 'Disable sensor',
      message:
        `Disabling ${sensor.name} tears down its queue and consumer. Messages still queued ` +
        'are discarded, and anything the field sensor publishes while it is disabled is ' +
        'dropped silently. Re-enabling rebuilds the infrastructure.',
      okLabel: 'Disable',
      color: 'warning',
    });
    if (!ok) return;
  }
  await run(`Sensor ${sensor.name} ${next ? 'enabled' : 'disabled'}`, () =>
    api.sensorSetEnabled(sensor.name, next)
  );
}

async function removeSensor(sensor: SensorEntry) {
  const ok = await confirm({
    title: 'Remove sensor',
    message:
      `Permanently remove ${sensor.name}? Its registry row, SQS queue, topic subscription ` +
      'and ECS service are all deleted, and queued messages are discarded. This cannot be ' +
      'undone — to pause a sensor without losing its configuration, disable it instead.',
    okLabel: 'Remove',
    color: 'negative',
  });
  if (!ok) return;

  await run(`Sensor ${sensor.name} removed`, () => api.sensorRemove(sensor.name));
  if (selectedName.value === sensor.name) selectedName.value = null;
}

async function reconcileNow() {
  busy.value = true;
  try {
    const result = await api.sensorReconcile();
    reportReconcile(result, 'Reconciled');
    await sensors.reload();
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
        Sensors live in the <code>sensors</code> table, not in the deploy config. Adding one
        here creates its SQS FIFO queue, topic subscription and consumer service within
        seconds — no redeploy.
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
              Enabled<InfoHint :text="HINTS.enabled" />
            </div>
            <div class="text-h6 q-mt-xs">
              <AsyncValue :state="sensors.state.value" :error="sensors.error.value">
                {{ list.filter((s) => s.enabled).length }}
              </AsyncValue>
            </div>
          </q-card-section>
        </q-card>
      </div>
      <div class="col-6 col-md-3">
        <q-card flat bordered>
          <q-card-section>
            <div class="text-caption text-grey-7 text-uppercase row items-center">
              Waiting<InfoHint :text="HINTS.waiting" />
            </div>
            <div class="text-h6 q-mt-xs">
              <AsyncValue :state="sensors.state.value" :error="sensors.error.value">
                {{ backlog.toLocaleString() }}
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
                  <q-item-label v-if="sensor.display_name" caption class="mono">
                    {{ sensor.name }}
                  </q-item-label>
                </q-item-section>

                <q-item-section side>
                  <q-item-label caption :class="isDrifted(sensor) ? 'text-negative' : ''">
                    <template v-if="isDrifted(sensor)">{{ driftSummary(sensor) }}</template>
                    <template v-else-if="!sensor.enabled">off</template>
                    <template v-else>{{ sensor.messages_available ?? 0 }} waiting</template>
                  </q-item-label>
                </q-item-section>

                <!-- Row actions, so a sensor can be managed without selecting
                     it first. .stop keeps the menu from also changing selection. -->
                <q-item-section v-if="isAdmin" side @click.stop>
                  <q-btn flat dense round icon="more_vert" size="sm" aria-label="Actions">
                    <q-menu auto-close>
                      <q-list style="min-width: 160px">
                        <q-item clickable :disable="busy" @click="toggleEnabled(sensor)">
                          <q-item-section>{{ sensor.enabled ? 'Disable' : 'Enable' }}</q-item-section>
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
                <q-icon name="circle" size="9px" color="positive" class="legend__dot" />
                <span><strong>running</strong> — enabled, queue and consumer both up</span>
              </div>
              <div class="legend__row">
                <q-icon name="circle" size="9px" color="grey-6" class="legend__dot" />
                <span>
                  <strong>off</strong> — disabled and torn down to match. A correct state, not a
                  fault
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
              <div v-if="selected && isAdmin" class="q-gutter-sm">
                <q-btn outline dense size="sm" :disable="busy" :label="selected.enabled ? 'Disable' : 'Enable'" @click="toggleEnabled(selected)">
                  <q-tooltip class="hint-tooltip">
                    {{ selected.enabled ? HINTS.disable : HINTS.enable }}
                  </q-tooltip>
                </q-btn>
                <q-btn outline dense size="sm" color="negative" label="Remove" :disable="busy" @click="removeSensor(selected)">
                  <q-tooltip class="hint-tooltip">{{ HINTS.remove }}</q-tooltip>
                </q-btn>
              </div>
            </template>

            <q-card-section v-if="!selected" class="text-body2 text-grey-7">
              Select a sensor to see the topic to publish to, the routing attribute it needs, and
              what the message must contain.
            </q-card-section>

            <template v-else>
              <q-card-section class="q-pt-md">
                <!-- Drift first: a DISABLED sensor with leftover resources is
                     still out of sync, and showing only "off" there would hide
                     the very thing that needs fixing. -->
                <q-banner v-if="isDrifted(selected)" rounded dense class="bg-orange-1 text-grey-9 q-mb-md">
                  <template #avatar><q-icon name="warning" color="warning" /></template>
                  <div class="text-weight-medium">Out of sync</div>
                  <div class="text-body2">{{ statusDetail(selected) }}</div>
                </q-banner>
                <q-banner v-else-if="!selected.enabled" rounded dense class="bg-blue-1 text-grey-9 q-mb-md">
                  <template #avatar><q-icon name="info" color="info" /></template>
                  <div class="text-weight-medium">This sensor is off</div>
                  <div class="text-body2">{{ statusDetail(selected) }}</div>
                </q-banner>

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
                      <q-item-label caption>Delivers to</q-item-label>
                      <q-item-label class="mono">{{ selected.queue_name }}</q-item-label>
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
                    Publish to the topic above. The sensor does not write to SQS directly — the
                    topic fans out to the right queue.
                  </li>
                  <li class="q-mb-sm">
                    Set the message attribute
                    <code>{{ sensors.data.value?.routing_attribute }}</code> to exactly
                    <code>{{ selected.name }}</code>. This is what routes the message. A missing
                    or misspelled value matches no subscription and is dropped
                    <strong>without an error</strong>.
                  </li>
                  <li class="q-mb-sm">
                    Set a <code>MessageGroupId</code> — required on a FIFO topic. Ordering holds
                    within a group, so use one group per sensor.
                  </li>
                  <li class="q-mb-sm">
                    Body is JSON with <code>capture_timestamp</code> (epoch seconds) and
                    <code>data</code>: base64 of a <code>Type=SDSM</code> /
                    <code>Payload=&lt;hex&gt;</code> text block. Anything whose type is not
                    <code>SDSM</code> is logged and skipped.
                  </li>
                  <li>
                    Content-based deduplication is on. Two identical bodies published within five
                    minutes are treated as one — vary the payload or set an explicit
                    <code>MessageDeduplicationId</code> when replaying test data.
                  </li>
                </ol>
              </q-card-section>
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
      <q-card style="min-width: min(460px, 92vw)">
        <q-card-section>
          <div class="text-h6">Add sensor</div>
        </q-card-section>

        <q-card-section class="q-gutter-md q-pt-none">
          <q-input v-model="addName" outlined dense label="Sensor name" placeholder="e.g. plymouth_barton" autofocus>
            <template #hint>
              Must match the <code>{{ sensors.data.value?.routing_attribute }}</code> attribute the
              field sensor publishes. It becomes part of the SQS queue name, so letters, digits,
              underscore and hyphen only — and it cannot be changed later.
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

        <q-banner dense class="bg-blue-1 text-grey-9 q-mx-md q-mb-md" rounded>
          <template #avatar><q-icon name="info" color="info" /></template>
          <div class="text-body2">
            Creating the sensor also builds its infrastructure straight away — no separate
            Reconcile and no <code>cdk deploy</code>. It normally starts processing within a
            minute or two; until then it shows as out of sync.
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

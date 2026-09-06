<script setup lang="ts">
import { computed, ref } from 'vue';
import { ElMessage, ElMessageBox } from 'element-plus';
import {
  api,
  type ReconcileResult,
  type SensorEntry,
  type SensorsResponse,
} from '@/api/client';
import { useAsyncValue } from '@/composables/useAsyncValue';
import AsyncValue from '@/components/AsyncValue.vue';
import InfoHint from '@/components/InfoHint.vue';
import { useAuthStore } from '@/stores/auth';

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
// control for anyone whose profile loads after this view mounts.
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
 *   enabled / disabled  — what you asked for
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

function reload() {
  void sensors.reload();
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
    ElMessage.error(`${verb}, but reconcile reported ${result.failed} failure(s): ${first?.error}`);
  } else {
    ElMessage.success(verb);
  }
}

async function run(verb: string, action: () => Promise<{ reconcile: ReconcileResult }>) {
  busy.value = true;
  try {
    const response = await action();
    reportReconcile(response.reconcile, verb);
    await sensors.reload();
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : 'Request failed.');
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
    ElMessage.warning('A sensor name is required.');
    return;
  }
  addOpen.value = false;
  await run(`Sensor ${name} added`, () =>
    api.sensorAdd(name, addDisplayName.value.trim() || null)
  );
  selectedName.value = name;
}

async function toggleEnabled(sensor: SensorEntry) {
  const next = !sensor.enabled;
  if (!next) {
    try {
      await ElMessageBox.confirm(
        `Disabling ${sensor.name} tears down its queue and consumer. Messages still queued are ` +
          'discarded, and anything the field sensor publishes while it is disabled is dropped ' +
          'silently. Re-enabling rebuilds the infrastructure.',
        'Disable sensor',
        { confirmButtonText: 'Disable', cancelButtonText: 'Cancel', type: 'warning' }
      );
    } catch {
      return;
    }
  }
  await run(`Sensor ${sensor.name} ${next ? 'enabled' : 'disabled'}`, () =>
    api.sensorSetEnabled(sensor.name, next)
  );
}

async function removeSensor(sensor: SensorEntry) {
  try {
    await ElMessageBox.confirm(
      `Permanently remove ${sensor.name}? Its registry row, SQS queue, topic subscription and ` +
        'ECS service are all deleted, and queued messages are discarded. This cannot be undone — ' +
        'to pause a sensor without losing its configuration, disable it instead.',
      'Remove sensor',
      { confirmButtonText: 'Remove', cancelButtonText: 'Cancel', type: 'error' }
    );
  } catch {
    return;
  }
  await run(`Sensor ${sensor.name} removed`, () => api.sensorRemove(sensor.name));
  if (selectedName.value === sensor.name) selectedName.value = null;
}

function onRowCommand(command: string, sensor: SensorEntry) {
  if (command === 'toggle') void toggleEnabled(sensor);
  else if (command === 'remove') void removeSensor(sensor);
  else if (command === 'reconcile') void reconcileNow();
}

async function reconcileNow() {
  busy.value = true;
  try {
    const result = await api.sensorReconcile();
    reportReconcile(result, 'Reconciled');
    await sensors.reload();
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : 'Reconcile failed.');
  } finally {
    busy.value = false;
  }
}

async function copy(text: string) {
  try {
    await navigator.clipboard.writeText(text);
    ElMessage.success('Copied');
  } catch {
    ElMessage.error('Clipboard unavailable.');
  }
}
</script>

<template>
  <div>
    <div class="header">
      <div>
        <h1 class="page-title">Sensors</h1>
        <p class="page-subtitle">
          Sensors live in the <code>sensors</code> table, not in the deploy config. Adding one here
          creates its SQS FIFO queue, topic subscription and consumer service within seconds — no
          redeploy.
        </p>
      </div>
      <div class="header__actions">
        <el-button :loading="sensors.state.value === 'loading'" @click="reload">Refresh</el-button>
        <el-tooltip v-if="isAdmin" :content="HINTS.reconcile" placement="bottom" :show-after="120" popper-class="hint-popper">
          <el-button :loading="busy" @click="reconcileNow">Reconcile</el-button>
        </el-tooltip>
        <el-tooltip v-if="isAdmin" :content="HINTS.add" placement="bottom" :show-after="120" popper-class="hint-popper">
          <el-button type="primary" :disabled="busy" @click="openAdd">Add sensor</el-button>
        </el-tooltip>
      </div>
    </div>

    <div class="stat-grid">
      <div class="stat">
        <div class="stat__label">Registered sensors<InfoHint :text="HINTS.registered" /></div>
        <div class="stat__value">
          <AsyncValue :state="sensors.state.value" :error="sensors.error.value">
            {{ list.length }}
          </AsyncValue>
        </div>
      </div>
      <div class="stat">
        <div class="stat__label">Enabled<InfoHint :text="HINTS.enabled" /></div>
        <div class="stat__value">
          <AsyncValue :state="sensors.state.value" :error="sensors.error.value">
            {{ list.filter((s) => s.enabled).length }}
          </AsyncValue>
        </div>
      </div>
      <div class="stat">
        <div class="stat__label">Messages waiting<InfoHint :text="HINTS.waiting" /></div>
        <div class="stat__value">
          <AsyncValue :state="sensors.state.value" :error="sensors.error.value">
            {{ backlog.toLocaleString() }}
          </AsyncValue>
        </div>
      </div>
      <div class="stat">
        <div class="stat__label">Out of sync<InfoHint :text="HINTS.drift" /></div>
        <div class="stat__value">
          <AsyncValue :state="sensors.state.value" :error="sensors.error.value">
            <span :class="driftCount > 0 ? 'bad' : ''">{{ driftCount }}</span>
          </AsyncValue>
        </div>
      </div>
    </div>

    <AsyncValue :state="sensors.state.value" :error="sensors.error.value">
      <el-alert
        v-if="sensors.data.value?.orphaned_queues.length"
        type="warning"
        show-icon
        :closable="false"
        class="alert"
        title="Queues with no registry row"
      >
        <template #default>
          <p class="alert__body">
            {{ sensors.data.value.orphaned_queues.join(', ') }} —
            a sensor was removed while its teardown failed, or a reconcile stopped halfway. Running
            <strong>Reconcile</strong> deletes them.
          </p>
        </template>
      </el-alert>

      <div class="grid">
        <section class="card">
          <h2 class="card__title">Registry</h2>

          <div v-if="!list.length" class="empty">
            No sensors are registered.
            <template v-if="isAdmin">Use <strong>Add sensor</strong> to create the first one.</template>
          </div>

          <ul v-else class="list">
            <li
              v-for="sensor in list"
              :key="sensor.name"
              class="row"
              :class="{ 'row--active': selectedName === sensor.name }"
              tabindex="0"
              role="button"
              @click="selectedName = sensor.name"
              @keydown.enter="selectedName = sensor.name"
            >
              <el-tooltip
                :content="statusDetail(sensor)"
                placement="right"
                :show-after="120"
                popper-class="hint-popper"
              >
                <span class="dot" :class="`dot--${statusOf(sensor)}`" />
              </el-tooltip>
              <span class="row__name">
                {{ sensor.display_name || sensor.name }}
                <span v-if="sensor.display_name" class="row__alias mono">{{ sensor.name }}</span>
              </span>
              <span class="row__meta">
                <template v-if="isDrifted(sensor)">
                  <span class="bad">
                    {{ sensor.enabled ? 'missing ' : 'leftover ' }}
                    {{
                      sensor.enabled
                        ? [!sensor.queue_exists && 'queue', !sensor.service_exists && 'consumer']
                            .filter(Boolean)
                            .join(' + ')
                        : [sensor.queue_exists && 'queue', sensor.service_exists && 'consumer']
                            .filter(Boolean)
                            .join(' + ')
                    }}
                  </span>
                </template>
                <template v-else-if="!sensor.enabled">off</template>
                <template v-else>{{ sensor.messages_available ?? 0 }} waiting</template>
              </span>

              <!-- Actions live on the row as well as in the detail panel: having
                   them only in the panel meant a sensor had to be selected
                   before it could be managed, which is not discoverable. -->
              <el-dropdown
                v-if="isAdmin"
                trigger="click"
                placement="bottom-end"
                @command="(command: string) => onRowCommand(command, sensor)"
              >
                <!-- .stop so opening the menu does not also re-select the row. -->
                <span class="row__more" :title="`Actions for ${sensor.name}`" @click.stop>
                  <el-icon><MoreFilled /></el-icon>
                </span>
                <template #dropdown>
                  <el-dropdown-menu>
                    <el-dropdown-item command="toggle" :disabled="busy">
                      {{ sensor.enabled ? 'Disable' : 'Enable' }}
                    </el-dropdown-item>
                    <el-dropdown-item command="reconcile" :disabled="busy">
                      Reconcile now
                    </el-dropdown-item>
                    <el-dropdown-item command="remove" divided :disabled="busy">
                      Remove
                    </el-dropdown-item>
                  </el-dropdown-menu>
                </template>
              </el-dropdown>
            </li>
          </ul>

          <p class="hint">
            <span class="dot dot--ok" /> <strong>running</strong> — enabled, queue and consumer
            both up<br />
            <span class="dot dot--disabled" /> <strong>off</strong> — you disabled it, and its
            queue and consumer were removed to match. This is a correct state, not a fault<br />
            <span class="dot dot--drift" /> <strong>out of sync</strong> — AWS does not match
            what you asked for, either way round. The only one that needs attention
          </p>
        </section>

        <section class="card">
          <div class="card__head">
            <h2 class="card__title">
              {{ selected ? selected.display_name || selected.name : 'Connect a field sensor' }}
            </h2>
            <div v-if="selected && isAdmin" class="card__actions">
              <el-tooltip
                :content="selected.enabled ? HINTS.disable : HINTS.enable"
                placement="bottom"
                :show-after="120"
                popper-class="hint-popper"
              >
                <el-button size="small" :disabled="busy" @click="toggleEnabled(selected)">
                  {{ selected.enabled ? 'Disable' : 'Enable' }}
                </el-button>
              </el-tooltip>
              <el-tooltip
                :content="HINTS.remove"
                placement="bottom"
                :show-after="120"
                popper-class="hint-popper"
              >
                <el-button
                  size="small"
                  type="danger"
                  plain
                  :disabled="busy"
                  @click="removeSensor(selected)"
                >
                  Remove
                </el-button>
              </el-tooltip>
            </div>
          </div>

          <div v-if="!selected" class="empty">
            Select a sensor to see the topic to publish to, the routing attribute it needs, and what
            the message must contain.
          </div>

          <template v-else>
            <!-- Drift is checked first: a DISABLED sensor with leftover
                 resources is still out of sync, and showing only "disabled"
                 there would hide the very thing that needs fixing. -->
            <el-alert
              v-if="isDrifted(selected)"
              type="warning"
              show-icon
              :closable="false"
              class="alert"
              title="Out of sync"
              :description="statusDetail(selected)"
            />
            <el-alert
              v-else-if="!selected.enabled"
              type="info"
              show-icon
              :closable="false"
              class="alert"
              title="This sensor is off"
              :description="statusDetail(selected)"
            />

            <div class="kv">
              <div class="kv__key">Publish to</div>
              <div class="kv__value mono copyable">
                <span>{{ sensors.data.value?.topic_arn }}</span>
                <el-button
                  link
                  size="small"
                  @click="copy(sensors.data.value?.topic_arn ?? '')"
                >
                  Copy
                </el-button>
              </div>
              <div class="kv__key">Routing attribute</div>
              <div class="kv__value mono">
                {{ sensors.data.value?.routing_attribute }} = {{ selected.name }}
              </div>
              <div class="kv__key">Delivers to</div>
              <div class="kv__value mono">{{ selected.queue_name }}</div>
              <div class="kv__key">
                Queue
                <InfoHint
                  text="The sensor's own SQS FIFO queue. The topic fans messages into it by matching the routing attribute below."
                />
              </div>
              <div class="kv__value">
                <template v-if="selected.queue_exists">
                  {{ selected.messages_available ?? 0 }} waiting ·
                  {{ selected.messages_in_flight ?? 0 }} in flight
                </template>
                <template v-else>not created</template>
              </div>
              <div class="kv__key">
                Consumer
                <InfoHint
                  text="The ECS Fargate service that reads this queue and writes to Aurora and Valkey. One service per sensor, so each one processes its own queue in order."
                />
              </div>
              <div class="kv__value">
                {{ selected.service_exists ? 'running' : 'not running' }}
              </div>
              <div class="kv__key">Registered</div>
              <div class="kv__value">{{ new Date(selected.created_at).toLocaleString() }}</div>
            </div>

            <h3 class="sub">How to hook up the field sensor</h3>
            <ol class="steps">
              <li>
                Publish to the topic above. The sensor does not write to SQS directly — the topic
                fans out to the right queue.
              </li>
              <li>
                Set the message attribute
                <code>{{ sensors.data.value?.routing_attribute }}</code> to exactly
                <code>{{ selected.name }}</code>. This is what routes the message. A missing or
                misspelled value matches no subscription and is dropped
                <strong>without an error</strong>.
              </li>
              <li>
                Set a <code>MessageGroupId</code> — required on a FIFO topic. Ordering holds within
                a group, so use one group per sensor.
              </li>
              <li>
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
          </template>
        </section>
      </div>

      <section v-if="lastReconcile" class="card card--wide">
        <h2 class="card__title">Last reconcile</h2>
        <p class="hint hint--top">
          {{ new Date(lastReconcile.reconciled_at).toLocaleString() }} ·
          {{ lastReconcile.created.length }} created ·
          {{ lastReconcile.deleted.length }} deleted ·
          <span :class="lastReconcile.failed > 0 ? 'bad' : ''">
            {{ lastReconcile.failed }} failed
          </span>
        </p>
        <div v-if="!lastReconcile.actions.length" class="empty">
          Nothing to change — AWS already matched the registry.
        </div>
        <ul v-else class="actions">
          <li v-for="action in lastReconcile.actions" :key="`${action.action}-${action.sensor}`">
            <span class="dot" :class="action.error ? 'dot--drift' : 'dot--ok'" />
            <span class="mono">{{ action.sensor }}</span>
            <span class="actions__verb">{{ action.action }}</span>
            <span class="actions__steps">{{ action.steps.join(' → ') || 'no steps' }}</span>
            <span v-if="action.error" class="bad">{{ action.error }}</span>
          </li>
        </ul>
      </section>
    </AsyncValue>

    <el-dialog v-model="addOpen" title="Add sensor" width="480px">
      <el-form label-position="top">
        <el-form-item label="Sensor name">
          <el-input v-model="addName" placeholder="e.g. plymouth_barton" />
          <p class="field-hint">
            Must match the <code>{{ sensors.data.value?.routing_attribute }}</code> attribute the
            field sensor publishes. It also becomes part of the SQS queue name, so it is letters,
            digits, underscore and hyphen only, and cannot be changed later.
          </p>
        </el-form-item>
        <el-form-item label="Display name (optional)">
          <el-input v-model="addDisplayName" placeholder="Plymouth Rd & Barton Dr" />
          <p class="field-hint">Shown in the console instead of the raw name. Safe to change.</p>
        </el-form-item>
      </el-form>
      <el-alert type="info" :closable="false" class="dialog-note">
        <template #default>
          <p class="alert__body">
            Creating the sensor also builds its infrastructure straight away — no separate
            Reconcile and no <code>cdk deploy</code>. It normally starts processing within a
            minute or two; until then the Sensors list shows it as out of sync.
          </p>
        </template>
      </el-alert>
      <template #footer>
        <el-button @click="addOpen = false">Cancel</el-button>
        <el-button type="primary" :loading="busy" @click="submitAdd">Create</el-button>
      </template>
    </el-dialog>
  </div>
</template>

<style scoped>
.header {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 16px;
}

.header__actions {
  display: flex;
  gap: 8px;
  flex-shrink: 0;
}

.header code,
.hint code,
.steps code,
.empty code,
.field-hint code {
  background: var(--page-bg);
  padding: 1px 5px;
  border-radius: 4px;
  font-size: 12px;
}

.grid {
  display: grid;
  grid-template-columns: minmax(260px, 0.62fr) minmax(380px, 1fr);
  gap: 16px;
  align-items: start;
}

@media (max-width: 1100px) {
  .grid {
    grid-template-columns: 1fr;
  }
}

.card--wide {
  margin-top: 16px;
}

.card__head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
}

.card__head .card__title {
  margin-bottom: 0;
}

.card__actions {
  display: flex;
  gap: 8px;
  flex-shrink: 0;
}

.list {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.row {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 10px;
  border-radius: 7px;
  cursor: pointer;
  font-size: 13px;
  outline: none;
  transition: background 0.12s ease;
}

.row:hover,
.row--active,
.row:focus-visible {
  background: var(--page-bg);
}

.row__name {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-weight: 550;
}

.row__alias {
  margin-left: 8px;
  font-weight: 400;
  font-size: 11px;
  color: var(--text-muted);
}

.row__more {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 22px;
  height: 22px;
  border-radius: 5px;
  color: var(--text-muted);
  cursor: pointer;
  flex-shrink: 0;
  opacity: 0;
  transition: opacity 0.12s ease, background 0.12s ease;
}

/* Revealed on hover or keyboard focus so the list stays quiet at rest, but
   never hidden on touch, where there is no hover state to trigger it. */
.row:hover .row__more,
.row--active .row__more,
.row__more:focus-visible,
.row:focus-visible .row__more {
  opacity: 1;
}

@media (hover: none) {
  .row__more {
    opacity: 1;
  }
}

.row__more:hover {
  background: var(--border);
  color: var(--text);
}

.row__meta {
  font-size: 11px;
  color: var(--text-muted);
  flex-shrink: 0;
}

.dot--disabled {
  background: var(--text-muted);
}

.dot--drift {
  background: var(--bad);
}

.hint {
  margin: 14px 0 0;
  font-size: 11.5px;
  color: var(--text-muted);
  line-height: 1.9;
}

.hint--top {
  margin: 0 0 12px;
}

.alert {
  margin-bottom: 16px;
}

.alert__body {
  margin: 0;
  font-size: 12.5px;
  line-height: 1.6;
}

.sub {
  font-size: 13px;
  font-weight: 650;
  margin: 22px 0 10px;
}

.steps {
  margin: 0;
  padding-left: 18px;
  display: flex;
  flex-direction: column;
  gap: 9px;
  font-size: 13px;
  line-height: 1.6;
}

.copyable {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}

.copyable span {
  min-width: 0;
  overflow-wrap: anywhere;
}

.actions {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 6px;
  font-size: 12.5px;
}

.actions li {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;
}

.actions__verb {
  text-transform: uppercase;
  font-size: 10.5px;
  letter-spacing: 0.04em;
  color: var(--text-muted);
}

.actions__steps {
  color: var(--text-muted);
}

.field-hint {
  margin: 6px 0 0;
  font-size: 11.5px;
  color: var(--text-muted);
  line-height: 1.6;
}

.dialog-note {
  margin-top: 4px;
}

/* Keeps the hint icon on the label's baseline rather than pushing the row. */
.stat__label,
.kv__key {
  display: inline-flex;
  align-items: center;
}

.bad {
  color: var(--bad);
}
</style>

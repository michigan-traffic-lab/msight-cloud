<script setup lang="ts">
import { computed, watch } from 'vue';
import { ElMessage } from 'element-plus';
import { api } from '@/api/client';
import {
  checkEndpoint,
  measureLatency,
  type EndpointCheck,
  type LatencyMeasurement,
} from '@/api/publicApi';
import { useAsyncValue } from '@/composables/useAsyncValue';
import AsyncValue from '@/components/AsyncValue.vue';

/**
 * Endpoints checked directly from this browser.
 *
 * These are the stack's public APIs, which allow any origin, so the console
 * calls them without a token. Measuring here rather than in the admin Lambda is
 * deliberate — see src/api/publicApi.ts for why.
 */
const HEALTH_ENDPOINTS = [
  { key: 'http-api', label: 'Public HTTP API', path: '/system/health' },
  { key: 'location-api', label: 'Location API', path: '/v1/clients/location/health' },
  { key: 'radius-api', label: 'Radius broadcast API', path: '/v1/clients/notify/radius/health' },
] as const;

const info = useAsyncValue((signal) => api.systemInfo(signal), { timeoutMs: 15000 });

/** Base URL of the public API, known only once system info has loaded. */
const publicBase = computed(() => info.data.value?.endpoints.http_api ?? null);

const latency = useAsyncValue<LatencyMeasurement>(
  async (signal) => {
    const base = publicBase.value;
    if (!base) throw new Error('Waiting for the API endpoint.');
    return measureLatency(base, signal);
  },
  { timeoutMs: 15000, immediate: false }
);

const health = HEALTH_ENDPOINTS.map((endpoint) => ({
  ...endpoint,
  probe: useAsyncValue<EndpointCheck>(
    async (signal) => {
      const base = publicBase.value;
      if (!base) throw new Error('Waiting for the API endpoint.');
      return checkEndpoint(`${base}${endpoint.path}`, signal);
    },
    { timeoutMs: 12000, immediate: false }
  ),
}));

// The probes need the endpoint from system info, so they start once it arrives
// rather than on mount.
watch(
  publicBase,
  (base) => {
    if (!base) return;
    void latency.reload();
    health.forEach((row) => void row.probe.reload());
  },
  { immediate: true }
);

const healthLoading = computed(() => health.some((row) => row.probe.state.value === 'loading'));

const anyLoading = computed(
  () => info.state.value === 'loading' || latency.state.value === 'loading' || healthLoading.value
);

/** Re-runs every endpoint check; each still loads on its own request. */
function reloadHealth() {
  health.forEach((row) => void row.probe.reload());
}

function reloadAll() {
  void info.reload();
  void latency.reload();
  reloadHealth();
}

function shortArn(arn: string | null | undefined): string {
  if (!arn) return '—';
  const parts = arn.split(':');
  return parts[parts.length - 1] || arn;
}

function statusClass(check?: EndpointCheck | null): string {
  if (!check) return 'dot--unknown';
  return check.ok ? 'dot--ok' : 'dot--degraded';
}

function ms(value: number | null | undefined): string {
  return value === null || value === undefined ? '—' : `${value} ms`;
}

/** Endpoints are long and get pasted elsewhere, so each one is copyable. */
const endpointRows = computed(() => [
  { label: 'Public HTTP API', value: info.data.value?.endpoints.http_api ?? null },
  { label: 'Sensor HTTP API', value: info.data.value?.endpoints.sensor_http_api ?? null },
  { label: 'WebSocket API', value: info.data.value?.endpoints.websocket_api ?? null },
]);

async function copyValue(value: string | null, label: string) {
  if (!value) return;
  try {
    await navigator.clipboard.writeText(value);
    ElMessage.success(`${label} copied.`);
  } catch {
    // Clipboard access needs a secure context and can be refused outright.
    ElMessage.error('Could not copy — select the text and copy manually.');
  }
}
</script>

<template>
  <div>
    <div class="header">
      <div>
        <h1 class="page-title">Cloud overview</h1>
        <p class="page-subtitle">
          Live status of the MSight cloud stack and its public endpoints.
        </p>
      </div>
      <el-button :icon="'Refresh'" :loading="anyLoading" @click="reloadAll">Refresh</el-button>
    </div>

    <div class="stat-grid">
      <div class="stat">
        <div class="stat__label">Region</div>
        <div class="stat__value">
          <AsyncValue :state="info.state.value" :error="info.error.value">
            {{ info.data.value?.region }}
          </AsyncValue>
        </div>
      </div>
      <div class="stat">
        <div class="stat__label">Configured sensors</div>
        <div class="stat__value">
          <AsyncValue :state="info.state.value" :error="info.error.value">
            {{ info.data.value?.sensors.configured_count }}
          </AsyncValue>
        </div>
      </div>
      <div class="stat">
        <div class="stat__label">API version</div>
        <div class="stat__value">
          <AsyncValue :state="info.state.value" :error="info.error.value">
            {{ info.data.value?.api_version }}
          </AsyncValue>
        </div>
      </div>
      <div class="stat">
        <div class="stat__label">Build ID</div>
        <div class="stat__value stat__value--sm mono">
          <AsyncValue :state="info.state.value" :error="info.error.value">
            {{ info.data.value?.build_id }}
          </AsyncValue>
        </div>
      </div>
    </div>

    <div class="grid">
      <section class="card">
        <div class="cardhead">
          <h2 class="card__title nomargin">Component health</h2>
          <el-button
            :icon="'Refresh'"
            circle
            text
            size="small"
            :loading="healthLoading"
            aria-label="Re-run every check"
            @click="reloadHealth"
          />
        </div>
        <p class="card__lede">
          Called directly from this browser, so the timings are what a real client sees —
          network, TLS and gateway included.
        </p>

        <table class="health">
          <tbody>
            <tr v-for="row in health" :key="row.key">
              <td class="health__name">{{ row.label }}</td>
              <td class="health__status">
                <AsyncValue :state="row.probe.state.value" :error="row.probe.error.value" inline>
                  <span>
                    <span class="dot" :class="statusClass(row.probe.data.value)" />
                    {{ row.probe.data.value?.ok ? 'ok' : 'failed' }}
                  </span>
                </AsyncValue>
              </td>
              <td class="health__latency mono">
                <template v-if="row.probe.state.value === 'ready'">
                  {{ ms(row.probe.data.value?.round_trip_ms) }}
                </template>
                <template v-else>—</template>
              </td>
              <td class="health__detail">
                <span class="muted">
                  {{
                    row.probe.state.value === 'ready'
                      ? `HTTP ${row.probe.data.value?.status}`
                      : '—'
                  }}
                </span>
              </td>
              <td class="health__action">
                <el-button
                  :icon="'Refresh'"
                  circle
                  text
                  size="small"
                  :loading="row.probe.state.value === 'loading'"
                  :aria-label="`Re-run the ${row.label} check`"
                  @click="row.probe.reload()"
                />
              </td>
            </tr>
          </tbody>
        </table>
      </section>

      <section class="card">
        <div class="cardhead">
          <h2 class="card__title nomargin">Latency breakdown</h2>
          <el-button
            :icon="'Refresh'"
            circle
            text
            size="small"
            :loading="latency.state.value === 'loading'"
            aria-label="Re-measure latency"
            @click="latency.reload()"
          />
        </div>
        <p class="card__lede">
          One round trip to <code>/v1/client/latency</code>, split using the timestamps that
          endpoint reports.
        </p>

        <AsyncValue :state="latency.state.value" :error="latency.error.value">
          <div class="bigms">{{ ms(latency.data.value?.round_trip_ms) }}</div>
          <div class="bigms__label">round trip from your browser</div>

          <table class="breakdown">
            <tbody>
              <tr>
                <td>Network, TLS and gateway</td>
                <td class="mono right">{{ ms(latency.data.value?.network_ms) }}</td>
              </tr>
              <tr>
                <td>Server processing</td>
                <td class="mono right">{{ ms(latency.data.value?.server_ms) }}</td>
              </tr>
              <tr class="nested">
                <td>↳ Valkey probe</td>
                <td class="mono right">{{ ms(latency.data.value?.valkey.latency_ms) }}</td>
              </tr>
              <tr class="nested">
                <td>↳ PostgreSQL probe</td>
                <td class="mono right">{{ ms(latency.data.value?.postgresql.latency_ms) }}</td>
              </tr>
            </tbody>
          </table>

          <div class="kv conn">
            <div class="kv__key">Your source IP</div>
            <div class="kv__value mono">{{ latency.data.value?.source_ip }}</div>
            <div class="kv__key">Protocol</div>
            <div class="kv__value mono">{{ latency.data.value?.protocol }}</div>
          </div>
        </AsyncValue>
      </section>

      <section class="card">
        <h2 class="card__title">Endpoints</h2>
        <AsyncValue :state="info.state.value" :error="info.error.value">
          <div class="kv">
            <template v-for="row in endpointRows" :key="row.label">
              <div class="kv__key">{{ row.label }}</div>
              <div class="kv__value copyrow">
                <span class="mono copyrow__text">{{ row.value ?? '—' }}</span>
                <el-button
                  v-if="row.value"
                  :icon="'CopyDocument'"
                  text
                  circle
                  size="small"
                  class="copyrow__btn"
                  :aria-label="`Copy the ${row.label} URL`"
                  @click="copyValue(row.value, row.label)"
                />
              </div>
            </template>
          </div>
        </AsyncValue>
      </section>

      <section class="card">
        <h2 class="card__title">SNS topics</h2>
        <AsyncValue :state="info.state.value" :error="info.error.value">
          <div class="kv">
            <div class="kv__key">Sensor fanout</div>
            <div class="kv__value mono">{{ shortArn(info.data.value?.topics.sensor) }}</div>
            <div class="kv__key">SPaT fanout</div>
            <div class="kv__value mono">{{ shortArn(info.data.value?.topics.spat) }}</div>
            <div class="kv__key">Control channel</div>
            <div class="kv__value mono">{{ shortArn(info.data.value?.topics.control) }}</div>
          </div>
        </AsyncValue>
      </section>

      <section class="card">
        <h2 class="card__title">Sensors</h2>
        <AsyncValue :state="info.state.value" :error="info.error.value">
          <div v-if="(info.data.value?.sensors.names.length ?? 0) === 0" class="empty">
            No sensors are configured in deploy.config.yaml.
          </div>
          <div v-else class="tags">
            <el-tag
              v-for="name in info.data.value?.sensors.names"
              :key="name"
              size="large"
              effect="plain"
            >
              {{ name }}
            </el-tag>
          </div>
          <p class="note">
            Sensors are provisioned at deploy time — each one creates an SQS FIFO queue and an
            ECS service. Adding one is a <code>cdk deploy</code>, not a console action.
          </p>
        </AsyncValue>
      </section>
    </div>

    <p v-if="info.state.value === 'ready'" class="timestamp">
      Last checked {{ new Date(info.data.value!.server_timestamp).toLocaleString() }}
    </p>
  </div>
</template>

<style scoped>
.header {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 16px;
}

.grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(380px, 1fr));
  gap: 16px;
}

.cardhead {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
}

.nomargin {
  margin: 0;
}

.card__lede {
  margin: 6px 0 14px;
  font-size: 12px;
  color: var(--text-muted);
  line-height: 1.6;
}

.card__lede code {
  background: var(--page-bg);
  padding: 1px 5px;
  border-radius: 4px;
}

.health {
  width: 100%;
  border-collapse: collapse;
}

.health tr + tr td {
  border-top: 1px solid var(--border);
}

.health td {
  padding: 11px 0;
  vertical-align: middle;
}

/* The name column takes whatever is left; every other column shrinks to its
   content. Fixed widths left the status sitting against the name with a wide
   dead gap after it. `width: 1%` plus nowrap is the table idiom for that. */
.health__name {
  font-size: 14px;
  padding-right: 20px;
}

.health__status {
  width: 1%;
  white-space: nowrap;
  font-size: 13px;
  padding-right: 22px !important;
}

.health__latency {
  width: 1%;
  white-space: nowrap;
  text-align: right;
  padding-right: 20px !important;
  color: var(--text-muted);
}

.health__detail {
  width: 1%;
  white-space: nowrap;
  font-size: 12px;
  padding-right: 8px !important;
}

.health__action {
  width: 40px;
  text-align: right;
}

.bigms {
  font-size: 30px;
  font-weight: 650;
  letter-spacing: -0.02em;
  line-height: 1.1;
}

.bigms__label {
  font-size: 11.5px;
  color: var(--text-muted);
  margin-top: 2px;
}

.breakdown {
  width: 100%;
  border-collapse: collapse;
  margin-top: 16px;
}

.breakdown td {
  padding: 8px 0;
  font-size: 12.5px;
  border-bottom: 1px solid var(--border);
}

.breakdown .nested td {
  color: var(--text-muted);
  padding-left: 14px;
  font-size: 12px;
}

.right {
  text-align: right;
}

.conn {
  margin-top: 16px;
}

.muted {
  color: var(--text-muted);
}

.copyrow {
  display: flex;
  align-items: flex-start;
  gap: 6px;
}

.copyrow__text {
  flex: 1;
  min-width: 0;
  word-break: break-all;
}

/* Nudged up so the icon sits on the first line of a wrapped URL. */
.copyrow__btn {
  flex-shrink: 0;
  margin-top: -3px;
}

.tags {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}

.note {
  margin: 16px 0 0;
  font-size: 12px;
  color: var(--text-muted);
  line-height: 1.6;
}

.note code {
  background: var(--page-bg);
  padding: 1px 5px;
  border-radius: 4px;
}

.timestamp {
  margin-top: 20px;
  font-size: 12px;
  color: var(--text-muted);
}
</style>

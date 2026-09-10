<script setup lang="ts">
import { computed, watch } from 'vue';
import { useQuasar } from 'quasar';
import { api } from '@/api/client';
import {
  checkEndpoint,
  measureLatency,
  type EndpointCheck,
  type LatencyMeasurement,
} from '@/api/publicApi';
import { useAsyncValue } from '@/composables/useAsyncValue';
import AsyncValue from '@/components/AsyncValue.vue';
import PageHeader from '@/components/PageHeader.vue';
import StatCard from '@/components/StatCard.vue';
import SectionCard from '@/components/SectionCard.vue';

const $q = useQuasar();

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

// Sensors live in Aurora, not in the stack's environment, so this is its own
// call rather than a field on systemInfo — and its own card can fail or time
// out without taking the rest of the overview with it.
const sensors = useAsyncValue((signal) => api.sensors(signal), { timeoutMs: 20000 });

// Apps are the consuming half of the same picture: sensors produce, apps
// receive. Its own call for the same reason as sensors — a slow Valkey should
// cost this one card, not the page.
const apps = useAsyncValue((signal) => api.apps(signal), { timeoutMs: 20000 });

/**
 * The three subscriptions, counted for the summary card. Mirrors the same list
 * on the Apps page; kept short here because this card summarises rather than
 * explains — the Apps page is where each stream is described.
 */
const APP_STREAMS = [
  { key: 'receive_sdsm' as const, label: 'SDSM', color: 'primary' },
  { key: 'receive_spat' as const, label: 'SPaT', color: 'teal' },
  { key: 'receive_critical_spat' as const, label: 'Critical SPaT', color: 'deep-orange' },
];

const appRows = computed(() => apps.data.value?.apps ?? []);

const appStreamCounts = computed(() =>
  APP_STREAMS.map((stream) => ({
    ...stream,
    count: appRows.value.filter((app) => app[stream.key]).length,
  }))
);

/** Apps registered but subscribed to nothing — they connect and are told nothing. */
const silentApps = computed(() => appRows.value.filter((app) => app.receives_nothing));

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
  () =>
    info.state.value === 'loading' ||
    latency.state.value === 'loading' ||
    sensors.state.value === 'loading' ||
    apps.state.value === 'loading' ||
    healthLoading.value
);

/** Re-runs every endpoint check; each still loads on its own request. */
function reloadHealth() {
  health.forEach((row) => void row.probe.reload());
}

function reloadAll() {
  void info.reload();
  void latency.reload();
  void sensors.reload();
  void apps.reload();
  reloadHealth();
}

function shortArn(arn: string | null | undefined): string {
  if (!arn) return '—';
  const parts = arn.split(':');
  return parts[parts.length - 1] || arn;
}

function statusColor(check?: EndpointCheck | null): string {
  if (!check) return 'grey-6';
  return check.ok ? 'positive' : 'warning';
}

const topicRows = computed(() => [
  { label: 'Sensor fanout', value: info.data.value?.topics.sensor },
  { label: 'SPaT fanout', value: info.data.value?.topics.spat },
  { label: 'Control channel', value: info.data.value?.topics.control },
]);

const endpointRows = computed(() => [
  { label: 'Public HTTP API', value: info.data.value?.endpoints.http_api },
  { label: 'Sensor HTTP API', value: info.data.value?.endpoints.sensor_http_api },
  { label: 'WebSocket API', value: info.data.value?.endpoints.websocket_api },
]);

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
    <PageHeader
      title="Overview"
      subtitle="Live health of the stack. Endpoint checks and latency are measured from this browser rather than reported by the backend, so they reflect what a real client would see."
    >
      <template #actions>
        <q-btn
          outline
          color="primary"
          icon="refresh"
          label="Refresh"
          :loading="anyLoading"
          @click="reloadAll"
          />
      </template>
    </PageHeader>

    <div class="row q-col-gutter-md q-mb-md">
      <div class="col-6 col-md-3">
        <StatCard label="Region">
          <AsyncValue :state="info.state.value" :error="info.error.value">
            {{ info.data.value?.region }}
          </AsyncValue>
        </StatCard>
      </div>

      <div class="col-6 col-md-3">
        <StatCard
          label="Sensors"
          :caption="`of ${sensors.data.value?.sensors.length ?? 0} registered`"
          hint="Sensors currently enabled. They live in an Aurora table, not in deploy config — manage them from the Sensors tab."
        >
          <AsyncValue :state="sensors.state.value" :error="sensors.error.value">
            {{ sensors.data.value?.sensors.filter((s) => s.enabled).length ?? 0 }}
          </AsyncValue>
        </StatCard>
      </div>

      <div class="col-6 col-md-3">
        <StatCard
          label="API latency"
          caption="round trip from this browser"
          hint="Measured in the browser against the public latency endpoint, so it includes real network time — not the Lambda's own view of itself."
        >
          <AsyncValue :state="latency.state.value" :error="latency.error.value">
            {{ latency.data.value?.round_trip_ms ?? '—' }}<span class="text-caption text-grey-7">
              ms</span
            >
          </AsyncValue>
        </StatCard>
      </div>

      <div class="col-6 col-md-3">
        <StatCard label="Build" dense :caption="info.data.value?.api_version">
          <AsyncValue :state="info.state.value" :error="info.error.value">
            <span class="mono">{{ info.data.value?.build_id }}</span>
          </AsyncValue>
        </StatCard>
      </div>
    </div>

    <div class="row q-col-gutter-md">
      <div class="col-12 col-md-6">
        <SectionCard
          title="Component health"
          lede="Each endpoint is probed independently, so one slow service does not hide the others."
          flush
        >
          <template #actions>
            <q-btn
              flat
              dense
              round
              icon="refresh"
              size="sm"
              :loading="healthLoading"
              aria-label="Re-run checks"
              @click="reloadHealth"
            >
              <q-tooltip>Re-run these checks</q-tooltip>
            </q-btn>
          </template>

          <q-list separator>
            <q-item v-for="row in health" :key="row.key">
              <q-item-section avatar style="min-width: 28px">
                <q-icon name="circle" size="10px" :color="statusColor(row.probe.data.value)" />
              </q-item-section>
              <q-item-section>
                <q-item-label class="text-body2">{{ row.label }}</q-item-label>
                <q-item-label caption class="mono">{{ row.path }}</q-item-label>
              </q-item-section>
              <q-item-section side>
                <AsyncValue :state="row.probe.state.value" :error="row.probe.error.value" inline>
                  <div class="text-right">
                    <div class="text-body2 text-weight-medium text-grey-9">
                      {{ row.probe.data.value?.round_trip_ms }} ms
                    </div>
                    <div class="text-caption text-grey-7">
                      HTTP {{ row.probe.data.value?.status }}
                    </div>
                  </div>
                </AsyncValue>
              </q-item-section>
            </q-item>
          </q-list>
        </SectionCard>
      </div>

      <div class="col-12 col-md-6">
        <SectionCard title="Endpoints" lede="Public URLs this deployment exposes." flush>
          <q-list separator>
            <q-item v-for="row in endpointRows" :key="row.label">
              <q-item-section>
                <q-item-label caption>{{ row.label }}</q-item-label>
                <q-item-label class="mono">
                  <AsyncValue :state="info.state.value" :error="info.error.value">
                    {{ row.value ?? '—' }}
                  </AsyncValue>
                </q-item-label>
              </q-item-section>
              <q-item-section side>
                <q-btn
                  flat
                  dense
                  round
                  size="sm"
                  icon="content_copy"
                  :disable="!row.value"
                  :aria-label="`Copy ${row.label}`"
                  @click="copy(row.value)"
                >
                  <q-tooltip>Copy</q-tooltip>
                </q-btn>
              </q-item-section>
            </q-item>
          </q-list>
        </SectionCard>
      </div>

      <div class="col-12 col-md-6">
        <SectionCard
          title="SNS topics"
          lede="The three fan-out points: sensor ingest, SPaT broadcast, and the low-frequency control channel."
          flush
        >
          <q-list separator>
            <q-item v-for="topic in topicRows" :key="topic.label">
              <q-item-section>
                <q-item-label class="text-body2">{{ topic.label }}</q-item-label>
              </q-item-section>
              <q-item-section side class="mono text-grey-8">
                {{ shortArn(topic.value) }}
              </q-item-section>
            </q-item>
          </q-list>
        </SectionCard>
      </div>

      <div class="col-12 col-md-6">
        <SectionCard
          title="Apps"
          lede="Consumer fleets and what each is subscribed to receive. Sensors produce; apps consume."
        >
          <AsyncValue :state="apps.state.value" :error="apps.error.value">
            <div v-if="!appRows.length" class="text-body2 text-grey-7">
              No apps are registered yet. Add one from the Apps tab.
            </div>
            <template v-else>
              <!-- Leads with the two numbers that answer "is anything actually
                   being served?" — fleet size and how many apps take each
                   stream. The per-app chips sit under them. -->
              <div class="row items-baseline q-gutter-lg q-mb-md">
                <div>
                  <div class="text-h6">{{ (apps.data.value?.total_connected ?? 0).toLocaleString() }}</div>
                  <div class="text-caption text-grey-7">clients connected</div>
                </div>
                <div v-for="stream in appStreamCounts" :key="stream.key">
                  <div class="text-h6" :class="`text-${stream.color}`">{{ stream.count }}</div>
                  <div class="text-caption text-grey-7">{{ stream.label }}</div>
                </div>
              </div>

              <div class="q-gutter-sm">
                <q-chip
                  v-for="app in appRows"
                  :key="app.app_id"
                  :outline="app.receives_nothing"
                  :color="app.receives_nothing ? 'grey-5' : 'primary'"
                  :text-color="app.receives_nothing ? 'grey-8' : 'white'"
                  :icon="app.receives_nothing ? 'notifications_off' : 'apps'"
                >
                  {{ app.display_name || app.app_id }}
                  <span v-if="app.connected !== null" class="q-ml-xs">
                    · {{ app.connected.toLocaleString() }}
                  </span>
                  <q-tooltip class="hint-tooltip">
                    {{
                      app.receives_nothing
                        ? `${app.app_id} is subscribed to nothing — its clients connect and are sent no messages.`
                        : `${app.app_id} receives ${APP_STREAMS.filter((s) => app[s.key]).map((s) => s.label).join(', ')}.`
                    }}
                  </q-tooltip>
                </q-chip>
              </div>

              <div v-if="silentApps.length" class="text-caption text-grey-7 q-mt-md">
                {{ silentApps.length }}
                {{ silentApps.length === 1 ? 'app is' : 'apps are' }} subscribed to nothing.
              </div>
              <div
                v-if="apps.data.value?.unregistered_app_ids.length"
                class="text-caption text-warning q-mt-xs"
              >
                {{ apps.data.value.unregistered_app_ids.join(', ') }} —
                named in <code>clientAppIds</code> but not registered, so receiving nothing.
              </div>
            </template>
          </AsyncValue>
        </SectionCard>
      </div>

      <div class="col-12 col-md-6">
        <SectionCard
          title="Sensors"
          lede="Registered in the console, not in deploy config. Adding one builds its queue, subscription and consumer within a few minutes."
        >
          <AsyncValue :state="sensors.state.value" :error="sensors.error.value">
            <div v-if="!sensors.data.value?.sensors.length" class="text-body2 text-grey-7">
              No sensors are registered yet. Add one from the Sensors tab.
            </div>
            <div v-else class="q-gutter-sm">
              <q-chip
                v-for="sensor in sensors.data.value.sensors"
                :key="sensor.name"
                :outline="!sensor.enabled"
                :color="sensor.enabled ? 'primary' : 'grey-5'"
                :text-color="sensor.enabled ? 'white' : 'grey-8'"
                :icon="sensor.enabled ? 'sensors' : 'pause_circle_outline'"
              >
                {{ sensor.display_name || sensor.name }}
              </q-chip>
            </div>
          </AsyncValue>
        </SectionCard>
      </div>
    </div>

    <div v-if="info.state.value === 'ready'" class="text-caption text-grey-6 q-mt-lg text-center">
      Last checked {{ new Date(info.data.value!.server_timestamp).toLocaleString() }}
    </div>
  </q-page>
</template>

<style scoped>
/* Matches the inline-code treatment on the Apps, Sensors and Storage pages, so
   a config key referenced here reads the same as it does there. */
code {
  background: rgba(0, 0, 0, 0.05);
  padding: 1px 5px;
  border-radius: 4px;
  font-size: 0.92em;
}
</style>

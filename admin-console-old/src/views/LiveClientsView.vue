<script setup lang="ts">
import { computed, ref, shallowRef, watch } from 'vue';
import { ElMessage } from 'element-plus';
import { api, type LiveClientsQuery, type LiveClientsSummary } from '@/api/client';
import { useAsyncValue } from '@/composables/useAsyncValue';
import AsyncValue from '@/components/AsyncValue.vue';

/**
 * The page leads with counts because counts are the only thing that stays cheap
 * as the fleet grows: ZCARD is constant time whatever the client count. Rows are
 * only ever fetched by an explicit, bounded query.
 */
const summary = useAsyncValue<LiveClientsSummary>((signal) => api.clientsSummary(signal), {
  timeoutMs: 20000,
});

const selectedApp = ref<string | null>(null);
const mode = ref<'radius' | 'sample' | 'lookup'>('radius');

const lat = ref<number | null>(42.2808);
const lon = ref<number | null>(-83.743);
const radiusM = ref(500);
const limit = ref(50);
const clientId = ref('');

const results = shallowRef<LiveClientsQuery | null>(null);
const querying = ref(false);
const queryError = ref<string | null>(null);

// Default to the busiest app so the first query targets somewhere with data.
watch(
  () => summary.data.value,
  (data) => {
    if (data && !selectedApp.value && data.apps.length > 0) {
      selectedApp.value = [...data.apps].sort((a, b) => b.connected - a.connected)[0].app_id;
    }
  },
  { immediate: true }
);

const staleCount = computed(() =>
  (summary.data.value?.apps ?? []).reduce((sum, app) => sum + app.expired_not_yet_reaped, 0)
);

async function runQuery() {
  if (!selectedApp.value) {
    ElMessage.warning('Pick an app first.');
    return;
  }

  querying.value = true;
  queryError.value = null;

  try {
    if (mode.value === 'radius') {
      if (lat.value === null || lon.value === null) {
        throw new Error('Latitude and longitude are required.');
      }
      results.value = await api.clientsSearch({
        app_id: selectedApp.value,
        lat: lat.value,
        lon: lon.value,
        radius_m: radiusM.value,
        limit: limit.value,
      });
    } else if (mode.value === 'sample') {
      results.value = await api.clientsSample({ app_id: selectedApp.value, limit: limit.value });
    } else {
      if (!clientId.value.trim()) {
        throw new Error('Enter a client ID.');
      }
      results.value = await api.clientsLookup({
        app_id: selectedApp.value,
        client_id: clientId.value.trim(),
      });
    }
  } catch (error) {
    queryError.value = error instanceof Error ? error.message : 'Query failed.';
    results.value = null;
  } finally {
    querying.value = false;
  }
}

async function loadMore() {
  if (!results.value?.next_cursor || !selectedApp.value) return;
  querying.value = true;
  try {
    const page = await api.clientsSample({
      app_id: selectedApp.value,
      cursor: results.value.next_cursor,
      limit: limit.value,
    });
    results.value = { ...page, clients: [...results.value.clients, ...page.clients] };
  } finally {
    querying.value = false;
  }
}
</script>

<template>
  <div>
    <div class="header">
      <div>
        <h1 class="page-title">Live clients</h1>
        <p class="page-subtitle">
          WebSocket connections currently served. Counts are exact and constant-time; rows are
          always fetched by a bounded query, never listed in full.
        </p>
      </div>
      <el-button
        :icon="'Refresh'"
        :loading="summary.state.value === 'loading'"
        @click="summary.reload()"
      >
        Refresh
      </el-button>
    </div>

    <div class="stat-grid">
      <div class="stat">
        <div class="stat__label">Connected now</div>
        <div class="stat__value">
          <AsyncValue :state="summary.state.value" :error="summary.error.value">
            {{ summary.data.value?.total_connected.toLocaleString() }}
          </AsyncValue>
        </div>
      </div>
      <div class="stat">
        <div class="stat__label">Apps</div>
        <div class="stat__value">
          <AsyncValue :state="summary.state.value" :error="summary.error.value">
            {{ summary.data.value?.apps.length ?? 0 }}
          </AsyncValue>
        </div>
      </div>
      <div class="stat">
        <div class="stat__label">Expired, not yet reaped</div>
        <div class="stat__value">
          <AsyncValue :state="summary.state.value" :error="summary.error.value">
            <span :class="staleCount > 0 ? 'warn' : ''">{{ staleCount.toLocaleString() }}</span>
          </AsyncValue>
        </div>
      </div>
      <div class="stat">
        <div class="stat__label">Zone</div>
        <div class="stat__value stat__value--sm mono">
          <AsyncValue :state="summary.state.value" :error="summary.error.value">
            {{ summary.data.value?.zone_id }}
          </AsyncValue>
        </div>
      </div>
    </div>

    <div class="grid">
      <section class="card">
        <h2 class="card__title">By app</h2>
        <AsyncValue :state="summary.state.value" :error="summary.error.value">
          <div v-if="!summary.data.value?.apps.length" class="empty">
            No apps configured. Add them under <code>clientAppIds:</code> in
            deploy.config.yaml and redeploy.
          </div>
          <ul v-else class="apps">
            <li
              v-for="app in summary.data.value.apps"
              :key="app.app_id"
              class="app"
              :class="{ 'app--active': selectedApp === app.app_id }"
              @click="selectedApp = app.app_id"
            >
              <span class="app__id">{{ app.app_id }}</span>
              <span class="app__count">{{ app.connected.toLocaleString() }}</span>
              <span class="app__meta">
                {{ app.expiring_within_60s }} expiring soon
              </span>
            </li>
          </ul>
        </AsyncValue>
        <p class="hint">
          Counts come from <code>ZCARD</code> on each app's geo set, so they cost the same at ten
          clients or ten million.
        </p>
      </section>

      <section class="card">
        <h2 class="card__title">Find clients</h2>

        <el-radio-group v-model="mode" size="small" class="modes">
          <el-radio-button value="radius">Near a point</el-radio-button>
          <el-radio-button value="lookup">By client ID</el-radio-button>
          <el-radio-button value="sample">Sample</el-radio-button>
        </el-radio-group>

        <div class="fields">
          <template v-if="mode === 'radius'">
            <label class="field">
              <span>Latitude</span>
              <el-input-number v-model="lat" :precision="5" :step="0.001" controls-position="right" />
            </label>
            <label class="field">
              <span>Longitude</span>
              <el-input-number v-model="lon" :precision="5" :step="0.001" controls-position="right" />
            </label>
            <label class="field">
              <span>Radius (m)</span>
              <el-input-number v-model="radiusM" :min="1" :max="50000" :step="100" controls-position="right" />
            </label>
          </template>

          <label v-else-if="mode === 'lookup'" class="field field--wide">
            <span>Client ID</span>
            <el-input v-model="clientId" placeholder="client-abc123" />
          </label>

          <label v-if="mode !== 'lookup'" class="field">
            <span>Limit</span>
            <el-input-number v-model="limit" :min="1" :max="200" :step="10" controls-position="right" />
          </label>
        </div>

        <el-button type="primary" :loading="querying" class="run" @click="runQuery">
          Run query
        </el-button>

        <el-alert
          v-if="queryError"
          type="error"
          show-icon
          :closable="false"
          class="alert"
          :title="queryError"
        />

        <p class="hint">
          Every query is capped at {{ limit }} rows server-side. There is no "list all" — this
          Valkey also serves the SPaT broadcast path, so no console request is allowed to scale
          with fleet size.
        </p>
      </section>
    </div>

    <section v-if="results" class="card results">
      <h2 class="card__title">
        Results · {{ results.mode }} · {{ results.clients.length }} shown
      </h2>

      <el-alert
        v-if="results.capped"
        type="info"
        show-icon
        :closable="false"
        class="alert"
        title="More clients match than are shown"
        description="The limit truncated this result. Narrow the radius, or continue the sample, rather than raising the limit indefinitely."
      />

      <div v-if="results.clients.length === 0" class="empty">
        No clients matched.
      </div>

      <table v-else class="clients">
        <thead>
          <tr>
            <th>Client</th>
            <th>Position</th>
            <th v-if="results.mode === 'radius'" class="num">Distance</th>
            <th>Details</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="client in results.clients" :key="client.client_id">
            <td class="mono">{{ client.client_id }}</td>
            <td class="mono muted">
              <template v-if="client.lat !== null && client.lon !== null">
                {{ client.lat.toFixed(5) }}, {{ client.lon.toFixed(5) }}
              </template>
              <template v-else>—</template>
            </td>
            <td v-if="results.mode === 'radius'" class="num mono">
              {{ client.distance_m === null ? '—' : `${Math.round(client.distance_m)} m` }}
            </td>
            <td class="fieldsCell">
              <span v-for="(value, key) in client.fields" :key="key" class="tagpair">
                <span class="tagpair__k">{{ key }}</span>{{ value }}
              </span>
            </td>
          </tr>
        </tbody>
      </table>

      <el-button v-if="results.next_cursor" text :loading="querying" class="more" @click="loadMore">
        Load next {{ limit }}
      </el-button>
    </section>
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
  grid-template-columns: minmax(260px, 0.7fr) minmax(340px, 1fr);
  gap: 16px;
  align-items: start;
}

@media (max-width: 1100px) {
  .grid {
    grid-template-columns: 1fr;
  }
}

.apps {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.app {
  display: grid;
  grid-template-columns: 1fr auto;
  gap: 2px 10px;
  padding: 9px 10px;
  border-radius: 7px;
  cursor: pointer;
  transition: background 0.12s ease;
}

.app:hover,
.app--active {
  background: var(--page-bg);
}

.app__id {
  font-size: 13px;
  font-weight: 550;
}

.app__count {
  font-size: 15px;
  font-weight: 650;
  grid-row: span 2;
  align-self: center;
}

.app__meta {
  font-size: 11px;
  color: var(--text-muted);
}

.modes {
  margin-bottom: 16px;
}

.fields {
  display: flex;
  flex-wrap: wrap;
  gap: 12px;
}

.field {
  display: flex;
  flex-direction: column;
  gap: 5px;
  font-size: 12px;
  color: var(--text-muted);
}

.field--wide {
  flex: 1;
  min-width: 220px;
}

.run {
  margin-top: 16px;
}

.alert {
  margin-top: 14px;
}

.results {
  margin-top: 16px;
}

.clients {
  width: 100%;
  border-collapse: collapse;
  margin-top: 12px;
}

.clients th {
  font-size: 10px;
  font-weight: 700;
  letter-spacing: 0.06em;
  text-transform: uppercase;
  color: var(--text-muted);
  text-align: left;
  padding-bottom: 7px;
  border-bottom: 1px solid var(--border);
}

.clients td {
  padding: 9px 10px 9px 0;
  font-size: 12px;
  border-bottom: 1px solid var(--border);
  vertical-align: top;
}

.num {
  text-align: right;
  width: 90px;
}

.fieldsCell {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
}

.tagpair {
  font-size: 10.5px;
  background: var(--page-bg);
  border: 1px solid var(--border);
  border-radius: 5px;
  padding: 1px 6px;
}

.tagpair__k {
  color: var(--text-muted);
  margin-right: 5px;
}

.more {
  margin-top: 12px;
}

.hint {
  margin: 14px 0 0;
  font-size: 11.5px;
  color: var(--text-muted);
  line-height: 1.6;
}

.hint code,
.empty code {
  background: var(--page-bg);
  padding: 1px 5px;
  border-radius: 4px;
}

.muted {
  color: var(--text-muted);
}

.warn {
  color: var(--warn);
}
</style>

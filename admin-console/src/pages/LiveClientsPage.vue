<script setup lang="ts">
import { computed, ref, shallowRef, watch } from 'vue';
import { useQuasar, type QTableColumn } from 'quasar';
import { api, type LiveClientsQuery, type LiveClientsSummary } from '@/api/client';
import { useAsyncValue } from '@/composables/useAsyncValue';
import PageHeader from '@/components/PageHeader.vue';
import AsyncValue from '@/components/AsyncValue.vue';
import StatCard from '@/components/StatCard.vue';
import SectionCard from '@/components/SectionCard.vue';

const $q = useQuasar();

/**
 * The page leads with counts because counts are the only thing that stays cheap
 * as the fleet grows: ZCARD is constant time whatever the client count. Rows are
 * only ever fetched by an explicit, bounded query — there is deliberately no
 * "list everything" control anywhere on this page.
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
    if (!data || selectedApp.value) return;
    const busiest = [...data.apps].sort((a, b) => b.connected - a.connected)[0];
    if (busiest) selectedApp.value = busiest.app_id;
  },
  { immediate: true }
);

const appOptions = computed(() =>
  (summary.data.value?.apps ?? []).map((app) => ({
    label: `${app.app_id} (${app.connected})`,
    value: app.app_id,
  }))
);

const staleCount = computed(() =>
  (summary.data.value?.apps ?? []).reduce((sum, app) => sum + app.expired_not_yet_reaped, 0)
);

const columns = computed<QTableColumn[]>(() => {
  const base: QTableColumn[] = [
    { name: 'client_id', label: 'Client', field: 'client_id', align: 'left', sortable: true },
    {
      name: 'position',
      label: 'Position',
      field: (row) =>
        row.lat === null || row.lon === null
          ? '—'
          : `${row.lat.toFixed(5)}, ${row.lon.toFixed(5)}`,
      align: 'left',
    },
  ];
  // Distance only means something for a radius search; showing an empty column
  // for the other two modes suggests data is missing rather than inapplicable.
  if (mode.value === 'radius') {
    base.push({
      name: 'distance_m',
      label: 'Distance',
      field: (row) => (row.distance_m === null ? '—' : `${Math.round(row.distance_m)} m`),
      align: 'right',
      sortable: true,
    });
  }
  return base;
});

async function runQuery() {
  if (!selectedApp.value) {
    $q.notify({ type: 'warning', message: 'Pick an app first.', position: 'top' });
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
</script>

<template>
  <q-page padding>
    <PageHeader
      title="Live clients"
      subtitle="Connected WebSocket clients, counted from Valkey. Counts are constant-time whatever the fleet size; individual clients are only ever fetched by a bounded query."
    >
      <template #actions>
        <q-btn
          outline
          color="primary"
          icon="refresh"
          label="Refresh"
          :loading="summary.state.value === 'loading'"
          @click="summary.reload()"
          />
      </template>
    </PageHeader>

    <!-- Stats -->
    <div class="row q-col-gutter-md q-mb-md">
      <div class="col-6 col-md-4">
        <StatCard label="Connected">
          <AsyncValue :state="summary.state.value" :error="summary.error.value">
                          {{ (summary.data.value?.total_connected ?? 0).toLocaleString() }}
                        </AsyncValue>
        </StatCard>
      </div>
      <div class="col-6 col-md-4">
        <StatCard label="Apps">
          <AsyncValue :state="summary.state.value" :error="summary.error.value">
                          {{ summary.data.value?.apps.length ?? 0 }}
                        </AsyncValue>
        </StatCard>
      </div>
      <div class="col-12 col-md-4">
        <StatCard label="Expired, not reaped" hint="Entries past their TTL that the reaper has not yet removed. A small number is normal; a growing one means the reaper is not keeping up." :tone="staleCount > 0 ? 'warning' : 'default'">
          <AsyncValue :state="summary.state.value" :error="summary.error.value">
                          {{ staleCount.toLocaleString() }}
                        </AsyncValue>
        </StatCard>
      </div>
    </div>

    <div class="row q-col-gutter-md">
      <!-- Per-app counts -->
      <div class="col-12 col-md-5">
        <SectionCard title="By app" flush>
          <AsyncValue :state="summary.state.value" :error="summary.error.value">
            <q-list separator>
              <q-item
                v-for="app in summary.data.value?.apps ?? []"
                :key="app.app_id"
                v-ripple
                clickable
                :active="selectedApp === app.app_id"
                active-class="bg-blue-grey-1"
                @click="selectedApp = app.app_id"
              >
                <q-item-section>
                  <q-item-label class="mono">{{ app.app_id }}</q-item-label>
                  <q-item-label caption>
                    {{ app.expiring_within_60s }} expiring within 60s ·
                    {{ app.expired_not_yet_reaped }} stale
                  </q-item-label>
                </q-item-section>
                <q-item-section side>
                  <q-badge color="primary" :label="app.connected.toLocaleString()" />
                </q-item-section>
              </q-item>
            </q-list>
          </AsyncValue>
        </SectionCard>
      </div>

      <!-- Query -->
      <div class="col-12 col-md-7">
        <q-card flat bordered>
          <q-card-section>
            <div class="text-caption text-grey-7 text-uppercase text-weight-medium q-mb-sm">
              Find clients
            </div>

            <q-btn-toggle
              v-model="mode"
              no-caps
              unelevated
              toggle-color="primary"
              class="q-mb-md"
              :options="[
                { label: 'Within radius', value: 'radius' },
                { label: 'Sample', value: 'sample' },
                { label: 'By client ID', value: 'lookup' },
              ]"
            />

            <div class="row q-col-gutter-sm">
              <div class="col-12">
                <q-select
                  v-model="selectedApp"
                  :options="appOptions"
                  emit-value
                  map-options
                  outlined
                  dense
                  label="App"
                />
              </div>

              <template v-if="mode === 'radius'">
                <div class="col-6 col-sm-3">
                  <q-input v-model.number="lat" outlined dense type="number" label="Latitude" step="0.0001" />
                </div>
                <div class="col-6 col-sm-3">
                  <q-input v-model.number="lon" outlined dense type="number" label="Longitude" step="0.0001" />
                </div>
                <div class="col-6 col-sm-3">
                  <q-input v-model.number="radiusM" outlined dense type="number" label="Radius (m)" :min="1" />
                </div>
                <div class="col-6 col-sm-3">
                  <q-input v-model.number="limit" outlined dense type="number" label="Limit" :min="1" :max="500" />
                </div>
              </template>

              <template v-else-if="mode === 'sample'">
                <div class="col-6">
                  <q-input v-model.number="limit" outlined dense type="number" label="Limit" :min="1" :max="500" />
                </div>
                <div class="col-12">
                  <div class="text-caption text-grey-7">
                    Takes an arbitrary bounded page via ZSCAN. Not a random sample and not the
                    whole fleet — enough to see what the data looks like.
                  </div>
                </div>
              </template>

              <template v-else>
                <div class="col-12">
                  <q-input v-model="clientId" outlined dense label="Client ID" input-class="mono" />
                </div>
              </template>

              <div class="col-12">
                <q-btn
                  unelevated
                  color="primary"
                  icon="search"
                  label="Run query"
                  :loading="querying"
                  :disable="!selectedApp"
                  @click="runQuery"
                />
              </div>
            </div>
          </q-card-section>

          <q-separator />

          <q-card-section>
            <q-banner v-if="queryError" rounded dense class="bg-red-1 text-negative q-mb-md">
              <template #avatar><q-icon name="error" color="negative" /></template>
              {{ queryError }}
            </q-banner>

            <div v-if="results" class="text-caption text-grey-7 q-mb-sm">
              {{ results.clients.length }} of {{ results.limit }} requested
              <template v-if="results.capped"> · capped, narrow the search to see more</template>
            </div>

            <q-table
              v-if="results?.clients.length"
              flat
              bordered
              dense
              :rows="results.clients"
              :columns="columns"
              row-key="client_id"
              :rows-per-page-options="[25, 50, 0]"
            >
              <template #body-cell-client_id="props">
                <q-td :props="props" class="mono">{{ props.value }}</q-td>
              </template>
            </q-table>

            <div v-else-if="results" class="text-body2 text-grey-7">
              No clients matched.
            </div>
            <div v-else class="text-body2 text-grey-7">
              Choose a mode and run a query. There is no "list all clients" — the keyspace is
              never scanned in full.
            </div>
          </q-card-section>
        </q-card>
      </div>
    </div>
  </q-page>
</template>

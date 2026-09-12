<script setup lang="ts">
import { computed, onUnmounted, ref } from 'vue';
import { useQuasar, type QTableColumn } from 'quasar';
import { api, type LogGroupsResponse, type LogQueryResults } from '@/api/client';
import { useAsyncValue } from '@/composables/useAsyncValue';
import AwsLink from '@/components/AwsLink.vue';
import PageHeader from '@/components/PageHeader.vue';
import { aws } from '@/aws-links';
import AsyncValue from '@/components/AsyncValue.vue';
import SectionCard from '@/components/SectionCard.vue';

const $q = useQuasar();

const groups = useAsyncValue<LogGroupsResponse>((signal) => api.logGroups(signal), {
  timeoutMs: 25000,
});

const CATEGORY_LABEL: Record<string, string> = {
  lambda: 'Lambda functions',
  container: 'Fargate containers',
  api: 'API Gateway access',
  insights: 'Container Insights',
  other: 'Other',
};

/** Ordered so the sources people actually search sit at the top. */
const CATEGORY_ORDER = ['lambda', 'container', 'api', 'insights', 'other'];

const PRESETS = [
  {
    label: 'Recent entries',
    query: 'fields @timestamp, @message\n| sort @timestamp desc',
  },
  {
    label: 'Errors only',
    query:
      'fields @timestamp, @message\n| filter @message like /(?i)(error|exception|traceback|failed)/\n| sort @timestamp desc',
  },
  {
    label: 'Slowest invocations',
    query:
      'filter @type = "REPORT"\n| fields @timestamp, @duration, @maxMemoryUsed, @requestId\n| sort @duration desc',
  },
  {
    label: 'Cold starts',
    query:
      'filter @type = "REPORT" and ispresent(@initDuration)\n| fields @timestamp, @initDuration, @requestId\n| sort @initDuration desc',
  },
];

const RANGE_OPTIONS = [
  { label: '15 min', value: 0.25 },
  { label: '1 hour', value: 1 },
  { label: '6 hours', value: 6 },
  { label: '24 hours', value: 24 },
  { label: '7 days', value: 168 },
];

const selectedGroups = ref<string[]>([]);
const query = ref(PRESETS[0]?.query ?? '');
const rangeHours = ref(1);
const limit = ref(100);

const queryId = ref<string | null>(null);
const results = ref<LogQueryResults | null>(null);
const running = ref(false);
const queryError = ref<string | null>(null);

let pollTimer: ReturnType<typeof setTimeout> | null = null;

function stopPolling() {
  if (pollTimer !== null) {
    clearTimeout(pollTimer);
    pollTimer = null;
  }
}

onUnmounted(stopPolling);

const grouped = computed(() => {
  const all = groups.data.value?.groups ?? [];
  return CATEGORY_ORDER.map((category) => ({
    category,
    label: CATEGORY_LABEL[category] ?? category,
    items: all.filter((group) => group.category === category),
  })).filter((section) => section.items.length > 0);
});

function humanBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toFixed(value < 10 ? 1 : 0)} ${units[unit] ?? 'TB'}`;
}

/**
 * Insights is asynchronous: StartQuery returns an id, and results arrive over
 * repeated polls. Backing off keeps a long scan from hammering the API while
 * still feeling immediate for a small one.
 */
async function poll(id: string, attempt = 0) {
  try {
    const next = await api.logQueryResults(id);
    results.value = next;

    if (next.status === 'Running' || next.status === 'Scheduled') {
      const delay = Math.min(500 * 2 ** Math.min(attempt, 4), 4000);
      pollTimer = setTimeout(() => void poll(id, attempt + 1), delay);
      return;
    }

    running.value = false;
    if (next.status === 'Failed' || next.status === 'Timeout') {
      queryError.value = `CloudWatch reported the query as ${next.status}.`;
    }
  } catch (error) {
    running.value = false;
    queryError.value = error instanceof Error ? error.message : 'Could not read results.';
  }
}

async function run() {
  if (selectedGroups.value.length === 0) {
    $q.notify({ type: 'warning', message: 'Select at least one log group.', position: 'top' });
    return;
  }

  stopPolling();
  queryError.value = null;
  results.value = null;
  running.value = true;

  const end = new Date();
  const start = new Date(end.getTime() - rangeHours.value * 3600 * 1000);

  try {
    const started = await api.logQueryStart({
      groups: selectedGroups.value,
      query: query.value,
      start: start.toISOString(),
      end: end.toISOString(),
      limit: limit.value,
    });
    queryId.value = started.query_id;
    void poll(started.query_id);
  } catch (error) {
    running.value = false;
    queryError.value = error instanceof Error ? error.message : 'Could not start the query.';
  }
}

async function cancel() {
  stopPolling();
  running.value = false;
  if (queryId.value) {
    try {
      await api.logQueryStop(queryId.value);
    } catch {
      // Already finished — nothing to cancel.
    }
  }
}

/** Columns come from the rows themselves, so any query shape renders. */
const columns = computed<QTableColumn[]>(() => {
  const rows = results.value?.rows ?? [];
  const seen = new Set<string>();
  for (const row of rows) {
    for (const key of Object.keys(row)) {
      if (key !== '@ptr') seen.add(key);
    }
  }
  return [...seen].map((key) => ({
    name: key,
    label: key,
    field: key,
    align: 'left' as const,
    sortable: true,
  }));
});

function applyPreset(preset: { query: string }) {
  query.value = preset.query;
}
</script>

<template>
  <q-page padding>
    <PageHeader
      title="Logs"
      subtitle="CloudWatch Logs Insights across the stack's log groups. Queries run asynchronously — results stream in as CloudWatch scans."
    >
      <template #actions>
        <q-btn
          outline
          color="primary"
          icon="refresh"
          label="Refresh groups"
          :loading="groups.state.value === 'loading'"
          @click="groups.reload()"
          />
      </template>
    </PageHeader>

    <div class="row q-col-gutter-md">
      <!-- Log group picker -->
      <div class="col-12 col-md-4">
        <SectionCard
          title="Log groups"
          lede="Pick the sources to search. Groups with no live writer are marked as orphans — they are still billed for storage."
          flush
        >
          <template #actions>
            <div class="text-caption text-grey-7">
              {{ selectedGroups.length }} selected ·
              {{ humanBytes(groups.data.value?.total_stored_bytes ?? 0) }}
            </div>
          </template>

          <AsyncValue :state="groups.state.value" :error="groups.error.value">
            <q-list dense class="q-pa-sm" style="max-height: 460px; overflow-y: auto">
              <template v-for="section in grouped" :key="section.category">
                <q-item-label header class="text-uppercase">{{ section.label }}</q-item-label>
                <q-item v-for="group in section.items" :key="group.name" dense class="q-px-sm">
                  <q-item-section side>
                    <q-checkbox v-model="selectedGroups" :val="group.name" dense />
                  </q-item-section>
                  <q-item-section>
                    <q-item-label class="mono" lines="1">
                      {{ group.name }}
                      <q-tooltip class="hint-tooltip">{{ group.name }}</q-tooltip>
                    </q-item-label>
                    <q-item-label caption>
                      {{ humanBytes(group.stored_bytes) }}
                      <template v-if="group.retention_days">
                        · {{ group.retention_days }}d retention
                      </template>
                      <template v-else> · never expires</template>
                      ·
                      <!-- Insights answers questions across groups; the
                           CloudWatch group page is where you read one stream
                           from end to end. -->
                      <AwsLink :href="aws.logGroup(group.name)" label="open" />
                    </q-item-label>
                  </q-item-section>
                  <q-item-section v-if="group.orphaned" side>
                    <q-badge outline color="warning" label="orphan">
                      <q-tooltip class="hint-tooltip">
                        No live resource writes to this group any more — it is still billed for
                        storage.
                      </q-tooltip>
                    </q-badge>
                  </q-item-section>
                </q-item>
              </template>
            </q-list>
          </AsyncValue>
        </SectionCard>
      </div>

      <!-- Query -->
      <div class="col-12 col-md-8">
        <q-card flat bordered>
          <q-card-section>
            <div class="text-caption text-grey-7 text-uppercase text-weight-medium q-mb-sm">
              Query
            </div>

            <div class="row q-gutter-sm q-mb-md">
              <q-btn
                v-for="preset in PRESETS"
                :key="preset.label"
                outline
                dense
                size="sm"
                color="primary"
                :label="preset.label"
                @click="applyPreset(preset)"
              />
            </div>

            <q-input
              v-model="query"
              outlined
              type="textarea"
              autogrow
              input-class="mono"
              label="Logs Insights query"
              :rows="4"
            />

            <div class="row q-col-gutter-md items-end q-mt-sm">
              <div class="col-12 col-sm-5">
                <q-select
                  v-model="rangeHours"
                  :options="RANGE_OPTIONS"
                  emit-value
                  map-options
                  outlined
                  dense
                  label="Time range"
                />
              </div>
              <div class="col-6 col-sm-3">
                <q-input
                  v-model.number="limit"
                  outlined
                  dense
                  type="number"
                  label="Row limit"
                  :min="1"
                  :max="1000"
                />
              </div>
              <div class="col-6 col-sm-4 q-gutter-sm">
                <q-btn
                  v-if="!running"
                  unelevated
                  color="primary"
                  icon="play_arrow"
                  label="Run"
                  :disable="selectedGroups.length === 0"
                  @click="run"
                />
                <q-btn v-else outline color="negative" icon="stop" label="Cancel" @click="cancel" />
              </div>
            </div>
          </q-card-section>

          <q-separator />

          <q-card-section>
            <q-banner v-if="queryError" rounded dense class="bg-red-1 text-negative q-mb-md">
              <template #avatar><q-icon name="error" color="negative" /></template>
              {{ queryError }}
            </q-banner>

            <div v-if="running" class="row items-center text-body2 text-grey-7 q-mb-md">
              <q-spinner size="16px" class="q-mr-sm" />
              {{ results?.status ?? 'Starting' }} — CloudWatch is scanning.
            </div>

            <div v-if="results" class="text-caption text-grey-7 q-mb-sm">
              {{ results.rows.length }} rows
              <template v-if="results.matched_records !== null">
                · {{ results.matched_records.toLocaleString() }} matched
              </template>
              <template v-if="results.scanned_bytes !== null">
                · {{ humanBytes(results.scanned_bytes) }} scanned
              </template>
            </div>

            <q-table
              v-if="results?.rows.length"
              flat
              bordered
              dense
              :rows="results.rows"
              :columns="columns"
              row-key="@ptr"
              :rows-per-page-options="[25, 50, 100, 0]"
              class="log-table"
            >
              <template #body-cell="props">
                <q-td :props="props" class="mono log-cell">{{ props.value }}</q-td>
              </template>
            </q-table>

            <div
              v-else-if="results && !running"
              class="text-body2 text-grey-7"
            >
              No rows matched. Widen the time range, or check the query against the group you
              selected.
            </div>

            <div v-else-if="!running && !results" class="text-body2 text-grey-7">
              Pick one or more log groups and run a query.
            </div>
          </q-card-section>
        </q-card>
      </div>
    </div>
  </q-page>
</template>

<style scoped>
/* Log lines are long; the table scrolls rather than widening the page, and
   cells wrap instead of being truncated to nothing useful. */
.log-table :deep(.q-table__middle) {
  max-height: 520px;
}

.log-cell {
  white-space: pre-wrap;
  word-break: break-word;
  max-width: 640px;
  vertical-align: top;
}
</style>

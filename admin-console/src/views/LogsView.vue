<script setup lang="ts">
import { computed, onUnmounted, ref, watch } from 'vue';
import { ElMessage } from 'element-plus';
import { api, type LogGroupsResponse, type LogQueryResults } from '@/api/client';
import { useAsyncValue } from '@/composables/useAsyncValue';
import AsyncValue from '@/components/AsyncValue.vue';

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

const selectedGroups = ref<string[]>([]);
const query = ref(PRESETS[0].query);
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
    label: CATEGORY_LABEL[category],
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
  return `${value.toFixed(value < 10 ? 1 : 0)} ${units[unit]}`;
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
    ElMessage.warning('Select at least one log group.');
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
const columns = computed(() => {
  const rows = results.value?.rows ?? [];
  const seen = new Set<string>();
  for (const row of rows) {
    for (const key of Object.keys(row)) {
      if (key !== '@ptr') seen.add(key);
    }
  }
  return [...seen];
});

watch(
  () => groups.data.value,
  (data) => {
    // Preselect the largest non-orphaned group so the first query does something.
    if (data && selectedGroups.value.length === 0) {
      const first = data.groups.find((group) => !group.orphaned);
      if (first) selectedGroups.value = [first.name];
    }
  },
  { immediate: true }
);
</script>

<template>
  <div>
    <div class="header">
      <div>
        <h1 class="page-title">Logs</h1>
        <p class="page-subtitle">
          CloudWatch Logs Insights across this stack. Queries run asynchronously and are billed
          per gigabyte scanned, so narrow the window before widening the group selection.
        </p>
      </div>
      <el-button
        :icon="'Refresh'"
        :loading="groups.state.value === 'loading'"
        @click="groups.reload()"
      >
        Refresh groups
      </el-button>
    </div>

    <div class="stat-grid">
      <div class="stat">
        <div class="stat__label">Log groups</div>
        <div class="stat__value">
          <AsyncValue :state="groups.state.value" :error="groups.error.value">
            {{ groups.data.value?.groups.length ?? 0 }}
          </AsyncValue>
        </div>
      </div>
      <div class="stat">
        <div class="stat__label">Stored</div>
        <div class="stat__value">
          <AsyncValue :state="groups.state.value" :error="groups.error.value">
            {{ humanBytes(groups.data.value?.total_stored_bytes ?? 0) }}
          </AsyncValue>
        </div>
      </div>
      <div class="stat">
        <div class="stat__label">Orphaned groups</div>
        <div class="stat__value">
          <AsyncValue :state="groups.state.value" :error="groups.error.value">
            <span :class="(groups.data.value?.orphaned_count ?? 0) > 0 ? 'warn' : ''">
              {{ groups.data.value?.orphaned_count ?? 0 }}
            </span>
          </AsyncValue>
        </div>
      </div>
      <div class="stat">
        <div class="stat__label">Selected</div>
        <div class="stat__value">{{ selectedGroups.length }}</div>
      </div>
    </div>

    <div class="grid">
      <section class="card">
        <h2 class="card__title">Log groups</h2>
        <AsyncValue :state="groups.state.value" :error="groups.error.value">
          <el-checkbox-group v-model="selectedGroups" class="groups">
            <div v-for="section in grouped" :key="section.category" class="section">
              <div class="section__label">{{ section.label }}</div>
              <el-checkbox
                v-for="group in section.items"
                :key="group.name"
                :value="group.name"
                class="group"
              >
                <span class="group__name">{{ group.name.replace('/aws/lambda/MsightCloudStack-', '') }}</span>
                <span class="group__size">{{ humanBytes(group.stored_bytes) }}</span>
                <el-tag v-if="group.orphaned" size="small" type="warning" effect="plain">
                  orphaned
                </el-tag>
              </el-checkbox>
            </div>
          </el-checkbox-group>
        </AsyncValue>
        <p class="hint">
          <strong>Orphaned</strong> means the Lambda that wrote this group no longer exists.
          The data still costs storage; nothing new will ever be written to it.
        </p>
      </section>

      <section class="card">
        <h2 class="card__title">Query</h2>

        <div class="controls">
          <label class="field">
            <span>Time range</span>
            <el-select v-model="rangeHours" style="width: 140px">
              <el-option :value="1" label="Last hour" />
              <el-option :value="6" label="Last 6 hours" />
              <el-option :value="24" label="Last 24 hours" />
              <el-option :value="72" label="Last 3 days" />
              <el-option :value="168" label="Last 7 days" />
            </el-select>
          </label>
          <label class="field">
            <span>Max rows</span>
            <el-input-number v-model="limit" :min="1" :max="1000" :step="50" controls-position="right" />
          </label>
        </div>

        <div class="presets">
          <el-button
            v-for="preset in PRESETS"
            :key="preset.label"
            size="small"
            text
            @click="query = preset.query"
          >
            {{ preset.label }}
          </el-button>
        </div>

        <el-input v-model="query" type="textarea" :rows="6" class="query" spellcheck="false" />

        <div class="actions">
          <el-button type="primary" :loading="running" @click="run">Run query</el-button>
          <el-button v-if="running" text @click="cancel">Cancel</el-button>
          <span v-if="results && !running" class="stats">
            {{ results.matched_records ?? 0 }} matched ·
            {{ humanBytes(results.scanned_bytes ?? 0) }} scanned
          </span>
        </div>

        <el-alert
          v-if="queryError"
          type="error"
          show-icon
          :closable="false"
          class="alert"
          :title="queryError"
        />
      </section>
    </div>

    <section v-if="results" class="card results">
      <h2 class="card__title">
        Results · {{ results.rows.length }} rows · {{ results.status }}
      </h2>

      <div v-if="results.rows.length === 0 && !running" class="empty">
        No entries matched in this window.
      </div>

      <div v-else class="tableWrap">
        <table class="rows">
          <thead>
            <tr>
              <th v-for="column in columns" :key="column">{{ column }}</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="(row, index) in results.rows" :key="index">
              <td v-for="column in columns" :key="column" class="cell">
                {{ row[column] ?? '' }}
              </td>
            </tr>
          </tbody>
        </table>
      </div>
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
  grid-template-columns: minmax(280px, 0.75fr) minmax(360px, 1fr);
  gap: 16px;
  align-items: start;
}

@media (max-width: 1100px) {
  .grid {
    grid-template-columns: 1fr;
  }
}

.groups {
  display: flex;
  flex-direction: column;
  gap: 14px;
  max-height: 420px;
  overflow-y: auto;
}

.section__label {
  font-size: 10px;
  font-weight: 700;
  letter-spacing: 0.07em;
  text-transform: uppercase;
  color: var(--text-muted);
  margin-bottom: 6px;
}

.group {
  display: flex;
  width: 100%;
  margin-right: 0;
  height: auto;
  padding: 3px 0;
}

.group__name {
  font-size: 11.5px;
  font-family: 'SF Mono', ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  word-break: break-all;
}

.group__size {
  margin-left: 8px;
  font-size: 10.5px;
  color: var(--text-muted);
}

.controls {
  display: flex;
  gap: 14px;
  flex-wrap: wrap;
  margin-bottom: 14px;
}

.field {
  display: flex;
  flex-direction: column;
  gap: 5px;
  font-size: 12px;
  color: var(--text-muted);
}

.presets {
  display: flex;
  flex-wrap: wrap;
  gap: 2px;
  margin-bottom: 8px;
}

.query :deep(textarea) {
  font-family: 'SF Mono', ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  font-size: 12px;
  line-height: 1.6;
}

.actions {
  display: flex;
  align-items: center;
  gap: 10px;
  margin-top: 14px;
}

.stats {
  font-size: 11.5px;
  color: var(--text-muted);
}

.alert {
  margin-top: 14px;
}

.results {
  margin-top: 16px;
}

.tableWrap {
  overflow-x: auto;
}

.rows {
  width: 100%;
  border-collapse: collapse;
}

.rows th {
  font-size: 10px;
  font-weight: 700;
  letter-spacing: 0.06em;
  text-transform: uppercase;
  color: var(--text-muted);
  text-align: left;
  padding: 0 12px 7px 0;
  border-bottom: 1px solid var(--border);
  white-space: nowrap;
}

.cell {
  padding: 7px 12px 7px 0;
  font-size: 11.5px;
  font-family: 'SF Mono', ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  border-bottom: 1px solid var(--border);
  vertical-align: top;
  max-width: 720px;
  overflow-wrap: anywhere;
}

.hint {
  margin: 14px 0 0;
  font-size: 11.5px;
  color: var(--text-muted);
  line-height: 1.6;
}

.warn {
  color: var(--warn);
}
</style>

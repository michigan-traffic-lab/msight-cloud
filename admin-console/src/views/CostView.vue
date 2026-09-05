<script setup lang="ts">
import { computed, ref, shallowRef, watch } from 'vue';
import { ElMessage } from 'element-plus';
import { api, type CostServiceDetail, type CostSummary } from '@/api/client';
import { useAsyncValue } from '@/composables/useAsyncValue';
import AsyncValue from '@/components/AsyncValue.vue';
import CostDonut, { type DonutSlice } from '@/components/CostDonut.vue';

/**
 * Categorical slots 1-5 from the validated palette, plus a neutral for the
 * folded tail. Assigned in fixed order by rank and never cycled — a service
 * keeps its colour as long as it holds its position in the list.
 */
const SLICE_COLORS = ['#2a78d6', '#eb6834', '#1baf7a', '#eda100', '#e87ba4'];
const OTHER_COLOR = '#8b8b86';

/** A donut is only readable at a glance; past six segments it stops being one. */
const MAX_SLICES = 5;

/** Date range: empty means current month to date, which is the default view. */
const range = ref<[string, string] | null>(null);
const selected = ref<string | null>(null);

/**
 * The date picker stays collapsed behind a chip until asked for. Arriving at
 * this page you want the current month's breakdown, not a form.
 */
const searchOpen = ref(false);
const draftRange = ref<[string, string] | null>(null);

const params = computed(() =>
  range.value ? { start: range.value[0], end: range.value[1] } : {}
);

const summary = useAsyncValue<CostSummary>(
  (signal) => api.costSummary(params.value, signal),
  { timeoutMs: 30000 }
);

// shallowRef, not ref: a plain ref would deep-unwrap the composable's inner
// refs, so `detail.state.value` would collapse to a bare string in the template.
const detail = shallowRef<ReturnType<typeof useAsyncValue<CostServiceDetail>> | null>(null);

// Selecting a slice loads its detail on its own request, so a slow drill-down
// never blocks the chart that triggered it.
watch(selected, (service) => {
  detail.value = service
    ? useAsyncValue<CostServiceDetail>(
        (signal) => api.costServiceDetail(service, params.value, signal),
        { timeoutMs: 30000 }
      )
    : null;
});

function openSearch() {
  draftRange.value = range.value;
  searchOpen.value = true;
}

function applyRange() {
  if (!draftRange.value) {
    return;
  }
  range.value = draftRange.value;
  searchOpen.value = false;
  selected.value = null;
  void summary.reload();
}

function cancelSearch() {
  draftRange.value = null;
  searchOpen.value = false;
}

function clearRange() {
  range.value = null;
  draftRange.value = null;
  searchOpen.value = false;
  selected.value = null;
  void summary.reload();
}

async function refreshNow() {
  // Bypasses the server-side cache. Cost Explorer bills per request, so this is
  // deliberate rather than automatic.
  try {
    summary.data.value = await api.costSummary({ ...params.value, refresh: true });
    summary.state.value = 'ready';
    ElMessage.success('Refreshed from Cost Explorer.');
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : 'Refresh failed.');
  }
}

/** Top services by cost, with the long tail folded into a single Other slice. */
const slices = computed<DonutSlice[]>(() => {
  const components = summary.data.value?.components ?? [];
  if (components.length === 0) return [];

  const head = components.slice(0, MAX_SLICES).map((component, index) => ({
    label: component.service,
    amount: component.amount,
    share: component.share,
    color: SLICE_COLORS[index],
  }));

  const tail = components.slice(MAX_SLICES);
  if (tail.length > 0) {
    head.push({
      label: `Other (${tail.length})`,
      amount: tail.reduce((sum, component) => sum + component.amount, 0),
      share: tail.reduce((sum, component) => sum + component.share, 0),
      color: OTHER_COLOR,
    });
  }

  return head;
});

/**
 * True only once the response confirms it. Driving this off the loaded period
 * rather than the local range keeps the tiles honest about the data on screen
 * while a new search is still in flight.
 */
const isCustomPeriod = computed(() => summary.data.value?.period.is_current_month === false);

/** Short label used inside stat tiles. */
const periodLabel = computed(() => {
  const period = summary.data.value?.period;
  if (!period) return '';
  return period.is_current_month ? 'Month to date' : 'Selected period';
});

function shortDate(value: string): string {
  return new Date(`${value}T00:00:00Z`).toLocaleDateString(undefined, {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    timeZone: 'UTC',
  });
}

/** Wording on the collapsed chip — always says which period is on screen. */
const periodChipLabel = computed(() => {
  const period = summary.data.value?.period;
  if (!period) return 'Current month';
  if (period.is_current_month) {
    return `Current month · ${new Date(`${period.start}T00:00:00Z`).toLocaleDateString(
      undefined,
      { month: 'long', year: 'numeric', timeZone: 'UTC' }
    )}`;
  }
  return `${shortDate(period.start)} – ${shortDate(period.end)}`;
});

const deltaPercent = computed(() => {
  const data = summary.data.value;
  if (!data?.previous_period_total) return null;
  return ((data.total - data.previous_period_total) / data.previous_period_total) * 100;
});

function money(value: number, currency = 'USD'): string {
  return new Intl.NumberFormat(undefined, {
    style: 'currency',
    currency,
    maximumFractionDigits: value < 100 ? 2 : 0,
  }).format(value);
}

/** "Other" is an aggregate, not a service — there is nothing to drill into. */
function onSelect(label: string | null) {
  selected.value = label && label.startsWith('Other (') ? null : label;
}
</script>

<template>
  <div>
    <div class="header">
      <div>
        <h1 class="page-title">Cost breakdown</h1>
        <p class="page-subtitle">
          Spend attributed to this stack by the
          <code v-if="summary.data.value">
            {{ summary.data.value.filter.tag_key }}={{ summary.data.value.filter.tag_value }}
          </code>
          <template v-else>cost allocation</template>
          tag. Cost Explorer data lags up to 24 hours.
        </p>
      </div>
      <el-button :icon="'Refresh'" :loading="summary.state.value === 'loading'" @click="refreshNow">
        Refresh
      </el-button>
    </div>

    <!-- Filters in one row above the charts. Collapsed by default: arriving
         here you want this month's breakdown, not a form to fill in. -->
    <div class="filters">
      <template v-if="!searchOpen">
        <!-- Passive indicator: says which period is on screen, does nothing. -->
        <span class="period-indicator">
          <el-icon><Calendar /></el-icon>
          <span>{{ periodChipLabel }}</span>
        </span>

        <!-- Only present once a custom period is showing, and it takes the
             place the current-month wording occupied. -->
        <el-button v-if="isCustomPeriod" :icon="'Back'" @click="clearRange">
          Back to current month
        </el-button>

        <el-button :icon="'Search'" @click="openSearch">Search</el-button>
      </template>

      <template v-else>
        <el-date-picker
          v-model="draftRange"
          type="daterange"
          value-format="YYYY-MM-DD"
          start-placeholder="Start"
          end-placeholder="End"
          :clearable="false"
          unlink-panels
        />
        <el-button type="primary" :disabled="!draftRange" @click="applyRange">Search</el-button>
        <el-button text @click="cancelSearch">Cancel</el-button>
      </template>
    </div>

    <div class="stat-grid">
      <div class="stat">
        <div class="stat__label">{{ periodLabel || 'Period total' }}</div>
        <div class="stat__value">
          <AsyncValue :state="summary.state.value" :error="summary.error.value">
            {{ money(summary.data.value?.total ?? 0, summary.data.value?.currency) }}
          </AsyncValue>
        </div>
      </div>

      <!-- Projection and previous-period comparison only mean something for a
           month in progress, so they are absent for an explicit date range
           rather than shown empty. -->
      <div v-if="!isCustomPeriod" class="stat">
        <div class="stat__label">Projected month total</div>
        <div class="stat__value">
          <AsyncValue :state="summary.state.value" :error="summary.error.value">
            <template v-if="summary.data.value?.projected_month_total !== null">
              {{ money(summary.data.value?.projected_month_total ?? 0, summary.data.value?.currency) }}
            </template>
            <span v-else class="stat__value--muted">Not enough history</span>
          </AsyncValue>
        </div>
      </div>

      <div v-if="!isCustomPeriod" class="stat">
        <div class="stat__label">Previous month to date</div>
        <div class="stat__value">
          <AsyncValue :state="summary.state.value" :error="summary.error.value">
            <template v-if="summary.data.value?.previous_period_total !== null">
              {{ money(summary.data.value?.previous_period_total ?? 0, summary.data.value?.currency) }}
              <span v-if="deltaPercent !== null" class="delta" :class="deltaPercent >= 0 ? 'delta--up' : 'delta--down'">
                {{ deltaPercent >= 0 ? '+' : '' }}{{ deltaPercent.toFixed(0) }}%
              </span>
            </template>
            <span v-else class="stat__value--muted">—</span>
          </AsyncValue>
        </div>
      </div>

      <div class="stat">
        <div class="stat__label">Services with spend</div>
        <div class="stat__value">
          <AsyncValue :state="summary.state.value" :error="summary.error.value">
            {{ summary.data.value?.components.length ?? 0 }}
          </AsyncValue>
        </div>
      </div>
    </div>

    <div class="grid">
      <section class="card">
        <h2 class="card__title">Breakdown by service</h2>

        <AsyncValue :state="summary.state.value" :error="summary.error.value">
          <div v-if="slices.length === 0" class="empty">
            No tagged spend in this period. Cost is attributed only from the first deploy
            that carried the tag, and Cost Explorer lags up to 24 hours — so a stack tagged
            recently will read zero for a while.
          </div>

          <div v-else class="breakdown">
            <CostDonut
              :slices="slices"
              :total="summary.data.value?.total ?? 0"
              :currency="summary.data.value?.currency ?? 'USD'"
              :selected="selected"
              :caption="periodLabel"
              @select="onSelect"
            />

            <!-- The list is the accurate read; the donut is the glance. It also
                 satisfies the relief rule for low-contrast slice colours. -->
            <ul class="legend">
              <li
                v-for="slice in slices"
                :key="slice.label"
                class="legend__row"
                :class="{ 'legend__row--active': selected === slice.label }"
                @click="onSelect(slice.label)"
              >
                <span class="legend__swatch" :style="{ background: slice.color }" />
                <span class="legend__label">{{ slice.label }}</span>
                <span class="legend__share">{{ Math.round(slice.share * 100) }}%</span>
                <span class="legend__amount mono">
                  {{ money(slice.amount, summary.data.value?.currency) }}
                </span>
              </li>
            </ul>
          </div>
        </AsyncValue>
      </section>

      <section class="card">
        <h2 class="card__title">
          {{ selected ? selected : 'Service detail' }}
        </h2>

        <div v-if="!selected" class="empty">
          Select a segment in the chart, or a row in the list, to see what makes up that
          service's cost.
        </div>

        <AsyncValue
          v-else-if="detail"
          :state="detail?.state.value ?? 'loading'"
          :error="detail?.error.value"
        >
          <div class="detail__total">
            {{ money(detail?.data.value?.total ?? 0, detail?.data.value?.currency) }}
            <span class="detail__total-label">over {{ periodLabel.toLowerCase() }}</span>
          </div>

          <table class="usage">
            <thead>
              <tr>
                <th>Usage type</th>
                <th class="usage__num">Share</th>
                <th class="usage__num">Cost</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="entry in detail?.data.value?.usage_types ?? []" :key="entry.usage_type">
                <td class="usage__type">{{ entry.usage_type }}</td>
                <td class="usage__num">{{ Math.round(entry.share * 100) }}%</td>
                <td class="usage__num mono">
                  {{ money(entry.amount, detail?.data.value?.currency) }}
                </td>
              </tr>
            </tbody>
          </table>

          <p v-if="(detail?.data.value?.usage_types.length ?? 0) === 0" class="empty">
            No usage-type breakdown available for this service in this period.
          </p>
        </AsyncValue>
      </section>
    </div>

    <p v-if="summary.state.value === 'ready'" class="timestamp">
      Figures fetched {{ new Date(summary.data.value!.fetched_at).toLocaleString() }}
      <template v-if="summary.data.value!.cached"> · served from cache</template>
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

.header code {
  background: var(--page-bg);
  padding: 1px 5px;
  border-radius: 4px;
  font-size: 12px;
}

.filters {
  display: flex;
  align-items: center;
  gap: 10px;
  margin-bottom: 20px;
  flex-wrap: wrap;
}

.period-indicator {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  padding: 7px 12px;
  border-radius: 8px;
  background: var(--page-bg);
  border: 1px solid var(--border);
  color: var(--text);
  font-size: 13px;
  font-weight: 550;
}

.period-indicator .el-icon {
  color: var(--text-muted);
}

.grid {
  display: grid;
  grid-template-columns: minmax(0, 1fr) minmax(320px, 0.85fr);
  gap: 16px;
  align-items: start;
}

@media (max-width: 1100px) {
  .grid {
    grid-template-columns: 1fr;
  }
}

.breakdown {
  display: flex;
  align-items: center;
  gap: 24px;
  flex-wrap: wrap;
}

.legend {
  list-style: none;
  margin: 0;
  padding: 0;
  flex: 1;
  min-width: 240px;
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.legend__row {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 7px 8px;
  border-radius: 6px;
  cursor: pointer;
  font-size: 13px;
  transition: background 0.12s ease;
}

.legend__row:hover,
.legend__row--active {
  background: var(--page-bg);
}

.legend__swatch {
  width: 10px;
  height: 10px;
  border-radius: 3px;
  flex-shrink: 0;
}

.legend__label {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.legend__share {
  color: var(--text-muted);
  font-size: 12px;
  width: 38px;
  text-align: right;
}

.legend__amount {
  width: 82px;
  text-align: right;
}

.stat__value--muted {
  font-size: 14px;
  font-weight: 500;
  color: var(--text-muted);
}

.delta {
  font-size: 13px;
  font-weight: 600;
  margin-left: 8px;
}

.delta--up {
  color: var(--bad);
}

.delta--down {
  color: var(--ok);
}

.detail__total {
  font-size: 24px;
  font-weight: 650;
  letter-spacing: -0.02em;
  margin-bottom: 18px;
}

.detail__total-label {
  font-size: 12px;
  font-weight: 400;
  color: var(--text-muted);
  margin-left: 8px;
}

.usage {
  width: 100%;
  border-collapse: collapse;
}

.usage th {
  font-size: 11px;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.05em;
  color: var(--text-muted);
  text-align: left;
  padding-bottom: 8px;
  border-bottom: 1px solid var(--border);
}

.usage td {
  padding: 9px 0;
  font-size: 13px;
  border-bottom: 1px solid var(--border);
}

.usage__type {
  word-break: break-all;
  padding-right: 12px;
}

.usage__num {
  text-align: right;
  width: 84px;
}

.timestamp {
  margin-top: 20px;
  font-size: 12px;
  color: var(--text-muted);
}
</style>

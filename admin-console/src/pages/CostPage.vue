<script setup lang="ts">
import { computed, ref, shallowRef, watch } from 'vue';
import { useQuasar } from 'quasar';
import { api, type CostServiceDetail, type CostSummary } from '@/api/client';
import { useAsyncValue } from '@/composables/useAsyncValue';
import PageHeader from '@/components/PageHeader.vue';
import AsyncValue from '@/components/AsyncValue.vue';
import CostDonut, { type DonutSlice } from '@/components/CostDonut.vue';
import StatCard from '@/components/StatCard.vue';
import SectionCard from '@/components/SectionCard.vue';

const $q = useQuasar();

/**
 * Categorical slots 1-5 from the validated palette, plus a neutral for the
 * folded tail. Assigned in fixed order by rank and never cycled — a service
 * keeps its colour as long as it holds its position in the list.
 */
const SLICE_COLORS = ['#2a78d6', '#eb6834', '#1baf7a', '#eda100', '#e87ba4'];
const OTHER_COLOR = '#8b8b86';

/** A donut is only readable at a glance; past six segments it stops being one. */
const MAX_SLICES = 5;

/** Marks the folded slice, so selecting it can be told from selecting a service. */
const OTHER_PREFIX = 'Other (';

/** Date range: null means current month to date, which is the default view. */
const range = ref<{ from: string; to: string } | null>(null);
const selected = ref<string | null>(null);

/**
 * The date picker stays collapsed behind a button until asked for. Arriving at
 * this page you want the current month's breakdown, not a form.
 */
const searchOpen = ref(false);
const draftRange = ref<{ from: string; to: string } | null>(null);

const params = computed(() => (range.value ? { start: range.value.from, end: range.value.to } : {}));

const summary = useAsyncValue<CostSummary>((signal) => api.costSummary(params.value, signal), {
  timeoutMs: 30000,
});

// shallowRef, not ref: a plain ref would deep-unwrap the composable's inner
// refs, so `detail.state.value` would collapse to a bare string in the template.
const detail = shallowRef<ReturnType<typeof useAsyncValue<CostServiceDetail>> | null>(null);

/** True when the folded "Other" slice is selected rather than a real service. */
const isOtherSelected = computed(
  () => selected.value !== null && selected.value.startsWith(OTHER_PREFIX)
);

/** The services folded into "Other", in the same rank order as the chart. */
const otherComponents = computed(() => (summary.data.value?.components ?? []).slice(MAX_SLICES));

// Selecting a slice loads its detail on its own request, so a slow drill-down
// never blocks the chart that triggered it. "Other" is an aggregate with no
// Cost Explorer identity, so it is rendered from data already in hand instead.
watch(selected, (service) => {
  detail.value =
    service && !service.startsWith(OTHER_PREFIX)
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
  if (!draftRange.value?.from || !draftRange.value?.to) return;
  range.value = draftRange.value;
  searchOpen.value = false;
  selected.value = null;
  void summary.reload();
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
    $q.notify({ type: 'positive', message: 'Refreshed from Cost Explorer.', position: 'top' });
  } catch (error) {
    $q.notify({
      type: 'negative',
      message: error instanceof Error ? error.message : 'Refresh failed.',
      position: 'top',
    });
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
    color: SLICE_COLORS[index] ?? OTHER_COLOR,
  }));

  const tail = components.slice(MAX_SLICES);
  if (tail.length > 0) {
    head.push({
      label: `${OTHER_PREFIX}${tail.length})`,
      amount: tail.reduce((sum, component) => sum + component.amount, 0),
      share: tail.reduce((sum, component) => sum + component.share, 0),
      color: OTHER_COLOR,
    });
  }

  return head;
});

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

/** Wording on the collapsed button — always says which period is on screen. */
const periodChipLabel = computed(() => {
  const period = summary.data.value?.period;
  if (!period) return 'Current month';
  if (period.is_current_month) {
    return `Current month · ${new Date(`${period.start}T00:00:00Z`).toLocaleDateString(undefined, {
      month: 'long',
      year: 'numeric',
      timeZone: 'UTC',
    })}`;
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

function onSelect(label: string | null) {
  selected.value = label;
}
</script>

<template>
  <q-page padding>
    <PageHeader
      title="Cost"
      subtitle="Spend attributed to this stack by its cost allocation tag, read from AWS Cost Explorer. Figures lag up to 24 hours and cover only resources carrying the tag."
    >
      <template #actions>
        <q-btn outline color="primary" icon="event" :label="periodChipLabel" @click="openSearch" />
        <q-btn
          outline
          color="primary"
          icon="refresh"
          label="Refresh"
          :loading="summary.state.value === 'loading'"
          @click="refreshNow"
          >
          <q-tooltip class="hint-tooltip">
          Bypasses the server-side cache and re-queries Cost Explorer, which bills per
          request — so it is a button rather than something that happens automatically.
        </q-tooltip>
        </q-btn>
      </template>
    </PageHeader>

    <!-- Stats -->
    <div class="row q-col-gutter-md q-mb-md">
      <div class="col-6 col-md-4">
        <StatCard :label="periodLabel || 'Total'">
          <AsyncValue :state="summary.state.value" :error="summary.error.value">
                          {{ money(summary.data.value?.total ?? 0, summary.data.value?.currency) }}
                        </AsyncValue>
        </StatCard>
      </div>
      <div class="col-6 col-md-4">
        <StatCard label="Projected month">
          <AsyncValue :state="summary.state.value" :error="summary.error.value">
                          <template v-if="summary.data.value?.projected_month_total !== null">
                            {{ money(summary.data.value?.projected_month_total ?? 0, summary.data.value?.currency) }}
                          </template>
                          <template v-else>—</template>
                        </AsyncValue>
        </StatCard>
      </div>
      <div class="col-12 col-md-4">
        <StatCard label="Previous period">
          <AsyncValue :state="summary.state.value" :error="summary.error.value">
                          {{ money(summary.data.value?.previous_period_total ?? 0, summary.data.value?.currency) }}
                          <span
                            v-if="deltaPercent !== null"
                            class="text-caption"
                            :class="deltaPercent > 0 ? 'text-negative' : 'text-positive'"
                          >
                            {{ deltaPercent > 0 ? '+' : '' }}{{ deltaPercent.toFixed(0) }}%
                          </span>
                        </AsyncValue>
        </StatCard>
      </div>
    </div>

    <div class="row q-col-gutter-md">
      <!-- Breakdown -->
      <div class="col-12 col-md-6">
        <SectionCard title="Breakdown by service" flush>
          <q-card-section>
            <AsyncValue :state="summary.state.value" :error="summary.error.value">
              <div v-if="slices.length === 0" class="text-body2 text-grey-7">
                No tagged spend in this period. Cost is attributed only from the first deploy
                that carried the tag, and Cost Explorer lags up to 24 hours.
              </div>
              <template v-else>
                <CostDonut
                  :slices="slices"
                  :total="summary.data.value?.total ?? 0"
                  :currency="summary.data.value?.currency ?? 'USD'"
                  :selected="selected"
                  :caption="periodLabel"
                  @select="onSelect"
                />
                <q-list dense separator class="q-mt-md">
                  <q-item
                    v-for="slice in slices"
                    :key="slice.label"
                    v-ripple
                    clickable
                    :active="selected === slice.label"
                    active-class="bg-blue-grey-1"
                    @click="onSelect(selected === slice.label ? null : slice.label)"
                  >
                    <q-item-section avatar style="min-width: 24px">
                      <q-icon name="square" size="12px" :style="{ color: slice.color }" />
                    </q-item-section>
                    <q-item-section>{{ slice.label }}</q-item-section>
                    <q-item-section side class="text-grey-8">
                      {{ Math.round(slice.share * 100) }}%
                    </q-item-section>
                    <q-item-section side class="mono text-grey-9">
                      {{ money(slice.amount, summary.data.value?.currency) }}
                    </q-item-section>
                  </q-item>
                </q-list>
              </template>
            </AsyncValue>
          </q-card-section>
        </SectionCard>
      </div>

      <!-- Service detail -->
      <div class="col-12 col-md-6">
        <SectionCard :title="selected ?? 'Service detail'" flush>
          <q-card-section v-if="!selected" class="text-body2 text-grey-7">
            Select a segment in the chart, or a row in the list, to see what makes up that
            service's cost.
          </q-card-section>

          <!-- "Other" is an aggregate with no Cost Explorer identity of its own,
               so it lists the services folded into it. Each one is selectable,
               so the tail is still one click from a usage-type breakdown. -->
          <q-card-section v-else-if="isOtherSelected">
            <div class="text-h6">
              {{ money(otherComponents.reduce((sum, c) => sum + c.amount, 0), summary.data.value?.currency) }}
              <span class="text-caption text-grey-7">
                across {{ otherComponents.length }} services
              </span>
            </div>
            <q-list dense separator class="q-mt-sm">
              <q-item
                v-for="component in otherComponents"
                :key="component.service"
                v-ripple
                clickable
                @click="onSelect(component.service)"
              >
                <q-item-section>{{ component.service }}</q-item-section>
                <q-item-section side class="text-grey-8">
                  {{ Math.round(component.share * 100) }}%
                </q-item-section>
                <q-item-section side class="mono text-grey-9">
                  {{ money(component.amount, summary.data.value?.currency) }}
                </q-item-section>
              </q-item>
            </q-list>
          </q-card-section>

          <q-card-section v-else-if="detail">
            <AsyncValue :state="detail?.state.value ?? 'loading'" :error="detail?.error.value">
              <div class="text-h6">
                {{ money(detail?.data.value?.total ?? 0, detail?.data.value?.currency) }}
                <span class="text-caption text-grey-7">over {{ periodLabel.toLowerCase() }}</span>
              </div>

              <q-list dense separator class="q-mt-sm">
                <q-item v-for="entry in detail?.data.value?.usage_types ?? []" :key="entry.usage_type">
                  <q-item-section class="text-body2">{{ entry.usage_type }}</q-item-section>
                  <q-item-section side class="text-grey-8">
                    {{ Math.round(entry.share * 100) }}%
                  </q-item-section>
                  <q-item-section side class="mono text-grey-9">
                    {{ money(entry.amount, detail?.data.value?.currency) }}
                  </q-item-section>
                </q-item>
              </q-list>

              <div
                v-if="(detail?.data.value?.usage_types.length ?? 0) === 0"
                class="text-body2 text-grey-7"
              >
                No usage-type breakdown available for this service in this period.
              </div>
            </AsyncValue>
          </q-card-section>
        </SectionCard>
      </div>
    </div>

    <div v-if="summary.state.value === 'ready'" class="text-caption text-grey-6 q-mt-md text-center">
      Fetched {{ new Date(summary.data.value!.fetched_at).toLocaleString() }}
      <template v-if="summary.data.value?.cached"> · served from cache</template>
    </div>

    <!-- Period picker -->
    <q-dialog v-model="searchOpen">
      <q-card style="min-width: min(340px, 92vw)">
        <q-card-section>
          <div class="text-h6">Select a period</div>
          <div class="text-caption text-grey-7">
            Leave blank for the current month to date.
          </div>
        </q-card-section>
        <q-card-section class="q-pt-none flex flex-center">
          <q-date v-model="draftRange" range minimal mask="YYYY-MM-DD" />
        </q-card-section>
        <q-card-actions align="right" class="q-pa-md q-pt-none">
          <q-btn flat label="Current month" color="grey-8" @click="clearRange" />
          <q-btn flat label="Cancel" color="grey-8" @click="searchOpen = false" />
          <q-btn unelevated color="primary" label="Apply" @click="applyRange" />
        </q-card-actions>
      </q-card>
    </q-dialog>
  </q-page>
</template>

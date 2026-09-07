<script setup lang="ts">
import { computed, ref, shallowRef, watch } from 'vue';
import { api, type MapDetail, type MapListEntry } from '@/api/client';
import { useAsyncValue } from '@/composables/useAsyncValue';
import PageHeader from '@/components/PageHeader.vue';
import AsyncValue from '@/components/AsyncValue.vue';
import IntersectionDiagram from '@/components/IntersectionDiagram.vue';
import SectionCard from '@/components/SectionCard.vue';

const list = useAsyncValue<{ maps: MapListEntry[]; fetched_at: string }>(
  (signal) => api.mapsList(signal),
  { timeoutMs: 20000 }
);

const selectedName = ref<string | null>(null);
const detail = shallowRef<MapDetail | null>(null);
const loadingDetail = ref(false);
const detailError = ref<string | null>(null);
const selectedLaneId = ref<number | null>(null);

watch(
  () => list.data.value,
  (data) => {
    // Indexing yields `T | undefined` under noUncheckedIndexedAccess, and the
    // length check does not narrow it, so the first entry is read explicitly.
    const first = data?.maps[0];
    if (first && !selectedName.value) void open(first.name);
  },
  { immediate: true }
);

async function open(name: string) {
  selectedName.value = name;
  selectedLaneId.value = null;
  loadingDetail.value = true;
  detailError.value = null;
  try {
    detail.value = await api.mapDetail(name);
  } catch (error) {
    detailError.value = error instanceof Error ? error.message : 'Could not load that map.';
    detail.value = null;
  } finally {
    loadingDetail.value = false;
  }
}

const severityColor: Record<string, string> = {
  critical: 'negative',
  warning: 'warning',
  info: 'info',
};

/** Lane counts by arm, so an approach missing lanes is obvious. */
const byArm = computed(() => {
  const lanes = detail.value?.lanes ?? [];
  const arms = new Map<string, number>();
  for (const lane of lanes) {
    const key = lane.arm_id === null ? 'none' : String(lane.arm_id);
    arms.set(key, (arms.get(key) ?? 0) + 1);
  }
  return [...arms.entries()].sort(([a], [b]) => a.localeCompare(b));
});

const osmLink = computed(() =>
  detail.value
    ? `https://www.openstreetmap.org/?mlat=${detail.value.intersection.ref_lat}&mlon=${detail.value.intersection.ref_lon}#map=18/${detail.value.intersection.ref_lat}/${detail.value.intersection.ref_lon}`
    : '#'
);
</script>

<template>
  <q-page padding>
    <PageHeader
      title="Intersection maps"
      subtitle="Decoded J2735 MAP geometry from Aurora, drawn in a local frame centred on the intersection reference point."
    >
      <template #actions>
        <q-btn
          outline
          color="primary"
          icon="refresh"
          label="Refresh"
          :loading="list.state.value === 'loading'"
          @click="list.reload()"
          />
      </template>
    </PageHeader>

    <div class="row q-col-gutter-md">
      <!-- Map list -->
      <div class="col-12 col-md-4">
        <SectionCard title="Maps" flush>
          <AsyncValue :state="list.state.value" :error="list.error.value">
            <q-card-section
              v-if="!list.data.value?.maps.length"
              class="text-body2 text-grey-7"
            >
              No maps are loaded. They are inserted by
              <code>tools/insert-map.js</code>.
            </q-card-section>

            <q-list v-else separator>
              <q-item
                v-for="entry in list.data.value.maps"
                :key="entry.name"
                v-ripple
                clickable
                :active="selectedName === entry.name"
                active-class="bg-blue-grey-1"
                @click="open(entry.name)"
              >
                <q-item-section>
                  <q-item-label>{{ entry.intersection_name || entry.name }}</q-item-label>
                  <q-item-label caption class="mono">{{ entry.name }}</q-item-label>
                </q-item-section>
                <q-item-section side>
                  <q-badge outline color="primary" :label="`${entry.lane_count} lanes`" />
                </q-item-section>
              </q-item>
            </q-list>
          </AsyncValue>
        </SectionCard>
      </div>

      <!-- Detail -->
      <div class="col-12 col-md-8">
        <q-card flat bordered>
          <q-inner-loading :showing="loadingDetail">
            <q-spinner size="32px" color="primary" />
          </q-inner-loading>

          <q-banner v-if="detailError" rounded dense class="bg-red-1 text-negative q-ma-md">
            <template #avatar><q-icon name="error" color="negative" /></template>
            {{ detailError }}
          </q-banner>

          <template v-if="detail">
            <q-card-section class="row items-center justify-between q-pb-none">
              <div class="text-subtitle1 text-weight-medium">{{ detail.name }}</div>
              <a
                :href="osmLink"
                target="_blank"
                rel="noopener noreferrer"
                class="text-caption text-primary"
              >
                Open location in OpenStreetMap ↗
              </a>
            </q-card-section>

            <!-- Findings first: a bad map is the reason to be on this page. -->
            <q-card-section v-if="detail.findings.length" class="q-pb-none">
              <q-list dense>
                <q-item v-for="finding in detail.findings" :key="finding.title" class="q-px-none">
                  <q-item-section avatar style="min-width: 82px">
                    <q-chip
                      dense
                      square
                      :color="severityColor[finding.severity] ?? 'grey-7'"
                      text-color="white"
                      class="text-capitalize"
                    >
                      {{ finding.severity }}
                    </q-chip>
                  </q-item-section>
                  <q-item-section>
                    <q-item-label class="text-weight-medium">{{ finding.title }}</q-item-label>
                    <q-item-label caption>{{ finding.detail }}</q-item-label>
                  </q-item-section>
                </q-item>
              </q-list>
            </q-card-section>
            <q-card-section v-else class="q-pb-none">
              <div class="row items-center text-body2 text-positive">
                <q-icon name="check_circle" size="16px" class="q-mr-xs" />
                No consistency problems found in this map.
              </div>
            </q-card-section>

            <q-card-section>
              <IntersectionDiagram
                :lanes="detail.lanes"
                :lane-width-m="detail.intersection.lane_width_m"
                :selected-lane-id="selectedLaneId"
                @select="selectedLaneId = $event"
              />
            </q-card-section>

            <q-separator />

            <q-card-section>
              <q-list dense>
                <q-item class="q-px-none">
                  <q-item-section>
                    <q-item-label caption>Intersection</q-item-label>
                    <q-item-label>
                      id {{ detail.intersection.intersection_id }} · region
                      {{ detail.intersection.region }} · revision
                      {{ detail.intersection.revision }}
                    </q-item-label>
                  </q-item-section>
                </q-item>
                <q-item class="q-px-none">
                  <q-item-section>
                    <q-item-label caption>Reference point</q-item-label>
                    <q-item-label class="mono">
                      {{ detail.intersection.ref_lat.toFixed(7) }},
                      {{ detail.intersection.ref_lon.toFixed(7) }}
                      <template v-if="detail.intersection.elevation !== null">
                        · {{ detail.intersection.elevation }} m
                      </template>
                    </q-item-label>
                  </q-item-section>
                  <q-item-section>
                    <q-item-label caption>center column</q-item-label>
                    <q-item-label class="mono">
                      {{ detail.center_lat.toFixed(7) }}, {{ detail.center_lon.toFixed(7) }}
                    </q-item-label>
                  </q-item-section>
                </q-item>
                <q-item class="q-px-none">
                  <q-item-section>
                    <q-item-label caption>Lane width</q-item-label>
                    <q-item-label>{{ detail.intersection.lane_width_m ?? '—' }} m</q-item-label>
                  </q-item-section>
                  <q-item-section>
                    <q-item-label caption>Speed limit</q-item-label>
                    <q-item-label>
                      <template v-if="detail.intersection.speed_limit_mps !== null">
                        {{ detail.intersection.speed_limit_mps }} m/s ·
                        {{ Math.round(detail.intersection.speed_limit_mps * 2.23694) }} mph
                      </template>
                      <template v-else>—</template>
                    </q-item-label>
                  </q-item-section>
                </q-item>
                <q-item class="q-px-none">
                  <q-item-section>
                    <q-item-label caption>Lanes by arm</q-item-label>
                    <q-item-label class="q-gutter-xs">
                      <q-badge
                        v-for="[arm, count] in byArm"
                        :key="arm"
                        outline
                        color="primary"
                        :label="`${arm === 'none' ? 'no arm' : `arm ${arm}`}: ${count}`"
                      />
                    </q-item-label>
                  </q-item-section>
                  <q-item-section side>
                    <q-item-label caption>Last updated</q-item-label>
                    <q-item-label>{{ new Date(detail.updated_at).toLocaleString() }}</q-item-label>
                  </q-item-section>
                </q-item>
              </q-list>

              <div class="text-caption text-grey-7 q-mt-md">
                Read-only. MAP geometry is loaded by <code>tools/insert-map.js</code> — editing
                decoded J2735 lane data through a form is how a map ends up malformed, and a
                malformed map breaks SPaT broadcasts without raising anything.
              </div>
            </q-card-section>
          </template>
        </q-card>
      </div>
    </div>
  </q-page>
</template>

<style scoped>
code {
  background: rgba(0, 0, 0, 0.05);
  padding: 1px 5px;
  border-radius: 4px;
  font-size: 0.92em;
}
</style>

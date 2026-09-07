<script setup lang="ts">
import { computed, ref, shallowRef, watch } from 'vue';
import { api, type MapDetail, type MapListEntry } from '@/api/client';
import { useAsyncValue } from '@/composables/useAsyncValue';
import AsyncValue from '@/components/AsyncValue.vue';
import IntersectionDiagram from '@/components/IntersectionDiagram.vue';

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
    if (data && !selectedName.value && data.maps.length > 0) {
      void open(data.maps[0].name);
    }
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

const severityType: Record<string, string> = {
  critical: 'danger',
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
  <div>
    <div class="header">
      <div>
        <h1 class="page-title">Intersection maps</h1>
        <p class="page-subtitle">
          Decoded J2735 MAP geometry from Aurora, drawn in a local frame centred on the
          intersection reference point.
        </p>
      </div>
      <el-button :icon="'Refresh'" :loading="list.state.value === 'loading'" @click="list.reload()">
        Refresh
      </el-button>
    </div>

    <div class="layout">
      <aside class="card">
        <h2 class="card__title">Maps</h2>
        <AsyncValue :state="list.state.value" :error="list.error.value">
          <div v-if="!list.data.value?.maps.length" class="empty">
            No maps stored. Load one with <code>tools/insert-map.js</code>.
          </div>
          <ul v-else class="maplist">
            <li
              v-for="entry in list.data.value.maps"
              :key="entry.name"
              class="maprow"
              :class="{ 'maprow--active': selectedName === entry.name }"
              @click="open(entry.name)"
            >
              <div class="maprow__name">{{ entry.name }}</div>
              <div class="maprow__meta">
                {{ entry.lane_count }} lanes ·
                {{ entry.center_lat.toFixed(4) }}, {{ entry.center_lon.toFixed(4) }}
              </div>
              <el-tag
                v-if="entry.intersection_name && entry.intersection_name !== entry.name"
                type="danger"
                size="small"
                effect="plain"
              >
                name mismatch
              </el-tag>
            </li>
          </ul>
        </AsyncValue>
      </aside>

      <section class="card">
        <el-alert
          v-if="detailError"
          type="error"
          show-icon
          :closable="false"
          class="alert"
          :title="detailError"
        />

        <div v-loading="loadingDetail">
          <template v-if="detail">
            <div class="titlerow">
              <h2 class="card__title nomargin">{{ detail.name }}</h2>
              <a :href="osmLink" target="_blank" rel="noopener noreferrer" class="osm">
                Open location in OpenStreetMap ↗
              </a>
            </div>

            <!-- Findings first: a bad map is the reason to be on this page. -->
            <div v-if="detail.findings.length" class="findings">
              <div
                v-for="finding in detail.findings"
                :key="finding.title"
                class="finding"
              >
                <el-tag :type="severityType[finding.severity]" size="small" effect="light">
                  {{ finding.severity }}
                </el-tag>
                <div>
                  <div class="finding__title">{{ finding.title }}</div>
                  <div class="finding__detail">{{ finding.detail }}</div>
                </div>
              </div>
            </div>
            <div v-else class="allclear">No consistency problems found in this map.</div>

            <IntersectionDiagram
              :lanes="detail.lanes"
              :lane-width-m="detail.intersection.lane_width_m"
              :selected-lane-id="selectedLaneId"
              @select="selectedLaneId = $event"
            />

            <div class="facts">
              <div class="kv">
                <div class="kv__key">Intersection</div>
                <div class="kv__value">
                  id {{ detail.intersection.intersection_id }} · region
                  {{ detail.intersection.region }} · revision {{ detail.intersection.revision }}
                </div>
                <div class="kv__key">Reference point</div>
                <div class="kv__value mono">
                  {{ detail.intersection.ref_lat.toFixed(7) }},
                  {{ detail.intersection.ref_lon.toFixed(7) }}
                  <template v-if="detail.intersection.elevation !== null">
                    · {{ detail.intersection.elevation }} m
                  </template>
                </div>
                <div class="kv__key">center column</div>
                <div class="kv__value mono">
                  {{ detail.center_lat.toFixed(7) }}, {{ detail.center_lon.toFixed(7) }}
                </div>
                <div class="kv__key">Lane width</div>
                <div class="kv__value">{{ detail.intersection.lane_width_m ?? '—' }} m</div>
                <div class="kv__key">Speed limit</div>
                <div class="kv__value">
                  <template v-if="detail.intersection.speed_limit_mps !== null">
                    {{ detail.intersection.speed_limit_mps }} m/s ·
                    {{ Math.round(detail.intersection.speed_limit_mps * 2.23694) }} mph
                  </template>
                  <template v-else>—</template>
                </div>
                <div class="kv__key">Lanes by arm</div>
                <div class="kv__value">
                  <span v-for="[arm, count] in byArm" :key="arm" class="armchip">
                    {{ arm === 'none' ? 'no arm' : `arm ${arm}` }}: {{ count }}
                  </span>
                </div>
                <div class="kv__key">Last updated</div>
                <div class="kv__value">{{ new Date(detail.updated_at).toLocaleString() }}</div>
              </div>
            </div>

            <p class="note">
              Read-only. MAP geometry is loaded by <code>tools/insert-map.js</code> — editing
              decoded J2735 lane data through a form is how a map ends up malformed, and a
              malformed map breaks SPaT broadcasts without raising anything.
            </p>
          </template>
        </div>
      </section>
    </div>
  </div>
</template>

<style scoped>
.header {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 16px;
}

.layout {
  display: grid;
  grid-template-columns: 230px minmax(0, 1fr);
  gap: 16px;
  align-items: start;
}

@media (max-width: 1000px) {
  .layout {
    grid-template-columns: 1fr;
  }
}

.maplist {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 4px;
  max-height: 440px;
  overflow-y: auto;
}

.maprow {
  padding: 10px;
  border-radius: 8px;
  cursor: pointer;
  transition: background 0.12s ease;
}

.maprow:hover,
.maprow--active {
  background: var(--page-bg);
}

.maprow__name {
  font-size: 13px;
  font-weight: 600;
}

.maprow__meta {
  font-size: 10.5px;
  color: var(--text-muted);
  margin-top: 3px;
}

.titlerow {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 12px;
  margin-bottom: 14px;
}

.nomargin {
  margin: 0;
}

.osm {
  font-size: 11.5px;
  color: var(--accent);
  text-decoration: none;
}

.osm:hover {
  text-decoration: underline;
}

.findings {
  margin-bottom: 18px;
}

.finding {
  display: flex;
  gap: 10px;
  align-items: flex-start;
  padding: 10px 0;
  border-top: 1px solid var(--border);
}

.finding:first-child {
  border-top: none;
  padding-top: 0;
}

.finding__title {
  font-size: 12.5px;
  font-weight: 650;
  margin-bottom: 2px;
}

.finding__detail {
  font-size: 11.5px;
  color: var(--text-muted);
  line-height: 1.6;
}

.allclear {
  font-size: 12px;
  color: var(--ok);
  margin-bottom: 16px;
}

.facts {
  margin-top: 20px;
  border-top: 1px solid var(--border);
  padding-top: 16px;
}

.armchip {
  display: inline-block;
  font-size: 11px;
  background: var(--page-bg);
  border: 1px solid var(--border);
  border-radius: 5px;
  padding: 1px 7px;
  margin: 0 5px 5px 0;
}

.note {
  margin: 18px 0 0;
  font-size: 11.5px;
  color: var(--text-muted);
  line-height: 1.6;
}

.note code,
.empty code {
  background: var(--page-bg);
  padding: 1px 5px;
  border-radius: 4px;
}

.alert {
  margin-bottom: 14px;
}
</style>

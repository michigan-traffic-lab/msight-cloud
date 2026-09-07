<script setup lang="ts">
import { computed, ref } from 'vue';
import type { MapLane } from '@/api/client';

const props = defineProps<{
  lanes: MapLane[];
  laneWidthM: number | null;
  selectedLaneId: number | null;
}>();

const emit = defineEmits<{ (event: 'select', laneId: number | null): void }>();

/**
 * Categorical slots 1-3 from the validated palette. Three classes is also the
 * limit that clears the all-pairs colour-blindness gates, which matters here
 * because lanes are compared across the whole diagram, not just to a neighbour.
 */
const DIRECTION_COLOR: Record<string, string> = {
  ingress: '#2a78d6',
  egress: '#eb6834',
  both: '#1baf7a',
  unknown: '#8b8b86',
};

const DIRECTION_LABEL: Record<string, string> = {
  ingress: 'Ingress',
  egress: 'Egress',
  both: 'Both ways',
  unknown: 'Unspecified',
};

const SIZE = 560;
const PADDING = 34;

const hovered = ref<number | null>(null);

/** Square extent centred on refPoint, so north stays up and scale stays true. */
const extent = computed(() => {
  let max = 30;
  for (const lane of props.lanes) {
    for (const point of lane.points) {
      max = Math.max(max, Math.abs(point.x), Math.abs(point.y));
    }
  }
  return max * 1.08;
});

const scale = computed(() => (SIZE / 2 - PADDING) / extent.value);

/** Local metres to SVG pixels. SVG y grows downward; north is up. */
function project(x: number, y: number) {
  return { px: SIZE / 2 + x * scale.value, py: SIZE / 2 - y * scale.value };
}

const rendered = computed(() =>
  props.lanes
    .filter((lane) => lane.points.length > 0)
    .flatMap((lane) => {
      // Lanes start at refPoint; deltas are cumulative from there.
      const path = [{ x: 0, y: 0 }, ...lane.points]
        .map((point) => {
          const { px, py } = project(point.x, point.y);
          return `${px.toFixed(1)},${py.toFixed(1)}`;
        })
        .join(' ');

      // The filter above already guarantees at least one point, but TypeScript
      // cannot carry that through, and indexing yields `T | undefined` under
      // noUncheckedIndexedAccess. Narrowed explicitly rather than asserted, so
      // the guarantee stays checked if that filter is ever changed.
      const last = lane.points.at(-1);
      if (last === undefined) return [];
      const previous = lane.points.at(-2) ?? { x: 0, y: 0 };
      const end = project(last.x, last.y);
      const angle = (Math.atan2(-(last.y - previous.y), last.x - previous.x) * 180) / Math.PI;

      return [
        {
          lane,
          path,
          end,
          angle,
          color: DIRECTION_COLOR[lane.direction] ?? DIRECTION_COLOR.unknown,
          isCrosswalk: lane.kind === 'crosswalk',
        },
      ];
    })
);

/** Ring at a round number of metres, for reading distance off the diagram. */
const scaleRing = computed(() => {
  const candidates = [25, 50, 100, 200, 400, 800];
  const target = extent.value / 2;
  const metres = candidates.reduce((best, value) =>
    Math.abs(value - target) < Math.abs(best - target) ? value : best
  );
  return { metres, radius: metres * scale.value };
});

const legend = computed(() => {
  const present = new Set(props.lanes.map((lane) => lane.direction));
  return [...present].map((direction) => ({
    direction,
    label: DIRECTION_LABEL[direction] ?? direction,
    color: DIRECTION_COLOR[direction] ?? DIRECTION_COLOR.unknown,
    count: props.lanes.filter((lane) => lane.direction === direction).length,
  }));
});

function strokeWidth(laneId: number): number {
  const active = hovered.value ?? props.selectedLaneId;
  if (active === laneId) return 5;
  // Roughly proportional to real lane width, floored so it stays visible.
  const metres = props.laneWidthM ?? 3;
  return Math.max(2.5, metres * scale.value * 0.55);
}

function opacity(laneId: number): number {
  const active = hovered.value ?? props.selectedLaneId;
  if (active === null) return 0.92;
  return active === laneId ? 1 : 0.22;
}

const focused = computed(() => {
  const id = hovered.value ?? props.selectedLaneId;
  return id === null ? null : (props.lanes.find((lane) => lane.lane_id === id) ?? null);
});
</script>

<template>
  <div class="diagram">
    <svg :viewBox="`0 0 ${SIZE} ${SIZE}`" class="svg" role="img" aria-label="Intersection lane geometry">
      <!-- Scale ring and axes, so distances are readable without a basemap. -->
      <circle
        :cx="SIZE / 2"
        :cy="SIZE / 2"
        :r="scaleRing.radius"
        class="ring"
      />
      <text :x="SIZE / 2 + scaleRing.radius + 4" :y="SIZE / 2 - 4" class="ringlabel">
        {{ scaleRing.metres }} m
      </text>
      <line :x1="PADDING" :y1="SIZE / 2" :x2="SIZE - PADDING" :y2="SIZE / 2" class="axis" />
      <line :x1="SIZE / 2" :y1="PADDING" :x2="SIZE / 2" :y2="SIZE - PADDING" class="axis" />
      <text :x="SIZE / 2" :y="PADDING - 12" class="compass" text-anchor="middle">N</text>

      <g v-for="item in rendered" :key="item.lane.lane_id">
        <polyline
          :points="item.path"
          :stroke="item.color"
          :stroke-width="strokeWidth(item.lane.lane_id)"
          :stroke-dasharray="item.isCrosswalk ? '6 4' : undefined"
          :opacity="opacity(item.lane.lane_id)"
          class="lane"
          tabindex="0"
          role="button"
          :aria-label="`Lane ${item.lane.lane_id}, ${item.lane.kind}, ${item.lane.direction}, ${item.lane.length_m} metres`"
          @mouseenter="hovered = item.lane.lane_id"
          @mouseleave="hovered = null"
          @focus="hovered = item.lane.lane_id"
          @blur="hovered = null"
          @click="emit('select', props.selectedLaneId === item.lane.lane_id ? null : item.lane.lane_id)"
          @keydown.enter.prevent="emit('select', item.lane.lane_id)"
        />
        <!-- Direction of travel at the far end. -->
        <polygon
          v-if="!item.isCrosswalk"
          points="0,-4 9,0 0,4"
          :fill="item.color"
          :opacity="opacity(item.lane.lane_id)"
          :transform="`translate(${item.end.px},${item.end.py}) rotate(${item.angle})`"
        />
      </g>

      <circle :cx="SIZE / 2" :cy="SIZE / 2" r="5" class="refpoint" />
    </svg>

    <div class="side">
      <div class="legend">
        <div v-for="item in legend" :key="item.direction" class="legend__row">
          <span class="legend__swatch" :style="{ background: item.color }" />
          <span>{{ item.label }}</span>
          <span class="legend__count">{{ item.count }}</span>
        </div>
        <div class="legend__note">Dashed = crosswalk · centre dot = refPoint</div>
      </div>

      <div v-if="focused" class="focus">
        <div class="focus__title">Lane {{ focused.lane_id }}</div>
        <div class="kv">
          <div class="kv__key">Type</div>
          <div class="kv__value">{{ focused.kind }}</div>
          <div class="kv__key">Direction</div>
          <div class="kv__value">{{ DIRECTION_LABEL[focused.direction] }}</div>
          <div class="kv__key">Arm</div>
          <div class="kv__value">{{ focused.arm_id ?? '—' }}</div>
          <div class="kv__key">Approach</div>
          <div class="kv__value">
            in {{ focused.ingress_approach ?? '—' }} · out {{ focused.egress_approach ?? '—' }}
          </div>
          <div class="kv__key">Length</div>
          <div class="kv__value">{{ focused.length_m }} m over {{ focused.node_count }} nodes</div>
          <div class="kv__key">Maneuver bits</div>
          <div class="kv__value mono">
            {{ focused.maneuvers.length ? focused.maneuvers.join(', ') : '—' }}
          </div>
        </div>
      </div>
      <div v-else class="focus focus--empty">
        Hover or click a lane for its attributes.
      </div>
    </div>
  </div>
</template>

<style scoped>
.diagram {
  display: flex;
  gap: 20px;
  flex-wrap: wrap;
  align-items: flex-start;
}

.svg {
  width: 560px;
  max-width: 100%;
  height: auto;
  background: var(--page-bg);
  border: 1px solid var(--border);
  border-radius: 10px;
}

.ring {
  fill: none;
  stroke: var(--border);
  stroke-dasharray: 3 5;
}

.ringlabel,
.compass {
  font-size: 10px;
  fill: var(--text-muted);
}

.axis {
  stroke: var(--border);
  stroke-width: 1;
}

.lane {
  fill: none;
  stroke-linecap: round;
  stroke-linejoin: round;
  cursor: pointer;
  transition: opacity 0.12s ease, stroke-width 0.12s ease;
  outline: none;
}

.lane:focus-visible {
  stroke-dasharray: 2 3;
}

.refpoint {
  fill: var(--text);
  stroke: var(--card-bg);
  stroke-width: 2;
}

.side {
  flex: 1;
  min-width: 220px;
  display: flex;
  flex-direction: column;
  gap: 14px;
}

.legend {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.legend__row {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 12px;
}

.legend__swatch {
  width: 12px;
  height: 3px;
  border-radius: 2px;
}

.legend__count {
  margin-left: auto;
  color: var(--text-muted);
}

.legend__note {
  font-size: 10.5px;
  color: var(--text-muted);
  margin-top: 4px;
}

.focus {
  border-top: 1px solid var(--border);
  padding-top: 12px;
}

.focus--empty {
  font-size: 12px;
  color: var(--text-muted);
}

.focus__title {
  font-size: 13px;
  font-weight: 650;
  margin-bottom: 10px;
}

@media (prefers-reduced-motion: reduce) {
  .lane {
    transition: none;
  }
}
</style>

<script setup lang="ts">
import { computed, ref } from 'vue';

export interface DonutSlice {
  label: string;
  amount: number;
  share: number;
  color: string;
}

const props = defineProps<{
  slices: DonutSlice[];
  total: number;
  currency: string;
  /** Label of the currently selected slice, if any. */
  selected: string | null;
  /** Caption under the centre figure. */
  caption: string;
}>();

const emit = defineEmits<{
  (event: 'select', label: string | null): void;
}>();

const hovered = ref<string | null>(null);

const SIZE = 240;
const CENTRE = SIZE / 2;
const OUTER = 104;
const INNER = 68;
/** Degrees of surface showing between segments — the 2px spacer rule. */
const GAP_DEG = 1.4;

function polar(radius: number, degrees: number) {
  const radians = ((degrees - 90) * Math.PI) / 180;
  return {
    x: CENTRE + radius * Math.cos(radians),
    y: CENTRE + radius * Math.sin(radians),
  };
}

/** Annular sector path for one segment. */
function arcPath(startDeg: number, endDeg: number, outer: number, inner: number): string {
  const sweep = endDeg - startDeg;
  const largeArc = sweep > 180 ? 1 : 0;
  const o1 = polar(outer, startDeg);
  const o2 = polar(outer, endDeg);
  const i1 = polar(inner, endDeg);
  const i2 = polar(inner, startDeg);

  return [
    `M ${o1.x} ${o1.y}`,
    `A ${outer} ${outer} 0 ${largeArc} 1 ${o2.x} ${o2.y}`,
    `L ${i1.x} ${i1.y}`,
    `A ${inner} ${inner} 0 ${largeArc} 0 ${i2.x} ${i2.y}`,
    'Z',
  ].join(' ');
}

const segments = computed(() => {
  const total = props.slices.reduce((sum, slice) => sum + slice.amount, 0);
  if (total <= 0) {
    return [];
  }

  let cursor = 0;
  return props.slices.map((slice) => {
    const sweep = (slice.amount / total) * 360;
    const start = cursor;
    cursor += sweep;

    // Never let the gap consume a thin slice entirely — a sliver still has to
    // be visible and clickable.
    const gap = Math.min(GAP_DEG, sweep / 3);
    return {
      ...slice,
      path: arcPath(start + gap / 2, start + sweep - gap / 2, OUTER, INNER),
    };
  });
});

/** Hover wins over selection for the centre readout, so the chart tracks the pointer. */
const focused = computed(() => {
  const label = hovered.value ?? props.selected;
  return label ? (props.slices.find((slice) => slice.label === label) ?? null) : null;
});

function money(value: number): string {
  return new Intl.NumberFormat(undefined, {
    style: 'currency',
    currency: props.currency,
    maximumFractionDigits: value < 100 ? 2 : 0,
  }).format(value);
}

function opacityFor(label: string): number {
  const active = hovered.value ?? props.selected;
  if (!active) return 1;
  return active === label ? 1 : 0.32;
}

function toggle(label: string) {
  emit('select', props.selected === label ? null : label);
}
</script>

<template>
  <div class="donut">
    <svg
      :viewBox="`0 0 ${SIZE} ${SIZE}`"
      class="donut__svg"
      role="img"
      :aria-label="`Cost breakdown by service, total ${money(total)}`"
    >
      <g v-for="segment in segments" :key="segment.label">
        <path
          :d="segment.path"
          :fill="segment.color"
          :opacity="opacityFor(segment.label)"
          class="donut__segment"
          :class="{ 'donut__segment--selected': selected === segment.label }"
          tabindex="0"
          role="button"
          :aria-label="`${segment.label}, ${money(segment.amount)}, ${Math.round(segment.share * 100)} percent`"
          @mouseenter="hovered = segment.label"
          @mouseleave="hovered = null"
          @focus="hovered = segment.label"
          @blur="hovered = null"
          @click="toggle(segment.label)"
          @keydown.enter.prevent="toggle(segment.label)"
          @keydown.space.prevent="toggle(segment.label)"
        />
      </g>

      <!-- Centre readout: the total, or the focused slice while pointing at one. -->
      <text :x="CENTRE" :y="CENTRE - 6" class="donut__value" text-anchor="middle">
        {{ money(focused ? focused.amount : total) }}
      </text>
      <text :x="CENTRE" :y="CENTRE + 14" class="donut__caption" text-anchor="middle">
        {{ focused ? focused.label : caption }}
      </text>
      <text
        v-if="focused"
        :x="CENTRE"
        :y="CENTRE + 32"
        class="donut__share"
        text-anchor="middle"
      >
        {{ Math.round(focused.share * 100) }}% of total
      </text>
    </svg>
  </div>
</template>

<style scoped>
.donut {
  display: flex;
  justify-content: center;
  align-items: center;
}

.donut__svg {
  width: 240px;
  height: 240px;
  overflow: visible;
}

.donut__segment {
  cursor: pointer;
  transition: opacity 0.15s ease;
  outline: none;
}

.donut__segment:focus-visible {
  stroke: var(--text);
  stroke-width: 2;
}

.donut__segment--selected {
  stroke: var(--card-bg);
  stroke-width: 2;
}

.donut__value {
  font-size: 22px;
  font-weight: 650;
  fill: var(--text);
  letter-spacing: -0.02em;
}

.donut__caption {
  font-size: 11px;
  fill: var(--text-muted);
}

.donut__share {
  font-size: 11px;
  fill: var(--text-muted);
}

@media (prefers-reduced-motion: reduce) {
  .donut__segment {
    transition: none;
  }
}
</style>

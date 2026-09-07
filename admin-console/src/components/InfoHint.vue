<script setup lang="ts">
/**
 * A small "what is this?" marker.
 *
 * The console shows numbers whose meaning is not self-evident — "out of sync"
 * and "messages waiting" both describe infrastructure state a reader cannot
 * infer from the label. Putting the explanation behind a hover keeps the
 * dashboard scannable while still making it answerable without leaving the page.
 */
withDefaults(
  defineProps<{
    /** Plain text, rendered as text — kept short enough to read in one pass. */
    text: string;
    anchor?: 'top middle' | 'bottom middle' | 'center right' | 'center left';
  }>(),
  { anchor: 'top middle' }
);
</script>

<template>
  <!-- tabindex so the hint is reachable without a pointer; QTooltip shows on
       focus as well as hover. -->
  <span class="hint-icon text-grey-6" tabindex="0" role="note" :aria-label="text">
    <q-icon name="info" size="13px" />
    <q-tooltip class="hint-tooltip" :anchor="anchor" self="center middle" :delay="120">
      {{ text }}
    </q-tooltip>
  </span>
</template>

<style scoped>
.hint-icon {
  display: inline-flex;
  align-items: center;
  margin-left: 5px;
  opacity: 0.6;
  cursor: help;
  vertical-align: middle;
  outline: none;
  transition: opacity 0.12s ease;
}

.hint-icon:hover,
.hint-icon:focus-visible {
  opacity: 1;
}
</style>

<script setup lang="ts">
import type { AsyncState } from '@/composables/useAsyncValue';

/**
 * Renders exactly one of: a spinner, a failure marker, or the value.
 *
 * Keeping this in one component means every independently-loading value on a
 * page fails the same way, and no caller has to remember the timeout case.
 */
defineProps<{
  state: AsyncState;
  error?: string | null;
  /** Compact variant for inline use inside a table cell. */
  inline?: boolean;
}>();
</script>

<template>
  <span
    v-if="state === 'loading'"
    class="row inline items-center no-wrap text-grey-7"
    :class="inline ? 'text-caption' : 'text-body2'"
  >
    <!-- QSpinner animates itself and honours reduced motion, so the hand-rolled
         keyframes the previous console carried are gone. -->
    <q-spinner size="15px" />
    <span v-if="!inline" class="q-ml-sm">Loading</span>
  </span>

  <span
    v-else-if="state === 'timeout' || state === 'error'"
    class="row inline items-center no-wrap text-negative cursor-help"
    :class="inline ? 'text-caption' : 'text-body2'"
  >
    <q-icon name="warning" size="15px" />
    <span class="q-ml-xs">{{ state === 'timeout' ? 'Timed out' : 'Unavailable' }}</span>
    <q-tooltip class="hint-tooltip" :delay="120">
      {{ error ?? 'Request failed.' }}
    </q-tooltip>
  </span>

  <slot v-else />
</template>

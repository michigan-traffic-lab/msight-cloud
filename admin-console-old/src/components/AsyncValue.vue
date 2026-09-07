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
  <span v-if="state === 'loading'" class="async async--loading" :class="{ 'async--inline': inline }">
    <el-icon class="async__spinner"><Loading /></el-icon>
    <span v-if="!inline" class="async__text">Loading</span>
  </span>

  <el-tooltip
    v-else-if="state === 'timeout' || state === 'error'"
    :content="error ?? 'Request failed.'"
    placement="top"
  >
    <span class="async async--failed" :class="{ 'async--inline': inline }">
      <el-icon class="async__icon"><WarningFilled /></el-icon>
      <span class="async__text">{{ state === 'timeout' ? 'Timed out' : 'Unavailable' }}</span>
    </span>
  </el-tooltip>

  <slot v-else />
</template>

<style scoped>
.async {
  display: inline-flex;
  align-items: center;
  gap: 7px;
  font-size: 14px;
  font-weight: 500;
  line-height: 1.2;
}

.async--inline {
  font-size: 13px;
}

.async--loading {
  color: var(--text-muted);
}

.async--failed {
  color: var(--bad);
  cursor: help;
}

.async__spinner {
  animation: async-spin 0.9s linear infinite;
}

.async__icon,
.async__spinner {
  font-size: 15px;
}

@keyframes async-spin {
  to {
    transform: rotate(360deg);
  }
}

@media (prefers-reduced-motion: reduce) {
  .async__spinner {
    animation-duration: 2.4s;
  }
}
</style>

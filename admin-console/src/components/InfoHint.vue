<script setup lang="ts">
/**
 * A small "what is this?" marker.
 *
 * The console shows numbers whose meaning is not self-evident — "out of sync"
 * and "messages waiting" both describe infrastructure state a reader cannot
 * infer from the label. Putting the explanation behind a hover keeps the
 * dashboard scannable while still making it answerable without leaving the
 * page.
 */
defineProps<{
  /** Plain text, rendered as text — kept short enough to read in one pass. */
  text: string;
  placement?: 'top' | 'right' | 'bottom' | 'left';
}>();
</script>

<template>
  <el-tooltip
    :content="text"
    :placement="placement ?? 'top'"
    effect="dark"
    :show-after="120"
    popper-class="hint-popper"
  >
    <!-- tabindex so the hint is reachable without a pointer. -->
    <span class="hint-icon" tabindex="0" role="note" :aria-label="text">
      <el-icon><InfoFilled /></el-icon>
    </span>
  </el-tooltip>
</template>

<style scoped>
.hint-icon {
  display: inline-flex;
  align-items: center;
  margin-left: 5px;
  color: var(--text-muted);
  opacity: 0.55;
  cursor: help;
  vertical-align: middle;
  outline: none;
  transition: opacity 0.12s ease;
}

.hint-icon:hover,
.hint-icon:focus-visible {
  opacity: 1;
}

.hint-icon .el-icon {
  font-size: 12.5px;
}
</style>

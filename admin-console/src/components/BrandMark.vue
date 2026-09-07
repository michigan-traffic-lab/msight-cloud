<script setup lang="ts">
import { ref } from 'vue';

/**
 * The MSight mark.
 *
 * Renders `public/logo.png`. The mark is wider than it is tall, so it is sized
 * by height with the width left to follow — boxing it into a square would
 * letterbox it and make it read smaller than everything beside it.
 *
 * Falls back to a lettermark if the asset is missing, so the console degrades
 * to something deliberate rather than a broken-image icon.
 */
withDefaults(defineProps<{ size?: number }>(), { size: 36 });

const failed = ref(false);

/**
 * Bound at runtime rather than written inline. A literal src is rewritten into
 * a build-time import by the Vue plugin, which fails the whole build if the
 * file is ever absent; this keeps it a plain public-directory URL.
 */
const LOGO_URL = '/logo.png';
</script>

<template>
  <span class="mark" :style="{ height: `${size}px` }">
    <img
      v-if="!failed"
      :src="LOGO_URL"
      alt="MSight"
      class="mark__img"
      @error="failed = true"
    />
    <span
      v-else
      class="mark__fallback"
      :style="{ fontSize: `${Math.round(size * 0.5)}px`, width: `${size}px` }"
      aria-label="MSight"
      >M</span
    >
  </span>
</template>

<style scoped>
.mark {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
}

.mark__img {
  height: 100%;
  width: auto;
  display: block;
}

.mark__fallback {
  height: 100%;
  display: flex;
  align-items: center;
  justify-content: center;
  border-radius: 10px;
  background: #f7b71d; /* MSight amber, matching the mark */
  color: #1a1a19;
  font-weight: 800;
  letter-spacing: -0.02em;
}
</style>

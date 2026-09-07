<script setup lang="ts">
/**
 * Title, one-line explanation, and the page's actions.
 *
 * Every page had been repeating this block, and they had already drifted:
 * different heading sizes, different gaps, actions sometimes wrapping under the
 * title and sometimes not. One component means the pages cannot drift again,
 * and the narrow-screen behaviour is decided once.
 */
defineProps<{
  title: string;
  subtitle?: string | undefined;
}>();
</script>

<template>
  <div class="page-header">
    <div class="page-header__text">
      <h1 class="page-header__title">{{ title }}</h1>
      <!-- Slot as well as prop: a subtitle sometimes needs a <code> span or a
           link, and interpolating markup into the prop renders it as text. -->
      <p v-if="subtitle || $slots.subtitle" class="page-header__subtitle">
        <slot name="subtitle">{{ subtitle }}</slot>
      </p>
    </div>

    <!-- Actions keep their intrinsic width and wrap below the title on a narrow
         screen rather than squeezing the heading. -->
    <div v-if="$slots.actions" class="page-header__actions">
      <slot name="actions" />
    </div>
  </div>
</template>

<style scoped>
.page-header {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 16px;
  flex-wrap: wrap;
  margin-bottom: 20px;
}

.page-header__text {
  min-width: 0;
}

.page-header__title {
  font-size: 21px;
  font-weight: 650;
  letter-spacing: -0.02em;
  line-height: 1.25;
  margin: 0;
  color: #1c2434;
}

.page-header__subtitle {
  margin: 5px 0 0;
  font-size: 13px;
  line-height: 1.6;
  color: #6b7688;
  max-width: 74ch;
}

.page-header__actions {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
  flex-shrink: 0;
}

@media (max-width: 599px) {
  .page-header__title {
    font-size: 19px;
  }

  /* Full-width buttons on a phone: a row of half-width outline buttons reads as
     broken rather than compact. */
  .page-header__actions {
    width: 100%;
  }

  .page-header__actions :deep(.q-btn) {
    flex: 1 1 auto;
  }
}
</style>

<script setup lang="ts">
/**
 * A titled panel.
 *
 * Gives every card on every page the same header treatment, the same optional
 * explanatory lede, and the same place for actions — which is most of what made
 * the hand-built versions look inconsistent from one page to the next.
 *
 * `flush` exists because a card whose body is a QList or QTable should have the
 * list run edge to edge under the header, not sit inside another layer of
 * padding.
 */
defineProps<{
  title: string;
  /** A sentence under the title explaining what the panel is for. */
  lede?: string | undefined;
  /** Removes body padding, for cards whose content is a list or table. */
  flush?: boolean | undefined;
}>();
</script>

<template>
  <q-card flat bordered class="section-card">
    <div class="section-card__head">
      <div class="section-card__heading">
        <div class="section-card__title">{{ title }}</div>
        <p v-if="lede" class="section-card__lede">{{ lede }}</p>
      </div>
      <div v-if="$slots.actions" class="section-card__actions">
        <slot name="actions" />
      </div>
    </div>

    <q-separator />

    <div :class="flush ? '' : 'section-card__body'">
      <slot />
    </div>

    <template v-if="$slots.footer">
      <q-separator />
      <div class="section-card__footer">
        <slot name="footer" />
      </div>
    </template>
  </q-card>
</template>

<style scoped>
.section-card {
  border-radius: 10px;
  height: 100%;
  display: flex;
  flex-direction: column;
}

.section-card__head {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 12px;
  padding: 14px 18px;
}

.section-card__heading {
  min-width: 0;
}

.section-card__title {
  font-size: 12px;
  font-weight: 650;
  letter-spacing: 0.07em;
  text-transform: uppercase;
  color: #6b7688;
  line-height: 1.3;
}

.section-card__lede {
  margin: 6px 0 0;
  font-size: 12.5px;
  line-height: 1.6;
  color: #6b7688;
  max-width: 68ch;
  text-transform: none;
  letter-spacing: 0;
}

.section-card__actions {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-shrink: 0;
}

.section-card__body {
  padding: 16px 18px;
  flex: 1;
}

.section-card__footer {
  padding: 12px 18px;
  background: #fafbfd;
  border-bottom-left-radius: 10px;
  border-bottom-right-radius: 10px;
}

@media (max-width: 1023px) {
  .section-card__head {
    padding: 12px 14px;
  }

  .section-card__body {
    padding: 13px 14px;
  }

  .section-card__footer {
    padding: 10px 14px;
  }
}
</style>

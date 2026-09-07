<script setup lang="ts">
import InfoHint from '@/components/InfoHint.vue';

/**
 * One headline number with its label.
 *
 * The value goes in the default slot rather than a prop so callers can wrap it
 * in AsyncValue — each tile then loads and fails on its own, which is the whole
 * point of the overview pages.
 */
defineProps<{
  label: string;
  /** Explanation shown behind an info icon next to the label. */
  hint?: string | undefined;
  /** Small text under the value: units, a qualifier, a comparison. */
  caption?: string | undefined;
  /** Colour token for the value, e.g. 'negative' when a count means trouble. */
  tone?: 'default' | 'positive' | 'warning' | 'negative' | undefined;
  /** Smaller value type, for identifiers rather than counts. */
  dense?: boolean | undefined;
}>();
</script>

<template>
  <q-card flat bordered class="stat-card">
    <q-card-section class="stat-card__body">
      <div class="stat-card__label">
        <span>{{ label }}</span>
        <InfoHint v-if="hint" :text="hint" />
      </div>

      <div
        class="stat-card__value"
        :class="[
          tone && tone !== 'default' ? `text-${tone}` : '',
          dense ? 'stat-card__value--dense' : '',
        ]"
      >
        <slot />
      </div>

      <div v-if="caption" class="stat-card__caption">{{ caption }}</div>
    </q-card-section>
  </q-card>
</template>

<style scoped>
.stat-card {
  border-radius: 10px;
  height: 100%;
}

.stat-card__body {
  padding: 16px 18px;
}

.stat-card__label {
  display: flex;
  align-items: center;
  font-size: 11px;
  font-weight: 650;
  letter-spacing: 0.07em;
  text-transform: uppercase;
  color: #6b7688;
  margin-bottom: 8px;
}

.stat-card__value {
  font-size: 25px;
  font-weight: 650;
  letter-spacing: -0.025em;
  line-height: 1.15;
  color: #1c2434;
  overflow-wrap: anywhere;
}

/* Identifiers and ARNs are read, not compared, so they do not need the size a
   headline count does — and at 25px they wrap into several lines. */
.stat-card__value--dense {
  font-size: 15px;
  font-weight: 600;
  letter-spacing: 0;
}

.stat-card__caption {
  margin-top: 5px;
  font-size: 11.5px;
  color: #6b7688;
}

@media (max-width: 1023px) {
  .stat-card__body {
    padding: 13px 14px;
  }

  .stat-card__value {
    font-size: 21px;
  }
}
</style>

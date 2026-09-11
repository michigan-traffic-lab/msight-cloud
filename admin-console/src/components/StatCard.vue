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
  /**
   * Where the number leads, if it leads anywhere.
   *
   * A count on an overview is nearly always a question — "one service, which
   * one?" — and the page that answers it is one the reader would otherwise hunt
   * for in the sidebar. Given a route, the whole tile becomes the link rather
   * than a small chevron in a corner, because the number is what people aim at.
   *
   * Typed loosely because vue-router ships no types in this project; the values
   * passed are route-name objects, which the router validates at navigation.
   */
  to?: string | Record<string, unknown> | undefined;
}>();
</script>

<template>
  <!--
    A link only when there is somewhere to go: `component :is` rather than two
    near-identical cards, so the markup below cannot drift between the two.
  -->
  <component
    :is="to ? 'router-link' : 'div'"
    v-bind="to ? { to } : {}"
    class="stat-card__frame"
    :class="to ? 'stat-card__frame--link' : ''"
  >
    <q-card flat bordered class="stat-card">
      <q-card-section class="stat-card__body">
        <div class="stat-card__label">
          <span>{{ label }}</span>
          <InfoHint v-if="hint" :text="hint" />
          <q-space />
          <q-icon v-if="to" name="arrow_forward" size="14px" class="stat-card__go" />
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
  </component>
</template>

<style scoped>
.stat-card__frame {
  display: block;
  height: 100%;
  text-decoration: none;
  color: inherit;
}

/* The affordance is the whole tile lifting, not a link-coloured number: the
   value has to stay readable as a number. */
.stat-card__frame--link .stat-card {
  transition:
    border-color 120ms ease,
    box-shadow 120ms ease;
  cursor: pointer;
}

.stat-card__frame--link:hover .stat-card {
  border-color: #90b4e8;
  box-shadow: 0 1px 6px rgba(21, 101, 192, 0.12);
}

.stat-card__frame--link:hover .stat-card__go {
  color: #1565c0;
  transform: translateX(2px);
}

.stat-card__go {
  color: #b4bccb;
  transition:
    color 120ms ease,
    transform 120ms ease;
}

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

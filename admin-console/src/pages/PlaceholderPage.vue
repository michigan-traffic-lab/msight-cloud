<script setup lang="ts">
import { computed } from 'vue';
import { useRoute } from 'vue-router';
import { findFeature } from '@/features';

const route = useRoute();
const feature = computed(() => findFeature(String(route.name)));
</script>

<template>
  <q-page padding>
    <div v-if="feature">
      <div class="row items-start justify-between q-col-gutter-md q-mb-sm">
        <div class="col">
          <h1 class="page-title">{{ feature.title }}</h1>
          <p class="page-subtitle">{{ feature.subtitle }}</p>
        </div>
        <div class="col-auto">
          <q-chip outline color="grey-7" text-color="grey-8">Not built yet</q-chip>
        </div>
      </div>

      <div class="grid-2">
        <section class="card">
          <h2 class="card__title">Planned capabilities</h2>
          <ul class="planned">
            <li v-for="item in feature.planned" :key="item" class="planned__item">
              <q-icon name="check_box_outline_blank" size="16px" class="planned__box" />
              <span>{{ item }}</span>
            </li>
          </ul>
        </section>

        <div class="side">
          <section class="card">
            <h2 class="card__title">Backend routes</h2>
            <ul class="routes">
              <li v-for="path in feature.apiRoutes" :key="path" class="routes__item mono">
                {{ path }}
              </li>
            </ul>
            <p class="hint q-mt-md q-mb-none">
              Routes this page will call once the backend lands.
            </p>
          </section>

          <section v-if="feature.backendNote" class="card q-mt-md">
            <h2 class="card__title">Implementation note</h2>
            <p class="note">{{ feature.backendNote }}</p>
          </section>
        </div>
      </div>
    </div>
  </q-page>
</template>

<style scoped>
.planned,
.routes {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.planned__item {
  display: flex;
  align-items: flex-start;
  gap: 10px;
  font-size: 13px;
  line-height: 1.6;
}

.planned__box {
  color: var(--text-muted);
  margin-top: 2px;
  flex-shrink: 0;
}

.routes__item {
  color: var(--accent);
  overflow-wrap: anywhere;
}

.note {
  margin: 0;
  font-size: 12.5px;
  color: var(--text-muted);
  line-height: 1.7;
}
</style>

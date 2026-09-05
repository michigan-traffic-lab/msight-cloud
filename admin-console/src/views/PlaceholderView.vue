<script setup lang="ts">
import { computed } from 'vue';
import { useRoute } from 'vue-router';
import { findFeature } from '@/features';

const route = useRoute();
const feature = computed(() => findFeature(String(route.name)));
</script>

<template>
  <div v-if="feature">
    <div class="header">
      <div>
        <h1 class="page-title">{{ feature.title }}</h1>
        <p class="page-subtitle">{{ feature.subtitle }}</p>
      </div>
      <el-tag type="info" effect="plain" size="large" round>Not built yet</el-tag>
    </div>

    <div class="grid">
      <section class="card">
        <h2 class="card__title">Planned capabilities</h2>

        <ul class="planned">
          <li v-for="item in feature.planned" :key="item" class="planned__item">
            <span class="planned__box" />
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
          <p class="routes__note">
            These land in the admin API router. The API Gateway route is a catch-all, so no
            infrastructure change is needed to add them.
          </p>
        </section>

        <section v-if="feature.backendNote" class="card card--note">
          <h2 class="card__title">Implementation note</h2>
          <p class="note">{{ feature.backendNote }}</p>
        </section>
      </div>
    </div>
  </div>
</template>

<style scoped>
.header {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 16px;
}

.grid {
  display: grid;
  grid-template-columns: minmax(0, 1.35fr) minmax(300px, 1fr);
  gap: 16px;
  align-items: start;
}

@media (max-width: 1100px) {
  .grid {
    grid-template-columns: 1fr;
  }
}

.side {
  display: flex;
  flex-direction: column;
  gap: 16px;
}

.planned {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 14px;
}

.planned__item {
  display: flex;
  align-items: flex-start;
  gap: 12px;
  font-size: 14px;
  line-height: 1.5;
}

.planned__box {
  flex-shrink: 0;
  width: 16px;
  height: 16px;
  margin-top: 2px;
  border: 1.5px dashed var(--border);
  border-radius: 4px;
  background: var(--page-bg);
}

.routes {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.routes__item {
  background: var(--page-bg);
  border: 1px solid var(--border);
  border-radius: 6px;
  padding: 7px 10px;
  word-break: break-all;
}

.routes__note {
  margin: 16px 0 0;
  font-size: 12px;
  color: var(--text-muted);
  line-height: 1.6;
}

.card--note {
  border-left: 3px solid var(--warn);
}

.note {
  margin: 0;
  font-size: 13px;
  line-height: 1.65;
  color: var(--text);
}
</style>

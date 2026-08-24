<script setup lang="ts">
import { onMounted, ref } from 'vue';
import { ElMessage } from 'element-plus';
import { api, type SystemOverview } from '@/api/client';

const overview = ref<SystemOverview | null>(null);
const loading = ref(true);

async function load() {
  loading.value = true;
  try {
    overview.value = await api.systemOverview();
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : 'Could not load the overview.');
  } finally {
    loading.value = false;
  }
}

function shortArn(arn: string | null): string {
  if (!arn) return '—';
  const parts = arn.split(':');
  return parts[parts.length - 1] || arn;
}

onMounted(load);
</script>

<template>
  <div>
    <div class="header">
      <div>
        <h1 class="page-title">Cloud overview</h1>
        <p class="page-subtitle">
          Live status of the MSight cloud stack and its public endpoints.
        </p>
      </div>
      <el-button :icon="'Refresh'" :loading="loading" @click="load">Refresh</el-button>
    </div>

    <div v-loading="loading">
      <template v-if="overview">
        <div class="stat-grid">
          <div class="stat">
            <div class="stat__label">Region</div>
            <div class="stat__value">{{ overview.region }}</div>
          </div>
          <div class="stat">
            <div class="stat__label">Configured sensors</div>
            <div class="stat__value">{{ overview.sensors.configured_count }}</div>
          </div>
          <div class="stat">
            <div class="stat__label">API version</div>
            <div class="stat__value">{{ overview.api_version }}</div>
          </div>
          <div class="stat">
            <div class="stat__label">Build ID</div>
            <div class="stat__value stat__value--sm mono">{{ overview.build_id }}</div>
          </div>
        </div>

        <div class="grid">
          <section class="card">
            <h2 class="card__title">Component health</h2>
            <el-table :data="overview.components" style="width: 100%">
              <el-table-column prop="name" label="Component" min-width="180" />
              <el-table-column label="Status" width="130">
                <template #default="{ row }">
                  <span :class="`dot dot--${row.status}`" />
                  <span>{{ row.status }}</span>
                </template>
              </el-table-column>
              <el-table-column label="Latency" width="110">
                <template #default="{ row }">
                  {{ row.latency_ms === null ? '—' : `${row.latency_ms} ms` }}
                </template>
              </el-table-column>
              <el-table-column prop="detail" label="Detail" min-width="180">
                <template #default="{ row }">
                  <span class="muted">{{ row.detail ?? '—' }}</span>
                </template>
              </el-table-column>
            </el-table>
          </section>

          <section class="card">
            <h2 class="card__title">Endpoints</h2>
            <div class="kv">
              <div class="kv__key">Public HTTP API</div>
              <div class="kv__value mono">{{ overview.endpoints.http_api ?? '—' }}</div>
              <div class="kv__key">Sensor HTTP API</div>
              <div class="kv__value mono">{{ overview.endpoints.sensor_http_api ?? '—' }}</div>
              <div class="kv__key">WebSocket API</div>
              <div class="kv__value mono">{{ overview.endpoints.websocket_api ?? '—' }}</div>
            </div>
          </section>

          <section class="card">
            <h2 class="card__title">SNS topics</h2>
            <div class="kv">
              <div class="kv__key">Sensor fanout</div>
              <div class="kv__value mono">{{ shortArn(overview.topics.sensor) }}</div>
              <div class="kv__key">SPaT fanout</div>
              <div class="kv__value mono">{{ shortArn(overview.topics.spat) }}</div>
              <div class="kv__key">Control channel</div>
              <div class="kv__value mono">{{ shortArn(overview.topics.control) }}</div>
            </div>
          </section>

          <section class="card">
            <h2 class="card__title">Sensors</h2>
            <div v-if="overview.sensors.names.length === 0" class="empty">
              No sensors are configured in deploy.config.yaml.
            </div>
            <div v-else class="tags">
              <el-tag
                v-for="name in overview.sensors.names"
                :key="name"
                size="large"
                effect="plain"
              >
                {{ name }}
              </el-tag>
            </div>
            <p class="note">
              Sensors are provisioned at deploy time — each one creates an SQS FIFO queue and
              an ECS service. Adding one is a <code>cdk deploy</code>, not a console action.
            </p>
          </section>
        </div>

        <p class="timestamp">
          Last checked {{ new Date(overview.server_timestamp).toLocaleString() }}
        </p>
      </template>
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
  grid-template-columns: repeat(auto-fit, minmax(380px, 1fr));
  gap: 16px;
}

.muted {
  color: var(--text-muted);
}

.tags {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}

.note {
  margin: 16px 0 0;
  font-size: 12px;
  color: var(--text-muted);
  line-height: 1.6;
}

.note code {
  background: var(--page-bg);
  padding: 1px 5px;
  border-radius: 4px;
}

.timestamp {
  margin-top: 20px;
  font-size: 12px;
  color: var(--text-muted);
}
</style>

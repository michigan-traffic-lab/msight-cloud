<script setup lang="ts">
import { computed, ref } from 'vue';
import { api, type SensorEntry, type SensorsResponse } from '@/api/client';
import { useAsyncValue } from '@/composables/useAsyncValue';
import AsyncValue from '@/components/AsyncValue.vue';

const sensors = useAsyncValue<SensorsResponse>((signal) => api.sensors(signal), {
  timeoutMs: 20000,
});

const selectedName = ref<string | null>(null);

const selected = computed<SensorEntry | null>(
  () => sensors.data.value?.sensors.find((s) => s.name === selectedName.value) ?? null
);

const topic = computed(() => sensors.data.value?.topic ?? null);

const backlog = computed(() =>
  (sensors.data.value?.sensors ?? []).reduce(
    (sum, sensor) => sum + (sensor.queue?.messages_available ?? 0),
    0
  )
);

const unwired = computed(
  () => (sensors.data.value?.sensors ?? []).filter((sensor) => !sensor.wired).length
);

function reload() {
  void sensors.reload();
}
</script>

<template>
  <div>
    <div class="header">
      <div>
        <h1 class="page-title">Sensors</h1>
        <p class="page-subtitle">
          Sensors are provisioned at deploy time from <code>deploy.config.yaml</code>. Each one
          gets its own SQS FIFO queue and consumer service.
        </p>
      </div>
      <el-button :icon="'Refresh'" :loading="sensors.state.value === 'loading'" @click="reload">
        Refresh
      </el-button>
    </div>

    <div class="stat-grid">
      <div class="stat">
        <div class="stat__label">Configured sensors</div>
        <div class="stat__value">
          <AsyncValue :state="sensors.state.value" :error="sensors.error.value">
            {{ sensors.data.value?.sensors.length ?? 0 }}
          </AsyncValue>
        </div>
      </div>
      <div class="stat">
        <div class="stat__label">Messages waiting</div>
        <div class="stat__value">
          <AsyncValue :state="sensors.state.value" :error="sensors.error.value">
            {{ backlog.toLocaleString() }}
          </AsyncValue>
        </div>
      </div>
      <div class="stat">
        <div class="stat__label">Not fully wired</div>
        <div class="stat__value">
          <AsyncValue :state="sensors.state.value" :error="sensors.error.value">
            <span :class="unwired > 0 ? 'bad' : ''">{{ unwired }}</span>
          </AsyncValue>
        </div>
      </div>
      <div class="stat">
        <div class="stat__label">Ingest topic</div>
        <div class="stat__value stat__value--sm mono">
          <AsyncValue :state="sensors.state.value" :error="sensors.error.value">
            {{ topic?.name }}
          </AsyncValue>
        </div>
      </div>
    </div>

    <AsyncValue :state="sensors.state.value" :error="sensors.error.value">
      <div class="grid">
        <section class="card">
          <h2 class="card__title">Sensors</h2>
          <div v-if="!sensors.data.value?.sensors.length" class="empty">
            No sensors are configured. Add them under <code>sensors:</code> in
            deploy.config.yaml and redeploy.
          </div>
          <ul v-else class="list">
            <li
              v-for="sensor in sensors.data.value.sensors"
              :key="sensor.name"
              class="row"
              :class="{ 'row--active': selectedName === sensor.name }"
              tabindex="0"
              role="button"
              @click="selectedName = sensor.name"
              @keydown.enter="selectedName = sensor.name"
            >
              <span class="dot" :class="sensor.wired ? 'dot--ok' : 'dot--degraded'" />
              <span class="row__name">{{ sensor.name }}</span>
              <span class="row__meta">
                <template v-if="sensor.queue">
                  {{ sensor.queue.messages_available }} waiting
                </template>
                <template v-else>no queue</template>
              </span>
            </li>
          </ul>
          <p class="hint">
            A sensor is <strong>wired</strong> when its queue exists, is subscribed to the topic,
            and the subscription filter admits its name.
          </p>
        </section>

        <section class="card">
          <h2 class="card__title">
            {{ selected ? selected.name : 'Connect a field sensor' }}
          </h2>

          <div v-if="!selected" class="empty">
            Select a sensor to see the topic to publish to, the routing attribute it needs, and
            what the message must contain.
          </div>

          <template v-else>
            <el-alert
              v-if="!selected.wired"
              type="warning"
              show-icon
              :closable="false"
              class="alert"
              title="This sensor is not fully wired"
              :description="
                selected.queue
                  ? 'Its queue exists but no topic subscription filter admits this name. Messages published for it will be discarded.'
                  : 'No SQS queue exists for this sensor. Redeploy the stack after adding it to deploy.config.yaml.'
              "
            />

            <div class="kv">
              <div class="kv__key">Publish to</div>
              <div class="kv__value mono">{{ topic?.arn }}</div>
              <div class="kv__key">Topic type</div>
              <div class="kv__value">
                {{ topic?.fifo ? 'FIFO — MessageGroupId is required' : 'Standard' }}
              </div>
              <div class="kv__key">Routing attribute</div>
              <div class="kv__value mono">
                {{ topic?.routing_attribute }} = {{ selected.name }}
              </div>
              <div class="kv__key">Delivers to</div>
              <div class="kv__value mono">{{ selected.queue?.name ?? '—' }}</div>
              <div class="kv__key">Queue depth</div>
              <div class="kv__value">
                {{ selected.queue?.messages_available ?? 0 }} waiting ·
                {{ selected.queue?.messages_in_flight ?? 0 }} in flight
              </div>
            </div>

            <h3 class="sub">How to hook up the field sensor</h3>
            <ol class="steps">
              <li>
                Publish to the topic above. The sensor does not write to SQS directly — the
                topic fans out to the right queue.
              </li>
              <li>
                Set the message attribute
                <code>{{ topic?.routing_attribute }}</code> to exactly
                <code>{{ selected.name }}</code>. This is what routes the message. A missing or
                misspelled value matches no subscription and is dropped
                <strong>without an error</strong>.
              </li>
              <li>
                Set a <code>MessageGroupId</code> — required on a FIFO topic. Ordering holds
                within a group, so use one group per sensor.
              </li>
              <li>
                Body is JSON with <code>capture_timestamp</code> (epoch seconds) and
                <code>data</code>: base64 of a <code>Type=SDSM</code> /
                <code>Payload=&lt;hex&gt;</code> text block. Anything whose type is not
                <code>SDSM</code> is logged and skipped.
              </li>
              <li v-if="topic?.content_based_deduplication">
                Content-based deduplication is on. Two identical bodies published within five
                minutes are treated as one — vary the payload or set an explicit
                <code>MessageDeduplicationId</code> when replaying test data.
              </li>
            </ol>

          </template>
        </section>
      </div>
    </AsyncValue>
  </div>
</template>

<style scoped>
.header {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 16px;
}

.header code,
.hint code,
.steps code,
.empty code {
  background: var(--page-bg);
  padding: 1px 5px;
  border-radius: 4px;
  font-size: 12px;
}

.grid {
  display: grid;
  grid-template-columns: minmax(260px, 0.62fr) minmax(380px, 1fr);
  gap: 16px;
  align-items: start;
}

@media (max-width: 1100px) {
  .grid {
    grid-template-columns: 1fr;
  }
}

.list {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.row {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 10px 10px;
  border-radius: 7px;
  cursor: pointer;
  font-size: 13px;
  outline: none;
  transition: background 0.12s ease;
}

.row:hover,
.row--active,
.row:focus-visible {
  background: var(--page-bg);
}

.row__name {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-weight: 550;
}

.row__meta {
  font-size: 11px;
  color: var(--text-muted);
}

.hint {
  margin: 14px 0 0;
  font-size: 11.5px;
  color: var(--text-muted);
  line-height: 1.6;
}

.alert {
  margin-bottom: 16px;
}

.sub {
  font-size: 13px;
  font-weight: 650;
  margin: 22px 0 10px;
}

.steps {
  margin: 0;
  padding-left: 18px;
  display: flex;
  flex-direction: column;
  gap: 9px;
  font-size: 13px;
  line-height: 1.6;
}

.bad {
  color: var(--bad);
}
</style>

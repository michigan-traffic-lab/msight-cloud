<script setup lang="ts">
import { computed, ref } from 'vue';
import { useQuasar } from 'quasar';
import { api, type ValkeyKey, type ValkeyOverview } from '@/api/client';
import { useAsyncValue } from '@/composables/useAsyncValue';
import PageHeader from '@/components/PageHeader.vue';
import AsyncValue from '@/components/AsyncValue.vue';
import { useAuthStore } from '@/stores/auth';
import StatCard from '@/components/StatCard.vue';
import SectionCard from '@/components/SectionCard.vue';

const $q = useQuasar();
const auth = useAuthStore();

const overview = useAsyncValue<ValkeyOverview>((signal) => api.valkeyOverview(signal), {
  timeoutMs: 20000,
});

const keyInput = ref('');
const inspected = ref<ValkeyKey | null>(null);
const inspecting = ref(false);
const inspectError = ref<string | null>(null);

/**
 * Operations are picked from a fixed list rather than typed as commands. There
 * is no way to express FLUSHALL, KEYS, or a pattern delete here — the API only
 * accepts one fully-qualified key per call.
 */
type Operation = 'value' | 'field' | 'ttl' | 'delete';
const operation = ref<Operation>('value');

const newValue = ref('');
const newTtl = ref<number | null>(null);
const hashField = ref('');
const applying = ref(false);

const canWrite = computed(() => auth.isAdmin);

const unaccounted = computed(() => {
  const data = overview.data.value;
  if (!data) return 0;
  return Math.max(0, data.cluster.total_keys - data.approx_accounted_keys);
});

async function inspect(key?: string) {
  const target = (key ?? keyInput.value).trim();
  if (!target) {
    $q.notify({ type: 'warning', message: 'Enter or pick a key.', position: 'top' });
    return;
  }
  keyInput.value = target;
  inspecting.value = true;
  inspectError.value = null;
  try {
    inspected.value = await api.valkeyKey(target);
    // Prefill so an edit starts from the current value rather than blank.
    newValue.value = inspected.value.string_value ?? '';
    newTtl.value = inspected.value.ttl_seconds > 0 ? inspected.value.ttl_seconds : null;
  } catch (error) {
    inspectError.value = error instanceof Error ? error.message : 'Could not read that key.';
    inspected.value = null;
  } finally {
    inspecting.value = false;
  }
}

function ttlLabel(ttl: number): string {
  if (ttl === -1) return 'no expiry';
  if (ttl === -2) return 'gone';
  return `${ttl}s remaining`;
}

async function apply() {
  const key = keyInput.value.trim();
  if (!key) return;

  const summaries: Record<Operation, string> = {
    value: `SET the string value of "${key}"`,
    field: `SET hash field "${hashField.value}" on "${key}"`,
    ttl:
      newTtl.value === null
        ? `Remove the expiry on "${key}"`
        : `Set the expiry on "${key}" to ${newTtl.value}s`,
    delete: `DELETE the key "${key}"`,
  };

  const confirmed = await new Promise<boolean>((resolve) => {
    $q.dialog({
      title: 'Confirm write',
      message:
        `${summaries[operation.value]}. This cache is on the live SPaT broadcast path — the ` +
        'change takes effect immediately.',
      cancel: { label: 'Cancel', flat: true, color: 'grey-8' },
      ok: {
        label: 'Apply',
        color: operation.value === 'delete' ? 'negative' : 'warning',
        unelevated: true,
      },
      persistent: true,
    })
      .onOk(() => resolve(true))
      .onCancel(() => resolve(false))
      .onDismiss(() => resolve(false));
  });
  if (!confirmed) return;

  applying.value = true;
  try {
    if (operation.value === 'value') {
      await api.valkeySetValue(key, newValue.value, newTtl.value);
    } else if (operation.value === 'field') {
      if (!hashField.value.trim()) throw new Error('Enter a hash field name.');
      await api.valkeySetField(key, hashField.value.trim(), newValue.value);
    } else if (operation.value === 'ttl') {
      await api.valkeySetTtl(key, newTtl.value);
    } else {
      await api.valkeyDeleteKey(key);
    }

    $q.notify({ type: 'positive', message: 'Applied.', position: 'top' });
    if (operation.value === 'delete') {
      inspected.value = null;
    } else {
      await inspect(key);
    }
    void overview.reload();
  } catch (error) {
    $q.notify({
      type: 'negative',
      message: error instanceof Error ? error.message : 'Operation failed.',
      position: 'top',
    });
  } finally {
    applying.value = false;
  }
}
</script>

<template>
  <q-page padding>
    <PageHeader
      title="Valkey cache"
      subtitle="Live values for the keys this stack writes, and single-key debugging operations. The keyspace is never scanned — every key shown here is constructed from a known pattern."
    >
      <template #actions>
        <q-btn
          outline
          color="primary"
          icon="refresh"
          label="Refresh"
          :loading="overview.state.value === 'loading'"
          @click="overview.reload()"
          />
      </template>
    </PageHeader>

    <!-- Cluster stats -->
    <div class="row q-col-gutter-md q-mb-md">
      <div class="col-6 col-md-3">
        <StatCard label="Memory">
          <AsyncValue :state="overview.state.value" :error="overview.error.value">
                          {{ overview.data.value?.cluster.used_memory }}
                        </AsyncValue>
        </StatCard>
      </div>
      <div class="col-6 col-md-3">
        <StatCard label="Keys">
          <AsyncValue :state="overview.state.value" :error="overview.error.value">
                          {{ (overview.data.value?.cluster.total_keys ?? 0).toLocaleString() }}
                        </AsyncValue>
        </StatCard>
      </div>
      <div class="col-6 col-md-3">
        <StatCard label="Hit rate">
          <AsyncValue :state="overview.state.value" :error="overview.error.value">
                          <template v-if="overview.data.value?.cluster.hit_rate !== null">
                            {{ Math.round((overview.data.value?.cluster.hit_rate ?? 0) * 100) }}%
                          </template>
                          <template v-else>—</template>
                        </AsyncValue>
        </StatCard>
      </div>
      <div class="col-6 col-md-3">
        <StatCard label="Unaccounted" hint="Keys in the cache that none of the patterns below explain. A large gap means something is writing keys this page knows nothing about.">
          <AsyncValue :state="overview.state.value" :error="overview.error.value">
                          {{ unaccounted.toLocaleString() }}
                        </AsyncValue>
        </StatCard>
      </div>
    </div>

    <div class="row q-col-gutter-md">
      <!-- Known keys -->
      <div class="col-12 col-md-5">
        <SectionCard title="Known keys" flush>
          <AsyncValue :state="overview.state.value" :error="overview.error.value">
            <q-list separator>
              <q-item-label header class="text-uppercase">Client fleets</q-item-label>
              <q-item
                v-for="app in overview.data.value?.apps ?? []"
                :key="app.app_id"
                v-ripple
                clickable
                @click="inspect(app.geo_key)"
              >
                <q-item-section>
                  <q-item-label class="mono" lines="1">{{ app.geo_key }}</q-item-label>
                  <q-item-label caption>
                    {{ app.connected }} connected · {{ app.expired_not_reaped }} stale
                  </q-item-label>
                </q-item-section>
              </q-item>

              <q-item-label header class="text-uppercase">Sensor heartbeats</q-item-label>
              <q-item
                v-for="sensor in overview.data.value?.sensors ?? []"
                :key="sensor.key"
                v-ripple
                clickable
                @click="inspect(sensor.key)"
              >
                <q-item-section>
                  <q-item-label class="mono" lines="1">{{ sensor.key }}</q-item-label>
                  <q-item-label caption>
                    <template v-if="sensor.seconds_ago !== null">
                      last seen {{ sensor.seconds_ago }}s ago
                    </template>
                    <template v-else>never seen</template>
                  </q-item-label>
                </q-item-section>
                <q-item-section side>
                  <q-icon
                    name="circle"
                    size="10px"
                    :color="sensor.seconds_ago === null ? 'grey-5' : sensor.seconds_ago < 60 ? 'positive' : 'warning'"
                  />
                </q-item-section>
              </q-item>
            </q-list>
          </AsyncValue>
        </SectionCard>
      </div>

      <!-- Inspector -->
      <div class="col-12 col-md-7">
        <q-card flat bordered>
          <q-card-section>
            <div class="text-caption text-grey-7 text-uppercase text-weight-medium q-mb-sm">
              Inspect a key
            </div>
            <q-input
              v-model="keyInput"
              outlined
              dense
              label="Full key"
              input-class="mono"
              :loading="inspecting"
              @keyup.enter="inspect()"
            >
              <template #append>
                <q-btn flat dense round icon="search" :loading="inspecting" @click="inspect()" />
              </template>
            </q-input>

            <q-banner v-if="inspectError" rounded dense class="bg-red-1 text-negative q-mt-md">
              <template #avatar><q-icon name="error" color="negative" /></template>
              {{ inspectError }}
            </q-banner>

            <template v-if="inspected">
              <q-list dense class="q-mt-md">
                <q-item class="q-px-none">
                  <q-item-section>
                    <q-item-label caption>Type</q-item-label>
                    <q-item-label>{{ inspected.type }}</q-item-label>
                  </q-item-section>
                  <q-item-section>
                    <q-item-label caption>Exists</q-item-label>
                    <q-item-label>{{ inspected.exists ? 'yes' : 'no' }}</q-item-label>
                  </q-item-section>
                  <q-item-section>
                    <q-item-label caption>TTL</q-item-label>
                    <q-item-label>{{ ttlLabel(inspected.ttl_seconds) }}</q-item-label>
                  </q-item-section>
                </q-item>
              </q-list>

              <div v-if="inspected.string_value !== null" class="q-mt-sm">
                <div class="text-caption text-grey-7">Value</div>
                <pre class="value-box mono">{{ inspected.string_value }}</pre>
              </div>

              <div v-if="inspected.entries.length" class="q-mt-sm">
                <div class="text-caption text-grey-7 q-mb-xs">
                  Entries
                  <template v-if="inspected.truncated"> (truncated)</template>
                </div>
                <q-list dense bordered separator class="rounded-borders">
                  <q-item v-for="entry in inspected.entries" :key="entry.member">
                    <q-item-section class="mono">{{ entry.member }}</q-item-section>
                    <q-item-section side class="mono text-grey-8">{{ entry.value }}</q-item-section>
                  </q-item>
                </q-list>
              </div>
            </template>
          </q-card-section>

          <!-- Write operations -->
          <template v-if="canWrite">
            <q-separator />
            <q-card-section>
              <q-banner rounded dense class="bg-orange-1 text-grey-9 q-mb-md">
                <template #avatar><q-icon name="warning" color="warning" /></template>
                <div class="text-body2">
                  These write directly to the cache backing live SPaT broadcasts. There is no
                  undo, and a wrong value takes effect immediately. Operations are a fixed list
                  and act on exactly one key — there is no pattern delete or flush.
                </div>
              </q-banner>

              <q-btn-toggle
                v-model="operation"
                no-caps
                unelevated
                toggle-color="primary"
                class="q-mb-md"
                :options="[
                  { label: 'Set value', value: 'value' },
                  { label: 'Set hash field', value: 'field' },
                  { label: 'Set TTL', value: 'ttl' },
                  { label: 'Delete', value: 'delete' },
                ]"
              />

              <div class="row q-col-gutter-sm">
                <div v-if="operation === 'field'" class="col-12">
                  <q-input v-model="hashField" outlined dense label="Hash field" input-class="mono" />
                </div>
                <div v-if="operation === 'value' || operation === 'field'" class="col-12">
                  <q-input
                    v-model="newValue"
                    outlined
                    dense
                    type="textarea"
                    autogrow
                    label="New value"
                    input-class="mono"
                  />
                </div>
                <div v-if="operation === 'value' || operation === 'ttl'" class="col-12 col-sm-6">
                  <q-input
                    v-model.number="newTtl"
                    outlined
                    dense
                    type="number"
                    label="TTL seconds"
                    hint="Leave blank for no expiry."
                    clearable
                  />
                </div>
                <div class="col-12">
                  <q-btn
                    unelevated
                    :color="operation === 'delete' ? 'negative' : 'warning'"
                    :label="operation === 'delete' ? 'Delete key' : 'Apply'"
                    :loading="applying"
                    :disable="!keyInput.trim()"
                    @click="apply"
                  />
                </div>
              </div>
            </q-card-section>
          </template>
        </q-card>
      </div>
    </div>
  </q-page>
</template>

<style scoped>
.value-box {
  background: rgba(0, 0, 0, 0.04);
  border-radius: 6px;
  padding: 10px 12px;
  margin: 4px 0 0;
  max-height: 220px;
  overflow: auto;
  white-space: pre-wrap;
  word-break: break-word;
}
</style>

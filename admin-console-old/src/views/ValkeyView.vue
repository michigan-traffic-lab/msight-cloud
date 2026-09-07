<script setup lang="ts">
import { computed, ref } from 'vue';
import { ElMessage, ElMessageBox } from 'element-plus';
import { api, type ValkeyKey, type ValkeyOverview } from '@/api/client';
import { useAsyncValue } from '@/composables/useAsyncValue';
import AsyncValue from '@/components/AsyncValue.vue';
import { useAuthStore } from '@/stores/auth';

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
    ElMessage.warning('Enter or pick a key.');
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
    ttl: newTtl.value === null ? `Remove the expiry on "${key}"` : `Set the expiry on "${key}" to ${newTtl.value}s`,
    delete: `DELETE the key "${key}"`,
  };

  try {
    await ElMessageBox.confirm(
      `${summaries[operation.value]}. This cache is on the live SPaT broadcast path — the change takes effect immediately.`,
      'Confirm write',
      {
        confirmButtonText: 'Apply',
        cancelButtonText: 'Cancel',
        confirmButtonClass: operation.value === 'delete' ? 'el-button--danger' : '',
        type: 'warning',
      }
    );
  } catch {
    return;
  }

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

    ElMessage.success('Applied.');
    if (operation.value === 'delete') {
      inspected.value = null;
    } else {
      await inspect(key);
    }
    void overview.reload();
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : 'Operation failed.');
  } finally {
    applying.value = false;
  }
}
</script>

<template>
  <div>
    <div class="header">
      <div>
        <h1 class="page-title">Valkey cache</h1>
        <p class="page-subtitle">
          Live values for the keys this stack writes, and single-key debugging operations.
        </p>
      </div>
      <el-button
        :icon="'Refresh'"
        :loading="overview.state.value === 'loading'"
        @click="overview.reload()"
      >
        Refresh
      </el-button>
    </div>

    <div class="stat-grid">
      <div class="stat">
        <div class="stat__label">Keys</div>
        <div class="stat__value">
          <AsyncValue :state="overview.state.value" :error="overview.error.value">
            {{ overview.data.value?.cluster.total_keys.toLocaleString() }}
          </AsyncValue>
        </div>
      </div>
      <div class="stat">
        <div class="stat__label">Memory used</div>
        <div class="stat__value stat__value--sm">
          <AsyncValue :state="overview.state.value" :error="overview.error.value">
            {{ overview.data.value?.cluster.used_memory }}
          </AsyncValue>
        </div>
      </div>
      <div class="stat">
        <div class="stat__label">Hit rate</div>
        <div class="stat__value">
          <AsyncValue :state="overview.state.value" :error="overview.error.value">
            <template v-if="overview.data.value?.cluster.hit_rate !== null">
              {{ Math.round((overview.data.value?.cluster.hit_rate ?? 0) * 100) }}%
            </template>
            <span v-else class="muted">—</span>
          </AsyncValue>
        </div>
      </div>
      <div class="stat">
        <div class="stat__label">Evicted keys</div>
        <div class="stat__value">
          <AsyncValue :state="overview.state.value" :error="overview.error.value">
            <span :class="(overview.data.value?.cluster.evicted_keys ?? 0) > 0 ? 'warn' : ''">
              {{ overview.data.value?.cluster.evicted_keys.toLocaleString() }}
            </span>
          </AsyncValue>
        </div>
      </div>
    </div>

    <div class="grid">
      <!-- Curated values: keys we can name without scanning -->
      <section class="card">
        <h2 class="card__title">Sensor feeds</h2>
        <p class="card__lede">
          The SPaT rate-limiter key doubles as a last-seen timestamp, so this answers whether a
          sensor is actually delivering right now.
        </p>
        <AsyncValue :state="overview.state.value" :error="overview.error.value">
          <div v-if="!overview.data.value?.sensors.length" class="empty">
            No sensors configured.
          </div>
          <table v-else class="mini">
            <tbody>
              <tr v-for="row in overview.data.value.sensors" :key="row.sensor">
                <td>
                  <span
                    class="dot"
                    :class="
                      row.seconds_ago === null
                        ? 'dot--degraded'
                        : row.seconds_ago < 10
                          ? 'dot--ok'
                          : 'dot--unknown'
                    "
                  />
                  {{ row.sensor }}
                </td>
                <td class="muted">
                  {{ row.seconds_ago === null ? 'no data' : `${row.seconds_ago}s ago` }}
                </td>
                <td class="right">
                  <el-button link size="small" @click="inspect(row.key)">Inspect</el-button>
                </td>
              </tr>
            </tbody>
          </table>
        </AsyncValue>

        <h2 class="card__title spaced">Client registries</h2>
        <AsyncValue :state="overview.state.value" :error="overview.error.value">
          <div v-if="!overview.data.value?.apps.length" class="empty">No apps configured.</div>
          <table v-else class="mini">
            <tbody>
              <tr v-for="row in overview.data.value.apps" :key="row.app_id">
                <td>{{ row.app_id }}</td>
                <td class="muted">
                  {{ row.connected }} clients
                  <template v-if="row.expired_not_reaped">
                    · {{ row.expired_not_reaped }} overdue
                  </template>
                </td>
                <td class="right">
                  <el-button link size="small" @click="inspect(row.geo_key)">Inspect</el-button>
                </td>
              </tr>
            </tbody>
          </table>
        </AsyncValue>

        <p v-if="unaccounted > 0" class="hint">
          <strong>{{ unaccounted.toLocaleString() }}</strong> keys are not accounted for by the
          families above. That is expected for connection keys, but a large gap can also mean
          keys exist that this page does not know about.
        </p>
      </section>

      <!-- Single-key operations -->
      <section class="card">
        <h2 class="card__title">Key operations</h2>

        <div class="lookup">
          <el-input
            v-model="keyInput"
            placeholder="msight:zone01:..."
            spellcheck="false"
            @keyup.enter="inspect()"
          />
          <el-button :loading="inspecting" @click="inspect()">Inspect</el-button>
        </div>
        <p class="card__lede">
          Keys must be inside the <code>msight:</code> namespace. Collection reads return at most
          50 members.
        </p>

        <el-alert
          v-if="inspectError"
          type="error"
          show-icon
          :closable="false"
          class="alert"
          :title="inspectError"
        />

        <!-- Current value -->
        <div v-if="inspected" class="result">
          <div class="result__head">
            <el-tag size="small" effect="plain">{{ inspected.type }}</el-tag>
            <span class="muted">{{ ttlLabel(inspected.ttl_seconds) }}</span>
            <el-button
              link
              size="small"
              :icon="'Refresh'"
              :loading="inspecting"
              @click="inspect(inspected.key)"
            >
              Refresh
            </el-button>
          </div>

          <div v-if="!inspected.exists" class="empty">This key does not exist.</div>

          <pre v-else-if="inspected.type === 'string'" class="valuebox">{{
            inspected.string_value
          }}</pre>

          <table v-else-if="inspected.entries.length" class="mini">
            <tbody>
              <tr v-for="entry in inspected.entries" :key="entry.member">
                <td class="mono">{{ entry.member }}</td>
                <td class="mono muted">{{ entry.value ?? '' }}</td>
              </tr>
            </tbody>
          </table>

          <p v-if="inspected.truncated" class="hint">
            Showing the first 50 members only.
          </p>
        </div>

        <!-- Write operations -->
        <template v-if="canWrite">
          <h3 class="sub">Modify</h3>

          <el-alert
            type="warning"
            show-icon
            :closable="false"
            class="alert"
            title="Writing here changes live behaviour"
            description="This cache is read by the SPaT broadcast path and the WebSocket senders. A hand-edited value takes effect on the next read — there is no staging step and no undo. Every write is recorded in the audit log."
          />

          <el-radio-group v-model="operation" size="small" class="ops">
            <el-radio-button value="value">Set value</el-radio-button>
            <el-radio-button value="field">Set hash field</el-radio-button>
            <el-radio-button value="ttl">Set expiry</el-radio-button>
            <el-radio-button value="delete">Delete key</el-radio-button>
          </el-radio-group>

          <div class="opfields">
            <label v-if="operation === 'field'" class="field field--wide">
              <span>Hash field</span>
              <el-input v-model="hashField" placeholder="lat" spellcheck="false" />
            </label>

            <label v-if="operation === 'value' || operation === 'field'" class="field field--wide">
              <span>Value</span>
              <el-input v-model="newValue" type="textarea" :rows="3" spellcheck="false" />
            </label>

            <label v-if="operation === 'value' || operation === 'ttl'" class="field">
              <span>Expiry (seconds, blank = none)</span>
              <el-input-number
                v-model="newTtl"
                :min="1"
                :max="86400"
                controls-position="right"
                placeholder="none"
              />
            </label>

            <p v-if="operation === 'delete'" class="deletenote">
              Removes this one key. There is no pattern delete — the only unit available here is a
              single key you have just inspected.
            </p>
          </div>

          <el-button
            :type="operation === 'delete' ? 'danger' : 'primary'"
            :loading="applying"
            :disabled="!keyInput.trim()"
            @click="apply"
          >
            {{ operation === 'delete' ? 'Delete key' : 'Apply' }}
          </el-button>
        </template>

        <p v-else class="hint">Modifying keys requires the admin role.</p>
      </section>
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
  grid-template-columns: minmax(280px, 0.85fr) minmax(360px, 1fr);
  gap: 16px;
  align-items: start;
}

@media (max-width: 1100px) {
  .grid {
    grid-template-columns: 1fr;
  }
}

.card__lede {
  margin: -4px 0 14px;
  font-size: 12px;
  color: var(--text-muted);
  line-height: 1.6;
}

.card__lede code {
  background: var(--page-bg);
  padding: 1px 5px;
  border-radius: 4px;
}

.spaced {
  margin-top: 24px;
}

.mini {
  width: 100%;
  border-collapse: collapse;
}

.mini td {
  padding: 7px 8px 7px 0;
  font-size: 12px;
  border-bottom: 1px solid var(--border);
  vertical-align: top;
  overflow-wrap: anywhere;
}

.right {
  text-align: right;
  width: 70px;
}

.lookup {
  display: flex;
  gap: 8px;
  margin-bottom: 8px;
}

.result {
  margin-top: 16px;
  border-top: 1px solid var(--border);
  padding-top: 14px;
}

.result__head {
  display: flex;
  align-items: center;
  gap: 10px;
  margin-bottom: 10px;
}

.valuebox {
  margin: 0;
  background: var(--page-bg);
  border: 1px solid var(--border);
  border-radius: 6px;
  padding: 10px;
  font-size: 12px;
  font-family: 'SF Mono', ui-monospace, monospace;
  max-height: 200px;
  overflow: auto;
  overflow-wrap: anywhere;
  white-space: pre-wrap;
}

.sub {
  font-size: 13px;
  font-weight: 650;
  margin: 24px 0 10px;
}

.ops {
  margin-bottom: 14px;
}

.opfields {
  display: flex;
  flex-wrap: wrap;
  gap: 12px;
  margin-bottom: 14px;
}

.field {
  display: flex;
  flex-direction: column;
  gap: 5px;
  font-size: 12px;
  color: var(--text-muted);
}

.field--wide {
  flex: 1;
  min-width: 240px;
}

.deletenote {
  margin: 0;
  font-size: 12px;
  color: var(--text-muted);
  line-height: 1.6;
}

.alert {
  margin-bottom: 14px;
}

.hint {
  margin: 14px 0 0;
  font-size: 11.5px;
  color: var(--text-muted);
  line-height: 1.6;
}

.muted {
  color: var(--text-muted);
}

.warn {
  color: var(--warn);
}
</style>

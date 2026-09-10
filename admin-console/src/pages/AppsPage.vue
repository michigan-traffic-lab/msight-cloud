<script setup lang="ts">
import { computed, ref } from 'vue';
import { useQuasar } from 'quasar';
import { api, type AppEntry, type AppPatch, type AppsResponse } from '@/api/client';
import { useAsyncValue } from '@/composables/useAsyncValue';
import PageHeader from '@/components/PageHeader.vue';
import AsyncValue from '@/components/AsyncValue.vue';
import InfoHint from '@/components/InfoHint.vue';
import SectionCard from '@/components/SectionCard.vue';
import { useAuthStore } from '@/stores/auth';

const $q = useQuasar();

/**
 * The three subscriptions, defined once.
 *
 * Every list row, every toggle and every stat is generated from this, so a
 * fourth stream is one entry here rather than an edit in five places — and the
 * wording of what each one does cannot drift between them.
 */
const STREAMS = [
  {
    key: 'receive_sdsm' as const,
    label: 'SDSM',
    icon: 'directions_car',
    color: 'primary',
    what: 'Detected road users near the client, from the sensor consumers.',
    detail:
      'Sent by the per-sensor Fargate consumers, which broadcast to clients within ' +
      '100 m of the detection. This is the highest-volume stream — a sensor ' +
      'publishes at roughly 10 Hz.',
  },
  {
    key: 'receive_spat' as const,
    label: 'SPaT',
    icon: 'traffic',
    color: 'teal',
    what: 'Signal phase and timing for nearby intersections.',
    detail:
      'Sent by the SPaT Lambda to clients within the configured broadcast radius ' +
      'of the intersection the message came from.',
  },
  {
    key: 'receive_critical_spat' as const,
    label: 'Critical SPaT',
    icon: 'priority_high',
    color: 'deep-orange',
    what: 'The low-latency subset of SPaT, on its own path.',
    detail:
      'A separate consumer from ordinary SPaT, so a slow general broadcast cannot ' +
      'delay it. An app can take either, both, or neither.',
  },
];

const HINTS = {
  registered:
    'Apps in the registry table. An app is a fleet of clients that connects over ' +
    'the WebSocket API; the registry decides what each one is sent.',
  connected:
    'Clients currently connected across every registered app, counted from ' +
    'Valkey. A fleet with no subscriptions still connects — it is simply told ' +
    'nothing.',
  silent:
    'Apps subscribed to nothing at all. They can connect and report position, ' +
    'and receive no messages in return. Usually a half-finished setup rather ' +
    'than a deliberate state.',
  propagation:
    'The consumers cache the subscription list rather than querying Aurora per ' +
    'message — the SDSM path alone runs at about 10 Hz per sensor, and uncached ' +
    'it held Aurora at its connection ceiling. So a change here is not instant.',
  inspectable:
    'Whether the Live clients page can drill into this app\'s fleet. That page ' +
    'reads its list from deploy config, not from this registry, so the two can ' +
    'disagree. It affects only what the console can show you — never what the ' +
    'app receives.',
  remove:
    'Removes the registry row. Connected clients are not disconnected — nothing ' +
    'here reaches their WebSocket — but once the consumers\' cache turns over ' +
    'they stop being sent anything. Their Valkey entries expire on their own.',
};

const auth = useAuthStore();
// Pinia unwraps store computeds on access, so this must stay a computed:
// capturing it in a const would freeze it before the profile loads.
const isAdmin = computed(() => auth.isAdmin);

const apps = useAsyncValue<AppsResponse>((signal) => api.apps(signal), { timeoutMs: 25000 });

const selectedId = ref<string | null>(null);
const busy = ref(false);

const list = computed<AppEntry[]>(() => apps.data.value?.apps ?? []);

const selected = computed<AppEntry | null>(
  () => list.value.find((app) => app.app_id === selectedId.value) ?? null
);

const silentCount = computed(() => list.value.filter((app) => app.receives_nothing).length);

const ttl = computed(() => apps.data.value?.config_cache_ttl_seconds ?? 60);

/** "up to 60s" — the sentence fragment used wherever a change is confirmed. */
const propagation = computed(() => `up to ${ttl.value}s`);

function subscriptionCount(stream: (typeof STREAMS)[number]): number {
  return list.value.filter((app) => app[stream.key]).length;
}

function streamsOf(app: AppEntry) {
  return STREAMS.filter((stream) => app[stream.key]);
}

function reload() {
  void apps.reload();
}

function confirm(options: {
  title: string;
  message: string;
  okLabel: string;
  color?: string;
}): Promise<boolean> {
  return new Promise((resolve) => {
    $q.dialog({
      title: options.title,
      message: options.message,
      html: false,
      cancel: { label: 'Cancel', flat: true, color: 'grey-8' },
      ok: { label: options.okLabel, color: options.color ?? 'primary', unelevated: true },
      persistent: true,
    })
      .onOk(() => resolve(true))
      .onCancel(() => resolve(false))
      .onDismiss(() => resolve(false));
  });
}

async function run(verb: string, action: () => Promise<unknown>) {
  busy.value = true;
  try {
    await action();
    $q.notify({ type: 'positive', message: verb, position: 'top' });
    await apps.reload();
  } catch (error) {
    $q.notify({
      type: 'negative',
      message: error instanceof Error ? error.message : 'Request failed.',
      timeout: 0,
      actions: [{ label: 'Dismiss', color: 'white' }],
      position: 'top',
    });
  } finally {
    busy.value = false;
  }
}

/**
 * Flipping one subscription.
 *
 * Sends only the flag that changed. The effect is delayed and invisible — no
 * error, just messages starting or stopping some seconds later — so the toast
 * says when it will actually take hold rather than claiming it is done.
 */
async function toggleStream(app: AppEntry, stream: (typeof STREAMS)[number]) {
  const next = !app[stream.key];
  const patch = { [stream.key]: next } as AppPatch;
  await run(
    `${app.app_id} ${next ? 'now receives' : 'no longer receives'} ${stream.label} — live in ${propagation.value}`,
    () => api.appUpdate(app.app_id, patch)
  );
}

// --- Add app ---------------------------------------------------------------

const addOpen = ref(false);
const addId = ref('');
const addDisplayName = ref('');
const addStreams = ref<Record<string, boolean>>({});

function openAdd() {
  addId.value = '';
  addDisplayName.value = '';
  addStreams.value = Object.fromEntries(STREAMS.map((stream) => [stream.key, false]));
  addOpen.value = true;
}

async function submitAdd() {
  const appId = addId.value.trim();
  if (!appId) {
    $q.notify({ type: 'warning', message: 'An app id is required.', position: 'top' });
    return;
  }
  addOpen.value = false;
  await run(`App ${appId} registered`, () =>
    api.appAdd(appId, addDisplayName.value.trim() || null, addStreams.value as AppPatch)
  );
  selectedId.value = appId;
}

// --- Rename ----------------------------------------------------------------

const renameOpen = ref(false);
const renameValue = ref('');

function openRename(app: AppEntry) {
  renameValue.value = app.display_name ?? '';
  renameOpen.value = true;
}

async function submitRename() {
  const app = selected.value;
  if (!app) return;
  renameOpen.value = false;
  await run(`${app.app_id} renamed`, () =>
    api.appUpdate(app.app_id, { display_name: renameValue.value.trim() || null })
  );
}

async function removeApp(app: AppEntry) {
  const ok = await confirm({
    title: 'Remove app',
    message:
      `Remove ${app.app_id}? Clients already connected are not disconnected, but once the ` +
      `consumers' cache turns over — ${propagation.value} — they stop being sent anything. ` +
      'Re-registering the same id restores it.',
    okLabel: 'Remove',
    color: 'negative',
  });
  if (!ok) return;

  await run(`App ${app.app_id} removed`, () => api.appRemove(app.app_id));
  if (selectedId.value === app.app_id) selectedId.value = null;
}

async function copy(text: string | null | undefined) {
  if (!text) return;
  try {
    await navigator.clipboard.writeText(text);
    $q.notify({ type: 'positive', message: 'Copied', timeout: 1200, position: 'top' });
  } catch {
    $q.notify({ type: 'negative', message: 'Clipboard unavailable.', position: 'top' });
  }
}
</script>

<template>
  <q-page padding>
    <PageHeader title="Apps">
      <template #subtitle>
        An app is a fleet of clients connecting over the WebSocket API. What each one is sent
        is decided here — the SDSM and SPaT consumers read these flags on their hot paths, so
        a change takes effect within {{ ttl }}s rather than instantly.
      </template>
      <template #actions>
        <q-btn
          outline
          color="primary"
          icon="refresh"
          label="Refresh"
          :loading="apps.state.value === 'loading'"
          @click="reload"
        />
        <q-btn
          v-if="isAdmin"
          unelevated
          color="primary"
          icon="add"
          label="Add app"
          :disable="busy"
          @click="openAdd"
        />
      </template>
    </PageHeader>

    <!-- Stats -->
    <div class="row q-col-gutter-md q-mb-md">
      <div class="col-6 col-md-3">
        <q-card flat bordered>
          <q-card-section>
            <div class="text-caption text-grey-7 text-uppercase row items-center">
              Registered<InfoHint :text="HINTS.registered" />
            </div>
            <div class="text-h6 q-mt-xs">
              <AsyncValue :state="apps.state.value" :error="apps.error.value">
                {{ list.length }}
              </AsyncValue>
            </div>
          </q-card-section>
        </q-card>
      </div>
      <div class="col-6 col-md-3">
        <q-card flat bordered>
          <q-card-section>
            <div class="text-caption text-grey-7 text-uppercase row items-center">
              Connected<InfoHint :text="HINTS.connected" />
            </div>
            <div class="text-h6 q-mt-xs">
              <AsyncValue :state="apps.state.value" :error="apps.error.value">
                {{ (apps.data.value?.total_connected ?? 0).toLocaleString() }}
              </AsyncValue>
            </div>
          </q-card-section>
        </q-card>
      </div>
      <div class="col-6 col-md-3">
        <q-card flat bordered>
          <q-card-section>
            <div class="text-caption text-grey-7 text-uppercase">Subscriptions</div>
            <div class="q-mt-xs">
              <AsyncValue :state="apps.state.value" :error="apps.error.value">
                <div class="row items-baseline q-gutter-sm">
                  <span v-for="stream in STREAMS" :key="stream.key" class="text-body2">
                    <span class="text-h6">{{ subscriptionCount(stream) }}</span>
                    <span class="text-caption text-grey-7"> {{ stream.label }}</span>
                    <q-tooltip class="hint-tooltip">{{ stream.what }}</q-tooltip>
                  </span>
                </div>
              </AsyncValue>
            </div>
          </q-card-section>
        </q-card>
      </div>
      <div class="col-6 col-md-3">
        <q-card flat bordered>
          <q-card-section>
            <div class="text-caption text-grey-7 text-uppercase row items-center">
              Receiving nothing<InfoHint :text="HINTS.silent" />
            </div>
            <div class="text-h6 q-mt-xs" :class="silentCount > 0 ? 'text-warning' : ''">
              <AsyncValue :state="apps.state.value" :error="apps.error.value">
                {{ silentCount }}
              </AsyncValue>
            </div>
          </q-card-section>
        </q-card>
      </div>
    </div>

    <AsyncValue :state="apps.state.value" :error="apps.error.value">
      <!-- The registry loaded; only the Valkey counts did not. Said plainly so
           the dashes in the Connected column are not read as "nobody is
           connected", which is the opposite of what it means. -->
      <q-banner
        v-if="apps.data.value?.counts_error"
        rounded
        class="bg-blue-1 text-grey-9 q-mb-md"
      >
        <template #avatar><q-icon name="info" color="info" /></template>
        <div class="text-weight-medium">Live client counts unavailable</div>
        <div class="text-body2">
          Subscriptions below are accurate — only the connected-client numbers are missing.
          {{ apps.data.value.counts_error }}
        </div>
      </q-banner>

      <q-banner
        v-if="apps.data.value?.unregistered_app_ids.length"
        rounded
        class="bg-orange-1 text-grey-9 q-mb-md"
      >
        <template #avatar><q-icon name="warning" color="warning" /></template>
        <div class="text-weight-medium">Configured but not registered</div>
        <div class="text-body2">
          {{ apps.data.value.unregistered_app_ids.join(', ') }} —
          <code>clientAppIds</code> in deploy config names these, but they have no row here, so
          they receive nothing. Register them below, or drop them from the config.
        </div>
      </q-banner>

      <div class="row q-col-gutter-md">
        <!-- Registry -->
        <div class="col-12 col-md-5">
          <SectionCard title="Registry" flush>
            <q-card-section v-if="!list.length" class="text-body2 text-grey-7">
              No apps are registered.
              <template v-if="isAdmin">
                Use <strong>Add app</strong> to register the first one.
              </template>
            </q-card-section>

            <q-list v-else separator>
              <q-item
                v-for="app in list"
                :key="app.app_id"
                v-ripple
                clickable
                :active="selectedId === app.app_id"
                active-class="bg-blue-grey-1"
                @click="selectedId = app.app_id"
              >
                <q-item-section avatar style="min-width: 26px">
                  <q-icon
                    name="circle"
                    size="10px"
                    :color="app.receives_nothing ? 'grey-6' : 'positive'"
                  >
                    <q-tooltip class="hint-tooltip">
                      {{
                        app.receives_nothing
                          ? 'Subscribed to nothing. It can connect and is sent no messages.'
                          : `Receiving ${streamsOf(app).map((s) => s.label).join(', ')}.`
                      }}
                    </q-tooltip>
                  </q-icon>
                </q-item-section>

                <q-item-section>
                  <q-item-label>{{ app.display_name || app.app_id }}</q-item-label>
                  <q-item-label caption>
                    <span v-if="app.display_name" class="mono">{{ app.app_id }} · </span>
                    <template v-if="app.receives_nothing">
                      <span class="text-grey-7">no subscriptions</span>
                    </template>
                    <template v-else>
                      <span
                        v-for="stream in streamsOf(app)"
                        :key="stream.key"
                        class="q-mr-xs"
                        :class="`text-${stream.color}`"
                      >
                        {{ stream.label }}
                      </span>
                    </template>
                  </q-item-label>
                </q-item-section>

                <q-item-section side>
                  <q-item-label caption>
                    <template v-if="app.connected === null">—</template>
                    <template v-else>{{ app.connected.toLocaleString() }} online</template>
                  </q-item-label>
                </q-item-section>

                <!-- Row actions, so an app can be managed without selecting it
                     first. .stop keeps the menu from also changing selection. -->
                <q-item-section v-if="isAdmin" side @click.stop>
                  <q-btn flat dense round icon="more_vert" size="sm" aria-label="Actions">
                    <q-menu auto-close>
                      <q-list style="min-width: 190px">
                        <q-item
                          v-for="stream in STREAMS"
                          :key="stream.key"
                          clickable
                          :disable="busy"
                          @click="toggleStream(app, stream)"
                        >
                          <q-item-section>
                            {{ app[stream.key] ? 'Stop sending' : 'Send' }} {{ stream.label }}
                          </q-item-section>
                        </q-item>
                        <q-separator />
                        <q-item
                          clickable
                          :disable="busy"
                          class="text-negative"
                          @click="removeApp(app)"
                        >
                          <q-item-section>Remove</q-item-section>
                        </q-item>
                      </q-list>
                    </q-menu>
                  </q-btn>
                </q-item-section>
              </q-item>
            </q-list>

            <q-card-section class="text-caption text-grey-7">
              Changes reach the consumers within {{ ttl }}s.
              <InfoHint :text="HINTS.propagation" />
            </q-card-section>
          </SectionCard>
        </div>

        <!-- Detail -->
        <div class="col-12 col-md-7">
          <SectionCard
            :title="selected ? selected.display_name || selected.app_id : 'What an app is'"
            flush
          >
            <template #actions>
              <div v-if="selected && isAdmin" class="q-gutter-sm">
                <q-btn
                  outline
                  dense
                  size="sm"
                  label="Rename"
                  :disable="busy"
                  @click="openRename(selected)"
                />
                <q-btn
                  outline
                  dense
                  size="sm"
                  color="negative"
                  label="Remove"
                  :disable="busy"
                  @click="removeApp(selected)"
                >
                  <q-tooltip class="hint-tooltip">{{ HINTS.remove }}</q-tooltip>
                </q-btn>
              </div>
            </template>

            <q-card-section v-if="!selected" class="text-body2 text-grey-7">
              <p class="q-mb-sm">
                An app is a consumer fleet: clients that connect over the WebSocket API, report
                where they are, and are sent what is relevant nearby.
              </p>
              <p class="q-mb-sm">
                Three independent subscriptions decide what "relevant" means, and each is served
                by a different consumer. An app may take any combination of them.
              </p>
              <p class="q-ma-none">Select an app to see and change its subscriptions.</p>
            </q-card-section>

            <template v-else>
              <q-card-section class="q-pt-md">
                <q-banner
                  v-if="selected.receives_nothing"
                  rounded
                  dense
                  class="bg-blue-1 text-grey-9 q-mb-md"
                >
                  <template #avatar><q-icon name="info" color="info" /></template>
                  <div class="text-weight-medium">This app receives nothing</div>
                  <div class="text-body2">
                    Its clients can connect and report position, and are sent no messages in
                    return. Turn on a subscription below.
                  </div>
                </q-banner>

                <q-list dense>
                  <q-item class="q-px-none">
                    <q-item-section>
                      <q-item-label caption>App id</q-item-label>
                      <q-item-label class="mono">{{ selected.app_id }}</q-item-label>
                    </q-item-section>
                    <q-item-section side>
                      <q-btn
                        flat
                        dense
                        round
                        size="sm"
                        icon="content_copy"
                        @click="copy(selected.app_id)"
                      >
                        <q-tooltip>Copy</q-tooltip>
                      </q-btn>
                    </q-item-section>
                  </q-item>
                  <q-item class="q-px-none">
                    <q-item-section>
                      <q-item-label caption>Connected now</q-item-label>
                      <q-item-label>
                        <template v-if="selected.connected === null">not counted</template>
                        <template v-else>
                          {{ selected.connected.toLocaleString() }}
                          <span class="text-caption text-grey-7">
                            · {{ selected.expiring_within_60s ?? 0 }} expiring within 60s
                          </span>
                        </template>
                      </q-item-label>
                    </q-item-section>
                    <q-item-section side>
                      <q-item-label caption>
                        Live inspection<InfoHint :text="HINTS.inspectable" anchor="center left" />
                      </q-item-label>
                      <q-item-label :class="selected.inspectable ? '' : 'text-grey-7'">
                        {{ selected.inspectable ? 'available' : 'not in clientAppIds' }}
                      </q-item-label>
                    </q-item-section>
                  </q-item>
                  <q-item class="q-px-none">
                    <q-item-section>
                      <q-item-label caption>Registered</q-item-label>
                      <q-item-label>
                        {{ new Date(selected.created_at).toLocaleString() }}
                      </q-item-label>
                    </q-item-section>
                    <q-item-section side>
                      <q-item-label caption>Last changed</q-item-label>
                      <q-item-label>
                        {{ new Date(selected.updated_at).toLocaleString() }}
                      </q-item-label>
                    </q-item-section>
                  </q-item>
                </q-list>
              </q-card-section>

              <q-separator />

              <!-- Subscriptions: the whole point of the page -->
              <q-card-section>
                <div class="text-subtitle2 q-mb-xs">Subscriptions</div>
                <div class="text-caption text-grey-7 q-mb-md">
                  Each is served by a different consumer, so they are independent. A change
                  takes up to {{ ttl }}s to reach them.
                </div>

                <q-list separator bordered class="rounded-borders">
                  <q-item v-for="stream in STREAMS" :key="stream.key">
                    <q-item-section avatar style="min-width: 40px">
                      <q-icon
                        :name="stream.icon"
                        size="20px"
                        :color="selected[stream.key] ? stream.color : 'grey-5'"
                      />
                    </q-item-section>
                    <q-item-section>
                      <q-item-label class="text-body2 text-weight-medium">
                        {{ stream.label }}
                      </q-item-label>
                      <q-item-label caption>{{ stream.detail }}</q-item-label>
                    </q-item-section>
                    <q-item-section side>
                      <q-toggle
                        :model-value="selected[stream.key]"
                        :disable="!isAdmin || busy"
                        :color="stream.color"
                        @update:model-value="toggleStream(selected, stream)"
                      >
                        <q-tooltip v-if="!isAdmin" class="hint-tooltip">
                          Changing what an app receives is an admin action.
                        </q-tooltip>
                      </q-toggle>
                    </q-item-section>
                  </q-item>
                </q-list>
              </q-card-section>
            </template>
          </SectionCard>
        </div>
      </div>
    </AsyncValue>

    <!-- Add app -->
    <q-dialog v-model="addOpen">
      <q-card style="min-width: min(480px, 92vw)">
        <q-card-section>
          <div class="text-h6">Add app</div>
        </q-card-section>

        <q-card-section class="q-gutter-md q-pt-none">
          <q-input v-model="addId" outlined dense label="App id" placeholder="e.g. app_demo" autofocus>
            <template #hint>
              Exactly what clients present when they connect. Letters, digits, dot, underscore,
              colon and hyphen — and it cannot be changed later, because it is embedded in the
              keys holding each client's live state.
            </template>
          </q-input>
          <q-input
            v-model="addDisplayName"
            outlined
            dense
            label="Display name (optional)"
            placeholder="Demo fleet"
            hint="Shown in the console instead of the raw id. Safe to change."
          />
        </q-card-section>

        <q-separator />

        <q-card-section>
          <div class="text-caption text-grey-7 text-uppercase text-weight-medium q-mb-sm">
            Subscriptions
          </div>
          <div v-for="stream in STREAMS" :key="stream.key" class="q-mb-sm">
            <q-toggle v-model="addStreams[stream.key]" :label="stream.label" :color="stream.color" />
            <div class="text-caption text-grey-7" style="margin-top: -4px">{{ stream.what }}</div>
          </div>
        </q-card-section>

        <q-banner dense class="bg-blue-1 text-grey-9 q-mx-md q-mb-md" rounded>
          <template #avatar><q-icon name="info" color="info" /></template>
          <div class="text-body2">
            An app with no subscriptions is valid — its clients connect and are sent nothing.
            You can turn streams on later; either way it takes up to {{ ttl }}s to take effect.
          </div>
        </q-banner>

        <q-card-actions align="right" class="q-pa-md q-pt-none">
          <q-btn flat label="Cancel" color="grey-8" @click="addOpen = false" />
          <q-btn unelevated color="primary" label="Register" :loading="busy" @click="submitAdd" />
        </q-card-actions>
      </q-card>
    </q-dialog>

    <!-- Rename -->
    <q-dialog v-model="renameOpen">
      <q-card style="min-width: min(420px, 92vw)">
        <q-card-section>
          <div class="text-h6">Rename app</div>
          <div class="text-caption text-grey-7 mono q-mt-xs">{{ selected?.app_id }}</div>
        </q-card-section>
        <q-card-section class="q-pt-none">
          <q-input
            v-model="renameValue"
            outlined
            dense
            label="Display name"
            autofocus
            hint="Console only. Clear it to fall back to the raw app id."
            @keyup.enter="submitRename"
          />
        </q-card-section>
        <q-card-actions align="right" class="q-pa-md q-pt-none">
          <q-btn flat label="Cancel" color="grey-8" @click="renameOpen = false" />
          <q-btn unelevated color="primary" label="Save" :loading="busy" @click="submitRename" />
        </q-card-actions>
      </q-card>
    </q-dialog>
  </q-page>
</template>

<style scoped>
code {
  background: rgba(0, 0, 0, 0.05);
  padding: 1px 5px;
  border-radius: 4px;
  font-size: 0.92em;
}
</style>

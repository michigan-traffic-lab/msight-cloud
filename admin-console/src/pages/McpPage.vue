<script setup lang="ts">
import { computed, ref } from 'vue';
import { useQuasar } from 'quasar';
import { config } from '@/config';
import { api, ApiError, type AdminRole, type McpToken } from '@/api/client';
import { useAsyncValue } from '@/composables/useAsyncValue';
import { useAuthStore } from '@/stores/auth';
import AsyncValue from '@/components/AsyncValue.vue';
import PageHeader from '@/components/PageHeader.vue';
import SectionCard from '@/components/SectionCard.vue';
import { since, when } from '@/format';

/**
 * The MCP endpoint, and the credentials that reach it.
 *
 * This page used to hand out the signed-in user's Cognito ID token. That is the
 * right credential for a browser and the wrong one for everything on this page:
 * an MCP client's configuration is a file read once at startup, with nowhere to
 * put a refresh, and a Cognito token lives an hour. The instructions said so —
 * "refresh it here and update the config each time" — which is not an
 * integration, it is a chore, and one whose failure reads as "server
 * disconnected" with nothing else to go on.
 *
 * So the credential is now a token this deployment issues: long-lived,
 * revocable, carrying a role of its own. The console shows the plaintext once,
 * at the moment it is created, because only a hash is stored and there is
 * nothing to show afterwards.
 *
 * Two things on this page look like mistakes and are not:
 *
 *   * The header is `X-Msight-Token`, not `Authorization`. `mcp-remote` — the
 *     bridge every desktop client uses to reach an HTTP MCP server — installs
 *     its own OAuth provider on the transport, and that provider overwrites
 *     Authorization on every request. A token passed there arrives at the API
 *     as the bare string "Bearer ". Any other header name survives untouched.
 *
 *   * The browser-hosted clients are documented as not connecting. They
 *     negotiate credentials over OAuth Dynamic Client Registration, which
 *     Cognito does not implement, and their dialogs have nowhere to put a
 *     token. Better to say so than to let someone find out by trying.
 */

const $q = useQuasar();
const auth = useAuthStore();

const mcpUrl = `${config.adminApiUrl}/mcp`;

/** Issuing needs operator. A viewer may read this page, but not the token list. */
const mayIssue = computed(() => auth.hasAtLeast('operator'));

// ── Tokens ────────────────────────────────────────────────────────────────

const tokens = useAsyncValue<{ tokens: McpToken[] }>((signal) =>
  mayIssue.value ? api.mcpTokens(signal) : Promise.resolve({ tokens: [] })
);

const rows = computed(() => tokens.data.value?.tokens ?? []);
const activeCount = computed(() => rows.value.filter((token) => token.active).length);

/**
 * The plaintext of a token created in this browser session.
 *
 * Held in memory only, and only until the page is left. It is fed into every
 * snippet below so that the copy buttons produce something that works, rather
 * than something that has to be edited afterwards.
 */
const revealed = ref<{ name: string; token: string } | null>(null);

/** What the snippets show when nothing has been minted here yet. */
const snippetToken = computed(() => revealed.value?.token ?? '<paste-your-token>');

/** The same value without the placeholder, for the copy button on the banner. */
const revealedToken = computed(() => revealed.value?.token ?? '');

const busy = ref(false);

// ── Create ────────────────────────────────────────────────────────────────

const createOpen = ref(false);
const newName = ref('');
const newRole = ref<AdminRole>('viewer');
const newExpiry = ref<number | null>(null);

const EXPIRY_CHOICES = [
  { label: 'Never', value: null },
  { label: '30 days', value: 30 },
  { label: '90 days', value: 90 },
  { label: '1 year', value: 365 },
];

/**
 * A token may carry at most the role of whoever issues it, so the options stop
 * at the caller's own. The service enforces the same rule; offering a choice it
 * would refuse only buys a worse error message.
 */
const ROLE_CHOICES: { label: string; value: AdminRole; what: string }[] = [
  {
    label: 'Viewer',
    value: 'viewer',
    what: 'Read-only: service status, logs, metrics, alarms, sensors, maps.',
  },
  {
    label: 'Operator',
    value: 'operator',
    what: 'Adds the day-to-day repairs — restart, dismiss a launch, re-check a source, read data and query logs.',
  },
  {
    label: 'Admin',
    value: 'admin',
    what: 'Everything: launch and tear down services, change capacity, edit data, manage users. Give this out sparingly.',
  },
];

const roleOptions = computed(() => ROLE_CHOICES.filter((choice) => auth.hasAtLeast(choice.value)));

function openCreate() {
  newName.value = '';
  newRole.value = 'viewer';
  newExpiry.value = null;
  createOpen.value = true;
}

async function submitCreate() {
  const name = newName.value.trim();
  if (name.length < 2) {
    $q.notify({
      type: 'warning',
      message: 'Give the token a name — it is the only way to tell two of them apart.',
      position: 'top',
    });
    return;
  }

  busy.value = true;
  try {
    const result = await api.mcpTokenCreate({
      name,
      role: newRole.value,
      expires_in_days: newExpiry.value,
    });
    revealed.value = { name: result.mcp_token.name, token: result.token };
    createOpen.value = false;
    await tokens.reload();
    $q.notify({
      type: 'positive',
      message: `Created "${name}". Copy it now — it is not shown again.`,
      position: 'top',
      timeout: 4000,
    });
  } catch (caught) {
    $q.notify({
      type: 'negative',
      message: caught instanceof ApiError ? caught.message : 'Could not create the token.',
      position: 'top',
      timeout: 6000,
    });
  } finally {
    busy.value = false;
  }
}

// ── Revoke ────────────────────────────────────────────────────────────────

const revokeTarget = ref<McpToken | null>(null);

async function confirmRevoke() {
  const target = revokeTarget.value;
  if (!target) {
    return;
  }

  busy.value = true;
  try {
    await api.mcpTokenRevoke(target.name);
    if (revealed.value?.name === target.name) {
      revealed.value = null;
    }
    revokeTarget.value = null;
    await tokens.reload();
    $q.notify({ type: 'positive', message: `Revoked "${target.name}".`, position: 'top' });
  } catch (caught) {
    $q.notify({
      type: 'negative',
      message: caught instanceof ApiError ? caught.message : 'Could not revoke the token.',
      position: 'top',
    });
  } finally {
    busy.value = false;
  }
}

interface TokenStatus {
  text: string;
  /** Both colours spelled out: a Quasar palette name has no derivable tint. */
  colour: string;
  textColour: string;
}

function statusOf(token: McpToken): TokenStatus {
  if (token.revoked_at) {
    return { text: 'Revoked', colour: 'grey-3', textColour: 'grey-8' };
  }
  if (!token.active) {
    return { text: 'Expired', colour: 'red-1', textColour: 'negative' };
  }
  // Worth separating from "Active": a token that has never been used is either
  // brand new or was pasted somewhere wrong, and the two look identical until
  // you notice nothing has ever presented it.
  if (!token.last_used_at) {
    return { text: 'Never used', colour: 'amber-1', textColour: 'warning' };
  }
  return { text: 'Active', colour: 'green-1', textColour: 'positive' };
}

function copy(text: string, label: string) {
  void navigator.clipboard.writeText(text).then(() => {
    $q.notify({ message: label, color: 'positive', icon: 'check', timeout: 1500, position: 'top' });
  });
}

// ── Providers ─────────────────────────────────────────────────────────────

const provider = ref('claude');

const providers = [
  { id: 'claude', label: 'Claude', icon: 'smart_toy' },
  { id: 'chatgpt', label: 'ChatGPT', icon: 'chat' },
  { id: 'gemini', label: 'Gemini', icon: 'auto_awesome' },
  { id: 'cursor', label: 'Cursor', icon: 'code' },
  { id: 'windsurf', label: 'Windsurf', icon: 'air' },
  { id: 'generic', label: 'Other', icon: 'extension' },
];

const HEADER_NAME = 'X-Msight-Token';

/**
 * `mcp-remote` takes one `--header` argument and splits it on the first colon,
 * so name and value are a single string. Written without a space after the
 * colon: a space is tolerated by current versions, but this is the form that
 * has been verified against the deployed endpoint, and the failure mode if a
 * version stops tolerating it is a 401 inside a subprocess nobody can see.
 */
const claudeDesktopServerEntry = computed(() => ({
  command: 'npx',
  args: [
    '-y',
    'mcp-remote',
    mcpUrl,
    '--transport',
    'http-only',
    '--header',
    `${HEADER_NAME}:${snippetToken.value}`,
  ],
}));

/** The single entry to paste inside an existing "mcpServers" block. */
const claudeDesktopSnippet = computed(() =>
  JSON.stringify({ 'msight-cloud': claudeDesktopServerEntry.value }, null, 2)
);

/** What the merged result looks like, with a placeholder sibling. */
const claudeDesktopMergeExample = computed(() =>
  JSON.stringify(
    {
      mcpServers: {
        'other-server': { '...': '...' },
        'msight-cloud': claudeDesktopServerEntry.value,
      },
    },
    null,
    2
  )
);

const claudeDesktopConfig = computed(() =>
  JSON.stringify({ mcpServers: { 'msight-cloud': claudeDesktopServerEntry.value } }, null, 2)
);

const curlTest = computed(
  () => `curl -s -X POST ${mcpUrl} \\
  -H "${HEADER_NAME}: ${snippetToken.value}" \\
  -H "Content-Type: application/json" \\
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","clientInfo":{"name":"test","version":"1.0"},"capabilities":{}}}'`
);

const geminiConfig = computed(() =>
  JSON.stringify(
    {
      mcpServers: {
        'msight-cloud': {
          httpUrl: mcpUrl,
          headers: { [HEADER_NAME]: snippetToken.value },
          timeout: 30000,
        },
      },
    },
    null,
    2
  )
);

const cursorConfig = computed(() =>
  JSON.stringify(
    {
      mcpServers: {
        'msight-cloud': { url: mcpUrl, headers: { [HEADER_NAME]: snippetToken.value } },
      },
    },
    null,
    2
  )
);

const windsurfConfig = computed(() =>
  JSON.stringify(
    {
      mcpServers: {
        'msight-cloud': { serverUrl: mcpUrl, headers: { [HEADER_NAME]: snippetToken.value } },
      },
    },
    null,
    2
  )
);

const genericExample = computed(
  () => `POST ${mcpUrl}
${HEADER_NAME}: ${snippetToken.value}
Content-Type: application/json

{
  "jsonrpc": "2.0",
  "id": 1,
  "method": "initialize",
  "params": {
    "protocolVersion": "2024-11-05",
    "clientInfo": { "name": "my-client", "version": "1.0" },
    "capabilities": {}
  }
}`
);

const claudeDesktopSteps = [
  'Make sure <strong>Node.js &ge; 18</strong> is installed (<code>node --version</code>).',
  'Create a token above and copy it — the snippets on the right fill themselves in with it while this page is open.',
  'Open Claude Desktop &rarr; <strong>Settings &rarr; Developer &rarr; Edit Config</strong>. The file opens in your text editor.',
  'If the file already has an <code>"mcpServers"</code> key, paste the first snippet <em>inside</em> that object. If it is empty or missing, paste the full config instead.',
  'Save the file.',
  'Fully quit Claude Desktop — <strong>File &rarr; Quit</strong>, or right-click the tray icon and choose Quit — then relaunch. Closing the window is not enough: the bridge is a child process that keeps running.',
  'Ask <em>"what alarms are firing?"</em> to verify. If it still says "server disconnected", run the curl command below: a JSON-RPC response proves the server and the token are fine and puts the fault in the config file.',
];

const cursorSteps = [
  'Create a token above and copy it.',
  'Open or create <code>~/.cursor/mcp.json</code> (global) or <code>.cursor/mcp.json</code> in your project.',
  'Paste the JSON on the right.',
  'Cursor hot-reloads MCP config — no restart needed.',
  'Open the chat panel and ask <em>"show me the status of all services"</em>.',
];

const windsurfSteps = [
  'Create a token above and copy it.',
  'Open or create <code>~/.codeium/windsurf/mcp_config.json</code>.',
  'Paste the JSON on the right. The key is <code>serverUrl</code>, not <code>url</code> — the wrong one fails silently.',
  'Restart Windsurf.',
  'Ask Cascade <em>"are any alarms in ALARM state?"</em> to verify.',
];

const geminiCliSteps = [
  'Install: <code>npm install -g @google/gemini-cli</code>.',
  'Create a token above and copy it.',
  'Open or create <code>~/.gemini/settings.json</code> and paste the config on the right.',
  'Run <code>gemini</code> in your terminal.',
  'Ask <em>"are any CloudWatch alarms firing?"</em> to verify.',
];

// ── Tool list ─────────────────────────────────────────────────────────────

/**
 * What the server exposes, by the role a token carries.
 *
 * Counts and categories rather than eighty names. The question someone asks on
 * this page is "what will this token let the assistant do", and the answer that
 * matters is the shape of the set — a connected client can always list the
 * tools itself, in far more detail than a card could.
 *
 * The numbers are pinned by a test against the server's own table. The block
 * that used to be here was a hand-copied list of thirteen tools that had
 * drifted to a sixth of the truth without anyone noticing, which is how a
 * reader concludes the server cannot do something it has done all along.
 */
const TOOL_COUNTS: Record<AdminRole, number> = { viewer: 11, operator: 36, admin: 80 };

const TOOL_GROUPS: { label: string; icon: string; what: string }[] = [
  {
    label: 'Microservices',
    icon: 'lan',
    what: 'Inspect, launch, rebuild, deploy, restart, roll back, read logs and metrics, set retention, and tear down.',
  },
  {
    label: 'Sensors',
    icon: 'sensors',
    what: 'List, register, enable and disable, change streaming and archive settings, and reconcile.',
  },
  {
    label: 'Clusters',
    icon: 'memory',
    what: 'List, check health, create, resize, provision and deprovision compute capacity.',
  },
  {
    label: 'Apps and clients',
    icon: 'group',
    what: 'Manage app registrations, count connected clients, look one up, and search by radius.',
  },
  {
    label: 'Storage',
    icon: 'inventory_2',
    what: 'List registered and available buckets, browse objects, register and unregister.',
  },
  {
    label: 'Data',
    icon: 'storage',
    what: 'Query Aurora, read and edit rows, and inspect or repair Valkey keys.',
  },
  {
    label: 'Operations',
    icon: 'monitor_heart',
    what: 'Alarms, CloudWatch Insights queries, network topology, cost, users, and system info.',
  },
];
</script>

<template>
  <q-page padding>
    <PageHeader
      title="MCP server"
      subtitle="Connect an AI assistant to this deployment. It reads service status, tails logs and inspects alarms — and, with an admin token, restarts services and rolls back deployments."
    >
      <template #actions>
        <q-btn
          v-if="mayIssue"
          unelevated
          color="primary"
          icon="key"
          label="New token"
          no-caps
          @click="openCreate"
        />
      </template>
    </PageHeader>

    <!--
      Shown once, immediately after creation, and never again: only the hash is
      stored. Deliberately loud — a token scrolled past is a token that has to be
      revoked and reissued.
    -->
    <q-banner v-if="revealed" rounded class="bg-green-1 q-mb-md reveal-banner">
      <template #avatar><q-icon name="vpn_key" color="positive" /></template>
      <div class="text-weight-medium">
        Token “{{ revealed.name }}” created. This is the only time it is shown.
      </div>
      <div class="text-caption text-grey-8 q-mt-xs">
        Only a hash is stored, so it cannot be shown again or recovered. If you lose it, revoke
        it and create another. The snippets below already contain it.
      </div>
      <q-input
        :model-value="revealedToken"
        readonly
        outlined
        dense
        class="q-mt-sm bg-white"
        input-class="mono"
      >
        <template #append>
          <q-btn
            flat
            round
            dense
            icon="content_copy"
            size="sm"
            @click="copy(revealedToken, 'Token copied')"
          />
        </template>
      </q-input>
      <template #action>
        <q-btn flat dense no-caps label="Dismiss" color="grey-8" @click="revealed = null" />
      </template>
    </q-banner>

    <div class="row q-col-gutter-md">
      <!-- Endpoint -->
      <div class="col-12 col-md-6">
        <SectionCard title="Endpoint">
          <q-input :model-value="mcpUrl" readonly dense outlined input-class="mono">
            <template #append>
              <q-btn
                flat
                round
                dense
                icon="content_copy"
                size="sm"
                @click="copy(mcpUrl, 'URL copied')"
              />
            </template>
          </q-input>
          <div class="text-caption text-grey-7 q-mt-sm">
            Streamable HTTP transport, MCP protocol 2024-11-05. The same URL works in every
            client below.
          </div>
        </SectionCard>
      </div>

      <!-- Authentication -->
      <div class="col-12 col-md-6">
        <SectionCard title="Authentication">
          <q-input
            :model-value="`${HEADER_NAME}: <token>`"
            readonly
            dense
            outlined
            input-class="mono"
          />
          <div class="text-caption text-grey-7 q-mt-sm">
            Not <code>Authorization</code>, and not by preference. <code>mcp-remote</code> — the
            bridge desktop clients use to reach an HTTP server — installs its own OAuth provider
            and overwrites <code>Authorization</code> on every request, so a token put there
            arrives as the bare word <code>Bearer</code>. This header name passes through
            untouched.
          </div>
        </SectionCard>
      </div>

      <!-- Tokens -->
      <div class="col-12">
        <SectionCard
          title="Access tokens"
          lede="Long-lived credentials for MCP clients. Each carries its own role, is revocable on its own, and is independent of the person who created it — revoking one logs nobody out."
          flush
        >
          <template #actions>
            <q-badge v-if="mayIssue" color="grey-3" text-color="grey-8">
              {{ activeCount }} active
            </q-badge>
            <q-btn
              v-if="mayIssue"
              flat
              round
              dense
              icon="refresh"
              size="sm"
              :loading="tokens.state.value === 'loading'"
              @click="tokens.reload()"
            />
          </template>

          <div v-if="!mayIssue" class="q-pa-md text-body2 text-grey-7">
            Issuing an MCP token needs the operator role. You can still use a token someone else
            issues you — the setup instructions below apply unchanged.
          </div>

          <AsyncValue v-else :state="tokens.state.value" :error="tokens.error.value">
            <div v-if="rows.length === 0" class="q-pa-lg text-center text-grey-7">
              <q-icon name="key_off" size="30px" color="grey-5" />
              <div class="text-body2 q-mt-sm">No tokens yet.</div>
              <div class="text-caption q-mt-xs" style="max-width: 56ch; margin: 0 auto">
                A client needs one to connect. Create one per machine or per person, so that
                revoking it takes down exactly one thing.
              </div>
              <q-btn
                unelevated
                color="primary"
                icon="key"
                label="New token"
                no-caps
                class="q-mt-md"
                @click="openCreate"
              />
            </div>

            <q-markup-table v-else flat dense class="token-table">
              <thead>
                <tr>
                  <th class="text-left">Name</th>
                  <th class="text-left">Role</th>
                  <th class="text-left">Token</th>
                  <th class="text-left">Created</th>
                  <th class="text-left">Last used</th>
                  <th class="text-left">Status</th>
                  <th class="text-right"></th>
                </tr>
              </thead>
              <tbody>
                <tr v-for="token in rows" :key="token.name" :class="token.active ? '' : 'inactive'">
                  <td class="text-left text-weight-medium">{{ token.name }}</td>
                  <td class="text-left">
                    <q-badge
                      :color="token.role === 'admin' ? 'red-1' : 'grey-3'"
                      :text-color="token.role === 'admin' ? 'negative' : 'grey-8'"
                    >
                      {{ token.role }}
                    </q-badge>
                  </td>
                  <td class="text-left mono text-grey-7">{{ token.hint }}…</td>
                  <td class="text-left">
                    {{ when(token.created_at) }}
                    <div class="text-caption text-grey-6">by {{ token.created_by }}</div>
                  </td>
                  <td class="text-left">
                    <span v-if="token.last_used_at">
                      {{ since(token.last_used_at) }}
                      <q-tooltip>{{ when(token.last_used_at) }}</q-tooltip>
                    </span>
                    <span v-else class="text-grey-6">—</span>
                  </td>
                  <td class="text-left">
                    <q-badge
                      :color="statusOf(token).colour"
                      :text-color="statusOf(token).textColour"
                    >
                      {{ statusOf(token).text }}
                    </q-badge>
                    <div v-if="token.expires_at && !token.revoked_at" class="text-caption text-grey-6">
                      expires {{ when(token.expires_at) }}
                    </div>
                  </td>
                  <td class="text-right">
                    <q-btn
                      v-if="!token.revoked_at"
                      flat
                      dense
                      no-caps
                      size="sm"
                      color="negative"
                      label="Revoke"
                      @click="revokeTarget = token"
                    />
                  </td>
                </tr>
              </tbody>
            </q-markup-table>
          </AsyncValue>
        </SectionCard>
      </div>

      <!-- Setup -->
      <div class="col-12">
        <q-card flat bordered class="setup-card">
          <q-card-section class="q-pb-none">
            <div class="section-title">Setup</div>
          </q-card-section>

          <q-tabs
            v-model="provider"
            dense
            align="left"
            class="q-px-md"
            indicator-color="primary"
            active-color="primary"
          >
            <q-tab
              v-for="p in providers"
              :key="p.id"
              :name="p.id"
              :label="p.label"
              :icon="p.icon"
              no-caps
            />
          </q-tabs>

          <q-separator />

          <q-tab-panels v-model="provider" animated>
            <!-- ── Claude ─────────────────────────────────────────────── -->
            <q-tab-panel name="claude" class="q-pa-md">
              <div class="row q-col-gutter-lg">
                <div class="col-12">
                  <div class="text-subtitle1 text-weight-medium">Claude Desktop</div>
                  <div class="text-caption text-grey-7 q-mb-sm">
                    Needs Node.js on the machine. <code>mcp-remote</code> bridges this hosted
                    HTTP endpoint into the stdio protocol Claude Desktop speaks, and passes the
                    token header through on every request.
                  </div>
                </div>

                <div class="col-12 col-md-5">
                  <q-list dense>
                    <q-item v-for="(step, i) in claudeDesktopSteps" :key="i" class="q-px-none">
                      <q-item-section avatar style="min-width: 28px">
                        <q-avatar size="22px" color="primary" text-color="white" class="text-caption">
                          {{ i + 1 }}
                        </q-avatar>
                      </q-item-section>
                      <q-item-section>
                        <q-item-label class="text-body2" v-html="step" />
                      </q-item-section>
                    </q-item>
                  </q-list>
                  <q-banner rounded class="bg-green-1 q-mt-md text-caption">
                    <template #avatar><q-icon name="check_circle" color="positive" /></template>
                    The token does not expire unless you gave it an expiry, so this config is
                    written once. Revoke it here when the machine is retired.
                  </q-banner>
                </div>

                <div class="col-12 col-md-7">
                  <div class="text-caption text-grey-7 q-mb-sm">
                    Mac: <code>~/Library/Application Support/Claude/claude_desktop_config.json</code
                    ><br />
                    Windows: <code>%APPDATA%\Claude\claude_desktop_config.json</code>
                  </div>

                  <div class="text-subtitle2 q-mb-xs">
                    If the file already has content — add this inside <code>"mcpServers"</code>
                    <q-btn
                      flat
                      dense
                      size="xs"
                      icon="content_copy"
                      class="q-ml-xs"
                      @click="copy(claudeDesktopSnippet, 'Snippet copied')"
                    />
                  </div>
                  <pre class="config-block">{{ claudeDesktopSnippet }}</pre>

                  <div class="text-caption text-grey-7 q-my-sm">
                    Your <code>mcpServers</code> block should look like this afterwards:
                  </div>
                  <pre class="config-block">{{ claudeDesktopMergeExample }}</pre>

                  <div class="text-subtitle2 q-mt-md q-mb-xs">
                    If the file is empty or does not exist — paste the whole thing
                    <q-btn
                      flat
                      dense
                      size="xs"
                      icon="content_copy"
                      class="q-ml-xs"
                      @click="copy(claudeDesktopConfig, 'Full config copied')"
                    />
                  </div>
                  <pre class="config-block">{{ claudeDesktopConfig }}</pre>

                  <div class="text-subtitle2 q-mt-md q-mb-xs">
                    Test the server directly, without any client
                    <q-btn
                      flat
                      dense
                      size="xs"
                      icon="content_copy"
                      class="q-ml-xs"
                      @click="copy(curlTest, 'curl command copied')"
                    />
                  </div>
                  <pre class="config-block">{{ curlTest }}</pre>
                  <div class="text-caption text-grey-7 q-mt-xs">
                    Success looks like
                    <code>{"jsonrpc":"2.0","id":1,"result":{"protocolVersion":"2024-11-05",…}}</code
                    >. A <code>401</code> means the token is wrong, revoked, or expired — check its
                    row above. A <code>404</code> means the URL is wrong.
                  </div>
                </div>

                <div class="col-12"><q-separator /></div>

                <div class="col-12">
                  <div class="text-subtitle1 text-weight-medium q-mb-xs">Claude.ai (web)</div>
                  <q-banner rounded class="bg-grey-2 text-caption">
                    <template #avatar><q-icon name="info" color="grey-7" /></template>
                    Custom connectors on claude.ai obtain their credentials over OAuth Dynamic
                    Client Registration, and the dialog has no field for a token. This deployment
                    authenticates with a header, so the web client cannot connect to it. Use
                    Claude Desktop, Claude Code, Cursor or the Gemini CLI, all of which pass a
                    static header.
                  </q-banner>
                </div>
              </div>
            </q-tab-panel>

            <!-- ── ChatGPT ────────────────────────────────────────────── -->
            <q-tab-panel name="chatgpt" class="q-pa-md">
              <div class="row q-col-gutter-md">
                <div class="col-12 col-md-7">
                  <div class="text-subtitle2 q-mb-sm">Not supported</div>
                  <q-banner rounded class="bg-grey-2 text-caption">
                    <template #avatar><q-icon name="info" color="grey-7" /></template>
                    ChatGPT's connector negotiates credentials over OAuth and offers no way to
                    send a fixed header, so it cannot authenticate against this endpoint. Entering
                    the URL will produce an authentication failure rather than a prompt for a
                    token.
                    <div class="q-mt-sm">
                      Supporting it would mean putting an OAuth authorisation server in front of
                      the MCP route — Cognito's hosted UI does not implement Dynamic Client
                      Registration, so this is a piece of work rather than a setting.
                    </div>
                  </q-banner>
                </div>
                <div class="col-12 col-md-5">
                  <div class="text-subtitle2 q-mb-sm">What works instead</div>
                  <q-list bordered separator rounded dense>
                    <q-item v-for="p in ['Claude Desktop', 'Claude Code', 'Cursor', 'Windsurf', 'Gemini CLI']" :key="p">
                      <q-item-section avatar style="min-width: 32px">
                        <q-icon name="check" color="positive" size="18px" />
                      </q-item-section>
                      <q-item-section>{{ p }}</q-item-section>
                    </q-item>
                  </q-list>
                </div>
              </div>
            </q-tab-panel>

            <!-- ── Gemini ─────────────────────────────────────────────── -->
            <q-tab-panel name="gemini" class="q-pa-md">
              <div class="row q-col-gutter-lg">
                <div class="col-12">
                  <div class="text-subtitle1 text-weight-medium">Gemini CLI</div>
                  <div class="text-caption text-grey-7 q-mb-sm">
                    Install with <code>npm install -g @google/gemini-cli</code>. It speaks
                    Streamable HTTP natively and sends arbitrary headers, so no bridge is needed.
                  </div>
                </div>
                <div class="col-12 col-md-5">
                  <q-list dense>
                    <q-item v-for="(step, i) in geminiCliSteps" :key="i" class="q-px-none">
                      <q-item-section avatar style="min-width: 28px">
                        <q-avatar size="22px" color="primary" text-color="white" class="text-caption">
                          {{ i + 1 }}
                        </q-avatar>
                      </q-item-section>
                      <q-item-section>
                        <q-item-label class="text-body2" v-html="step" />
                      </q-item-section>
                    </q-item>
                  </q-list>
                </div>
                <div class="col-12 col-md-7">
                  <div class="text-subtitle2 q-mb-xs">
                    ~/.gemini/settings.json
                    <q-btn
                      flat
                      dense
                      size="xs"
                      icon="content_copy"
                      class="q-ml-xs"
                      @click="copy(geminiConfig, 'Config copied')"
                    />
                  </div>
                  <div class="text-caption text-grey-7 q-mb-xs">
                    Use <code>httpUrl</code>, not <code>url</code> — <code>httpUrl</code> selects
                    Streamable HTTP, <code>url</code> selects SSE, which this server does not
                    serve.
                  </div>
                  <pre class="config-block">{{ geminiConfig }}</pre>
                </div>

                <div class="col-12"><q-separator /></div>

                <div class="col-12">
                  <div class="text-subtitle1 text-weight-medium q-mb-xs">
                    Gemini web and AI Studio
                  </div>
                  <q-banner rounded class="bg-grey-2 text-caption">
                    <template #avatar><q-icon name="info" color="grey-7" /></template>
                    Neither has a UI for adding a custom MCP server. Use the CLI above.
                  </q-banner>
                </div>
              </div>
            </q-tab-panel>

            <!-- ── Cursor ─────────────────────────────────────────────── -->
            <q-tab-panel name="cursor" class="q-pa-md">
              <div class="row q-col-gutter-md">
                <div class="col-12 col-md-5">
                  <div class="text-subtitle2 q-mb-sm">Steps</div>
                  <q-list dense>
                    <q-item v-for="(step, i) in cursorSteps" :key="i" class="q-px-none">
                      <q-item-section avatar style="min-width: 28px">
                        <q-avatar size="22px" color="primary" text-color="white" class="text-caption">
                          {{ i + 1 }}
                        </q-avatar>
                      </q-item-section>
                      <q-item-section>
                        <q-item-label class="text-body2" v-html="step" />
                      </q-item-section>
                    </q-item>
                  </q-list>
                </div>
                <div class="col-12 col-md-7">
                  <div class="text-subtitle2 q-mb-xs">
                    ~/.cursor/mcp.json <span class="text-grey-6">(global)</span> or
                    .cursor/mcp.json <span class="text-grey-6">(project)</span>
                    <q-btn
                      flat
                      dense
                      size="xs"
                      icon="content_copy"
                      class="q-ml-xs"
                      @click="copy(cursorConfig, 'Config copied')"
                    />
                  </div>
                  <pre class="config-block">{{ cursorConfig }}</pre>
                </div>
              </div>
            </q-tab-panel>

            <!-- ── Windsurf ───────────────────────────────────────────── -->
            <q-tab-panel name="windsurf" class="q-pa-md">
              <div class="row q-col-gutter-md">
                <div class="col-12 col-md-5">
                  <div class="text-subtitle2 q-mb-sm">Steps</div>
                  <q-list dense>
                    <q-item v-for="(step, i) in windsurfSteps" :key="i" class="q-px-none">
                      <q-item-section avatar style="min-width: 28px">
                        <q-avatar size="22px" color="primary" text-color="white" class="text-caption">
                          {{ i + 1 }}
                        </q-avatar>
                      </q-item-section>
                      <q-item-section>
                        <q-item-label class="text-body2" v-html="step" />
                      </q-item-section>
                    </q-item>
                  </q-list>
                </div>
                <div class="col-12 col-md-7">
                  <div class="text-subtitle2 q-mb-xs">
                    ~/.codeium/windsurf/mcp_config.json
                    <q-btn
                      flat
                      dense
                      size="xs"
                      icon="content_copy"
                      class="q-ml-xs"
                      @click="copy(windsurfConfig, 'Config copied')"
                    />
                  </div>
                  <pre class="config-block">{{ windsurfConfig }}</pre>
                </div>
              </div>
            </q-tab-panel>

            <!-- ── Other ──────────────────────────────────────────────── -->
            <q-tab-panel name="generic" class="q-pa-md">
              <div class="row q-col-gutter-md">
                <div class="col-12 col-md-5">
                  <div class="text-subtitle2 q-mb-sm">Connection details</div>
                  <q-list bordered separator rounded>
                    <q-item>
                      <q-item-section>
                        <q-item-label caption>Transport</q-item-label>
                        <q-item-label>Streamable HTTP (MCP 2024-11-05)</q-item-label>
                      </q-item-section>
                    </q-item>
                    <q-item>
                      <q-item-section>
                        <q-item-label caption>Endpoint</q-item-label>
                        <q-item-label class="mono">POST {{ mcpUrl }}</q-item-label>
                      </q-item-section>
                      <q-item-section side>
                        <q-btn
                          flat
                          dense
                          icon="content_copy"
                          size="sm"
                          @click="copy(mcpUrl, 'URL copied')"
                        />
                      </q-item-section>
                    </q-item>
                    <q-item>
                      <q-item-section>
                        <q-item-label caption>Required header</q-item-label>
                        <q-item-label class="mono">{{ HEADER_NAME }}: &lt;token&gt;</q-item-label>
                      </q-item-section>
                    </q-item>
                    <q-item>
                      <q-item-section>
                        <q-item-label caption>Content-Type</q-item-label>
                        <q-item-label class="mono">application/json</q-item-label>
                      </q-item-section>
                    </q-item>
                    <q-item>
                      <q-item-section>
                        <q-item-label caption>GET and DELETE</q-item-label>
                        <q-item-label class="text-body2">
                          Answered 405. There is no server-initiated stream and no session to
                          delete; every exchange is one POST.
                        </q-item-label>
                      </q-item-section>
                    </q-item>
                  </q-list>
                </div>
                <div class="col-12 col-md-7">
                  <div class="text-subtitle2 q-mb-sm">Example initialize request</div>
                  <pre class="config-block">{{ genericExample }}</pre>
                </div>
              </div>
            </q-tab-panel>
          </q-tab-panels>
        </q-card>
      </div>

      <!-- Tools -->
      <div class="col-12">
        <SectionCard
          title="Available tools"
          lede="What the assistant can do once connected. The floor applies to the token's role, not to yours — an admin who issues a viewer token gets the read-only set in that client."
        >
          <!--
            How many tools each role actually gets. This is the consequence of
            the choice made in the create dialog, and the number is the part
            people are surprised by: a viewer token is not "slightly less", it
            is an eighth of the surface.
          -->
          <div class="row q-col-gutter-sm q-mb-md">
            <div v-for="choice in ROLE_CHOICES" :key="choice.value" class="col-12 col-sm-4">
              <div class="tool-card q-pa-md rounded-borders">
                <div class="row items-baseline q-gutter-xs">
                  <div class="text-h6">{{ TOOL_COUNTS[choice.value] }}</div>
                  <div class="text-caption text-grey-7">of {{ TOOL_COUNTS.admin }} tools</div>
                </div>
                <div class="text-weight-medium q-mt-xs">{{ choice.label }} token</div>
                <div class="text-caption text-grey-7">{{ choice.what }}</div>
              </div>
            </div>
          </div>

          <q-list bordered separator class="rounded-borders">
            <q-item v-for="group in TOOL_GROUPS" :key="group.label">
              <q-item-section avatar style="min-width: 36px">
                <q-icon :name="group.icon" color="grey-7" size="20px" />
              </q-item-section>
              <q-item-section>
                <q-item-label class="text-weight-medium">{{ group.label }}</q-item-label>
                <q-item-label caption>{{ group.what }}</q-item-label>
              </q-item-section>
            </q-item>
          </q-list>

          <div class="text-caption text-grey-7 q-mt-sm" style="max-width: 76ch">
            A connected client lists the tools itself, with full descriptions and argument
            schemas — ask it what it can do. If a tool you expect is missing, the usual reason
            is the token's role: the <code>whoami</code> tool reports which one it holds.
          </div>
        </SectionCard>
      </div>
    </div>

    <!-- Create -->
    <q-dialog v-model="createOpen">
      <q-card style="min-width: min(480px, 92vw)">
        <q-card-section>
          <div class="text-h6">New MCP token</div>
        </q-card-section>

        <q-card-section class="q-gutter-md q-pt-none">
          <q-input
            v-model="newName"
            outlined
            dense
            label="Name"
            placeholder="e.g. rusheng-laptop"
            autofocus
            hint="A label, not a secret. One per machine or per person keeps revocation precise."
            @keyup.enter="submitCreate"
          />

          <div>
            <div class="text-caption text-grey-7 q-mb-xs">Role</div>
            <q-option-group v-model="newRole" :options="roleOptions" type="radio" dense />
            <div class="text-caption text-grey-7 q-mt-xs" style="max-width: 60ch">
              {{ ROLE_CHOICES.find((choice) => choice.value === newRole)?.what }}
            </div>
          </div>

          <q-select
            v-model="newExpiry"
            :options="EXPIRY_CHOICES"
            outlined
            dense
            emit-value
            map-options
            label="Expires"
            hint="A token that never expires is the point of this credential — the thing it replaces died hourly. Set one if the client is temporary."
          />
        </q-card-section>

        <q-banner dense rounded class="bg-blue-1 text-grey-9 q-mx-md q-mb-md">
          <template #avatar><q-icon name="info" color="info" /></template>
          <div class="text-body2">
            The token is shown once, on the next screen. Only its hash is stored, so it cannot be
            recovered afterwards — copy it before closing the banner.
          </div>
        </q-banner>

        <q-card-actions align="right" class="q-pa-md q-pt-none">
          <q-btn flat label="Cancel" color="grey-8" no-caps @click="createOpen = false" />
          <q-btn
            unelevated
            color="primary"
            label="Create token"
            no-caps
            :loading="busy"
            @click="submitCreate"
          />
        </q-card-actions>
      </q-card>
    </q-dialog>

    <!-- Revoke -->
    <q-dialog :model-value="revokeTarget !== null" @update:model-value="revokeTarget = null">
      <q-card style="min-width: min(440px, 92vw)">
        <q-card-section>
          <div class="text-h6">Revoke “{{ revokeTarget?.name }}”?</div>
        </q-card-section>
        <q-card-section class="q-pt-none text-body2 text-grey-8">
          Any client configured with this token stops working. Because token checks are cached at
          the API for five minutes, a request already in that window may still succeed briefly.
          <div class="q-mt-sm">
            This cannot be undone — a replacement is a new token, and every config holding the old
            one has to be updated.
          </div>
        </q-card-section>
        <q-card-actions align="right" class="q-pa-md q-pt-none">
          <q-btn flat label="Cancel" color="grey-8" no-caps @click="revokeTarget = null" />
          <q-btn
            unelevated
            color="negative"
            label="Revoke"
            no-caps
            :loading="busy"
            @click="confirmRevoke"
          />
        </q-card-actions>
      </q-card>
    </q-dialog>
  </q-page>
</template>

<style scoped>
.section-title {
  font-size: 12px;
  font-weight: 650;
  letter-spacing: 0.07em;
  text-transform: uppercase;
  color: #6b7688;
}

.setup-card {
  border-radius: 10px;
}

.config-block {
  background: #f4f6fa;
  border: 1px solid #e0e0e0;
  border-radius: 8px;
  padding: 12px 16px;
  font-size: 12px;
  line-height: 1.6;
  overflow-x: auto;
  white-space: pre;
  font-family: 'Roboto Mono', monospace;
  margin: 0;
}

.tool-card {
  background: #f4f6fa;
  border: 1px solid #e8eaed;
  height: 100%;
}

.mono,
:deep(.mono) {
  font-family: 'Roboto Mono', monospace;
}

.token-table :deep(th) {
  font-size: 11px;
  text-transform: uppercase;
  letter-spacing: 0.06em;
  color: #6b7688;
}

/* A revoked or expired row is history, not something to act on. */
.token-table tr.inactive {
  opacity: 0.6;
}

.reveal-banner :deep(.q-field__native) {
  font-family: 'Roboto Mono', monospace;
  font-size: 12px;
}

code {
  background: #f0f0f0;
  border-radius: 3px;
  padding: 1px 4px;
  font-size: 11px;
}
</style>

<template>
  <q-page padding>
    <div class="row q-col-gutter-md">

      <!-- Header -->
      <div class="col-12">
        <div class="text-h5 text-weight-medium q-mb-xs">MCP Server</div>
        <div class="text-body2 text-grey-7">
          Connect any AI assistant to manage your cloud using natural language.
          The server exposes your admin API as tools — the AI reads status, tails
          logs, and (if you are an admin) restarts services or rolls back deployments.
        </div>
      </div>

      <!-- Server URL + Token row -->
      <div class="col-12 col-md-6">
        <q-card flat bordered>
          <q-card-section>
            <div class="text-subtitle2 text-grey-8 q-mb-sm">MCP Server URL</div>
            <q-input
              :model-value="mcpUrl"
              readonly
              dense
              outlined
              class="mcp-url-input"
            >
              <template #append>
                <q-btn flat round dense icon="content_copy" size="sm" @click="copy(mcpUrl, 'URL copied')" />
              </template>
            </q-input>
            <div class="text-caption text-grey-6 q-mt-xs">
              Use this URL in any MCP client. The server uses Streamable HTTP transport (MCP 2024-11-05).
            </div>
          </q-card-section>
        </q-card>
      </div>

      <div class="col-12 col-md-6">
        <q-card flat bordered>
          <q-card-section>
            <div class="row items-center q-mb-sm">
              <div class="text-subtitle2 text-grey-8">Your Access Token</div>
              <q-space />
              <q-chip
                v-if="tokenExpiry"
                :color="tokenExpired ? 'negative' : tokenExpiringSoon ? 'warning' : 'positive'"
                text-color="white"
                dense
                size="sm"
              >
                {{ tokenExpired ? 'Expired' : tokenExpiringSoon ? 'Expiring soon' : 'Valid' }}
              </q-chip>
            </div>
            <q-input
              :model-value="maskedToken"
              readonly
              dense
              outlined
              type="text"
            >
              <template #append>
                <q-btn flat round dense icon="refresh" size="sm" @click="refreshToken" :loading="refreshing" />
                <q-btn flat round dense icon="content_copy" size="sm" @click="copy(token, 'Token copied')" :disable="!token" />
              </template>
            </q-input>
            <div class="text-caption text-grey-6 q-mt-xs">
              Cognito ID token — paste this into your MCP client config under
              <code>Authorization: Bearer &lt;token&gt;</code>.
              Expires in 1 hour; click refresh for a new one.
            </div>
          </q-card-section>
        </q-card>
      </div>

      <!-- Setup instructions -->
      <div class="col-12">
        <q-card flat bordered>
          <q-card-section class="q-pb-none">
            <div class="text-subtitle2 text-grey-8">Setup Instructions</div>
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

            <!-- Claude Desktop -->
            <q-tab-panel name="claude-desktop" class="q-pa-md">
              <div class="row q-col-gutter-md">
                <div class="col-12 col-md-5">
                  <div class="text-subtitle2 q-mb-sm">Steps</div>
                  <q-list dense>
                    <q-item v-for="(step, i) in claudeDesktopSteps" :key="i" class="q-px-none">
                      <q-item-section avatar style="min-width: 28px">
                        <q-avatar size="22px" color="primary" text-color="white" class="text-caption">{{ i + 1 }}</q-avatar>
                      </q-item-section>
                      <q-item-section>
                        <q-item-label class="text-body2" v-html="step" />
                      </q-item-section>
                    </q-item>
                  </q-list>
                  <q-banner rounded class="bg-amber-1 q-mt-md text-caption">
                    <template #avatar><q-icon name="schedule" color="warning" /></template>
                    Your token expires every hour. You will need to refresh it and update the config file each time.
                  </q-banner>
                </div>
                <div class="col-12 col-md-7">
                  <div class="text-subtitle2 q-mb-sm">
                    claude_desktop_config.json
                    <q-btn flat dense size="xs" icon="content_copy" class="q-ml-xs" @click="copy(claudeDesktopConfig, 'Config copied')" />
                  </div>
                  <pre class="config-block">{{ claudeDesktopConfig }}</pre>
                </div>
              </div>
            </q-tab-panel>

            <!-- Claude.ai -->
            <q-tab-panel name="claude-ai" class="q-pa-md">
              <div class="row q-col-gutter-md">
                <div class="col-12 col-md-5">
                  <div class="text-subtitle2 q-mb-sm">Steps</div>
                  <q-list dense>
                    <q-item v-for="(step, i) in claudeAiSteps" :key="i" class="q-px-none">
                      <q-item-section avatar style="min-width: 28px">
                        <q-avatar size="22px" color="primary" text-color="white" class="text-caption">{{ i + 1 }}</q-avatar>
                      </q-item-section>
                      <q-item-section>
                        <q-item-label class="text-body2" v-html="step" />
                      </q-item-section>
                    </q-item>
                  </q-list>
                  <q-banner rounded class="bg-blue-1 q-mt-md text-caption">
                    <template #avatar><q-icon name="info" color="info" /></template>
                    Claude.ai Pro and Team plans include MCP server support. Max plan includes it by default.
                  </q-banner>
                </div>
                <div class="col-12 col-md-7">
                  <div class="text-subtitle2 q-mb-sm">What to enter in the integration dialog</div>
                  <q-list bordered separator rounded>
                    <q-item>
                      <q-item-section>
                        <q-item-label caption>Server URL</q-item-label>
                        <q-item-label class="text-mono text-body2">{{ mcpUrl }}</q-item-label>
                      </q-item-section>
                      <q-item-section side>
                        <q-btn flat dense icon="content_copy" size="sm" @click="copy(mcpUrl, 'URL copied')" />
                      </q-item-section>
                    </q-item>
                    <q-item>
                      <q-item-section>
                        <q-item-label caption>Authorization Header</q-item-label>
                        <q-item-label class="text-mono text-body2">Bearer &lt;your token above&gt;</q-item-label>
                      </q-item-section>
                      <q-item-section side>
                        <q-btn flat dense icon="content_copy" size="sm" @click="copy('Bearer ' + token, 'Header copied')" :disable="!token" />
                      </q-item-section>
                    </q-item>
                  </q-list>
                </div>
              </div>
            </q-tab-panel>

            <!-- Cursor -->
            <q-tab-panel name="cursor" class="q-pa-md">
              <div class="row q-col-gutter-md">
                <div class="col-12 col-md-5">
                  <div class="text-subtitle2 q-mb-sm">Steps</div>
                  <q-list dense>
                    <q-item v-for="(step, i) in cursorSteps" :key="i" class="q-px-none">
                      <q-item-section avatar style="min-width: 28px">
                        <q-avatar size="22px" color="primary" text-color="white" class="text-caption">{{ i + 1 }}</q-avatar>
                      </q-item-section>
                      <q-item-section>
                        <q-item-label class="text-body2" v-html="step" />
                      </q-item-section>
                    </q-item>
                  </q-list>
                </div>
                <div class="col-12 col-md-7">
                  <div class="text-subtitle2 q-mb-sm">
                    .cursor/mcp.json
                    <q-btn flat dense size="xs" icon="content_copy" class="q-ml-xs" @click="copy(cursorConfig, 'Config copied')" />
                  </div>
                  <pre class="config-block">{{ cursorConfig }}</pre>
                </div>
              </div>
            </q-tab-panel>

            <!-- Windsurf / Codeium -->
            <q-tab-panel name="windsurf" class="q-pa-md">
              <div class="row q-col-gutter-md">
                <div class="col-12 col-md-5">
                  <div class="text-subtitle2 q-mb-sm">Steps</div>
                  <q-list dense>
                    <q-item v-for="(step, i) in windsurfSteps" :key="i" class="q-px-none">
                      <q-item-section avatar style="min-width: 28px">
                        <q-avatar size="22px" color="primary" text-color="white" class="text-caption">{{ i + 1 }}</q-avatar>
                      </q-item-section>
                      <q-item-section>
                        <q-item-label class="text-body2" v-html="step" />
                      </q-item-section>
                    </q-item>
                  </q-list>
                </div>
                <div class="col-12 col-md-7">
                  <div class="text-subtitle2 q-mb-sm">
                    ~/.codeium/windsurf/mcp_config.json
                    <q-btn flat dense size="xs" icon="content_copy" class="q-ml-xs" @click="copy(windsurfConfig, 'Config copied')" />
                  </div>
                  <pre class="config-block">{{ windsurfConfig }}</pre>
                </div>
              </div>
            </q-tab-panel>

            <!-- Generic -->
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
                        <q-item-label class="text-mono">POST {{ mcpUrl }}</q-item-label>
                      </q-item-section>
                      <q-item-section side>
                        <q-btn flat dense icon="content_copy" size="sm" @click="copy(mcpUrl, 'URL copied')" />
                      </q-item-section>
                    </q-item>
                    <q-item>
                      <q-item-section>
                        <q-item-label caption>Auth header</q-item-label>
                        <q-item-label class="text-mono">Authorization: Bearer &lt;token&gt;</q-item-label>
                      </q-item-section>
                    </q-item>
                    <q-item>
                      <q-item-section>
                        <q-item-label caption>Content-Type</q-item-label>
                        <q-item-label class="text-mono">application/json</q-item-label>
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

      <!-- Available tools -->
      <div class="col-12">
        <q-card flat bordered>
          <q-card-section>
            <div class="text-subtitle2 text-grey-8 q-mb-sm">Available Tools</div>
            <div class="text-caption text-grey-6 q-mb-md">
              Tools marked <q-chip size="xs" color="negative" text-color="white" dense>admin</q-chip>
              are only visible to users with the admin role.
            </div>
            <div class="row q-col-gutter-sm">
              <div v-for="tool in allTools" :key="tool.name" class="col-12 col-sm-6 col-md-4">
                <div class="tool-card q-pa-sm rounded-borders">
                  <div class="row items-center q-mb-xs">
                    <code class="text-caption text-primary">{{ tool.name }}</code>
                    <q-space />
                    <q-chip v-if="tool.minRole === 'admin'" size="xs" color="negative" text-color="white" dense>admin</q-chip>
                  </div>
                  <div class="text-caption text-grey-7">{{ tool.description }}</div>
                </div>
              </div>
            </div>
          </q-card-section>
        </q-card>
      </div>

    </div>
  </q-page>
</template>

<script setup lang="ts">
import { ref, computed, onMounted } from 'vue';
import { useQuasar } from 'quasar';
import { config } from '@/config';
import { idToken } from '@/auth/cognito';

const $q = useQuasar();

const mcpUrl = `${config.adminApiUrl}/mcp`;

const token = ref('');
const refreshing = ref(false);

const tokenExpiry = computed(() => {
  if (!token.value) return null;
  try {
    const parts = token.value.split('.');
    if (parts.length !== 3) return null;
    const payload = JSON.parse(atob(parts[1]!));
    return typeof payload.exp === 'number' ? payload.exp * 1000 : null;
  } catch {
    return null;
  }
});

const tokenExpired = computed(() =>
  tokenExpiry.value !== null && Date.now() > tokenExpiry.value
);

const tokenExpiringSoon = computed(() =>
  tokenExpiry.value !== null && !tokenExpired.value && Date.now() > tokenExpiry.value - 5 * 60 * 1000
);

const maskedToken = computed(() => {
  if (!token.value) return '';
  return token.value.slice(0, 20) + '…' + token.value.slice(-8);
});

async function refreshToken() {
  refreshing.value = true;
  try {
    const t = await idToken();
    token.value = t ?? '';
  } finally {
    refreshing.value = false;
  }
}

onMounted(refreshToken);

function copy(text: string, label: string) {
  navigator.clipboard.writeText(text).then(() => {
    $q.notify({ message: label, color: 'positive', icon: 'check', timeout: 1500 });
  });
}

// ── Providers ────────────────────────────────────────────────────────────────

const provider = ref('claude-desktop');

const providers = [
  { id: 'claude-desktop', label: 'Claude Desktop', icon: 'computer' },
  { id: 'claude-ai',      label: 'Claude.ai',      icon: 'language' },
  { id: 'cursor',         label: 'Cursor',          icon: 'code' },
  { id: 'windsurf',       label: 'Windsurf',        icon: 'air' },
  { id: 'generic',        label: 'Other',           icon: 'extension' },
];

// ── Config snippets ───────────────────────────────────────────────────────────

const claudeDesktopConfig = computed(() =>
  JSON.stringify({
    mcpServers: {
      'msight-cloud': {
        url: mcpUrl,
        headers: {
          Authorization: `Bearer ${token.value || '<paste-your-token>'}`,
        },
      },
    },
  }, null, 2)
);

const claudeDesktopSteps = [
  'Copy your token above (click the copy icon).',
  'Open <strong>Claude Desktop → Settings → Developer → Edit Config</strong>.',
  'Paste the JSON on the right into <code>claude_desktop_config.json</code>.',
  'Save the file and restart Claude Desktop.',
  'Start a conversation — type <em>"list my microservices"</em> to test.',
];

const claudeAiSteps = [
  'Copy your token above.',
  'Go to <strong>claude.ai → Settings → Integrations → Add Integration</strong>.',
  'Enter the Server URL and the Authorization header value shown on the right.',
  'Save. The tools appear automatically in new conversations.',
  'Start a conversation — type <em>"what alarms are firing?"</em> to test.',
];

const cursorConfig = computed(() =>
  JSON.stringify({
    mcpServers: {
      'msight-cloud': {
        url: mcpUrl,
        headers: {
          Authorization: `Bearer ${token.value || '<paste-your-token>'}`,
        },
      },
    },
  }, null, 2)
);

const cursorSteps = [
  'Copy your token above.',
  'In your project root, open (or create) <code>.cursor/mcp.json</code>.',
  'Paste the JSON on the right.',
  'Open Cursor\'s chat panel — the msight-cloud tools appear in the tool picker.',
  'Ask <em>"show me the status of all services"</em> to verify.',
];

const windsurfConfig = computed(() =>
  JSON.stringify({
    mcpServers: {
      'msight-cloud': {
        serverUrl: mcpUrl,
        headers: {
          Authorization: `Bearer ${token.value || '<paste-your-token>'}`,
        },
      },
    },
  }, null, 2)
);

const windsurfSteps = [
  'Copy your token above.',
  'Open <code>~/.codeium/windsurf/mcp_config.json</code> (create it if needed).',
  'Paste the JSON on the right.',
  'Restart Windsurf. The tools appear in the Cascade panel.',
  'Ask Cascade <em>"are any alarms in ALARM state?"</em> to verify.',
];

const genericExample = `POST ${mcpUrl}
Authorization: Bearer <your-token>
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
}`;

// ── Tool list (for display only) ─────────────────────────────────────────────

const allTools = [
  { name: 'list_microservices',       description: 'List all microservices with state',                          minRole: null },
  { name: 'get_microservice_status',  description: 'Full ECS status, image, and log summary for one service',    minRole: null },
  { name: 'get_microservice_logs',    description: 'Recent container or build log output',                        minRole: null },
  { name: 'get_microservice_metrics', description: 'CPU/memory utilization over the last 3 hours',               minRole: null },
  { name: 'list_microservice_images', description: 'Available ECR image tags for rollback',                      minRole: null },
  { name: 'list_microservice_builds', description: 'Recent CodeBuild history with commit SHA and duration',       minRole: null },
  { name: 'list_alarms',             description: 'CloudWatch alarms, filterable by state or name prefix',       minRole: null },
  { name: 'get_clients_summary',     description: 'Connected WebSocket client counts by app',                    minRole: null },
  { name: 'list_sensors',            description: 'Sensor list with queue depths and consumer status',            minRole: null },
  { name: 'restart_microservice',    description: 'Rolling restart of a deployed service (no downtime)',          minRole: 'admin' },
  { name: 'rollback_microservice',   description: 'Deploy a specific previous image tag',                        minRole: 'admin' },
  { name: 'suppress_alarm',          description: 'Disable alarm actions to silence it',                         minRole: 'admin' },
  { name: 'unsuppress_alarm',        description: 'Re-enable actions on a suppressed alarm',                     minRole: 'admin' },
];
</script>

<style scoped>
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
}

.tool-card {
  background: #f4f6fa;
  border: 1px solid #e8eaed;
  height: 100%;
}

.text-mono {
  font-family: 'Roboto Mono', monospace;
}

code {
  background: #f0f0f0;
  border-radius: 3px;
  padding: 1px 4px;
  font-size: 11px;
}
</style>

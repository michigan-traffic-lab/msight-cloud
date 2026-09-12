<script setup lang="ts">
import { computed, nextTick, ref } from 'vue';
import { useQuasar } from 'quasar';
import {
  api,
  ApiError,
  type GithubAppStatus,
  type GithubInstallation,
} from '@/api/client';
import { useAsyncValue } from '@/composables/useAsyncValue';
import AsyncValue from '@/components/AsyncValue.vue';
import InfoHint from '@/components/InfoHint.vue';
import PageHeader from '@/components/PageHeader.vue';
import SectionCard from '@/components/SectionCard.vue';
import { useAuthStore } from '@/stores/auth';

/**
 * The GitHub connection, on its own page under Settings.
 *
 * It lives here rather than on the Microservices page because it is not about
 * microservices: it is a deployment-wide integration, made once by one admin
 * and then never touched, while that page is a working list somebody opens
 * daily. Mixing the two put a one-time setup above the thing it enables, and
 * left the registry looking like an appendix to it.
 *
 * The separation matters more the moment this platform carries more than one
 * team's work: an installation is a grant held by the deployment, and where it
 * is managed should look like a deployment setting rather than a property of
 * whichever page happened to need it first.
 *
 * What is stored is deliberately not a GitHub account. One admin installs the
 * App once; what survives is an installation id belonging to the repository
 * owner and a private key that mints short-lived tokens against it, so every
 * later console user — with no GitHub account of their own — can configure a
 * service from it.
 */

const $q = useQuasar();
const auth = useAuthStore();
const isAdmin = computed(() => auth.isAdmin);

const HINTS = {
  connection:
    'The App is installed once, by one admin. What gets stored is a grant belonging to ' +
    'the repository owner — not a GitHub login — so it keeps working after that person ' +
    'leaves, and every other console user configures microservices without a GitHub ' +
    'account of their own.',
  selection:
    '"selected" means the owner picked specific repositories. "all" means every ' +
    'repository they own is reachable, including ones created later, without anyone ' +
    'consenting again.',
  permissions:
    'What GitHub says this installation actually granted. It can lag what the App now ' +
    'asks for: adding a permission leaves existing installations on the old set until ' +
    'the owner approves the change.',
  revoke:
    'Also uninstalls the App from the repository owner on GitHub. Without it the ' +
    'install stays listed in their settings with nothing here able to see or remove it.',
};

const appStatus = useAsyncValue<GithubAppStatus>((signal) => api.githubApp(signal));
const installations = useAsyncValue<{ installations: GithubInstallation[] }>((signal) =>
  api.githubInstallations(signal)
);

const busy = ref(false);

const installationList = computed<GithubInstallation[]>(
  () => installations.data.value?.installations ?? []
);
const connected = computed(() => appStatus.data.value?.configured === true);

/** Services are counted only to warn before disconnecting something in use. */
const services = useAsyncValue((signal) => api.microservices(signal));

const dependentCount = computed(() => services.data.value?.microservices.length ?? 0);

function reloadAll(): void {
  void appStatus.reload();
  void installations.reload();
  void services.reload();
}

function reportError(error: unknown, fallback: string): void {
  $q.notify({
    type: 'negative',
    message: error instanceof ApiError ? error.message : fallback,
    timeout: 0,
    actions: [{ label: 'Dismiss', color: 'white' }],
    position: 'top',
    multiLine: true,
  });
}

function formatWhen(iso: string | null): string {
  return iso ? new Date(iso).toLocaleString() : '—';
}


// --- One-click App creation ------------------------------------------------

// Empty means "create it under whoever is signed in to GitHub", which is the
// default path. The App is public, so which account or organisation it gets
// INSTALLED on is chosen on GitHub's own installation page — from a list GitHub
// renders, not from a name typed here. Only the advanced case, where the App
// itself should be owned by an organisation, fills this in.
const manifestOrg = ref('');
// Editable because the name is unique across the whole of GitHub — including
// against Apps this console has forgotten but GitHub still holds — so a
// collision needs fixing here rather than on GitHub's error page.
const manifestName = ref('');
const connecting = ref(false);

/**
 * The name the server uses when the field is left blank.
 *
 * Taken from the server rather than derived here: it knows the deployment name,
 * and one place deciding the rule is what keeps the placeholder honest. Shown
 * as a placeholder rather than pre-filled, so an untouched field still means
 * "whatever the deployment is called".
 */
const defaultAppName = computed(() => appStatus.data.value?.suggested_app_name ?? 'MSight');

function copyWebhookUrl(): void {
  const url = appStatus.data.value?.webhook_url ?? '';
  if (!url) return;
  void navigator.clipboard.writeText(url).then(() => {
    $q.notify({ message: 'Webhook URL copied', color: 'positive', icon: 'check', timeout: 1500 });
  });
}
const manifestForm = ref<HTMLFormElement | null>(null);
const manifestAction = ref('');
const manifestPayload = ref('');

/**
 * Hands the browser to GitHub with a manifest describing the App we need.
 *
 * A form POST rather than a fetch, and that is forced rather than stylistic:
 * GitHub creates an App only from a real top-level form submission, because it
 * renders a consent page first. No API can create one on someone's behalf, so
 * this is as automatic as the platform allows.
 *
 * The manifest is built and signed for server-side — this only submits it — so
 * the permissions being requested cannot be altered from the browser. The
 * `state` in the action URL is what proves the code GitHub sends back belongs
 * to a flow this deployment started.
 */
async function connectGithub(): Promise<void> {
  // Blank is the normal case and needs no prompting: GitHub creates the App
  // under the signed-in account, and asks where to install it next.
  const org = (manifestOrg.value ?? '').trim();

  connecting.value = true;
  try {
    const intent = await api.githubManifestIntent(org || null, manifestName.value.trim() || null);
    manifestAction.value = intent.create_url;
    manifestPayload.value = intent.manifest;

    // Let Vue write both bindings into the DOM before submitting; submitting
    // the form in the same tick posts the previous (empty) values.
    await nextTick();
    manifestForm.value?.submit();
  } catch (error) {
    connecting.value = false;
    reportError(error, 'Could not start the GitHub connection.');
  }
}

const appDialog = ref(false);
const appForm = ref({ app_id: '', private_key: '', webhook_secret: '' });
const appDialogError = ref<string | null>(null);

function openAppDialog(): void {
  appForm.value = { app_id: '', private_key: '', webhook_secret: '' };
  appDialogError.value = null;
  appDialog.value = true;
}

async function saveApp(): Promise<void> {
  appDialogError.value = null;
  busy.value = true;
  try {
    const result = await api.githubSaveApp({
      app_id: Number(appForm.value.app_id),
      private_key: appForm.value.private_key,
      webhook_secret: appForm.value.webhook_secret || null,
    });
    appDialog.value = false;
    $q.notify({
      type: 'positive',
      message: `Verified with GitHub as "${result.app.name ?? result.app.slug}".`,
    });
    void appStatus.reload();
  } catch (error) {
    // Held in the dialog rather than flashed as a toast: the message names what
    // is wrong with the credentials, and the fix is in the fields still on
    // screen.
    appDialogError.value =
      error instanceof ApiError ? error.message : 'The credentials could not be saved.';
  } finally {
    busy.value = false;
  }
}

/**
 * Clears the stored credentials — and says plainly what it does not do.
 *
 * GitHub exposes no API to delete a GitHub App, so this cannot remove it there
 * and never will. The consequence people hit is the one worth naming: App names
 * are unique across the whole of GitHub, so the forgotten App keeps holding its
 * name, and creating a replacement with the same name is refused. The delete
 * URL is captured before the row is cleared, because afterwards there is
 * nothing left to derive it from.
 */
function forgetApp(): void {
  const app = appStatus.data.value?.app ?? null;
  const deleteUrl = appStatus.data.value?.app_delete_url ?? null;
  const appLabel = app?.name || app?.slug || 'the App';

  $q.dialog({
    title: 'Forget the GitHub App?',
    message:
      `This clears the stored App ID and private key. It does not delete ${appLabel} on ` +
      'GitHub — there is no API for that, so it stays in your GitHub settings and keeps ' +
      'holding its name. GitHub App names are unique across all of GitHub, so creating a ' +
      'new App with the same name will be refused until you delete this one there.',
    cancel: true,
    ok: { label: 'Forget', color: 'negative', unelevated: true },
  }).onOk(() => {
    void (async () => {
      busy.value = true;
      try {
        await api.githubForgetApp();
        $q.notify({
          type: 'positive',
          message: 'App credentials cleared.',
          // Spread rather than an explicit undefined: exactOptionalPropertyTypes
          // rejects assigning undefined to an optional property.
          ...(deleteUrl
            ? { caption: `${appLabel} still exists on GitHub. Delete it there to free its name.` }
            : {}),
          timeout: deleteUrl ? 0 : 4000,
          actions: deleteUrl
            ? [
                {
                  label: 'Delete on GitHub',
                  color: 'white',
                  handler: () => window.open(deleteUrl, '_blank', 'noopener'),
                },
                { label: 'Dismiss', color: 'white' },
              ]
            : [],
        });
        reloadAll();
      } catch (error) {
        reportError(error, 'The credentials could not be cleared.');
      } finally {
        busy.value = false;
      }
    })();
  });
}

/**
 * Sends the browser to GitHub's own installation page.
 *
 * A full navigation rather than a popup: GitHub's consent screen is the
 * repository picker, and this console deliberately does not build one — so it
 * never sees the repositories the owner chose not to grant.
 */
async function connectRepository(): Promise<void> {
  busy.value = true;
  try {
    const intent = await api.githubInstallIntent();
    window.location.assign(intent.install_url);
  } catch (error) {
    reportError(error, 'Could not start the installation.');
    busy.value = false;
  }
}

function disconnect(installation: GithubInstallation): void {
  const revoke = ref(true);
  $q.dialog({
    title: `Disconnect ${installation.account_login}?`,
    message:
      'This deployment forgets the grant. Any microservice still built from it has to be ' +
      'removed first.',
    options: {
      type: 'checkbox',
      model: ['revoke'],
      items: [{ label: 'Also uninstall the App on GitHub', value: 'revoke' }],
    },
    cancel: true,
    ok: { label: 'Disconnect', color: 'negative', unelevated: true },
  }).onOk((picked: string[]) => {
    revoke.value = Array.isArray(picked) && picked.includes('revoke');
    void (async () => {
      busy.value = true;
      try {
        const result = await api.githubRemoveInstallation(
          installation.installation_id,
          revoke.value
        );
        $q.notify({
          type: result.revoke_error ? 'warning' : 'positive',
          message: result.revoke_error
            ? `Disconnected here, but GitHub refused the uninstall: ${result.revoke_error}`
            : 'Disconnected.',
          timeout: 8000,
          multiLine: true,
        });
        reloadAll();
      } catch (error) {
        reportError(error, 'Could not disconnect.');
      } finally {
        busy.value = false;
      }
    })();
  });
}
</script>

<template>
  <q-page padding>
    <div class="q-mb-sm">
      <q-btn
        flat
        dense
        no-caps
        size="sm"
        icon="arrow_back"
        label="Settings"
        :to="{ name: 'settings' }"
      />
    </div>

    <PageHeader title="GitHub App">
      <template #subtitle>
        The App this deployment builds microservices from. Installed once, by one admin —
        what is stored is a grant belonging to the repository owner rather than anybody's
        GitHub login, so it keeps working after that person leaves.
      </template>
      <template #actions>
        <q-btn
          outline
          color="primary"
          icon="refresh"
          label="Refresh"
          :loading="appStatus.state.value === 'loading'"
          @click="reloadAll"
        />
      </template>
    </PageHeader>


    <!-- GitHub connection -->
    <SectionCard
      title="GitHub connection"
      :lede="HINTS.connection"
      class="q-mb-md"
    >
      <template #actions>
        <q-btn
          v-if="isAdmin && connected"
          flat
          dense
          no-caps
          color="primary"
          icon="add_link"
          label="Connect a repository"
          :disable="busy"
          @click="connectRepository"
        />
        <q-btn
          v-if="isAdmin && connected"
          flat
          dense
          no-caps
          color="grey-7"
          icon="link_off"
          label="Forget App"
          :disable="busy"
          @click="forgetApp"
        />
      </template>

      <AsyncValue :state="appStatus.state.value" :error="appStatus.error.value">
        <!-- Not configured: the one-time setup, spelled out. -->
        <div v-if="!connected">
          <div class="text-body2" style="max-width: 60ch">
            Microservices are built from a repository's own Dockerfile, so this deployment
            needs read access to your code. Installing a GitHub App grants it — read-only, to
            the repositories you pick, owned by the account rather than by any person.
          </div>

          <q-banner
            v-if="appStatus.data.value?.app && !appStatus.data.value.secret_present"
            rounded
            class="bg-orange-1 text-grey-9 q-mt-md"
          >
            <template #avatar><q-icon name="warning" color="warning" /></template>
            An App is recorded (<span class="mono">{{ appStatus.data.value.app.slug }}</span>)
            but its private key is missing from Secrets Manager. Save the credentials again.
          </q-banner>

          <div v-if="isAdmin" class="q-mt-md">
            <div class="text-body2 q-mb-md" style="max-width: 60ch">
              Two clicks on GitHub: create the App, then choose where to install it. The
              permissions, callback URLs and private key are filled in and stored for you.
            </div>

            <!-- No account question here. GitHub puts no owner picker on the
                 App-creation page, so asking would mean asking for an org slug
                 from memory before the user has even signed in. The App is
                 public, so GitHub's install page lists every account and
                 organisation they can install on and the choice happens there,
                 signed in, from a real list. -->
            <!-- Editable up front rather than only on GitHub's error page:
                 App names are unique across all of GitHub, and an App this
                 console has forgotten still holds its name there. -->
            <q-input
              v-model="manifestName"
              outlined
              dense
              clearable
              label="App name"
              :placeholder="defaultAppName"
              class="q-mb-md"
              style="max-width: 340px"
              @keyup.enter="connectGithub"
            >
              <template #hint>
                Shown on GitHub's consent screen. Must be unique across all of GitHub — if it
                is taken, change it here or on GitHub's page.
              </template>
            </q-input>

            <div class="row items-center q-gutter-sm">
              <q-btn
                unelevated
                color="primary"
                icon="link"
                label="Install GitHub App"
                :loading="connecting"
                :disable="busy"
                @click="connectGithub"
              />
              <q-btn
                flat
                dense
                no-caps
                color="grey-8"
                label="I already have an App"
                :disable="busy || connecting"
                @click="openAppDialog"
              >
                <q-tooltip class="hint-tooltip">
                  Paste an existing App's ID and private key instead. Only needed if the App was
                  created outside this console, or has to be shared with another deployment.
                </q-tooltip>
              </q-btn>
            </div>

            <div class="text-caption text-grey-7 q-mt-sm" style="max-width: 60ch">
              Read-only on contents and metadata — enough to find a Dockerfile, and nothing
              that can change a repository.
            </div>

            <!-- The one thing the default gives up, offered rather than
                 imposed: an App owned by a person disappears with that
                 person's GitHub account, taking its installations along. A team
                 that cares names the organisation and accepts knowing it up
                 front — which is exactly the friction the default removes. -->
            <q-expansion-item
              dense
              dense-toggle
              class="q-mt-sm advanced-owner"
              label="Create the App under an organisation instead"
              header-class="text-caption text-grey-7"
            >
              <div class="q-pt-sm" style="max-width: 52ch">
                <div class="text-caption text-grey-7 q-mb-sm">
                  By default the App belongs to your own GitHub account, and it is deleted if
                  that account is — which would take every repository connection with it. An
                  App owned by an organisation outlives whoever set it up. You need owner or
                  App-manager rights in it.
                </div>
                <q-input
                  v-model="manifestOrg"
                  outlined
                  dense
                  clearable
                  label="Organisation"
                  placeholder="msight-tech"
                  style="max-width: 340px"
                  @keyup.enter="connectGithub"
                >
                  <template #hint>
                    The name as it appears in the URL —
                    <span class="mono">github.com/msight-tech</span> — not the display name.
                  </template>
                </q-input>
              </div>
            </q-expansion-item>

            <!-- GitHub only creates an App from a real form submission, so this
                 is posted by the browser rather than fetched. It is filled in
                 and submitted by connectGithub, then navigates away. -->
            <form ref="manifestForm" method="post" :action="manifestAction" class="hidden">
              <input type="hidden" name="manifest" :value="manifestPayload" />
            </form>
          </div>
          <div v-else class="text-body2 text-grey-7 q-mt-md">
            An administrator has to complete this once.
          </div>
        </div>

        <!-- Configured. -->
        <div v-else>
          <div class="row items-center q-gutter-sm">
            <q-icon name="verified" color="positive" size="20px" />
            <div class="text-body1 text-weight-medium">
              {{ appStatus.data.value?.app?.name ?? appStatus.data.value?.app?.slug }}
            </div>
            <q-chip dense square class="mono" color="grey-3" text-color="grey-8">
              app {{ appStatus.data.value?.app?.app_id }}
            </q-chip>
            <a
              v-if="appStatus.data.value?.app_settings_url"
              :href="appStatus.data.value.app_settings_url"
              target="_blank"
              rel="noopener"
              class="text-primary text-caption"
            >
              settings on GitHub
            </a>
          </div>
          <div class="text-caption text-grey-7 q-mt-xs">
            Credentials saved by {{ appStatus.data.value?.app?.configured_by }} on
            {{ formatWhen(appStatus.data.value?.app?.configured_at ?? null) }}. Since no GitHub
            identity is stored, this is the record of who wired it up.
          </div>

          <q-separator class="q-my-md" />

          <!--
            The one piece of this setup that cannot be done from here.
            `hook_attributes.active` is set when an App is created and there is
            no API to change it afterwards — `PATCH /app/hook/config` covers the
            URL, the content type and the secret, but not that flag. An App
            created before the receiver existed therefore has its webhook
            switched off, and nothing in this console can tell: GitHub does not
            report the flag either. So it is stated rather than detected.
          -->
          <div class="text-caption text-grey-7 text-uppercase q-mb-sm">Push deliveries</div>
          <div class="text-body2 text-grey-8" style="max-width: 74ch">
            A push to a branch a microservice builds from rebuilds and redeploys it. GitHub
            delivers those pushes here:
          </div>
          <q-input
            :model-value="appStatus.data.value?.webhook_url ?? ''"
            readonly
            dense
            outlined
            class="q-mt-sm"
            input-class="mono"
          >
            <template #append>
              <q-btn
                flat
                round
                dense
                size="sm"
                icon="content_copy"
                @click="copyWebhookUrl"
              />
            </template>
          </q-input>
          <q-banner rounded dense class="bg-amber-1 text-grey-9 q-mt-sm">
            <template #avatar><q-icon name="priority_high" color="warning" /></template>
            <div class="text-body2" style="max-width: 70ch">
              If this App was created before automatic rebuilds existed, its webhook is switched
              off and nothing will arrive. Open
              <a
                v-if="appStatus.data.value?.app_settings_url"
                :href="appStatus.data.value.app_settings_url"
                target="_blank"
                rel="noopener"
                class="text-primary"
                >the App's settings on GitHub</a
              ><span v-else>the App's settings on GitHub</span>, check that the Webhook URL
              matches the one above, and tick <strong>Active</strong>. There is no API for that
              flag, so it cannot be done from here. Apps created from now on have it on already.
            </div>
          </q-banner>

          <q-separator class="q-my-md" />

          <div class="text-caption text-grey-7 text-uppercase q-mb-sm">Installations</div>
          <AsyncValue :state="installations.state.value" :error="installations.error.value">
            <div v-if="!installationList.length" class="text-body2 text-grey-7">
              No repository access yet.
              <template v-if="isAdmin">
                Use <strong>Connect a repository</strong> — GitHub shows its own repository
                picker, so this console never sees the ones you do not grant.
              </template>
            </div>

            <q-list v-else bordered separator class="rounded-borders">
              <q-item v-for="install in installationList" :key="install.installation_id">
                <q-item-section avatar style="min-width: 34px">
                  <q-icon
                    :name="install.suspended ? 'pause_circle' : 'check_circle'"
                    :color="install.suspended ? 'warning' : 'positive'"
                    size="20px"
                  />
                </q-item-section>
                <q-item-section>
                  <q-item-label>
                    {{ install.account_login }}
                    <span class="text-caption text-grey-7">
                      · {{ install.target_type ?? install.account_type ?? 'account' }}
                    </span>
                  </q-item-label>
                  <q-item-label caption>
                    <span class="row items-center inline">
                      {{ install.repository_selection ?? 'unknown' }} repositories
                      <InfoHint :text="HINTS.selection" />
                    </span>
                    · connected by {{ install.connected_by }}
                    <span v-if="install.suspended" class="text-warning">
                      · suspended by the owner
                    </span>
                  </q-item-label>
                  <q-item-label caption class="q-mt-xs">
                    <q-chip
                      v-for="(value, key) in install.permissions"
                      :key="key"
                      dense
                      square
                      size="sm"
                      color="grey-3"
                      text-color="grey-8"
                      class="mono"
                    >
                      {{ key }}: {{ value }}
                    </q-chip>
                    <InfoHint :text="HINTS.permissions" />
                  </q-item-label>
                </q-item-section>
                <q-item-section side>
                  <q-btn
                    v-if="isAdmin"
                    flat
                    dense
                    round
                    icon="link_off"
                    color="grey-7"
                    :disable="busy"
                    @click="disconnect(install)"
                  >
                    <q-tooltip class="hint-tooltip">{{ HINTS.revoke }}</q-tooltip>
                  </q-btn>
                </q-item-section>
              </q-item>
            </q-list>
          </AsyncValue>
        </div>
      </AsyncValue>
    </SectionCard>

    <q-dialog v-model="appDialog" persistent>
      <q-card style="min-width: 560px; max-width: 92vw">
        <q-card-section>
          <div class="text-h6">GitHub App credentials</div>
          <div class="text-body2 text-grey-7 q-mt-xs">
            Stored in Secrets Manager and read only by the function that talks to GitHub. No
            route can read the key back out.
          </div>
        </q-card-section>

        <q-card-section class="q-gutter-md">
          <q-banner v-if="appDialogError" rounded class="bg-red-1 text-grey-9">
            <template #avatar><q-icon name="error" color="negative" /></template>
            {{ appDialogError }}
          </q-banner>

          <q-input
            v-model="appForm.app_id"
            outlined
            dense
            label="App ID"
            hint="The numeric ID at the top of the App's settings page."
            inputmode="numeric"
          />
          <q-input
            v-model="appForm.private_key"
            outlined
            dense
            type="textarea"
            rows="7"
            label="Private key (PEM)"
            hint="The whole .pem file, including the BEGIN and END lines."
            class="mono"
          />
          <q-input
            v-model="appForm.webhook_secret"
            outlined
            dense
            label="Webhook secret (optional)"
            hint="Not used yet. It is what will authenticate push events when builds are wired up."
          />
        </q-card-section>

        <q-card-actions align="right">
          <q-btn flat no-caps label="Cancel" :disable="busy" @click="appDialog = false" />
          <q-btn
            unelevated
            no-caps
            color="primary"
            label="Save and verify"
            :loading="busy"
            :disable="!appForm.app_id || !appForm.private_key"
            @click="saveApp"
          />
        </q-card-actions>
      </q-card>
    </q-dialog>

    <!-- Microservice dialog -->

    <!--
      Nothing to manage until the App exists, and the registry is where the
      grant is actually spent — so the page says where to go next rather than
      ending on a dead card.
    -->
    <div v-if="connected && installationList.length" class="q-mt-lg">
      <q-btn
        flat
        dense
        no-caps
        color="primary"
        icon-right="arrow_forward"
        :label="
          dependentCount
            ? dependentCount + ' microservice' + (dependentCount === 1 ? '' : 's') + ' use this connection'
            : 'Register a microservice from it'
        "
        :to="{ name: 'microservices' }"
      />
    </div>
  </q-page>
</template>

<style scoped>
.mono,
.mono :deep(input),
.mono :deep(textarea) {
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
}

.detail-table {
  width: 100%;
  border-collapse: collapse;
  font-size: 13px;
}

.detail-table th {
  text-align: left;
  font-weight: 500;
  color: #6b7688;
  padding: 5px 12px 5px 0;
  white-space: nowrap;
  vertical-align: top;
  width: 1%;
}

.detail-table td {
  padding: 5px 0;
  color: #1c2434;
  word-break: break-all;
}

.setup-list {
  padding-left: 20px;
  margin: 8px 0 14px;
  line-height: 1.7;
}

.setup-list li {
  margin-bottom: 8px;
}

.url-box {
  background: #f4f6fa;
  border: 1px solid #e2e6ee;
  border-radius: 6px;
  padding: 6px 10px;
  margin: 5px 0;
  font-size: 12.5px;
  word-break: break-all;
  user-select: all;
}
</style>

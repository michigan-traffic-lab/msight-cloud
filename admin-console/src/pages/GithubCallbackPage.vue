<script setup lang="ts">
import { onMounted, ref } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { api, ApiError, type GithubApp, type GithubInstallationRepos } from '@/api/client';

/**
 * Where GitHub sends the browser after someone installs the App.
 *
 * This page exists because of a constraint rather than a design preference.
 * GitHub finishes the install by redirecting a *browser*, and a top-level
 * redirect carries no Authorization header — so pointing the App's setup URL at
 * the admin API would hit its Cognito authorizer and 401 before any Lambda ran,
 * losing the installation id with it.
 *
 * CloudFront serves this page with no authorizer, the session is already in the
 * browser, and the call below is an ordinary authenticated request. That is the
 * whole trick: the static site bridges the gap, and the API keeps every route
 * behind Cognito.
 *
 * If the session happens to have expired, the router guard sends the user to
 * the login page with this full URL — query string included — as the redirect
 * target, so the handshake survives signing back in.
 */

const route = useRoute();
const router = useRouter();

type Phase = 'working' | 'installing' | 'done' | 'failed';

const phase = ref<Phase>('working');
const message = ref<string | null>(null);
const result = ref<GithubInstallationRepos | null>(null);
/** Set only on the App-creation half, to name what was just made. */
const createdApp = ref<GithubApp | null>(null);

function firstQueryValue(key: string): string | null {
  const raw = route.query[key];
  const value = Array.isArray(raw) ? raw[0] : raw;
  return typeof value === 'string' && value.length > 0 ? value : null;
}

/**
 * One URL, two arrivals.
 *
 * GitHub uses this same address for both halves of the setup, distinguished
 * only by what it puts in the query string:
 *
 *   ?code=…&state=…             an App was just created from our manifest
 *   ?installation_id=…&state=…  the App was installed on an account
 *
 * They have to share a URL because a GitHub App has one Setup URL and one
 * Callback URL, and the manifest sets both to this page.
 */
onMounted(async () => {
  const state = firstQueryValue('state');
  const code = firstQueryValue('code');
  const installationId = firstQueryValue('installation_id');

  if (!state || (!code && !installationId)) {
    phase.value = 'failed';
    message.value =
      'GitHub did not include the expected parameters in the redirect. Start the ' +
      'connection again from the Microservices page — and if this keeps happening, check ' +
      'that the App\'s Setup URL matches the one in the stack outputs exactly.';
    return;
  }

  // Half one: the App now exists and GitHub is handing over its credentials.
  // On success we go straight on to installing it, because an App that is
  // created but never installed grants nothing — leaving the operator on a
  // "done" screen here would be leaving them halfway.
  if (code) {
    try {
      const created = await api.githubCompleteManifest({ code, state });
      createdApp.value = created.app;
      phase.value = 'installing';

      const intent = await api.githubInstallIntent();
      window.location.assign(intent.install_url);
      return;
    } catch (error) {
      phase.value = 'failed';
      message.value =
        error instanceof ApiError
          ? error.message
          : 'The GitHub App was created but could not be recorded. Try connecting again.';
      return;
    }
  }

  // Half two. GitHub also sends `setup_action`, which is 'install' or 'update'.
  // Both are treated the same: the completion call is an upsert, so re-running
  // it after the owner changes which repos are granted refreshes the record.
  try {
    result.value = await api.githubCompleteInstall({
      installation_id: Number(installationId),
      state,
    });
    phase.value = 'done';
  } catch (error) {
    phase.value = 'failed';
    message.value =
      error instanceof ApiError
        ? error.message
        : 'The installation could not be recorded. Try connecting again.';
  }
});

function goToMicroservices(): void {
  void router.replace({ name: 'microservices' });
}
</script>

<template>
  <q-page padding>
    <div class="row justify-center">
      <div class="col-12 col-md-8 col-lg-6">
        <q-card flat bordered>
          <q-card-section v-if="phase === 'working'" class="text-center q-py-xl">
            <q-spinner color="primary" size="42px" />
            <div class="text-h6 q-mt-md">Finishing the GitHub setup</div>
            <div class="text-body2 text-grey-7">
              Confirming with GitHub, then storing what it returned.
            </div>
          </q-card-section>

          <!-- The App exists but grants nothing yet, so this hands straight on
               to the install rather than stopping at a success screen. -->
          <q-card-section v-else-if="phase === 'installing'" class="text-center q-py-xl">
            <q-spinner color="primary" size="42px" />
            <div class="text-h6 q-mt-md">
              Created {{ createdApp?.name || createdApp?.slug || 'the GitHub App' }}
            </div>
            <div class="text-body2 text-grey-7">
              Taking you to GitHub to choose which repositories it may read.
            </div>
          </q-card-section>

          <q-card-section v-else-if="phase === 'done'">
            <div class="row items-center q-gutter-sm">
              <q-icon name="check_circle" color="positive" size="28px" />
              <div class="text-h6">Repository access connected</div>
            </div>

            <div class="text-body2 q-mt-md">
              The App is installed on
              <strong>{{ result?.installation.account_login }}</strong> and this deployment can
              read
              {{ result?.repositories.length ?? 0 }}
              {{ (result?.repositories.length ?? 0) === 1 ? 'repository' : 'repositories' }}.
            </div>

            <!-- The property that makes the whole design work, said plainly at
                 the one moment the user is thinking about their GitHub account. -->
            <q-banner rounded class="bg-blue-1 text-grey-9 q-mt-md">
              <template #avatar><q-icon name="info" color="info" /></template>
              No GitHub account is attached to this console. What was stored is an
              installation belonging to
              <strong>{{ result?.installation.account_login }}</strong>, so this keeps working
              after you sign out, change your GitHub password, or leave the organisation — and
              every other console user can now configure microservices without a GitHub account
              of their own.
            </q-banner>

            <q-list v-if="result?.repositories.length" bordered separator class="q-mt-md rounded-borders">
              <q-item v-for="repo in result.repositories.slice(0, 8)" :key="repo.repo_id">
                <q-item-section avatar style="min-width: 32px">
                  <q-icon :name="repo.private ? 'lock' : 'public'" size="18px" color="grey-7" />
                </q-item-section>
                <q-item-section>
                  <q-item-label class="mono">{{ repo.full_name }}</q-item-label>
                  <q-item-label caption>default branch {{ repo.default_branch }}</q-item-label>
                </q-item-section>
              </q-item>
              <q-item v-if="result.repositories.length > 8">
                <q-item-section class="text-caption text-grey-7">
                  and {{ result.repositories.length - 8 }} more
                </q-item-section>
              </q-item>
            </q-list>

            <q-banner v-if="result?.truncated" rounded class="bg-orange-1 text-grey-9 q-mt-md">
              <template #avatar><q-icon name="warning" color="warning" /></template>
              This installation grants more repositories than could be listed in one pass, so
              the list above is partial.
            </q-banner>
          </q-card-section>

          <q-card-section v-else>
            <div class="row items-center q-gutter-sm">
              <q-icon name="error" color="negative" size="28px" />
              <div class="text-h6">Could not connect</div>
            </div>
            <div class="text-body2 q-mt-md">{{ message }}</div>
          </q-card-section>

          <q-separator />
          <q-card-actions align="right">
            <q-btn
              unelevated
              color="primary"
              :label="phase === 'done' ? 'Configure a microservice' : 'Back to Microservices'"
              @click="goToMicroservices"
            />
          </q-card-actions>
        </q-card>
      </div>
    </div>
  </q-page>
</template>

<style scoped>
.mono {
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
}
</style>

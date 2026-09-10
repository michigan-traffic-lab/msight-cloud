<script setup lang="ts">
import { computed, nextTick, ref, watch } from 'vue';
import { useQuasar } from 'quasar';
import {
  api,
  ApiError,
  type GithubAppStatus,
  type GithubInstallation,
  type GithubRepo,
  type Microservice,
  type MicroserviceCheckState,
  type ComputeCluster,
  type ScalingMetric,
  type ScalingMode,
} from '@/api/client';
import { useAsyncValue } from '@/composables/useAsyncValue';
import AsyncValue from '@/components/AsyncValue.vue';
import InfoHint from '@/components/InfoHint.vue';
import PageHeader from '@/components/PageHeader.vue';
import SectionCard from '@/components/SectionCard.vue';
import { useAuthStore } from '@/stores/auth';

/**
 * Microservices built from a GitHub repository.
 *
 * The page carries two things that look separate and are not: the GitHub
 * connection, and the registry of what gets built from it. The connection is
 * made once, by one admin, and then never again — so it is presented as
 * configuration that recedes rather than a login anyone repeats.
 *
 * Nothing is provisioned yet. A registered microservice records a verified
 * source and the runtime shape it will take; building the image and running it
 * on Fargate come next. The page says so rather than implying a deployment that
 * has not happened.
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
  dockerfile:
    'Where the Dockerfile lives, relative to the repository root. A monorepo usually ' +
    'keeps one per service — "services/api/Dockerfile" — and a repository may have ' +
    'several under names like "docker/Dockerfile.prod".',
  context:
    'The directory docker build runs in. Everything COPY can reach is relative to it. ' +
    'Usually the repository root, or the service\'s own directory in a monorepo.',
  check:
    'The last look at GitHub: does the branch exist, and is there a Dockerfile where ' +
    'this says there is. Checked before a microservice can be saved, and re-checkable ' +
    'any time — which is how a Dockerfile deleted later becomes visible here instead ' +
    'of at the first build.',
  provision:
    'Nothing is created on AWS yet. These rows record a verified source and the shape ' +
    'the Fargate service will take; building the image and running it come next.',
  runtime:
    'The task size the Fargate service will be given. Fargate accepts only specific ' +
    'CPU values, and each one allows a limited memory range — so the memory choices ' +
    'change with the CPU.',
  scaling:
    'How many tasks run. A fixed count always runs that many and costs the same idle ' +
    'or busy. Auto scaling lets ECS move between a floor and a ceiling to hold CPU or ' +
    'memory near a target, so you pay for what is running — but never less than the ' +
    'floor. Recorded now; the ECS policy is created when provisioning is wired up.',
  cluster:
    'Which compute cluster this service runs on. A Fargate cluster has no machines to ' +
    'manage and no GPUs; an EC2 cluster runs one instance type, which is the only way to ' +
    'get a GPU. A service with no cluster is configured but has nowhere to run.',
  revoke:
    'Also uninstalls the App from the repository owner on GitHub. Without it the ' +
    'install stays listed in their settings with nothing here able to see or remove it.',
};

/** Fargate's allowed CPU values, with the memory range each one permits. */
const CPU_OPTIONS = [
  { label: '0.25 vCPU (256)', value: 256 },
  { label: '0.5 vCPU (512)', value: 512 },
  { label: '1 vCPU (1024)', value: 1024 },
  { label: '2 vCPU (2048)', value: 2048 },
  { label: '4 vCPU (4096)', value: 4096 },
];

const CHECK_LABELS: Record<MicroserviceCheckState, { label: string; color: string; icon: string }> =
  {
    ok: { label: 'Buildable', color: 'positive', icon: 'check_circle' },
    unchecked: { label: 'Not checked', color: 'grey-6', icon: 'help' },
    dockerfile_missing: { label: 'No Dockerfile', color: 'negative', icon: 'error' },
    branch_missing: { label: 'Branch gone', color: 'negative', icon: 'error' },
    context_missing: { label: 'Bad context', color: 'warning', icon: 'warning' },
    error: { label: 'Error', color: 'negative', icon: 'error' },
  };

const appStatus = useAsyncValue<GithubAppStatus>((signal) => api.githubApp(signal));
const installations = useAsyncValue<{ installations: GithubInstallation[] }>((signal) =>
  api.githubInstallations(signal)
);
const services = useAsyncValue<{ microservices: Microservice[] }>((signal) =>
  api.microservices(signal)
);
// A service needs somewhere to run, so the picker needs the list. Its own call:
// a slow cluster read should not hold up the registry.
const clusters = useAsyncValue<{ clusters: ComputeCluster[] }>((signal) => api.clusters(signal));

const busy = ref(false);
const selectedName = ref<string | null>(null);

const list = computed<Microservice[]>(() => services.data.value?.microservices ?? []);
const selected = computed<Microservice | null>(
  () => list.value.find((row) => row.name === selectedName.value) ?? null
);
const installationList = computed<GithubInstallation[]>(
  () => installations.data.value?.installations ?? []
);
const connected = computed(() => appStatus.data.value?.configured === true);
const attentionCount = computed(
  () => list.value.filter((row) => row.check_state !== 'ok').length
);
// Derived rather than hardcoded to zero, so it starts reporting the truth on
// its own once provisioning is wired up instead of needing this page edited.
const provisionedCount = computed(
  () => list.value.filter((row) => row.provision_state !== 'not_provisioned').length
);

/** Clusters a service can be placed on, and the one it is currently on. */
const clusterList = computed<ComputeCluster[]>(() => clusters.data.value?.clusters ?? []);
const clusterOptions = computed(() =>
  clusterList.value.map((cluster) => ({
    label: `${cluster.display_name || cluster.name} — ${
      cluster.capacity_type === 'fargate' ? 'Fargate' : cluster.instance_type
    }${cluster.gpus_per_instance ? ` · ${cluster.gpus_per_instance}× GPU` : ''}`,
    value: cluster.name,
  }))
);
const formCluster = computed<ComputeCluster | null>(
  () => clusterList.value.find((cluster) => cluster.name === form.value.cluster_name) ?? null
);
/** Only a shared GPU cluster leaves video memory unguarded, so only it asks. */
const needsVram = computed(
  () => (formCluster.value?.gpus_per_instance ?? 0) > 0 && formCluster.value?.gpu_mode === 'shared'
);

/**
 * The URL GitHub must be configured to redirect to.
 *
 * Derived from where this page is actually served rather than from config: it
 * is the one value that has to match byte for byte, and a hand-copied one that
 * does not is the likeliest reason an install fails at the last step.
 */
const setupUrl = computed(() => `${window.location.origin}/settings/github/callback`);

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

function reloadAll(): void {
  void clusters.reload();
  void appStatus.reload();
  void installations.reload();
  void services.reload();
}

function reportError(error: unknown, fallback: string): void {
  $q.notify({
    type: 'negative',
    message: error instanceof ApiError ? error.message : fallback,
    timeout: 9000,
    multiLine: true,
  });
}

function formatBytes(bytes: number | null): string {
  if (bytes === null) return '—';
  if (bytes < 1024) return `${bytes} B`;
  return `${(bytes / 1024).toFixed(1)} KB`;
}

function formatWhen(iso: string | null): string {
  return iso ? new Date(iso).toLocaleString() : 'never';
}

// ── GitHub App credentials ───────────────────────────────────────────────────

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

// ── Microservice add / edit ──────────────────────────────────────────────────

const serviceDialog = ref(false);
const editingName = ref<string | null>(null);
const dialogError = ref<string | null>(null);
const repoOptions = ref<GithubRepo[]>([]);
const reposLoading = ref(false);
const reposTruncated = ref(false);

const form = ref({
  name: '',
  display_name: '',
  installation_id: null as number | null,
  repo_id: null as number | null,
  branch: '',
  dockerfile_path: 'Dockerfile',
  build_context: '.',
  desired_count: 1,
  cpu: 256,
  memory: 512,
  container_port: null as number | null,
  cluster_name: null as string | null,
  gpu_vram_mb: 0,
  scaling_mode: 'fixed' as ScalingMode,
  min_tasks: 1,
  max_tasks: 4,
  scaling_metric: 'cpu' as ScalingMetric,
  scaling_target: 60,
  scale_out_cooldown: 60,
  scale_in_cooldown: 300,
});

const selectedRepo = computed<GithubRepo | null>(
  () => repoOptions.value.find((repo) => repo.repo_id === form.value.repo_id) ?? null
);

/**
 * Fargate pairs CPU with a fixed memory range in 1 GiB steps, and rejects
 * anything else at task-definition registration. A free-number field invited a
 * value that looked reasonable and was not, so the options are derived from the
 * chosen CPU instead.
 */
const FARGATE_MEMORY: Record<number, { min: number; max: number }> = {
  256: { min: 512, max: 2048 },
  512: { min: 1024, max: 4096 },
  1024: { min: 2048, max: 8192 },
  2048: { min: 4096, max: 16384 },
  4096: { min: 8192, max: 30720 },
};

const memoryOptions = computed(() => {
  const range = FARGATE_MEMORY[form.value.cpu] ?? { min: 512, max: 2048 };
  const values: Array<{ label: string; value: number }> = [];
  // 256 CPU is the one size with sub-GiB steps; everything else moves in 1 GiB.
  const step = form.value.cpu === 256 ? 512 : 1024;
  for (let mib = range.min; mib <= range.max; mib += step) {
    values.push({ label: mib >= 1024 ? `${mib / 1024} GB (${mib})` : `${mib} MiB`, value: mib });
  }
  return values;
});

const memoryHint = computed(() => {
  const range = FARGATE_MEMORY[form.value.cpu];
  return range ? `${range.min}–${range.max} MiB at this CPU` : '';
});

// Changing CPU can strand the memory value outside the new range, which Fargate
// would reject much later. Snapped to the nearest allowed value instead.
watch(
  () => form.value.cpu,
  () => {
    const allowed = memoryOptions.value.map((option) => option.value);
    const last = allowed[allowed.length - 1];
    if (last !== undefined && !allowed.includes(form.value.memory)) {
      form.value.memory = allowed.find((value) => value >= form.value.memory) ?? last;
    }
  }
);

/**
 * The scaling policy stated back as a sentence, or the reason it cannot work.
 *
 * The rules are between fields, so a per-field message would never say the
 * actual problem — "max 2" is only wrong because the minimum is 4.
 */
const scalingProblem = computed<string | null>(() => {
  if (form.value.scaling_mode !== 'auto') return null;
  const { min_tasks: min, max_tasks: max, scaling_target: target } = form.value;

  if (!Number.isInteger(min) || min < 1) {
    return 'Minimum tasks must be at least 1 — a service allowed to reach zero produces no metric to scale back up on.';
  }
  if (!Number.isInteger(max) || max < min) {
    return `Maximum tasks (${max}) is below the minimum (${min}), which is a policy that can never settle.`;
  }
  if (!Number.isInteger(target) || target < 10 || target > 90) {
    return 'Target utilisation must be between 10% and 90%. Outside that the policy never stops scaling one way.';
  }
  return null;
});

const scalingSummary = computed(() => {
  const { min_tasks: min, max_tasks: max, scaling_metric: metric, scaling_target: target } = form.value;
  const unit = form.value.cpu / 1024;
  return (
    `Runs ${min}–${max} tasks, adding one when average ${metric === 'cpu' ? 'CPU' : 'memory'} ` +
    `goes above ${target}%. You always pay for at least ${min} task${min === 1 ? '' : 's'} ` +
    `(${min * unit} vCPU total), even when idle.`
  );
});

async function loadRepos(installationId: number): Promise<void> {
  reposLoading.value = true;
  repoOptions.value = [];
  reposTruncated.value = false;
  try {
    const result = await api.githubInstallationRepos(installationId);
    // Archived repositories are shown but cannot be chosen — hiding them makes
    // "my repo isn't in the list" unanswerable.
    repoOptions.value = result.repositories;
    reposTruncated.value = result.truncated;
  } catch (error) {
    dialogError.value =
      error instanceof ApiError ? error.message : 'Could not list the repositories.';
  } finally {
    reposLoading.value = false;
  }
}

watch(
  () => form.value.installation_id,
  (installationId) => {
    form.value.repo_id = null;
    if (installationId !== null) {
      void loadRepos(installationId);
    }
  }
);

// The branch defaults to whatever the repository itself defaults to, which is
// right far more often than "main" is.
watch(selectedRepo, (repo) => {
  if (repo && !editingName.value) {
    form.value.branch = repo.default_branch;
  }
});

function openAdd(): void {
  editingName.value = null;
  dialogError.value = null;
  repoOptions.value = [];
  form.value = {
    name: '',
    display_name: '',
    installation_id: installationList.value[0]?.installation_id ?? null,
    repo_id: null,
    branch: '',
    dockerfile_path: 'Dockerfile',
    build_context: '.',
    desired_count: 1,
    cpu: 256,
    memory: 512,
    container_port: null,
    cluster_name: clusterOptions.value[0]?.value ?? null,
    gpu_vram_mb: 0,
    scaling_mode: 'fixed',
    min_tasks: 1,
    max_tasks: 4,
    scaling_metric: 'cpu',
    scaling_target: 60,
    scale_out_cooldown: 60,
    scale_in_cooldown: 300,
  };
  if (form.value.installation_id !== null) {
    void loadRepos(form.value.installation_id);
  }
  serviceDialog.value = true;
}

function openEdit(row: Microservice): void {
  editingName.value = row.name;
  dialogError.value = null;
  form.value = {
    name: row.name,
    display_name: row.display_name ?? '',
    installation_id: row.installation_id,
    repo_id: row.repo_id,
    branch: row.branch,
    dockerfile_path: row.dockerfile_path,
    build_context: row.build_context,
    desired_count: row.desired_count,
    cpu: row.cpu,
    memory: row.memory,
    container_port: row.container_port,
    cluster_name: row.cluster_name,
    gpu_vram_mb: row.gpu_vram_mb,
    scaling_mode: row.scaling_mode,
    min_tasks: row.min_tasks,
    max_tasks: row.max_tasks,
    scaling_metric: row.scaling_metric,
    scaling_target: row.scaling_target,
    scale_out_cooldown: row.scale_out_cooldown,
    scale_in_cooldown: row.scale_in_cooldown,
  };
  void loadRepos(row.installation_id);
  serviceDialog.value = true;
}

const canSubmit = computed(() => {
  if (form.value.installation_id === null || form.value.repo_id === null) return false;
  if (!form.value.branch.trim() || !form.value.dockerfile_path.trim()) return false;
  // An unsatisfiable scaling policy is refused here as well as by the server,
  // so the button says no before a round trip does.
  if (scalingProblem.value !== null) return false;
  return editingName.value !== null || form.value.name.trim().length >= 2;
});

/**
 * Saves, and keeps the dialog open on a rejected source.
 *
 * A missing Dockerfile is the most likely outcome of a first attempt and it is
 * refused rather than stored — so the message belongs beside the path field
 * that produced it, with the rest of the form intact to correct.
 */
async function submitService(): Promise<void> {
  dialogError.value = null;
  busy.value = true;
  try {
    if (editingName.value) {
      const result = await api.microserviceUpdate(editingName.value, {
        display_name: form.value.display_name || null,
        repo_id: form.value.repo_id!,
        branch: form.value.branch.trim(),
        dockerfile_path: form.value.dockerfile_path.trim(),
        build_context: form.value.build_context.trim() || '.',
        desired_count: form.value.desired_count,
        cpu: form.value.cpu,
        memory: form.value.memory,
        container_port: form.value.container_port,
        cluster_name: form.value.cluster_name,
        gpu_vram_mb: form.value.gpu_vram_mb,
        scaling: {
          mode: form.value.scaling_mode,
          min_tasks: form.value.min_tasks,
          max_tasks: form.value.max_tasks,
          metric: form.value.scaling_metric,
          target: form.value.scaling_target,
          scale_out_cooldown: form.value.scale_out_cooldown,
          scale_in_cooldown: form.value.scale_in_cooldown,
        },
      });
      $q.notify({
        type: 'positive',
        message: result.rechecked
          ? `${result.microservice.name} updated and re-verified against GitHub.`
          : `${result.microservice.name} updated.`,
      });
    } else {
      const result = await api.microserviceCreate({
        name: form.value.name.trim(),
        display_name: form.value.display_name || null,
        installation_id: form.value.installation_id!,
        repo_id: form.value.repo_id!,
        branch: form.value.branch.trim(),
        dockerfile_path: form.value.dockerfile_path.trim(),
        build_context: form.value.build_context.trim() || '.',
        desired_count: form.value.desired_count,
        cpu: form.value.cpu,
        memory: form.value.memory,
        container_port: form.value.container_port,
        cluster_name: form.value.cluster_name,
        gpu_vram_mb: form.value.gpu_vram_mb,
        scaling: {
          mode: form.value.scaling_mode,
          min_tasks: form.value.min_tasks,
          max_tasks: form.value.max_tasks,
          metric: form.value.scaling_metric,
          target: form.value.scaling_target,
          scale_out_cooldown: form.value.scale_out_cooldown,
          scale_in_cooldown: form.value.scale_in_cooldown,
        },
      });
      selectedName.value = result.microservice.name;
      $q.notify({
        type: 'positive',
        message: `${result.microservice.name} registered — Dockerfile found at ${result.microservice.dockerfile_path}.`,
      });
    }
    serviceDialog.value = false;
    void services.reload();
  } catch (error) {
    dialogError.value =
      error instanceof ApiError ? error.message : 'The microservice could not be saved.';
  } finally {
    busy.value = false;
  }
}

async function recheck(row: Microservice): Promise<void> {
  busy.value = true;
  try {
    const result = await api.microserviceCheck(row.name);
    $q.notify({
      type: result.microservice.check_state === 'ok' ? 'positive' : 'warning',
      message:
        result.microservice.check_state === 'ok'
          ? `${row.name}: Dockerfile found on ${result.microservice.branch}.`
          : (result.microservice.check_detail ?? 'The source could not be verified.'),
      timeout: 9000,
      multiLine: true,
    });
    void services.reload();
  } catch (error) {
    reportError(error, 'The check could not be run.');
  } finally {
    busy.value = false;
  }
}

function removeService(row: Microservice): void {
  $q.dialog({
    title: `Remove ${row.name}?`,
    message:
      'The registry row is deleted. Nothing is provisioned on AWS yet, so there is no ' +
      'infrastructure to tear down, and the repository is not touched.',
    cancel: true,
    ok: { label: 'Remove', color: 'negative', unelevated: true },
  }).onOk(() => {
    void (async () => {
      busy.value = true;
      try {
        await api.microserviceRemove(row.name);
        if (selectedName.value === row.name) selectedName.value = null;
        $q.notify({ type: 'positive', message: `${row.name} removed.` });
        void services.reload();
      } catch (error) {
        reportError(error, 'The microservice could not be removed.');
      } finally {
        busy.value = false;
      }
    })();
  });
}
</script>

<template>
  <q-page padding>
    <PageHeader title="Microservices">
      <template #subtitle>
        Services built from a GitHub repository's own Dockerfile. The GitHub App is installed
        once by one admin — no GitHub account is attached to this console, so everyone else
        works from the stored grant.
      </template>
      <template #actions>
        <q-btn
          outline
          color="primary"
          icon="refresh"
          label="Refresh"
          :loading="services.state.value === 'loading'"
          @click="reloadAll"
        />
        <q-btn
          v-if="isAdmin && connected && installationList.length"
          unelevated
          color="primary"
          icon="add"
          label="Add microservice"
          :disable="busy"
          @click="openAdd"
        />
      </template>
    </PageHeader>

    <!-- Nothing is deployed yet, and the page should not imply otherwise. -->
    <q-banner v-if="connected" rounded class="bg-blue-1 text-grey-9 q-mb-md">
      <template #avatar><q-icon name="science" color="info" /></template>
      <div class="text-weight-medium">Source configuration only, so far</div>
      <div class="text-body2">
        A microservice registered here records a <em>verified</em> source — the branch exists
        and there is a Dockerfile where you said. No image is built and no ECS service is
        created yet; those are the next step.
      </div>
    </q-banner>

    <!-- Stats -->
    <div v-if="connected" class="row q-col-gutter-md q-mb-md">
      <div class="col-6 col-md-3">
        <q-card flat bordered>
          <q-card-section>
            <div class="text-caption text-grey-7 text-uppercase">Registered</div>
            <div class="text-h6 q-mt-xs">
              <AsyncValue :state="services.state.value" :error="services.error.value">
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
              Needs attention<InfoHint :text="HINTS.check" />
            </div>
            <div class="text-h6 q-mt-xs" :class="attentionCount > 0 ? 'text-warning' : ''">
              <AsyncValue :state="services.state.value" :error="services.error.value">
                {{ attentionCount }}
              </AsyncValue>
            </div>
          </q-card-section>
        </q-card>
      </div>
      <div class="col-6 col-md-3">
        <q-card flat bordered>
          <q-card-section>
            <div class="text-caption text-grey-7 text-uppercase row items-center">
              Connections<InfoHint :text="HINTS.connection" />
            </div>
            <div class="text-h6 q-mt-xs">
              <AsyncValue :state="installations.state.value" :error="installations.error.value">
                {{ installationList.length }}
              </AsyncValue>
            </div>
          </q-card-section>
        </q-card>
      </div>
      <div class="col-6 col-md-3">
        <q-card flat bordered>
          <q-card-section>
            <div class="text-caption text-grey-7 text-uppercase row items-center">
              Provisioned<InfoHint :text="HINTS.provision" />
            </div>
            <div class="text-h6 q-mt-xs" :class="provisionedCount === 0 ? 'text-grey-7' : ''">
              <AsyncValue :state="services.state.value" :error="services.error.value">
                {{ provisionedCount }}
              </AsyncValue>
            </div>
          </q-card-section>
        </q-card>
      </div>
    </div>

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

    <!-- Registry -->
    <div v-if="connected" class="row q-col-gutter-md">
      <div class="col-12 col-md-6">
        <SectionCard title="Registry" flush>
          <AsyncValue :state="services.state.value" :error="services.error.value">
            <q-card-section v-if="!list.length" class="text-body2 text-grey-7">
              No microservices are registered.
              <template v-if="!connected">
                Connect a GitHub repository first.
              </template>
              <template v-else-if="isAdmin">
                Use <strong>Add microservice</strong> to point one at a Dockerfile.
              </template>
            </q-card-section>

            <q-list v-else separator>
              <q-item
                v-for="row in list"
                :key="row.name"
                v-ripple
                clickable
                :active="selectedName === row.name"
                active-class="bg-blue-grey-1"
                @click="selectedName = row.name"
              >
                <q-item-section avatar style="min-width: 30px">
                  <q-icon
                    :name="CHECK_LABELS[row.check_state].icon"
                    :color="CHECK_LABELS[row.check_state].color"
                    size="16px"
                  >
                    <q-tooltip class="hint-tooltip">
                      {{ row.check_detail ?? CHECK_LABELS[row.check_state].label }}
                    </q-tooltip>
                  </q-icon>
                </q-item-section>
                <q-item-section>
                  <q-item-label>{{ row.display_name || row.name }}</q-item-label>
                  <q-item-label caption>
                    <span class="mono">{{ row.repo_full_name }}</span>
                    @<span class="mono">{{ row.branch }}</span>
                  </q-item-label>
                  <q-item-label caption class="mono text-grey-6">
                    {{ row.dockerfile_path }}
                  </q-item-label>
                </q-item-section>
                <q-item-section side>
                  <q-chip
                    dense
                    square
                    size="sm"
                    :color="`${CHECK_LABELS[row.check_state].color}-1`"
                    :text-color="CHECK_LABELS[row.check_state].color"
                  >
                    {{ CHECK_LABELS[row.check_state].label }}
                  </q-chip>
                </q-item-section>
              </q-item>
            </q-list>
          </AsyncValue>
        </SectionCard>
      </div>

      <!-- Detail -->
      <div class="col-12 col-md-6">
        <SectionCard :title="selected ? selected.name : 'Detail'">
          <template v-if="selected" #actions>
            <q-btn
              flat
              dense
              no-caps
              color="primary"
              icon="refresh"
              label="Re-check"
              :disable="busy"
              @click="recheck(selected)"
            />
            <q-btn
              v-if="isAdmin"
              flat
              dense
              no-caps
              color="primary"
              icon="edit"
              label="Edit"
              :disable="busy"
              @click="openEdit(selected)"
            />
            <q-btn
              v-if="isAdmin"
              flat
              dense
              no-caps
              color="negative"
              icon="delete"
              label="Remove"
              :disable="busy"
              @click="removeService(selected)"
            />
          </template>

          <div v-if="!selected" class="text-body2 text-grey-7">
            Select a microservice to see its source and the state of its last check.
          </div>

          <div v-else>
            <q-banner
              v-if="selected.check_state !== 'ok'"
              rounded
              class="q-mb-md"
              :class="
                selected.check_state === 'context_missing'
                  ? 'bg-orange-1 text-grey-9'
                  : 'bg-red-1 text-grey-9'
              "
            >
              <template #avatar>
                <q-icon
                  :name="CHECK_LABELS[selected.check_state].icon"
                  :color="CHECK_LABELS[selected.check_state].color"
                />
              </template>
              <div class="text-weight-medium">{{ CHECK_LABELS[selected.check_state].label }}</div>
              <div class="text-body2">
                {{ selected.check_detail ?? 'This source has not been verified.' }}
              </div>
            </q-banner>

            <div class="text-caption text-grey-7 text-uppercase q-mb-xs">Source</div>
            <table class="detail-table">
              <tbody>
                <tr>
                  <th>Repository</th>
                  <td class="mono">{{ selected.repo_full_name }}</td>
                </tr>
                <tr>
                  <th>Branch</th>
                  <td class="mono">{{ selected.branch }}</td>
                </tr>
                <tr>
                  <th>
                    Dockerfile
                    <InfoHint :text="HINTS.dockerfile" />
                  </th>
                  <td class="mono">
                    {{ selected.dockerfile_path }}
                    <span class="text-grey-6">({{ formatBytes(selected.dockerfile_size) }})</span>
                  </td>
                </tr>
                <tr>
                  <th>
                    Build context
                    <InfoHint :text="HINTS.context" />
                  </th>
                  <td class="mono">{{ selected.build_context }}</td>
                </tr>
                <tr>
                  <th>Last checked</th>
                  <td>
                    {{ formatWhen(selected.checked_at) }}
                    <span v-if="selected.checked_commit_sha" class="mono text-grey-6">
                      at {{ selected.checked_commit_sha.slice(0, 7) }}
                    </span>
                  </td>
                </tr>
              </tbody>
            </table>

            <div class="text-caption text-grey-7 text-uppercase q-mt-md q-mb-xs row items-center">
              Runtime shape<InfoHint :text="HINTS.runtime" />
            </div>
            <table class="detail-table">
              <tbody>
                <tr>
                  <th>Task size</th>
                  <td class="mono">{{ selected.cpu }} CPU units · {{ selected.memory }} MiB</td>
                </tr>
                <tr>
                  <th>Scaling</th>
                  <td>
                    <template v-if="selected.scaling_mode === 'auto'">
                      <span class="mono">
                        {{ selected.min_tasks }}–{{ selected.max_tasks }} tasks
                      </span>
                      <span class="text-grey-7">
                        · auto, holding
                        {{ selected.scaling_metric === 'cpu' ? 'CPU' : 'memory' }} near
                        {{ selected.scaling_target }}%
                      </span>
                    </template>
                    <template v-else>
                      <span class="mono">{{ selected.desired_count }} task(s)</span>
                      <span class="text-grey-7"> · fixed</span>
                    </template>
                  </td>
                </tr>
                <tr v-if="selected.scaling_mode === 'auto'">
                  <th>Cooldowns</th>
                  <td class="mono">
                    {{ selected.scale_out_cooldown }}s out · {{ selected.scale_in_cooldown }}s in
                  </td>
                </tr>
                <tr>
                  <th>Container port</th>
                  <td class="mono">{{ selected.container_port ?? 'none' }}</td>
                </tr>
                <tr>
                  <th>Provisioned</th>
                  <td>
                    <q-chip dense square size="sm" color="grey-3" text-color="grey-8">
                      {{ selected.provision_state.replace(/_/g, ' ') }}
                    </q-chip>
                  </td>
                </tr>
              </tbody>
            </table>

            <div class="text-caption text-grey-6 q-mt-md">
              Registered by {{ selected.created_by }} on {{ formatWhen(selected.created_at) }}.
            </div>
          </div>
        </SectionCard>
      </div>
    </div>

    <!-- App credentials dialog -->
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
    <q-dialog v-model="serviceDialog" persistent>
      <q-card style="min-width: 620px; max-width: 94vw">
        <q-card-section>
          <div class="text-h6">
            {{ editingName ? `Edit ${editingName}` : 'Add microservice' }}
          </div>
          <div class="text-body2 text-grey-7 q-mt-xs">
            Saving checks GitHub first: the branch has to exist and there has to be a
            Dockerfile where you say. Nothing is stored unless it does.
          </div>
        </q-card-section>

        <!--
          One grid for the whole body.

          The section previously combined `q-gutter-md` with nested
          `row q-col-gutter-md`: the first adds margins to every direct child,
          the second adds a negative margin to pull columns back. Together the
          full-width fields sat a few pixels inside the gridded rows, so nothing
          lined up down the left edge. Every field is a column of one grid now,
          full-width ones included.
        -->
        <q-card-section class="q-pt-none">
          <!-- The refusal that matters, kept beside the field that caused it. -->
          <q-banner v-if="dialogError" rounded class="bg-red-1 text-grey-9 q-mb-md">
            <template #avatar><q-icon name="error" color="negative" /></template>
            {{ dialogError }}
          </q-banner>

          <div class="row q-col-gutter-md">
            <div class="col-12 col-sm-6">
              <q-input
                v-model="form.name"
                outlined
                dense
                label="Name"
                :disable="editingName !== null"
                hint="Lowercase, hyphens. Becomes the ECR repository and ECS service name."
              />
            </div>
            <div class="col-12 col-sm-6">
              <q-input
                v-model="form.display_name"
                outlined
                dense
                label="Display name (optional)"
              />
            </div>

            <div class="col-12">
              <q-select
                v-model="form.installation_id"
                outlined
                dense
                emit-value
                map-options
                label="GitHub account"
                :disable="editingName !== null"
                :options="
                  installationList.map((i) => ({
                    label: `${i.account_login} (${i.repository_selection ?? 'unknown'} repos)`,
                    value: i.installation_id,
                  }))
                "
              />
            </div>

            <div class="col-12">
              <q-select
                v-model="form.repo_id"
                outlined
                dense
                emit-value
                map-options
                label="Repository"
                :loading="reposLoading"
                :options="
                  repoOptions.map((r) => ({
                    label: r.archived ? `${r.full_name} (archived)` : r.full_name,
                    value: r.repo_id,
                    disable: r.archived,
                  }))
                "
                :hint="
                  reposTruncated
                    ? 'This installation grants more repositories than could be listed.'
                    : 'Only repositories this installation grants are listed.'
                "
              />
            </div>

            <div class="col-12 col-sm-4">
              <q-input
                v-model="form.branch"
                outlined
                dense
                label="Branch"
                class="mono"
                :hint="selectedRepo ? `default: ${selectedRepo.default_branch}` : ''"
              />
            </div>
            <div class="col-12 col-sm-4">
              <q-input
                v-model="form.dockerfile_path"
                outlined
                dense
                label="Dockerfile path"
                class="mono"
              >
                <template #append><InfoHint :text="HINTS.dockerfile" /></template>
              </q-input>
            </div>
            <div class="col-12 col-sm-4">
              <q-input
                v-model="form.build_context"
                outlined
                dense
                label="Build context"
                class="mono"
              >
                <template #append><InfoHint :text="HINTS.context" /></template>
              </q-input>
            </div>

            <div class="col-12">
              <q-separator class="q-mt-sm q-mb-md" />
              <div class="text-caption text-grey-7 text-uppercase row items-center">
                Where it runs<InfoHint :text="HINTS.cluster" />
              </div>
            </div>

            <div class="col-12" :class="needsVram ? 'col-sm-8' : ''">
              <q-select
                v-model="form.cluster_name"
                outlined
                dense
                emit-value
                map-options
                clearable
                label="Cluster"
                :options="clusterOptions"
                :hint="
                  clusterOptions.length
                    ? 'Fargate has no GPUs; an EC2 cluster with GPU cards does.'
                    : 'No clusters yet — create one on the Clusters page first.'
                "
              />
            </div>

            <!-- Only asked where it matters: on a shared GPU cluster nothing in
                 ECS checks video memory, so this figure is the only guard. -->
            <div v-if="needsVram" class="col-12 col-sm-4">
              <q-input
                v-model.number="form.gpu_vram_mb"
                outlined
                dense
                type="number"
                min="0"
                label="VRAM needed (MiB)"
                :hint="`card has ${formCluster?.gpu_vram_mb ?? 0} MiB`"
              />
            </div>

            <div class="col-12">
              <q-separator class="q-mt-sm q-mb-md" />
              <div class="text-caption text-grey-7 text-uppercase row items-center">
                Task size<InfoHint :text="HINTS.runtime" />
              </div>
            </div>

            <div class="col-6 col-sm-4">
              <q-select
                v-model="form.cpu"
                outlined
                dense
                emit-value
                map-options
                label="CPU"
                :options="CPU_OPTIONS"
              />
            </div>
            <div class="col-6 col-sm-4">
              <q-select
                v-model.number="form.memory"
                outlined
                dense
                emit-value
                map-options
                label="Memory"
                :options="memoryOptions"
                :hint="memoryHint"
              />
            </div>
            <div class="col-6 col-sm-4">
              <q-input
                v-model.number="form.container_port"
                outlined
                dense
                type="number"
                label="Port (optional)"
              />
            </div>

            <div class="col-12">
              <q-separator class="q-mt-sm q-mb-md" />
              <div class="text-caption text-grey-7 text-uppercase row items-center">
                Scaling<InfoHint :text="HINTS.scaling" />
              </div>
            </div>

            <div class="col-12">
              <q-btn-toggle
                v-model="form.scaling_mode"
                no-caps
                unelevated
                dense
                toggle-color="primary"
                :options="[
                  { label: 'Fixed count', value: 'fixed' },
                  { label: 'Auto scale', value: 'auto' },
                ]"
              />
              <div class="text-caption text-grey-7 q-mt-xs" style="max-width: 62ch">
                {{
                  form.scaling_mode === 'fixed'
                    ? 'Always runs exactly this many tasks. Predictable, and the cost is the same whether the service is busy or idle.'
                    : 'ECS adds and removes tasks to hold the chosen metric near its target. You pay for what is running, and the floor is what you pay when idle.'
                }}
              </div>
            </div>

            <!-- Fixed -->
            <div v-if="form.scaling_mode === 'fixed'" class="col-6 col-sm-4">
              <q-input
                v-model.number="form.desired_count"
                outlined
                dense
                type="number"
                min="0"
                label="Tasks"
                hint="0 stops the service without deleting it."
              />
            </div>

            <!-- Auto -->
            <template v-else>
              <div class="col-6 col-sm-3">
                <q-input
                  v-model.number="form.min_tasks"
                  outlined
                  dense
                  type="number"
                  min="1"
                  label="Min tasks"
                  :error="scalingProblem !== null && form.min_tasks > form.max_tasks"
                  hide-bottom-space
                />
              </div>
              <div class="col-6 col-sm-3">
                <q-input
                  v-model.number="form.max_tasks"
                  outlined
                  dense
                  type="number"
                  min="1"
                  label="Max tasks"
                  :error="scalingProblem !== null && form.min_tasks > form.max_tasks"
                  hide-bottom-space
                />
              </div>
              <div class="col-6 col-sm-3">
                <q-select
                  v-model="form.scaling_metric"
                  outlined
                  dense
                  emit-value
                  map-options
                  label="Track"
                  :options="[
                    { label: 'CPU', value: 'cpu' },
                    { label: 'Memory', value: 'memory' },
                  ]"
                />
              </div>
              <div class="col-6 col-sm-3">
                <q-input
                  v-model.number="form.scaling_target"
                  outlined
                  dense
                  type="number"
                  min="10"
                  max="90"
                  label="Target %"
                  hide-bottom-space
                />
              </div>

              <div class="col-6 col-sm-3">
                <q-input
                  v-model.number="form.scale_out_cooldown"
                  outlined
                  dense
                  type="number"
                  min="0"
                  label="Scale-out wait (s)"
                  hide-bottom-space
                />
              </div>
              <div class="col-6 col-sm-3">
                <q-input
                  v-model.number="form.scale_in_cooldown"
                  outlined
                  dense
                  type="number"
                  min="0"
                  label="Scale-in wait (s)"
                  hide-bottom-space
                />
              </div>

              <div class="col-12">
                <!-- Said in a sentence rather than left to be inferred from six
                     numbers, because the cost floor is the part people miss. -->
                <q-banner
                  dense
                  rounded
                  :class="scalingProblem ? 'bg-red-1 text-grey-9' : 'bg-blue-1 text-grey-9'"
                >
                  <template #avatar>
                    <q-icon :name="scalingProblem ? 'error' : 'info'" :color="scalingProblem ? 'negative' : 'info'" />
                  </template>
                  <div class="text-body2">{{ scalingProblem ?? scalingSummary }}</div>
                </q-banner>
              </div>
            </template>
          </div>
        </q-card-section>

        <q-card-actions align="right">
          <q-btn flat no-caps label="Cancel" :disable="busy" @click="serviceDialog = false" />
          <q-btn
            unelevated
            no-caps
            color="primary"
            :label="editingName ? 'Save and re-check' : 'Check and register'"
            :loading="busy"
            :disable="!canSubmit"
            @click="submitService"
          />
        </q-card-actions>
      </q-card>
    </q-dialog>
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

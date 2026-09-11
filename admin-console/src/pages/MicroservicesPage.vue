<script setup lang="ts">
import { computed, nextTick, ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { useQuasar } from 'quasar';
import {
  api,
  ApiError,
  buildRunning,
  launchInFlight,
  type BuildState,
  type CapacityType,
  type ClusterScalingMode,
  type GpuMode,
  type ComputeInput,
  type InstanceType,
  type GithubAppStatus,
  type GithubInstallation,
  type GithubRepo,
  type LaunchState,
  type LaunchStatus,
  type Microservice,
  type MicroserviceCheckState,
  type MicroserviceStatus,
  type ComputeCluster,
  type ScalingMetric,
  type ScalingMode,
} from '@/api/client';
import { useAsyncValue } from '@/composables/useAsyncValue';
import { vcpu } from '@/format';
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
 * Adding a service is a wizard, and it ends with the service running. It asks
 * for a source, then hardware, then a runtime shape, and then takes every step
 * those answers were for: the service's own dedicated cluster, an image
 * repository and log groups, an image built from the branch, and the ECS
 * service. Nobody is sent to another page to finish the job — a cluster carries
 * exactly one service, so there was never a second decision to make.
 *
 * The build in the middle takes minutes, which is why a launch has its own
 * state on the row rather than living in this tab. The page polls while one is
 * in flight; the server finishes it either way.
 */

const $q = useQuasar();
const route = useRoute();
const router = useRouter();
const auth = useAuthStore();
const isAdmin = computed(() => auth.isAdmin);

const HINTS = {
  connection:
    'The App is installed once, by one admin. What gets stored is a grant belonging to ' +
    'the repository owner — not a GitHub login — so it keeps working after that person ' +
    'leaves, and every other console user configures microservices without a GitHub ' +
    'account of their own.',
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
    'Services with AWS resources behind them — an ECS cluster, an image repository, log ' +
    'groups, and for a deployed one a running service. A registered service that has ' +
    'never been launched has none of these and costs nothing.',
  runtime:
    'The task size the Fargate service will be given. Fargate accepts only specific ' +
    'CPU values, and each one allows a limited memory range — so the memory choices ' +
    'change with the CPU.',
  scaling:
    'How many tasks run. A fixed count always runs that many and costs the same idle ' +
    'or busy. Auto scaling lets ECS move between a floor and a ceiling to hold CPU or ' +
    'memory near a target, so you pay for what is running — but never less than the ' +
    'floor. The target-tracking policy is created when the service is deployed.',
  cluster:
    'The hardware this service runs on. Fargate has no machines to manage and no GPUs; ' +
    'EC2 runs one instance type, which is the only way to get a GPU. A dedicated ECS ' +
    'cluster is created for this service alone — one cluster carries one service, which ' +
    'is what makes its cost and its capacity attributable, and is why there is nothing ' +
    'to pick or name here. It is created and destroyed with the service; the Capacity ' +
    'page is for watching and adjusting it.',
  gpuMode:
    'Exclusive gives each task a whole GPU, enforced by ECS — one task per card. Shared ' +
    'declares no GPU requirement, so tasks pack by CPU and memory and every one of them ' +
    'sees the card. Shared is the only way to fit several small models on one GPU, because ' +
    'ECS allocates whole devices and nothing below the driver can enforce a fraction.',
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


const list = computed<Microservice[]>(() => services.data.value?.microservices ?? []);
/** The row the form is editing, for the parts of it that are read-only. */
const editingRow = computed<Microservice | null>(
  () => list.value.find((row) => row.name === editingName.value) ?? null
);
const installationList = computed<GithubInstallation[]>(
  () => installations.data.value?.installations ?? []
);
const connected = computed(() => appStatus.data.value?.configured === true);
const attentionCount = computed(
  () => list.value.filter((row) => row.check_state !== 'ok').length
);
// Anything with AWS resources behind it, which is not the same as "running":
// a service whose build failed is scaffolded, billing for nothing, and still
// worth counting here — it is the number that has resources to clean up.
const provisionedCount = computed(
  () => list.value.filter((row) => row.provision_state !== 'not_provisioned').length
);

/** Clusters a service can be placed on, and the one it is currently on. */
const clusterList = computed<ComputeCluster[]>(() => clusters.data.value?.clusters ?? []);

/**
 * The hardware this service runs on.
 *
 * Part of the service form, not a cluster to pick. A cluster carries exactly
 * one service, so it is a property of the service — one is created for it
 * automatically, named after it, and provisioned along with it. There is no
 * cluster to choose, create beforehand, or attach.
 *
 * Fargate is the default: nothing to manage, no cost when idle.
 */
const compute = ref({
  capacity_type: 'fargate' as CapacityType,
  instance_type: '',
  scaling_mode: 'auto' as ClusterScalingMode,
  min_instances: 0,
  max_instances: 4,
  target_capacity: 100,
  gpus_per_instance: 0,
  gpu_vram_mb: 0,
  gpu_mode: 'shared' as GpuMode,
});

const computeIsEc2 = computed(() => compute.value.capacity_type === 'ec2');

/** The cluster a service already has, for the read-only summary when editing. */
const clusterOf = (row: Microservice | null): ComputeCluster | null =>
  row?.cluster_name
    ? (clusterList.value.find((cluster) => cluster.name === row.cluster_name) ?? null)
    : null;

/** The instance catalog, so the GPU facts are not typed from memory here either. */
const catalog = useAsyncValue<{ instance_types: InstanceType[]; memory_overhead_mib: number }>(
  (signal) => api.instanceTypes(signal)
);

const instanceOptions = computed(() =>
  (catalog.data.value?.instance_types ?? []).map((spec) => ({
    value: spec.name,
    label:
      `${spec.name} — ${spec.vcpu} vCPU, ${Math.round(spec.memoryMib / 1024)} GB` +
      (spec.gpus > 0 ? `, ${spec.gpuModel}` : ''),
  }))
);

const computeInstance = computed<InstanceType | null>(
  () =>
    (catalog.data.value?.instance_types ?? []).find(
      (spec) => spec.name === compute.value.instance_type.trim()
    ) ?? null
);

function applyInstancePreset(value: string | null): void {
  const spec = (catalog.data.value?.instance_types ?? []).find((row) => row.name === value);
  if (!spec) return;
  compute.value.gpus_per_instance = spec.gpus;
  compute.value.gpu_vram_mb = spec.gpuVramMb;
}

/**
 * The hardware this service will actually be on.
 *
 * On the add path that is whatever the compute fields say. On the edit path the
 * capacity already exists as a cluster and is edited there, so the questions
 * below read from it instead.
 */
const effectiveCompute = computed<{
  gpus_per_instance: number;
  gpu_mode: GpuMode;
  capacity_type: CapacityType;
  instance_type: string | null;
  gpu_vram_mb: number;
} | null>(() => {
  if (!editingName.value) {
    return {
      gpus_per_instance: computeIsEc2.value ? compute.value.gpus_per_instance : 0,
      gpu_mode: compute.value.gpu_mode,
      capacity_type: compute.value.capacity_type,
      instance_type: computeIsEc2.value ? compute.value.instance_type.trim() : null,
      gpu_vram_mb: compute.value.gpu_vram_mb,
    };
  }
  const found = clusterList.value.find((cluster) => cluster.name === form.value.cluster_name);
  return found ?? null;
});

/** Only a shared GPU leaves video memory unguarded, so only it asks. */
const needsVram = computed(
  () =>
    (effectiveCompute.value?.gpus_per_instance ?? 0) > 0 &&
    effectiveCompute.value?.gpu_mode === 'shared'
);

/**
 * Whether the task's memory or CPU exceeds what the chosen instance can give.
 *
 * The API refuses this at deploy time, but by then the cluster exists and
 * instances may be running. Said here, while the number is still being typed:
 * ECS accepts an oversized task definition and simply never places it, which
 * surfaces as a service stuck at 0/1 with no explanation.
 */
const taskTooLarge = computed<string | null>(() => {
  const hardware = effectiveCompute.value;
  if (!hardware || hardware.capacity_type !== 'ec2') return null;
  const spec = (catalog.data.value?.instance_types ?? []).find(
    (entry) => entry.name === hardware.instance_type
  );
  if (!spec) return null;

  if (form.value.memory > spec.task_memory_ceiling) {
    return `A ${spec.name} can only offer about ${Math.round(spec.task_memory_ceiling / 1024)} GB to tasks — the agent and the OS take the rest. This task asks for ${Math.round(form.value.memory / 1024)} GB and would never place.`;
  }
  if (form.value.cpu > spec.vcpu * 1024) {
    return `A ${spec.name} has ${spec.vcpu} vCPU. This task asks for ${vcpu(form.value.cpu)}.`;
  }
  return null;
});

/**
 * The URL GitHub must be configured to redirect to.
 *
 * Derived from where this page is actually served rather than from config: it
 * is the one value that has to match byte for byte, and a hand-copied one that
 * does not is the likeliest reason an install fails at the last step.
 */


function reloadAll(): void {
  void clusters.reload();
  void appStatus.reload();
  void installations.reload();
  void services.reload();
}

function stateTone(state: string): string {
  if (state === 'provisioned') return 'positive';
  if (state === 'failed') return 'negative';
  if (state === 'scaffolded') return 'info';
  return 'grey-6';
}

function stateLabel(state: string): string {
  if (state === 'not_provisioned') return 'not provisioned';
  if (state === 'scaffolded') return 'ready to build';
  return state;
}

/** The same states in one word, for the badge in the list. */
const LAUNCH_BADGES: Record<LaunchState, string> = {
  none: '',
  requested: 'launching',
  provisioning: 'provisioning',
  building: 'building',
  deploying: 'deploying',
  running: 'running',
  failed: 'launch failed',
};

function reportError(error: unknown, fallback: string): void {
  $q.notify({
    type: 'negative',
    message: error instanceof ApiError ? error.message : fallback,
    timeout: 9000,
    multiLine: true,
  });
}

// ── GitHub App credentials ───────────────────────────────────────────────────

// ── Microservice add / edit ──────────────────────────────────────────────────

const serviceDialog = ref(false);
const editingName = ref<string | null>(null);
const dialogError = ref<string | null>(null);

/**
 * The questions, in the order they depend on each other.
 *
 * A wizard rather than one long form because that is what adding a service
 * actually is: the source decides whether there is anything to build, the
 * hardware decides what task sizes are even possible, and the runtime shape is
 * chosen against that hardware. Presented all at once, the last page's
 * validation kept referring to the first page's answers.
 *
 * Editing gets the same steps with a clickable header instead of Continue.
 * Someone editing came for one field and knows which.
 */
type WizardStep = 'source' | 'compute' | 'runtime' | 'launch';

const STEP_ORDER: WizardStep[] = ['source', 'compute', 'runtime', 'launch'];

const step = ref<WizardStep>('source');

/**
 * Whether to bring the service up, or only register it.
 *
 * On by default: the whole point of asking these questions is to get something
 * running, and leaving it off by default would restore the redundant second
 * trip this replaced. It is still a checkbox, because it is the moment
 * something starts costing money and that deserves to be visible and
 * refusable.
 */
const startNow = ref(true);
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
  const unit = form.value.cpu;
  return (
    `Runs ${min}–${max} tasks, adding one when average ${metric === 'cpu' ? 'CPU' : 'memory'} ` +
    `goes above ${target}%. You always pay for at least ${min} task${min === 1 ? '' : 's'} ` +
    `(${vcpu(min * unit)} in total), even when idle.`
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
  step.value = 'source';
  startNow.value = true;
  repoOptions.value = [];
  compute.value = {
    capacity_type: 'fargate',
    instance_type: '',
    scaling_mode: 'auto',
    min_instances: 0,
    max_instances: 4,
    target_capacity: 100,
    gpus_per_instance: 0,
    gpu_vram_mb: 0,
    gpu_mode: 'shared',
  };
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
    cluster_name: null,
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

/**
 * Opening the editor from somewhere else.
 *
 * The service's own page carries every action except this one: the form that
 * edits a service is the same long, validated form that creates one, and a
 * second copy of it there would be a second thing to keep correct. So that page
 * links here with the service named, and this opens the form on it.
 *
 * The query is cleared as soon as it is spent, so a reload does not reopen a
 * dialog the operator has closed.
 */
watch(
  [() => route.query.edit, () => services.state.value],
  ([wanted]) => {
    if (typeof wanted !== 'string' || !wanted) return;
    const row = list.value.find((entry) => entry.name === wanted);
    if (!row) return;
    openEdit(row);
    void router.replace({ name: 'microservices' });
  },
  { immediate: true }
);

function openEdit(row: Microservice): void {
  editingName.value = row.name;
  dialogError.value = null;
  // Editing starts on the source step like adding does, but every header is
  // clickable — someone editing came for one field and knows which.
  step.value = 'source';
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

/**
 * What is wrong with the cluster half of the form, if anything.
 *
 * Checked here as well as server-side so the button refuses before a round
 * trip, and so the message sits next to the field that produced it.
 */
const clusterProblem = computed<string | null>(() => {
  if (editingName.value || !computeIsEc2.value) return null;
  if (!compute.value.instance_type.trim()) {
    return 'Name the instance type to run on.';
  }
  if (compute.value.max_instances < compute.value.min_instances) {
    return `Maximum instances (${compute.value.max_instances}) is below the minimum (${compute.value.min_instances}).`;
  }
  if (compute.value.max_instances < 1) return 'Maximum instances must be at least 1.';
  if (compute.value.gpus_per_instance > 0 && compute.value.gpu_vram_mb <= 0) {
    return 'Record how much memory one card has — it is what lets the console refuse a GPU overcommit.';
  }
  return null;
});

/**
 * What is missing from the source step.
 *
 * Per step rather than per form, so Continue can refuse with the reason next to
 * the fields that produced it instead of a single disabled button at the end
 * that never says which page is wrong.
 */
const sourceProblem = computed<string | null>(() => {
  if (!editingName.value && form.value.name.trim().length < 2) {
    return 'Name the service. It becomes the ECR repository, the ECS service and its cluster.';
  }
  if (form.value.installation_id === null) return 'Choose the GitHub account to build from.';
  if (form.value.repo_id === null) return 'Choose a repository.';
  if (!form.value.branch.trim()) return 'Name the branch to build.';
  if (!form.value.dockerfile_path.trim()) return 'Say where the Dockerfile is.';
  return null;
});

/** Task size and scaling, checked against the hardware chosen a step earlier. */
const runtimeProblem = computed<string | null>(() => scalingProblem.value ?? taskTooLarge.value);

const stepProblem = computed<Record<WizardStep, string | null>>(() => ({
  source: sourceProblem.value,
  compute: clusterProblem.value,
  runtime: runtimeProblem.value,
  launch: null,
}));

/** Every step has to be answerable before the last one can act. */
const canSubmit = computed(
  () =>
    sourceProblem.value === null &&
    clusterProblem.value === null &&
    runtimeProblem.value === null
);

const stepIndex = computed(() => STEP_ORDER.indexOf(step.value));
const isLastStep = computed(() => stepIndex.value === STEP_ORDER.length - 1);

function nextWizardStep(): void {
  if (stepProblem.value[step.value] !== null) return;
  const next = STEP_ORDER[stepIndex.value + 1];
  if (next) step.value = next;
}

function previousWizardStep(): void {
  const previous = STEP_ORDER[stepIndex.value - 1];
  if (previous) step.value = previous;
}

/**
 * What the last step is about to do, as a list rather than a sentence.
 *
 * Every line is something that gets created or spent, named with the value that
 * will actually be used. It exists because this is the only screen between a
 * form and a GPU instance, and "are you sure" is not a description.
 */
const launchPlan = computed<string[]>(() => {
  const name = form.value.name.trim() || 'the service';
  const repo = selectedRepo.value?.full_name ?? 'the repository';
  const hardware = computeIsEc2.value
    ? `${compute.value.instance_type.trim() || 'EC2'} instances` +
      (compute.value.gpus_per_instance > 0
        ? `, ${compute.value.gpus_per_instance}× GPU (${compute.value.gpu_mode})`
        : '')
    : 'Fargate';

  const tasks =
    form.value.scaling_mode === 'auto'
      ? `${form.value.min_tasks}–${form.value.max_tasks} tasks, scaling on ${form.value.scaling_metric} to ${form.value.scaling_target}%`
      : `${form.value.desired_count} task${form.value.desired_count === 1 ? '' : 's'}`;

  const size = `${vcpu(form.value.cpu)} / ${Math.round(form.value.memory / 1024)} GB`;

  /**
   * Registering and launching create genuinely different things, so the list
   * says which. Without the launch nothing reaches AWS at all — both rows are
   * a record of intent, and a plan that claimed an ECS cluster had been
   * created would be describing the other choice.
   */
  if (!startNow.value) {
    return [
      `A registry entry for "${name}", refused unless ${form.value.dockerfile_path.trim()} is really on that branch.`,
      `A cluster named "${name}" reserved for it, on ${hardware} — recorded, not created. Nothing exists on AWS and nothing bills until you launch it.`,
    ];
  }

  return [
    `A dedicated ECS cluster named "${name}" running on ${hardware}.`,
    'An image repository, container and build log groups, and a CodeBuild project.',
    `An image built from ${repo}@${form.value.branch.trim()} using ${form.value.dockerfile_path.trim()}.`,
    `${tasks} of ${size}, started when that build succeeds.`,
  ];
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
        position: 'top',
      });
      serviceDialog.value = false;
    } else {
      // The cluster is created server-side from this, named after the service.
      // Nothing here names or chooses one.
      const computePayload: ComputeInput = computeIsEc2.value
        ? {
            capacity_type: 'ec2',
            instance_type: compute.value.instance_type.trim(),
            scaling_mode: compute.value.scaling_mode,
            min_instances: compute.value.min_instances,
            max_instances: compute.value.max_instances,
            target_capacity: compute.value.target_capacity,
            gpus_per_instance: compute.value.gpus_per_instance,
            gpu_vram_mb: compute.value.gpu_vram_mb,
            gpu_mode: compute.value.gpu_mode,
          }
        : { capacity_type: 'fargate' };

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
        compute: computePayload,
        gpu_vram_mb: form.value.gpu_vram_mb,
        /**
         * The bring-up, recorded with the row that is being created.
         *
         * This flag does not do the work — the call below it does. What it buys
         * is that the decision survives this browser: the row is created in
         * `requested`, so if the launch call never lands, the server finishes
         * what was asked for on its next pass anyway.
         */
        launch: startNow.value,
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

      const created = result.microservice.name;
      serviceDialog.value = false;

      if (!startNow.value) {
        $q.notify({
          type: 'positive',
          message: `${created} registered — Dockerfile found at ${result.microservice.dockerfile_path}.`,
          caption:
            'Its capacity is recorded but nothing exists on AWS yet. Launch it when you ' +
            'want it running.',
          position: 'top',
        });
      } else {
        /**
         * The launch runs behind the closed dialog, not in front of it.
         *
         * It is ten to twenty seconds of AWS calls, and a modal spinner for
         * that long tells the operator less than the progress on the service's
         * own page does — which is already showing, because the create recorded
         * the launch as requested.
         *
         * Its failure is its own failure, too: reported as a notification
         * rather than as `dialogError`, because the service is saved and valid
         * either way and the server retries the launch on its next pass.
         * Putting the form back up over a service that already exists would
         * only invite a second attempt at the same name.
         */
        void (async () => {
          try {
            const launched = await api.microserviceLaunch(created);
            $q.notify({
              type: launched.error ? 'negative' : 'info',
              message: launched.error
                ? `${created}: the launch stopped — ${launched.error}`
                : `Launching ${created}`,
              position: 'top',
              timeout: launched.error ? 0 : 8000,
              multiLine: true,
            });
          } catch (error) {
            reportError(
              error,
              `${created} was created, but its launch could not be started. The server retries ` +
                'on its own; you can also launch it from the service.'
            );
          } finally {
            void services.reload();
          }
        })();
      }

      /**
       * Straight to the new service's own page.
       *
       * It is where the launch it just started is shown, and the alternative —
       * landing back on a list where the only sign of it is a badge — makes the
       * operator find their own service to watch it.
       */
      void router.push({ name: 'microservice', params: { name: created } });
    }
    void services.reload();
    // A cluster was created with it, and a launch has begun creating its AWS
    // resources.
    void clusters.reload();
  } catch (error) {
    dialogError.value =
      error instanceof ApiError ? error.message : 'The microservice could not be saved.';
  } finally {
    busy.value = false;
  }
}

</script>

<template>
  <q-page padding>
    <PageHeader title="Microservices">
      <template #subtitle>
        Services built from a GitHub repository's own Dockerfile and run on ECS. Open one to
        manage it — its source, logs, capacity and actions are all on its own page.
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

    <!--
      Without the App there is nothing this page can do, and the thing that
      fixes it is a deployment setting rather than anything here — so the page
      says so once and points at it, instead of rendering an empty registry
      above a form that cannot be opened.

      Waits for the status to load: "not connected" and "not asked yet" look the
      same from here, and flashing a setup prompt at someone whose connection is
      fine is worse than a moment of nothing.
    -->
    <SectionCard
      v-if="!connected && appStatus.state.value === 'ready'"
      title="No GitHub App is connected"
      lede="Microservices are built from a repository's own Dockerfile, so this deployment needs a GitHub App before anything can be registered."
    >
      <div class="text-body2 text-grey-8" style="max-width: 72ch">
        <p>
          The App is created and installed once, by one admin. What gets stored is a grant
          belonging to the repository owner rather than anybody's GitHub login — so it keeps
          working after that person leaves, and every other console user can configure a
          service without a GitHub account of their own.
        </p>
        <p v-if="!isAdmin" class="text-grey-7">
          Setting it up is an admin action. An admin can do it from Settings.
        </p>
      </div>

      <template #footer>
        <q-btn
          unelevated
          no-caps
          color="primary"
          icon="hub"
          label="Set up the GitHub App"
          :to="{ name: 'github-settings' }"
        />
      </template>
    </SectionCard>

    <!--
      Four explicit steps, and the page has to teach them, because each spends
      something different: provisioning is free, building spends CodeBuild
      minutes, deploying starts instances that bill by the second.
    -->
    <q-banner v-if="connected" rounded class="bg-blue-1 text-grey-9 q-mb-md">
      <template #avatar><q-icon name="info" color="info" /></template>
      <div class="text-weight-medium">Add a service and it runs</div>
      <div class="text-body2">
        Adding one asks for a source, the hardware to run it on, and a runtime shape, then
        does everything those answers were for: its own ECS cluster and image repository,
        an image built from your branch in CodeBuild, and the ECS service — where tasks
        begin billing. The build takes minutes and finishes on its own, so you can leave
        the page. <strong>Delete</strong> undoes all of it in one action. The individual
        steps below a service are there to resume one that stopped halfway; the Capacity
        page is for adjusting the hardware afterwards.
      </div>
    </q-banner>

    <!--
      The App exists but no account has installed it, which is a different
      problem with a different fix and the same dead end for this page.
    -->
    <q-banner
      v-else-if="connected && !installationList.length && installations.state.value === 'ready'"
      rounded
      class="bg-orange-1 text-grey-9 q-mb-md"
    >
      <template #avatar><q-icon name="warning" color="warning" /></template>
      <div class="text-weight-medium">The App is created but not installed anywhere</div>
      <div class="text-body2">
        It has to be installed on the account that owns the repositories before any of them
        can be reached.
      </div>
      <template #action>
        <q-btn flat dense no-caps label="Install it" :to="{ name: 'github-settings' }" />
      </template>
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
                <router-link class="plain-link" :to="{ name: 'github-settings' }">
                  {{ installationList.length }}
                </router-link>
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

    <!-- Registry -->
    <div v-if="connected" class="row q-col-gutter-md">
      <div class="col-12">
        <SectionCard
          title="Registry"
          lede="One row per microservice. Open one to manage it: its source, image, logs, capacity and actions are all on its own page."
          flush
        >
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
                :to="{ name: 'microservice', params: { name: row.name } }"
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
                  <div class="row items-center no-wrap q-gutter-sm">
                  <div class="column items-end q-gutter-xs">
                    <q-chip
                      dense
                      square
                      size="sm"
                      :color="`${CHECK_LABELS[row.check_state].color}-1`"
                      :text-color="CHECK_LABELS[row.check_state].color"
                      class="q-ma-none"
                    >
                      {{ CHECK_LABELS[row.check_state].label }}
                    </q-chip>
                    <q-badge
                      :color="stateTone(row.provision_state)"
                      :outline="row.provision_state === 'not_provisioned'"
                    >
                      {{ stateLabel(row.provision_state) }}
                    </q-badge>
                    <!--
                      A launch is the one thing worth surfacing in the list: it
                      is the only state that moves on its own, and the operator
                      who started it is often looking at a different row by the
                      time it lands.
                    -->
                    <q-badge v-if="launchInFlight(row.launch_state)" color="info">
                      <q-spinner size="10px" class="q-mr-xs" />
                      {{ LAUNCH_BADGES[row.launch_state] }}
                    </q-badge>
                    <q-badge v-else-if="row.launch_state === 'failed'" color="negative">
                      launch failed
                    </q-badge>
                    <q-badge v-else-if="buildRunning(row.build_state)" color="info">
                      <q-spinner size="10px" class="q-mr-xs" />building
                    </q-badge>
                  </div>
                    <q-icon name="chevron_right" color="grey-6" size="20px" />
                  </div>
                </q-item-section>
              </q-item>
            </q-list>
          </AsyncValue>
        </SectionCard>
      </div>
    </div>

    <!-- App credentials dialog -->
    <q-dialog v-model="serviceDialog" persistent>
      <q-card style="min-width: min(680px, 94vw); max-width: 94vw">
        <q-card-section>
          <div class="text-h6">
            {{ editingName ? `Edit ${editingName}` : 'Add microservice' }}
          </div>
          <div class="text-body2 text-grey-7 q-mt-xs">
            {{
              editingName
                ? 'Saving checks GitHub again: the branch has to exist and there has to be a Dockerfile where you say. Nothing is stored unless it does.'
                : 'Four questions, and then it runs. The source is checked against GitHub before anything is stored, and a cluster of its own is created for it — there is nothing to set up first.'
            }}
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

          <!--
            A wizard on the add path, a tabbed form on the edit path.

            Same steps either way, but `header-nav` only when editing: adding is
            a sequence where each answer constrains the next — the instance type
            decides which task sizes can even place — while editing is someone
            who came for one field and knows which.
          -->
          <q-stepper
            v-model="step"
            flat
            animated
            keep-alive
            color="primary"
            class="wizard"
            :header-nav="editingName !== null"
          >
            <q-step
              name="source"
              title="Source"
              icon="source"
              :done="stepIndex > 0"
              :error="step !== 'source' && stepProblem.source !== null"
            >
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

                <div v-if="stepProblem.source" class="col-12">
                  <div class="text-caption text-grey-7">{{ stepProblem.source }}</div>
                </div>
              </div>
            </q-step>

            <q-step
              name="compute"
              title="Hardware"
              icon="memory"
              :done="stepIndex > 1"
              :error="step !== 'compute' && stepProblem.compute !== null"
            >
              <div class="row q-col-gutter-md">
                <div class="col-12">
                  <div class="text-body2 text-grey-8 row items-center">
                    The machines this service runs on.<InfoHint :text="HINTS.cluster" />
                  </div>
                </div>

                <!--
                  No cluster to pick, create beforehand, or attach. A cluster
                  carries exactly one service, so it is a property of the service:
                  one is created for it automatically, named after it, and
                  provisioned with it. These are just the hardware questions.
                -->
                <template v-if="!editingName">
                  <div class="col-12">
                    <q-btn-toggle
                      v-model="compute.capacity_type"
                      no-caps
                      unelevated
                      dense
                      toggle-color="primary"
                      :options="[
                        { label: 'Fargate', value: 'fargate' },
                        { label: 'EC2 instances', value: 'ec2' },
                      ]"
                    />
                    <div class="text-caption text-grey-7 q-mt-xs">
                      {{
                        computeIsEc2
                          ? 'A pool of instances you own — the only option that can have GPUs, billed per instance-hour whether or not a task is running.'
                          : 'AWS runs the machines. Nothing to manage, an idle service costs nothing, and there are no GPUs.'
                      }}
                    </div>
                  </div>

                  <template v-if="computeIsEc2">
                    <div class="col-12 col-sm-7">
                      <q-select
                        v-model="compute.instance_type"
                        outlined
                        dense
                        use-input
                        fill-input
                        hide-selected
                        new-value-mode="add-unique"
                        input-debounce="0"
                        label="Instance type"
                        :options="instanceOptions"
                        :loading="catalog.state.value === 'loading'"
                        emit-value
                        map-options
                        @update:model-value="applyInstancePreset"
                      />
                      <div v-if="computeInstance" class="text-caption text-grey-7 q-mt-xs">
                        {{ computeInstance.vcpu }} vCPU ·
                        {{ Math.round(computeInstance.memoryMib / 1024) }} GB · tasks up to
                        {{ Math.round(computeInstance.task_memory_ceiling / 1024) }} GB
                        <template v-if="computeInstance.gpus > 0">
                          · {{ computeInstance.gpuModel }}
                        </template>
                      </div>
                      <div
                        v-else-if="compute.instance_type.trim()"
                        class="text-caption text-orange-9 q-mt-xs"
                      >
                        Not in the catalog — its GPU count and video memory are taken at your word.
                      </div>
                    </div>

                    <div class="col-12 col-sm-5">
                      <q-select
                        v-model="compute.scaling_mode"
                        outlined
                        dense
                        emit-value
                        map-options
                        label="Instance count"
                        :options="[
                          { label: 'Auto scale', value: 'auto' },
                          { label: 'Fixed', value: 'fixed' },
                        ]"
                      />
                    </div>

                    <div class="col-6 col-sm-4">
                      <q-input
                        v-model.number="compute.min_instances"
                        outlined
                        dense
                        type="number"
                        min="0"
                        :label="compute.scaling_mode === 'fixed' ? 'Instances' : 'Min instances'"
                      />
                    </div>
                    <div v-if="compute.scaling_mode === 'auto'" class="col-6 col-sm-4">
                      <q-input
                        v-model.number="compute.max_instances"
                        outlined
                        dense
                        type="number"
                        min="1"
                        label="Max instances"
                      />
                    </div>
                    <div v-if="compute.scaling_mode === 'auto'" class="col-6 col-sm-4">
                      <q-input
                        v-model.number="compute.target_capacity"
                        outlined
                        dense
                        type="number"
                        min="1"
                        max="100"
                        label="Target capacity %"
                      />
                    </div>

                    <div class="col-6 col-sm-4">
                      <q-input
                        v-model.number="compute.gpus_per_instance"
                        outlined
                        dense
                        type="number"
                        min="0"
                        label="GPUs per instance"
                      />
                    </div>
                    <div v-if="compute.gpus_per_instance > 0" class="col-6 col-sm-4">
                      <q-input
                        v-model.number="compute.gpu_vram_mb"
                        outlined
                        dense
                        type="number"
                        min="0"
                        label="VRAM per card (MiB)"
                      />
                    </div>
                    <div v-if="compute.gpus_per_instance > 0" class="col-12 col-sm-4">
                      <q-select
                        v-model="compute.gpu_mode"
                        outlined
                        dense
                        emit-value
                        map-options
                        label="GPU sharing"
                        :options="[
                          { label: 'Shared', value: 'shared' },
                          { label: 'Exclusive', value: 'exclusive' },
                        ]"
                      >
                        <template #append><InfoHint :text="HINTS.gpuMode" /></template>
                      </q-select>
                    </div>
                  </template>
                </template>

                <!--
                  On edit the hardware already exists as this service's cluster, and
                  changing it replaces instances — so it is shown, not offered, and
                  edited where that consequence is explained.
                -->
                <div v-else class="col-12">
                  <div class="text-body2">
                    Runs on
                    <template v-if="clusterOf(editingRow)">
                      <span class="text-weight-medium">
                        {{
                          clusterOf(editingRow)!.capacity_type === 'fargate'
                            ? 'Fargate'
                            : clusterOf(editingRow)!.instance_type
                        }}
                      </span>
                      <template v-if="clusterOf(editingRow)!.gpus_per_instance">
                        · {{ clusterOf(editingRow)!.gpus_per_instance }}× GPU
                      </template>
                    </template>
                    <span v-else class="text-orange-9">nothing — its capacity was removed</span>
                  </div>
                  <div class="text-caption text-grey-7 q-mt-xs">
                    This hardware belongs to this service alone. Changing it replaces
                    instances, so it is done on the Capacity page where that consequence is
                    spelled out.
                  </div>
                </div>

                <div v-if="clusterProblem" class="col-12">
                  <q-banner rounded dense class="bg-orange-1 text-grey-9">
                    <template #avatar><q-icon name="warning" color="warning" /></template>
                    <div class="text-body2">{{ clusterProblem }}</div>
                  </q-banner>
                </div>
              </div>
            </q-step>

            <q-step
              name="runtime"
              title="Runtime"
              icon="tune"
              :done="stepIndex > 2"
              :error="step !== 'runtime' && stepProblem.runtime !== null"
            >
              <div class="row q-col-gutter-md">
                <div class="col-12">
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
                    :hint="`card has ${effectiveCompute?.gpu_vram_mb ?? 0} MiB`"
                  />
                </div>

                <!--
                  The API refuses this at deploy time, but by then the cluster
                  exists and instances may be running. ECS accepts an oversized
                  task definition and simply never places it, which surfaces as a
                  service stuck at 0/1 with no explanation.
                -->
                <div v-if="taskTooLarge" class="col-12">
                  <q-banner rounded dense class="bg-orange-1 text-grey-9">
                    <template #avatar><q-icon name="warning" color="warning" /></template>
                    <div class="text-body2">{{ taskTooLarge }}</div>
                  </q-banner>
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
            </q-step>

            <!--
              The last step, and the only screen between a form and a GPU
              instance. So it lists what is about to be created, with the values
              that will actually be used, rather than asking "are you sure".
            -->
            <q-step
              name="launch"
              :title="editingName ? 'Review' : 'Launch'"
              icon="rocket_launch"
            >
              <div v-if="editingName" class="text-body2 text-grey-8">
                Saving re-checks the source against GitHub. It does not rebuild or redeploy —
                use Launch on the service for that, or the individual steps.
              </div>

              <template v-else>
                <div class="text-body2 text-grey-8 q-mb-sm">Creating this will:</div>
                <ul class="plan-list">
                  <li v-for="(line, index) in launchPlan" :key="index">{{ line }}</li>
                </ul>

                <q-checkbox v-model="startNow" label="Start it now" />
                <div class="text-caption text-grey-7 q-ml-lg" style="max-width: 66ch">
                  {{
                    computeIsEc2
                      ? `Builds the image and starts the service. ${compute.instance_type.trim() || 'The'} instances bill per hour from the moment they launch, whether or not a task is on them.`
                      : 'Builds the image and starts the service. Fargate bills per task while it runs.'
                  }}
                  Without this the service is registered and its cluster created, and nothing is
                  built or started until you launch it.
                </div>

                <q-banner
                  v-if="startNow"
                  dense
                  rounded
                  class="bg-blue-1 text-grey-9 q-mt-md"
                >
                  <template #avatar><q-icon name="schedule" color="info" /></template>
                  <div class="text-body2">
                    The image build takes minutes. This page follows it, and the service is
                    deployed as soon as the build succeeds — you do not have to wait here for
                    it, and there is nothing else to press.
                  </div>
                </q-banner>

                <q-banner
                  v-if="!canSubmit"
                  dense
                  rounded
                  class="bg-orange-1 text-grey-9 q-mt-md"
                >
                  <template #avatar><q-icon name="warning" color="warning" /></template>
                  <div class="text-body2">
                    {{ stepProblem.source ?? stepProblem.compute ?? stepProblem.runtime }}
                  </div>
                </q-banner>
              </template>
            </q-step>
          </q-stepper>
        </q-card-section>

        <q-card-actions align="right">
          <q-btn flat no-caps label="Cancel" :disable="busy" @click="serviceDialog = false" />
          <q-btn
            v-if="stepIndex > 0"
            flat
            no-caps
            label="Back"
            :disable="busy"
            @click="previousWizardStep"
          />
          <!--
            Continue refuses on the step that is wrong rather than leaving a
            disabled Create at the end, which never says which page to go back
            to.
          -->
          <q-btn
            v-if="!isLastStep"
            :unelevated="editingName === null"
            :outline="editingName !== null"
            no-caps
            color="primary"
            label="Continue"
            :disable="busy || stepProblem[step] !== null"
            @click="nextWizardStep"
          />
          <!--
            On the add path this is the last step's button, because the last
            step is where the plan and the cost are stated. On the edit path it
            is on every step: someone editing came for one field, and making
            them walk to the end to save it is the ceremony this page is
            supposed to be losing.
          -->
          <q-btn
            v-if="isLastStep || editingName !== null"
            unelevated
            no-caps
            color="primary"
            :icon="!editingName && startNow ? 'rocket_launch' : undefined"
            :label="
              editingName
                ? 'Save and re-check'
                : startNow
                  ? 'Create and launch'
                  : 'Create without launching'
            "
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

/* The stepper supplies its own padding; the dialog already has some. */
.wizard :deep(.q-stepper__step-inner) {
  padding: 8px 0 0;
}

.wizard :deep(.q-stepper__header) {
  border-bottom: 1px solid #e2e6ee;
}

.plan-list {
  padding-left: 20px;
  margin: 0 0 14px;
  line-height: 1.6;
  font-size: 13px;
  color: #1c2434;
}

.plan-list li {
  margin-bottom: 5px;
}

/* The count is a number first and a link second, so it keeps the heading
   colour and earns its underline only on hover. */
.plain-link {
  color: inherit;
  text-decoration: none;
}

.plain-link:hover {
  text-decoration: underline;
  text-decoration-color: #90b4e8;
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

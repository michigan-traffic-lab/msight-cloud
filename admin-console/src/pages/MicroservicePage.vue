<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { useQuasar } from 'quasar';
import {
  api,
  ApiError,
  buildRunning,
  launchInFlight,
  type BuildState,
  type ClusterHealthResponse,
  type ComputeCluster,
  type LaunchState,
  type LaunchStatus,
  type LogTail,
  type Microservice,
  type MicroserviceEvent,
  type MicroserviceEventKind,
  type MicroserviceStatus,
} from '@/api/client';
import AwsLink from '@/components/AwsLink.vue';
import InfoHint from '@/components/InfoHint.vue';
import PageHeader from '@/components/PageHeader.vue';
import SectionCard from '@/components/SectionCard.vue';
import { aws } from '@/aws-links';
import { bytes, mib, since, taskSize, timeOnly, vcpu, when } from '@/format';
import { highlight, isFiltering, matches, severityOf, shortStream } from '@/log-filter';
import { useAuthStore } from '@/stores/auth';

/**
 * One microservice, everything about it.
 *
 * A page rather than a panel beside a list, because there is genuinely a page
 * of material here — a source, an image, a task shape, a scaling policy, the
 * machines underneath, two log streams, and eight actions — and squeezing it
 * into half a column produced a view where the only way to find anything was to
 * already know where it was.
 *
 * The organising idea is that each tab answers one question an operator
 * actually arrives with. Overview: what is this and is it current. Logs: what
 * did it say. Capacity: what is it running on and is there room. Activity: what
 * has ECS been doing about it. The header carries the state and the action,
 * because those are what you need before you have decided which question you
 * have.
 */

const route = useRoute();
const router = useRouter();
const $q = useQuasar();
const auth = useAuthStore();
const isAdmin = computed(() => auth.isAdmin);

const HINTS = {
  streams:
    'Both stdout and stderr, and no way to tell them apart. The awslogs driver sends ' +
    'everything a container writes to either stream into one CloudWatch stream, and a ' +
    'CloudWatch event carries only a timestamp and the text — there is no field saying ' +
    'which one it came from. CodeBuild does the same with the build log. So nothing is ' +
    'missing here, but a line that looks like an error is identified by its wording ' +
    'rather than by its source.',
};

const name = computed(() => String(route.params.name ?? ''));
const tab = ref<'overview' | 'logs' | 'capacity' | 'activity'>('overview');

const busy = ref(false);

// ── The service itself ──────────────────────────────────────────────────────

const status = ref<MicroserviceStatus | null>(null);
const statusLoading = ref(false);
const statusError = ref<string | null>(null);

const service = computed<Microservice | null>(() => status.value?.microservice ?? null);
const runtime = computed(() => status.value?.runtime ?? null);

/** Polls while anything is still moving; stops the moment nothing is. */
let statusTimer: ReturnType<typeof setTimeout> | null = null;

function stopPolling(): void {
  if (statusTimer !== null) {
    clearTimeout(statusTimer);
    statusTimer = null;
  }
}

async function loadStatus(quiet = false): Promise<void> {
  if (!name.value) return;
  if (!quiet) statusLoading.value = true;
  statusError.value = null;
  const previousLaunch = service.value?.launch_state ?? null;
  const requested = name.value;

  try {
    const next = await api.microserviceStatus(requested);
    if (name.value !== requested) return;
    status.value = next;

    // Announced on the transition only, so a page left open does not repeat it
    // every six seconds.
    if (previousLaunch !== null && next.microservice.launch_state !== previousLaunch) {
      const wasRebuild = next.microservice.launch_kind === 'rebuild';
      const byPush = next.microservice.launch_trigger === 'push';

      // Every launch transition writes a history entry, so a state change is
      // exactly when the history is stale. Only refetched if it has been opened
      // once — an unopened tab does not need to be kept current.
      if (events.value) void loadEvents();

      if (next.microservice.launch_state === 'running') {
        $q.notify({
          type: 'positive',
          message: wasRebuild
            ? `${requested} redeployed${byPush ? ' from a push' : ''}.`
            : `${requested} is running.`,
          ...(next.microservice.build_commit_sha
            ? { caption: `Commit ${next.microservice.build_commit_sha.slice(0, 7)}` }
            : {}),
          position: 'top',
          timeout: 9000,
        });
      } else if (next.microservice.launch_state === 'failed') {
        $q.notify({
          type: 'negative',
          message: `${requested}: the ${wasRebuild ? 'rebuild' : 'launch'} did not finish.`,
          ...(next.microservice.launch_detail
            ? { caption: next.microservice.launch_detail }
            : {}),
          position: 'top',
          timeout: 0,
          multiLine: true,
          actions: [{ label: 'Dismiss', color: 'white' }],
        });
      }
    }

    /**
     * Six seconds while a launch or a build is live.
     *
     * This endpoint is also what advances the recorded build state and deploys
     * a launch whose build has landed, so the poll is not merely a refresh —
     * it is what makes the launch finish while someone is watching.
     */
    stopPolling();
    if (
      launchInFlight(next.microservice.launch_state) ||
      buildRunning(next.microservice.build_state)
    ) {
      statusTimer = setTimeout(() => void loadStatus(true), 6000);
    }
  } catch (error) {
    if (name.value !== requested) return;
    statusError.value =
      error instanceof ApiError ? error.message : 'This service could not be read.';
    if (error instanceof ApiError && error.status === 404) status.value = null;
  } finally {
    if (!quiet) statusLoading.value = false;
  }
}

// ── Its capacity ────────────────────────────────────────────────────────────

const cluster = ref<ComputeCluster | null>(null);
const health = ref<ClusterHealthResponse | null>(null);
const healthLoading = ref(false);
const healthError = ref<string | null>(null);

async function loadCapacity(): Promise<void> {
  const row = service.value;
  if (!row?.cluster_name) {
    cluster.value = null;
    health.value = null;
    return;
  }

  healthLoading.value = true;
  healthError.value = null;
  try {
    const [clusters, live] = await Promise.all([
      api.clusters(),
      api.clusterHealth(row.cluster_name),
    ]);
    cluster.value = clusters.clusters.find((entry) => entry.name === row.cluster_name) ?? null;
    health.value = live;
  } catch (error) {
    healthError.value =
      error instanceof ApiError ? error.message : 'The capacity could not be read.';
  } finally {
    healthLoading.value = false;
  }
}

const nodes = computed(() => health.value?.health?.instances ?? []);

/**
 * Fargate has no nodes, and that is not a degenerate case to render as zeros.
 *
 * There are no container instances to register, so "0 nodes · 0 vCPU of 0"
 * is the only answer those figures can ever give — and it reads as a broken
 * cluster rather than as the one that needs no machines. What is true on
 * Fargate is the tasks: how many run, and what each was given. So the two
 * capacity types show different things rather than the same things with
 * different numbers in them.
 */
const isFargate = computed(() => cluster.value?.capacity_type === 'fargate');

/** Tasks actually up, preferring the ECS service's own count over the cluster's. */
const runningTasks = computed(
  () => runtime.value?.running_count ?? health.value?.health?.running_tasks ?? 0
);

/** What those running tasks add up to — which is what Fargate bills for. */
const fargateInUse = computed(() => {
  const row = service.value;
  if (!row) return { cpu: 0, memory: 0 };
  return { cpu: row.cpu * runningTasks.value, memory: row.memory * runningTasks.value };
});

/**
 * How full something is, as a fraction.
 *
 * ECS reports what is left; what an operator reads is how much is gone. Doing
 * the subtraction once is what keeps the bar and the numbers beside it from
 * disagreeing.
 */
function used(registered: number, remaining: number): number {
  return Math.max(0, registered - remaining);
}

function fractionUsed(registered: number, remaining: number): number {
  return registered > 0 ? used(registered, remaining) / registered : 0;
}

function loadTone(fraction: number): string {
  if (fraction >= 0.9) return 'negative';
  if (fraction >= 0.7) return 'warning';
  return 'primary';
}

// ── Its logs ────────────────────────────────────────────────────────────────

/**
 * Two logs, chosen between rather than merged.
 *
 * The container log answers "why is it misbehaving" and the build log answers
 * "why is there nothing to run". Interleaving them would produce a stream in
 * which neither question is legible.
 *
 * stdout and stderr are not separated, because CloudWatch does not separate
 * them: both the awslogs driver and CodeBuild write one stream in the order the
 * process produced it, and that interleaving is what shows which output a
 * failure followed.
 */
const logSource = ref<'container' | 'build'>('container');
const logs = ref<LogTail | null>(null);
const logsLoading = ref(false);
const logsError = ref<string | null>(null);
const logLimit = ref(200);
const logBody = ref<HTMLElement | null>(null);
const followLogs = ref(true);

let logTimer: ReturnType<typeof setTimeout> | null = null;

function stopLogPolling(): void {
  if (logTimer !== null) {
    clearTimeout(logTimer);
    logTimer = null;
  }
}

async function loadLogs(quiet = false): Promise<void> {
  if (!name.value) return;
  if (!quiet) logsLoading.value = true;
  logsError.value = null;
  const requested = { name: name.value, source: logSource.value, stream: logStream.value };

  try {
    /**
     * A chosen task is read server-side rather than filtered out of the merged
     * tail. The merge reads only the newest few streams, so filtering it would
     * silently show nothing for the fourth task while looking like it worked.
     */
    const result = await api.microserviceLogs(
      requested.name,
      requested.source,
      logLimit.value,
      requested.source === 'container' ? requested.stream : null
    );
    if (
      name.value !== requested.name ||
      logSource.value !== requested.source ||
      logStream.value !== requested.stream
    ) {
      return;
    }
    logs.value = result;

    // Pinned to the newest line, the way a terminal behaves, unless the reader
    // has scrolled up to look at something.
    if (followLogs.value) {
      void Promise.resolve().then(() => {
        const element = logBody.value;
        if (element) element.scrollTop = element.scrollHeight;
      });
    }

    /**
     * Only a running build follows itself. It is the one thing here that
     * changes on a timescale anyone waits through, and the wait is exactly when
     * someone is watching it.
     */
    stopLogPolling();
    const row = service.value;
    if (
      tab.value === 'logs' &&
      logSource.value === 'build' &&
      row &&
      buildRunning(row.build_state)
    ) {
      logTimer = setTimeout(() => void loadLogs(true), 6000);
    }
  } catch (error) {
    if (name.value !== requested.name) return;
    logs.value = null;
    logsError.value = error instanceof ApiError ? error.message : 'The log could not be read.';
  } finally {
    if (!quiet) logsLoading.value = false;
  }
}

function onLogScroll(event: Event): void {
  const element = event.target as HTMLElement;
  // Within a line of the bottom counts as "at the bottom": a reader who has
  // scrolled up wants to stay there, and one who is at the end wants to follow.
  followLogs.value = element.scrollHeight - element.scrollTop - element.clientHeight < 24;
}

// ── History ─────────────────────────────────────────────────────────────────

/**
 * What has happened to this service, as opposed to what is true about it now.
 *
 * Every other panel on this page is a snapshot the next change overwrites. This
 * is the one that accumulates — and the only place a deployment can be traced
 * back to the commit that caused it, which is what an automatic rebuild makes
 * necessary rather than merely nice.
 */
const events = ref<MicroserviceEvent[] | null>(null);
const eventsLoading = ref(false);
const eventsError = ref<string | null>(null);

async function loadEvents(): Promise<void> {
  if (!name.value) return;
  const requested = name.value;
  eventsLoading.value = true;
  eventsError.value = null;
  try {
    const result = await api.microserviceEvents(requested, 50);
    if (name.value !== requested) return;
    events.value = result.events;
  } catch (error) {
    if (name.value !== requested) return;
    eventsError.value = error instanceof ApiError ? error.message : 'Could not load the history.';
  } finally {
    if (name.value === requested) eventsLoading.value = false;
  }
}

// ── Ways through to AWS ─────────────────────────────────────────────────────

/**
 * Built from stored ARNs, so each one is null until the thing exists.
 *
 * That nullness is the useful part: the header link appears when there is an
 * ECS service to look at and not before, rather than offering a link to a
 * cluster page that says "not found" for a service nobody has launched.
 */
const awsService = computed(() => aws.ecsService(service.value?.service_arn));
const awsCluster = computed(() => aws.ecsCluster(cluster.value?.cluster_arn));
const awsLogGroup = computed(() => aws.logGroup(service.value?.log_group_name));
const awsBuildLogGroup = computed(() => aws.logGroup(service.value?.build_log_group));
const awsBuildProject = computed(() => aws.codeBuildProject(service.value?.build_project_name));
const awsBuild = computed(() => aws.codeBuildBuild(service.value?.build_id));
const awsEcr = computed(() => aws.ecrRepository(service.value?.ecr_repository_uri));

/** The header's single link: the service if it exists, else its cluster. */
const awsPrimary = computed(() => awsService.value ?? awsCluster.value);

// ── Following the branch ────────────────────────────────────────────────────

const autoDeployBusy = ref(false);

async function setAutoDeploy(value: boolean): Promise<void> {
  const row = service.value;
  if (!row) return;

  autoDeployBusy.value = true;
  try {
    await api.microserviceUpdate(row.name, { auto_deploy: value });
    await loadStatus(true);
    $q.notify({
      type: 'positive',
      message: value
        ? `${row.name} will rebuild on every push to ${row.branch}.`
        : `${row.name} will no longer rebuild on a push.`,
      position: 'top',
    });
  } catch (error) {
    $q.notify({
      type: 'negative',
      message: error instanceof ApiError ? error.message : 'Could not change the setting.',
      position: 'top',
    });
  } finally {
    autoDeployBusy.value = false;
  }
}

const EVENT_STYLES: Record<
  MicroserviceEventKind,
  { icon: string; colour: string; label: string }
> = {
  launch: { icon: 'rocket_launch', colour: 'primary', label: 'Launch started' },
  rebuild: { icon: 'sync', colour: 'primary', label: 'Rebuild started' },
  build_started: { icon: 'build', colour: 'info', label: 'Build started' },
  build_succeeded: { icon: 'check_circle', colour: 'positive', label: 'Build succeeded' },
  build_failed: { icon: 'error', colour: 'negative', label: 'Build failed' },
  deployed: { icon: 'cloud_done', colour: 'positive', label: 'Deployed' },
  deploy_failed: { icon: 'cloud_off', colour: 'negative', label: 'Deploy failed' },
  restarted: { icon: 'restart_alt', colour: 'warning', label: 'Restarted' },
  rolled_back: { icon: 'history', colour: 'warning', label: 'Rolled back' },
  push_ignored: { icon: 'block', colour: 'grey-6', label: 'Push ignored' },
};

function eventStyle(kind: MicroserviceEventKind) {
  return (
    EVENT_STYLES[kind] ?? { icon: 'circle', colour: 'grey-6', label: kind.replace(/_/g, ' ') }
  );
}

// ── Loading, in the order the tabs need it ──────────────────────────────────

watch(
  name,
  (value) => {
    stopPolling();
    stopLogPolling();
    status.value = null;
    logs.value = null;
    cluster.value = null;
    health.value = null;
    events.value = null;
    if (value) void loadStatus().then(() => loadCapacity());
  },
  { immediate: true }
);

// Each tab fetches its own material the first time it is opened, so opening the
// page costs one call rather than four.
watch(tab, (value) => {
  if (value === 'logs' && !logs.value) void loadLogs();
  if (value === 'capacity' && !health.value) void loadCapacity();
  if (value === 'activity' && !events.value) void loadEvents();
  if (value !== 'logs') stopLogPolling();
});

watch(logSource, () => {
  logs.value = null;
  followLogs.value = true;
  void loadLogs();
});

onBeforeUnmount(() => {
  stopPolling();
  stopLogPolling();
});

function refreshAll(): void {
  void loadStatus();
  void loadCapacity();
  if (tab.value === 'logs') void loadLogs();
}


// ── Reading the log ─────────────────────────────────────────────────────────

/**
 * Severity is computed once per fetch, not once per keystroke per line: the
 * filter re-runs on every character typed, and the regexes are the expensive
 * part of it.
 */
const logRows = computed(() =>
  (logs.value?.events ?? []).map((event, index) => ({
    ...event,
    key: `${event.timestamp}-${index}`,
    severity: severityOf(event.message),
  }))
);

const logQuery = ref('');
const logSeverity = ref<'all' | 'warn' | 'error'>('all');
const logStream = ref<string | null>(null);

const logFilter = computed(() => ({
  query: logQuery.value,
  severity: logSeverity.value,
  stream: null,
}));

/**
 * Every task that has written, labelled with where it ran.
 *
 * Taken from the group's stream list rather than from the lines on screen: the
 * merged view reads only the newest few streams, so a picker built from what
 * arrived could never offer the task you actually wanted.
 *
 * The node comes from a join, not from the log. A stream is named
 * `<service>/<container>/<task id>` and never mentions the host, so the machine
 * is recovered by matching the task id against the ECS task list and that
 * task's container instance against the registered nodes. On Fargate there is
 * no node to find and the zone is the only placement fact there is.
 */
const streamOptions = computed(() =>
  (logs.value?.available ?? []).map((entry) => {
    const taskId = entry.name.split('/').pop() ?? entry.name;
    const task = (runtime.value?.tasks ?? []).find((row) => row.arn.endsWith(`/${taskId}`));
    const node = task?.container_instance
      ? (nodes.value.find((entry2) => entry2.id === task.container_instance)?.ec2_instance_id ??
        task.container_instance)
      : null;

    const where = node ?? task?.availability_zone ?? null;
    return {
      value: entry.name,
      label: where ? `${shortStream(entry.name)} · ${where}` : shortStream(entry.name),
      caption: entry.last_event_at ? `last wrote ${since(entry.last_event_at)}` : 'no events',
    };
  })
);

/** Which tasks are being read right now, for the line under the viewer. */
const streamsRead = computed(() => logs.value?.streams.length ?? 0);
const streamsAvailable = computed(() => logs.value?.available.length ?? 0);

const filtering = computed(() => isFiltering(logFilter.value));

/**
 * The task is no longer part of this: choosing one re-reads that stream, so by
 * the time these lines exist they are already only that task's.
 */
const visibleRows = computed(() => logRows.value.filter((row) => matches(row, logFilter.value)));

/** Bound in the template, where the needle is always the current query. */
function highlightLine(message: string) {
  return highlight(message, logQuery.value);
}

/** What is on screen, for pasting into an issue or a message. */
async function copyVisible(): Promise<void> {
  const text = visibleRows.value.map((row) => `${row.timestamp} ${row.message}`).join('\n');
  try {
    await navigator.clipboard.writeText(text);
    $q.notify({
      type: 'positive',
      message: `Copied ${visibleRows.value.length} lines.`,
      position: 'top',
      timeout: 1500,
    });
  } catch {
    $q.notify({ type: 'negative', message: 'Clipboard unavailable.', position: 'top' });
  }
}

// A filter is about the lines in front of you, so it resets when they change.
watch([logSource, name], () => {
  logQuery.value = '';
  logSeverity.value = 'all';
  logStream.value = null;
});

// Choosing a task is a different read, not a narrower view of this one.
watch(logStream, () => {
  followLogs.value = true;
  void loadLogs();
});

// ── Presentation ────────────────────────────────────────────────────────────

const title = computed(() => service.value?.display_name || name.value);

const repoUrl = computed(() =>
  service.value ? `https://github.com/${service.value.repo_full_name}` : ''
);
const branchUrl = computed(() =>
  service.value ? `${repoUrl.value}/tree/${encodeURIComponent(service.value.branch)}` : ''
);
const dockerfileUrl = computed(() =>
  service.value
    ? `${repoUrl.value}/blob/${encodeURIComponent(service.value.branch)}/${service.value.dockerfile_path}`
    : ''
);
const commitUrl = (sha: string): string => `${repoUrl.value}/commit/${sha}`;

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

function buildTone(state: BuildState): string {
  if (state === 'succeeded') return 'positive';
  if (state === 'failed') return 'negative';
  if (state === 'stopped') return 'warning';
  if (state === 'never') return 'grey-6';
  return 'info';
}

const LAUNCH_TITLES: Record<LaunchState, string> = {
  none: '',
  requested: 'Launch queued',
  provisioning: 'Creating infrastructure',
  building: 'Building the image',
  deploying: 'Starting the service',
  running: 'Launched',
  failed: 'The launch did not finish',
};

/**
 * The same sequence, worded for a service that is already up.
 *
 * Not cosmetic. "Starting the service" over something that has been serving
 * traffic for a week reads as an outage; what is actually happening is that a
 * new image is being built and rolled in underneath, with the old one still
 * answering until it lands. The words are the only thing that says so.
 */
const REBUILD_TITLES: Record<LaunchState, string> = {
  none: '',
  requested: 'Rebuild queued',
  provisioning: 'Checking infrastructure',
  building: 'Rebuilding the image',
  deploying: 'Redeploying',
  running: 'Redeployed',
  failed: 'The rebuild did not finish',
};

const rebuilding = computed(() => service.value?.launch_kind === 'rebuild');

const launchTitle = computed(() => {
  const state = service.value?.launch_state ?? 'none';
  return (rebuilding.value ? REBUILD_TITLES : LAUNCH_TITLES)[state];
});

/** Set when the thing in flight was started by a push rather than a person. */
const launchFromPush = computed(
  () => service.value?.launch_trigger === 'push' && service.value.launch_state !== 'none'
);

const LAUNCH_STAGES = [
  { key: 'infra', label: 'Cluster & scaffolding', states: ['requested', 'provisioning'] },
  { key: 'image', label: 'Image build', states: ['building'] },
  { key: 'service', label: 'ECS service', states: ['deploying'] },
];

/** Where a failed launch stopped, inferred from what exists. */
const failedStage = computed(() => {
  const row = service.value;
  if (!row) return 0;
  if (row.provision_state === 'not_provisioned' || row.provision_state === 'failed') return 0;
  if (row.build_state !== 'succeeded') return 1;
  return 2;
});

type StageStatus = 'done' | 'active' | 'failed' | 'pending';

const launchStages = computed<Array<{ key: string; label: string; status: StageStatus }>>(() => {
  const state = service.value?.launch_state ?? 'none';
  if (state === 'none') return [];
  const active = LAUNCH_STAGES.findIndex((stage) => stage.states.includes(state));

  return LAUNCH_STAGES.map((stage, index) => {
    const status: StageStatus =
      state === 'running'
        ? 'done'
        : state === 'failed'
          ? index < failedStage.value
            ? 'done'
            : index === failedStage.value
              ? 'failed'
              : 'pending'
          : active === -1
            ? 'pending'
            : index < active
              ? 'done'
              : index === active
                ? 'active'
                : 'pending';
    return { key: stage.key, label: stage.label, status };
  });
});

/** The capacity in one phrase, which is how it is always read. */
const capacityLabel = computed(() => {
  const row = cluster.value;
  if (!row) return service.value?.cluster_name ? 'unknown' : 'none';
  if (row.capacity_type === 'fargate') return 'Fargate';
  const gpu = row.gpus_per_instance > 0 ? ` · ${row.gpus_per_instance}× GPU` : '';
  const count =
    row.scaling_mode === 'fixed'
      ? `${row.min_instances}`
      : `${row.min_instances}–${row.max_instances}`;
  return `${row.instance_type ?? 'EC2'} × ${count}${gpu}`;
});

/** What to do next, in one sentence, when there is something to do. */
const nextStep = computed<string | null>(() => {
  const row = service.value;
  if (!row) return null;
  if (launchInFlight(row.launch_state)) return null;
  if (!row.cluster_name) {
    return 'This service has nowhere to run: the capacity created with it was removed.';
  }
  if (row.provision_state === 'not_provisioned') {
    return 'Nothing exists on AWS yet. Launch it to create its cluster, build the image and start the service.';
  }
  if (row.build_state === 'never') return 'No image has been built yet. Launch it to build and deploy.';
  if (buildRunning(row.build_state)) return null;
  if (row.build_state !== 'succeeded') {
    return 'The last build did not succeed, so there is no image to deploy. The build log says why.';
  }
  if (row.provision_state !== 'provisioned') {
    return 'The image is built but nothing is running it. Deploy to start the ECS service.';
  }
  if (status.value?.image_stale) {
    return 'The branch has moved past the running image. Rebuild and redeploy to pick it up.';
  }
  return null;
});

// ── Actions ─────────────────────────────────────────────────────────────────

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

async function runAction(
  action: () => Promise<{ steps?: string[]; error: string | null }>,
  verb: string
): Promise<void> {
  busy.value = true;
  try {
    const result = await action();
    $q.notify({
      type: result.error ? 'negative' : 'positive',
      message: result.error ? `${verb} failed: ${result.error}` : `${verb} complete.`,
      ...(result.steps?.length ? { caption: result.steps.join(', ') } : {}),
      position: 'top',
      timeout: result.error ? 0 : 6000,
      ...(result.error ? { actions: [{ label: 'Dismiss', color: 'white' }] } : {}),
    });
  } catch (error) {
    reportError(error, `${verb} failed.`);
  } finally {
    busy.value = false;
    refreshAll();
  }
}

/** What deploying starts billing for, in one clause. */
const costSentence = computed(() =>
  cluster.value && cluster.value.capacity_type === 'ec2'
    ? `This starts ${cluster.value.instance_type} instances, which bill per hour whether or not a task is on them.`
    : 'Fargate bills per task while it runs.'
);

function launch(): void {
  const row = service.value;
  if (!row) return;
  $q.dialog({
    title: `Launch ${row.name}`,
    message:
      `Creates its cluster and scaffolding, builds the image from ${row.repo_full_name}@${row.branch}, ` +
      `then starts the ECS service when the build succeeds. ${costSentence.value}`,
    cancel: true,
    ok: { label: 'Launch', color: 'primary', unelevated: true },
  }).onOk(() => {
    void (async () => {
      busy.value = true;
      try {
        const result: LaunchStatus = await api.microserviceLaunch(row.name);
        $q.notify({
          type: result.error ? 'negative' : 'info',
          message: result.error ? `The launch stopped — ${result.error}` : `Launching ${row.name}`,
          ...(result.error
            ? {}
            : {
                caption:
                  'Building the image now. It deploys on its own when the build succeeds.',
              }),
          position: 'top',
          timeout: result.error ? 0 : 8000,
          multiLine: true,
        });
      } catch (error) {
        reportError(error, 'The launch could not be started.');
      } finally {
        busy.value = false;
        refreshAll();
      }
    })();
  });
}

function build(): void {
  const row = service.value;
  if (!row) return;
  void (async () => {
    busy.value = true;
    try {
      const started = await api.microserviceBuild(row.name);
      $q.notify({
        type: 'info',
        message: `Building ${row.name}`,
        caption: `Image tag ${started.image_tag}`,
        position: 'top',
      });
      // Straight to the log: a build someone started by hand is a build they
      // want to watch.
      tab.value = 'logs';
      logSource.value = 'build';
    } catch (error) {
      reportError(error, 'The build could not be started.');
    } finally {
      busy.value = false;
      refreshAll();
    }
  })();
}

function deploy(): void {
  const row = service.value;
  if (!row) return;
  $q.dialog({
    title: `Deploy ${row.name}`,
    message: `Register the task definition and start the ECS service. ${costSentence.value}`,
    cancel: true,
    ok: { label: 'Deploy', color: 'primary', unelevated: true },
  }).onOk(() => {
    void runAction(() => api.microserviceDeploy(row.name), 'Deploying');
  });
}

function restart(): void {
  const row = service.value;
  if (!row) return;
  $q.dialog({
    title: `Restart ${row.name}`,
    message:
      'Starts a fresh deployment on the same task definition, replacing tasks a rollout at a ' +
      'time. This is also how a rebuilt image under an unchanged tag gets pulled.',
    cancel: true,
    ok: { label: 'Restart', color: 'primary', unelevated: true },
  }).onOk(() => void runAction(() => api.microserviceRestart(row.name), 'Restart'));
}

const deprovisionDialog = ref(false);
const deprovisionOptions = ref({ delete_images: false, delete_logs: false });

function confirmDeprovision(): void {
  const row = service.value;
  if (!row) return;
  void (async () => {
    busy.value = true;
    try {
      const result = await api.microserviceDeprovision(row.name, deprovisionOptions.value);
      deprovisionDialog.value = false;
      $q.notify({
        type: result.error ? 'negative' : 'positive',
        message: result.error ? `Deprovisioning failed: ${result.error}` : 'Deprovisioned.',
        ...(result.steps.length ? { caption: result.steps.join(', ') } : {}),
        position: 'top',
        timeout: result.error ? 0 : 6000,
      });
    } catch (error) {
      reportError(error, 'The service could not be deprovisioned.');
    } finally {
      busy.value = false;
      refreshAll();
    }
  })();
}

const removeDialog = ref(false);
const removeOptions = ref({ delete_images: false, delete_logs: false });

function confirmRemove(): void {
  const row = service.value;
  if (!row) return;
  void (async () => {
    busy.value = true;
    try {
      const result = await api.microserviceRemove(row.name, removeOptions.value);
      removeDialog.value = false;
      $q.notify({
        type: 'positive',
        message: `${row.name} deleted.`,
        ...(result.steps.length ? { caption: result.steps.join(', ') } : {}),
        position: 'top',
        timeout: 8000,
      });
      void router.push({ name: 'microservices' });
    } catch (error) {
      // The dialog stays open: a teardown that failed leaves everything intact
      // and the usual next move is to try again.
      reportError(error, `${row.name} could not be deleted.`);
    } finally {
      busy.value = false;
    }
  })();
}

async function recheck(): Promise<void> {
  const row = service.value;
  if (!row) return;
  busy.value = true;
  try {
    const result = await api.microserviceCheck(row.name);
    $q.notify({
      type: result.microservice.check_state === 'ok' ? 'positive' : 'warning',
      message:
        result.microservice.check_state === 'ok'
          ? `Dockerfile found on ${result.microservice.branch}.`
          : (result.microservice.check_detail ?? 'The source could not be verified.'),
      position: 'top',
      timeout: 9000,
      multiLine: true,
    });
  } catch (error) {
    reportError(error, 'The check could not be run.');
  } finally {
    busy.value = false;
    void loadStatus();
  }
}

/**
 * Editing routes back to the list, where the form lives.
 *
 * The wizard that creates a service is the same form that edits one, and it is
 * a long form with its own validation; a second copy of it here would be a
 * second thing to keep correct.
 */
function edit(): void {
  void router.push({ name: 'microservices', query: { edit: name.value } });
}

function editCapacity(): void {
  void router.push({ name: 'clusters', query: { edit: service.value?.cluster_name ?? '' } });
}
</script>

<template>
  <q-page padding>
    <!-- Back, because this page is reached from a list and browsers are not the
         only way people expect to return to one. -->
    <div class="q-mb-sm">
      <q-btn
        flat
        dense
        no-caps
        size="sm"
        icon="arrow_back"
        label="Microservices"
        :to="{ name: 'microservices' }"
      />
    </div>

    <PageHeader :title="title">
      <template #subtitle>
        <template v-if="service">
          <a class="link" :href="repoUrl" target="_blank" rel="noopener noreferrer">
            {{ service.repo_full_name }}
          </a>
          <span class="text-grey-6"> @ </span>
          <a class="link" :href="branchUrl" target="_blank" rel="noopener noreferrer">
            {{ service.branch }}
          </a>
          <span class="text-grey-6"> · </span>
          <a class="link" :href="dockerfileUrl" target="_blank" rel="noopener noreferrer">
            {{ service.dockerfile_path }}
          </a>
        </template>
        <template v-else>Loading…</template>
      </template>

      <template #actions>
        <q-btn
          outline
          color="primary"
          icon="refresh"
          label="Refresh"
          :loading="statusLoading"
          @click="refreshAll"
        />

        <!-- One contextual primary action. Everything else is in the menu,
             because a row of eight equal buttons is a menu that cannot be
             closed. -->
        <q-btn
          v-if="isAdmin && service && !launchInFlight(service.launch_state)"
          unelevated
          color="primary"
          icon="rocket_launch"
          :label="
            service.launch_state === 'failed'
              ? rebuilding
                ? 'Retry rebuild'
                : 'Retry launch'
              : service.provision_state === 'provisioned'
                ? 'Rebuild & redeploy'
                : 'Launch'
          "
          :disable="busy || !service.cluster_name"
          @click="launch"
        />

        <!--
          Straight through to ECS. This console shows the six numbers that
          matter; the moment one of them is wrong the next question is usually
          one only the AWS console answers, and finding the resource by hand
          means knowing its generated name.
        -->
        <AwsLink :href="awsPrimary" button :label="awsService ? 'ECS service' : 'ECS cluster'" />

        <q-btn v-if="isAdmin && service" outline color="primary" icon="more_horiz" label="Manage">
          <q-menu auto-close>
            <q-list style="min-width: 230px">
              <q-item clickable :disable="busy" @click="edit">
                <q-item-section avatar><q-icon name="edit" size="20px" /></q-item-section>
                <q-item-section>Edit source and runtime</q-item-section>
              </q-item>
              <q-item clickable :disable="busy" @click="recheck">
                <q-item-section avatar><q-icon name="fact_check" size="20px" /></q-item-section>
                <q-item-section>Re-check source</q-item-section>
              </q-item>

              <q-separator />

              <q-item
                v-if="service.provision_state !== 'not_provisioned'"
                clickable
                :disable="busy || buildRunning(service.build_state)"
                @click="build"
              >
                <q-item-section avatar><q-icon name="build" size="20px" /></q-item-section>
                <q-item-section>
                  {{ service.build_state === 'never' ? 'Build image' : 'Rebuild image' }}
                </q-item-section>
              </q-item>
              <q-item
                v-if="buildRunning(service.build_state)"
                clickable
                :disable="busy"
                @click="runAction(() => api.microserviceBuildStop(service!.name), 'Stopping the build')"
              >
                <q-item-section avatar><q-icon name="stop" size="20px" /></q-item-section>
                <q-item-section>Stop build</q-item-section>
              </q-item>
              <q-item
                v-if="service.build_state === 'succeeded'"
                clickable
                :disable="busy"
                @click="deploy"
              >
                <q-item-section avatar><q-icon name="publish" size="20px" /></q-item-section>
                <q-item-section>
                  {{ service.provision_state === 'provisioned' ? 'Redeploy' : 'Deploy' }}
                </q-item-section>
              </q-item>
              <q-item
                v-if="service.provision_state === 'provisioned'"
                clickable
                :disable="busy"
                @click="restart"
              >
                <q-item-section avatar><q-icon name="restart_alt" size="20px" /></q-item-section>
                <q-item-section>Restart tasks</q-item-section>
              </q-item>
              <q-item
                v-if="service.provision_state !== 'not_provisioned'"
                clickable
                :disable="busy"
                @click="runAction(() => api.microserviceProvision(service!.name), 'Repairing')"
              >
                <q-item-section avatar><q-icon name="healing" size="20px" /></q-item-section>
                <q-item-section>Repair scaffolding</q-item-section>
              </q-item>

              <q-separator />

              <q-item
                v-if="service.provision_state !== 'not_provisioned'"
                clickable
                :disable="busy"
                @click="deprovisionDialog = true"
              >
                <q-item-section avatar>
                  <q-icon name="power_settings_new" size="20px" color="negative" />
                </q-item-section>
                <q-item-section class="text-negative">Deprovision</q-item-section>
              </q-item>
              <q-item clickable :disable="busy" @click="removeDialog = true">
                <q-item-section avatar>
                  <q-icon name="delete" size="20px" color="negative" />
                </q-item-section>
                <q-item-section class="text-negative">Delete service</q-item-section>
              </q-item>
            </q-list>
          </q-menu>
        </q-btn>
      </template>
    </PageHeader>

    <q-banner v-if="statusError" rounded class="bg-red-1 text-grey-9 q-mb-md">
      <template #avatar><q-icon name="error" color="negative" /></template>
      {{ statusError }}
    </q-banner>

    <div v-if="!service && statusLoading" class="text-body2 text-grey-7">Loading…</div>

    <template v-if="service">
      <!--
        A launch in progress, as the three things it is doing. Shown while one
        is in flight and while one has failed, and not once it has succeeded —
        a service that is up says so in the strip below.
      -->
      <q-banner
        v-if="launchInFlight(service.launch_state) || service.launch_state === 'failed'"
        rounded
        class="q-mb-md"
        :class="service.launch_state === 'failed' ? 'bg-red-1 text-grey-9' : 'bg-blue-1 text-grey-9'"
      >
        <template #avatar>
          <q-spinner v-if="launchInFlight(service.launch_state)" color="info" size="24px" />
          <q-icon v-else name="error" color="negative" />
        </template>
        <div class="row items-center q-gutter-sm">
          <div class="text-weight-medium">{{ launchTitle }}</div>
          <!--
            What started it. Only worth saying when it was not a person on this
            page: an unexpected rebuild is otherwise unattributable until you
            go and read the history.
          -->
          <q-badge v-if="launchFromPush" color="blue-1" text-color="primary">
            <q-icon name="commit" size="13px" class="q-mr-xs" />
            triggered by push
          </q-badge>
        </div>
        <div v-if="service.launch_detail" class="text-body2">{{ service.launch_detail }}</div>
        <div class="row items-center q-gutter-xs q-mt-sm">
          <q-chip
            v-for="stage in launchStages"
            :key="stage.key"
            dense
            square
            size="sm"
            class="q-ml-none"
            :color="
              stage.status === 'done'
                ? 'positive'
                : stage.status === 'failed'
                  ? 'negative'
                  : stage.status === 'active'
                    ? 'info'
                    : 'grey-4'
            "
            :text-color="stage.status === 'pending' ? 'grey-8' : 'white'"
            :icon="
              stage.status === 'done'
                ? 'check'
                : stage.status === 'failed'
                  ? 'close'
                  : stage.status === 'active'
                    ? 'sync'
                    : 'radio_button_unchecked'
            "
          >
            {{ stage.label }}
          </q-chip>
        </div>
        <template #action>
          <q-btn
            v-if="service.launch_state === 'failed' && logs === null"
            flat
            dense
            no-caps
            label="See the build log"
            @click="
              tab = 'logs';
              logSource = 'build';
            "
          />
        </template>
      </q-banner>

      <!--
        The state strip: the four facts you need before deciding which question
        you have. Each is the answer to "is this bit fine", which is why they
        are badges and counts rather than prose.
      -->
      <div class="row q-col-gutter-sm q-mb-md">
        <div class="col-6 col-md-3">
          <q-card flat bordered class="stat">
            <q-card-section class="q-pa-sm">
              <div class="stat__label">Deployment</div>
              <div class="stat__value">
                <q-badge
                  :color="stateTone(service.provision_state)"
                  :outline="service.provision_state === 'not_provisioned'"
                >
                  {{ stateLabel(service.provision_state) }}
                </q-badge>
              </div>
              <div class="stat__note">{{ when(service.provisioned_at) }}</div>
            </q-card-section>
          </q-card>
        </div>

        <div class="col-6 col-md-3">
          <q-card flat bordered class="stat">
            <q-card-section class="q-pa-sm">
              <div class="stat__label">Image</div>
              <div class="stat__value">
                <q-badge :color="buildTone(service.build_state)">
                  <q-spinner
                    v-if="buildRunning(service.build_state)"
                    size="10px"
                    class="q-mr-xs"
                  />
                  {{ service.build_state }}
                </q-badge>
              </div>
              <div class="stat__note">
                <span v-if="service.image_tag" class="mono">{{ service.image_tag }}</span>
                <span v-else>never built</span>
              </div>
            </q-card-section>
          </q-card>
        </div>

        <div class="col-6 col-md-3">
          <q-card flat bordered class="stat">
            <q-card-section class="q-pa-sm">
              <div class="stat__label">Tasks</div>
              <div class="stat__value">
                {{ runtime?.running_count ?? 0 }}
                <span class="text-grey-6">/ {{ runtime?.desired_count ?? service.desired_count }}</span>
                <span v-if="runtime?.pending_count" class="text-warning text-caption">
                  · {{ runtime.pending_count }} pending
                </span>
              </div>
              <div class="stat__note">{{ taskSize(service.cpu, service.memory) }} each</div>
            </q-card-section>
          </q-card>
        </div>

        <div class="col-6 col-md-3">
          <q-card flat bordered class="stat">
            <q-card-section class="q-pa-sm">
              <div class="stat__label">Capacity</div>
              <div class="stat__value">{{ capacityLabel }}</div>
              <div class="stat__note">
                <template v-if="isFargate">no machines to manage</template>
                <template v-else>
                  {{ health?.health?.registered_instances ?? 0 }} node(s) registered
                </template>
              </div>
            </q-card-section>
          </q-card>
        </div>
      </div>

      <q-banner v-if="nextStep" rounded class="bg-blue-1 text-grey-9 q-mb-md">
        <template #avatar><q-icon name="arrow_forward" color="info" /></template>
        <div class="text-body2">{{ nextStep }}</div>
      </q-banner>

      <q-card flat bordered>
        <q-tabs v-model="tab" no-caps dense align="left" class="text-grey-8" active-color="primary">
          <q-tab name="overview" icon="info" label="Overview" />
          <q-tab name="logs" icon="terminal" label="Logs" />
          <q-tab name="capacity" icon="memory" label="Capacity" />
          <q-tab name="activity" icon="timeline" label="Activity" />
        </q-tabs>
        <q-separator />

        <q-tab-panels v-model="tab" animated>
          <!-- ── Overview ─────────────────────────────────────────────── -->
          <q-tab-panel name="overview" class="q-pa-md">
            <div class="row q-col-gutter-md">
              <div class="col-12 col-md-6">
                <SectionCard title="Source" lede="What gets built, and from where.">
                  <q-banner
                    v-if="service.check_state !== 'ok'"
                    rounded
                    dense
                    class="bg-red-1 text-grey-9 q-mb-sm"
                  >
                    <template #avatar><q-icon name="error" color="negative" /></template>
                    <div class="text-body2">
                      {{ service.check_detail ?? 'This source has not been verified.' }}
                    </div>
                  </q-banner>

                  <table class="facts">
                    <tbody>
                      <tr>
                        <th>Repository</th>
                        <td>
                          <a class="link mono" :href="repoUrl" target="_blank" rel="noopener noreferrer">
                            {{ service.repo_full_name }}<q-icon name="open_in_new" size="13px" />
                          </a>
                        </td>
                      </tr>
                      <tr>
                        <th>Branch</th>
                        <td>
                          <a class="link mono" :href="branchUrl" target="_blank" rel="noopener noreferrer">
                            {{ service.branch }}<q-icon name="open_in_new" size="13px" />
                          </a>
                        </td>
                      </tr>
                      <tr>
                        <th>Dockerfile</th>
                        <td>
                          <a class="link mono" :href="dockerfileUrl" target="_blank" rel="noopener noreferrer">
                            {{ service.dockerfile_path }}<q-icon name="open_in_new" size="13px" />
                          </a>
                        </td>
                      </tr>
                      <tr>
                        <th>Build context</th>
                        <td class="mono">{{ service.build_context }}</td>
                      </tr>
                      <tr>
                        <th>Checked</th>
                        <td>
                          {{ when(service.checked_at) }}
                          <span class="text-grey-6">({{ since(service.checked_at) }})</span>
                        </td>
                      </tr>
                    </tbody>
                  </table>

                  <q-separator class="q-my-md" />

                  <!--
                    The setting that decides whether this source is followed or
                    merely recorded. On the Source card because that is what it
                    is about, and because "which branch" and "does it follow it"
                    are one question read together.
                  -->
                  <div class="row items-start no-wrap">
                    <q-toggle
                      :model-value="service.auto_deploy"
                      :disable="!isAdmin || autoDeployBusy"
                      color="primary"
                      dense
                      class="q-mr-sm"
                      @update:model-value="setAutoDeploy"
                    />
                    <div>
                      <div class="text-body2 text-weight-medium">
                        Deploy on every push to {{ service.branch }}
                      </div>
                      <div class="text-caption text-grey-7" style="max-width: 46ch">
                        <template v-if="service.auto_deploy">
                          A commit on this branch rebuilds the image and rolls it out. The running
                          service keeps serving until the new image is ready.
                        </template>
                        <template v-else>
                          Commits are recorded but nothing is built. Use Rebuild to pick up the
                          branch when you want it.
                        </template>
                      </div>
                    </div>
                  </div>
                </SectionCard>
              </div>

              <div class="col-12 col-md-6">
                <SectionCard title="Image" lede="What is deployed, and whether it is current.">
                  <q-banner
                    v-if="status?.image_stale"
                    rounded
                    dense
                    class="bg-orange-1 text-grey-9 q-mb-sm"
                  >
                    <template #avatar><q-icon name="update" color="warning" /></template>
                    <div class="text-body2">
                      The branch has moved past the running image. Rebuild to pick it up.
                    </div>
                  </q-banner>

                  <table class="facts">
                    <tbody>
                      <tr>
                        <th>Tag</th>
                        <td class="mono">{{ service.image_tag ?? '—' }}</td>
                      </tr>
                      <tr>
                        <th>Built from</th>
                        <td>
                          <a
                            v-if="service.build_commit_sha"
                            class="link mono"
                            :href="commitUrl(service.build_commit_sha)"
                            target="_blank"
                            rel="noopener noreferrer"
                          >
                            {{ service.build_commit_sha.slice(0, 12) }}<q-icon name="open_in_new" size="13px" />
                          </a>
                          <span v-else>—</span>
                        </td>
                      </tr>
                      <tr>
                        <th>Branch head</th>
                        <td>
                          <a
                            v-if="service.checked_commit_sha"
                            class="link mono"
                            :href="commitUrl(service.checked_commit_sha)"
                            target="_blank"
                            rel="noopener noreferrer"
                          >
                            {{ service.checked_commit_sha.slice(0, 12) }}<q-icon name="open_in_new" size="13px" />
                          </a>
                          <span v-else>—</span>
                        </td>
                      </tr>
                      <tr>
                        <th>Size</th>
                        <td>{{ bytes(status?.image?.size_bytes ?? null) }}</td>
                      </tr>
                      <tr>
                        <th>Pushed</th>
                        <td>{{ when(status?.image?.pushed_at ?? null) }}</td>
                      </tr>
                      <tr>
                        <th>Last build</th>
                        <td>
                          {{ when(service.build_finished_at ?? service.build_started_at) }}
                          <span v-if="service.build_detail" class="text-grey-7">
                            — {{ service.build_detail }}
                          </span>
                        </td>
                      </tr>
                    </tbody>
                  </table>
                </SectionCard>
              </div>

              <div class="col-12 col-md-6">
                <SectionCard title="Runtime" lede="The shape of each task, and how many run.">
                  <table class="facts">
                    <tbody>
                      <tr>
                        <th>CPU</th>
                        <td>
                          {{ vcpu(service.cpu) }}
                          <span class="text-grey-6">({{ service.cpu }} units)</span>
                        </td>
                      </tr>
                      <tr>
                        <th>Memory</th>
                        <td>{{ mib(service.memory) }}</td>
                      </tr>
                      <tr v-if="service.container_port">
                        <th>Port</th>
                        <td class="mono">{{ service.container_port }}</td>
                      </tr>
                      <tr v-if="service.gpu_vram_mb > 0">
                        <th>
                          VRAM
                          <InfoHint
                            text="What this service expects to need on a shared GPU. ECS never
                                  checks it, so it is the console's only guard against an
                                  overcommit that would place and then fail."
                          />
                        </th>
                        <td>{{ mib(service.gpu_vram_mb) }}</td>
                      </tr>
                      <tr>
                        <th>Scaling</th>
                        <td v-if="service.scaling_mode === 'fixed'">
                          Fixed · {{ service.desired_count }}
                          task{{ service.desired_count === 1 ? '' : 's' }}
                        </td>
                        <td v-else>
                          Auto · {{ service.min_tasks }}–{{ service.max_tasks }} tasks, holding
                          {{ service.scaling_metric === 'cpu' ? 'CPU' : 'memory' }} near
                          {{ service.scaling_target }}%
                        </td>
                      </tr>
                      <tr v-if="service.scaling_mode === 'auto'">
                        <th>Cooldowns</th>
                        <td>
                          out {{ service.scale_out_cooldown }}s · in
                          {{ service.scale_in_cooldown }}s
                        </td>
                      </tr>
                    </tbody>
                  </table>

                  <template #footer>
                    <q-btn
                      v-if="isAdmin"
                      flat
                      dense
                      no-caps
                      size="sm"
                      color="primary"
                      label="Edit runtime"
                      @click="edit"
                    />
                  </template>
                </SectionCard>
              </div>

              <div class="col-12 col-md-6">
                <!--
                  Every row here names something that exists in AWS, so every
                  row that has been provisioned carries a way through to it.
                  The link is absent rather than dead when the resource has not
                  been created yet — which is what the dashes mean.
                -->
                <SectionCard title="AWS resources" lede="What provisioning created, by name.">
                  <table class="facts">
                    <tbody>
                      <tr>
                        <th>ECS service</th>
                        <td class="mono">
                          {{ status?.ecs_service_name ?? '—' }}
                          <AwsLink :href="awsService" class="q-ml-xs" />
                        </td>
                      </tr>
                      <tr>
                        <th>ECS cluster</th>
                        <td class="mono">
                          {{ status?.ecs_cluster_name ?? '—' }}
                          <AwsLink :href="awsCluster" class="q-ml-xs" />
                        </td>
                      </tr>
                      <tr>
                        <th>Image repository</th>
                        <td class="mono break">
                          {{ service.ecr_repository_uri ?? '—' }}
                          <AwsLink :href="awsEcr" class="q-ml-xs" />
                        </td>
                      </tr>
                      <tr>
                        <th>Build project</th>
                        <td class="mono">
                          {{ service.build_project_name ?? '—' }}
                          <AwsLink :href="awsBuildProject" class="q-ml-xs" />
                        </td>
                      </tr>
                      <tr>
                        <th>Container log</th>
                        <td class="mono break">
                          {{ service.log_group_name ?? '—' }}
                          <span v-if="status?.logs" class="text-grey-6">
                            ({{ bytes(status.logs.stored_bytes) }})
                          </span>
                          <AwsLink :href="awsLogGroup" class="q-ml-xs" />
                        </td>
                      </tr>
                      <tr>
                        <th>Build log</th>
                        <td class="mono break">
                          {{ service.build_log_group ?? '—' }}
                          <span v-if="status?.build_logs" class="text-grey-6">
                            ({{ bytes(status.build_logs.stored_bytes) }})
                          </span>
                          <AwsLink :href="awsBuildLogGroup" class="q-ml-xs" />
                        </td>
                      </tr>
                      <tr>
                        <th>Log retention</th>
                        <td>
                          {{
                            service.log_retention_days === null
                              ? 'never expires'
                              : `${service.log_retention_days} days`
                          }}
                        </td>
                      </tr>
                    </tbody>
                  </table>
                </SectionCard>
              </div>
            </div>
          </q-tab-panel>

          <!-- ── Logs ─────────────────────────────────────────────────── -->
          <q-tab-panel name="logs" class="q-pa-md">
            <div class="row items-center q-gutter-sm q-mb-sm">
              <q-btn-toggle
                v-model="logSource"
                no-caps
                unelevated
                dense
                toggle-color="primary"
                :options="[
                  { label: 'Container', value: 'container' },
                  { label: 'Build', value: 'build' },
                ]"
              />
              <div class="row items-center text-caption text-grey-7">
                {{
                  logSource === 'build'
                    ? 'What CodeBuild printed while making the image.'
                    : 'Everything the tasks printed.'
                }}
                <InfoHint :text="HINTS.streams" />
              </div>
              <!--
                This tail is the last few hundred lines. Anything older, or any
                query over them, belongs in CloudWatch — so the way there is
                offered rather than left to be found.
              -->
              <AwsLink
                :href="logSource === 'build' ? awsBuildLogGroup : awsLogGroup"
                label="CloudWatch"
                class="q-ml-sm"
              />
              <q-space />
              <q-badge
                v-if="logSource === 'build' && buildRunning(service.build_state)"
                color="info"
              >
                <q-spinner size="10px" class="q-mr-xs" />following
              </q-badge>
              <q-select
                v-model.number="logLimit"
                dense
                outlined
                emit-value
                map-options
                style="width: 120px"
                :options="[
                  { label: '100 lines', value: 100 },
                  { label: '200 lines', value: 200 },
                  { label: '500 lines', value: 500 },
                  { label: '1000 lines', value: 1000 },
                ]"
                @update:model-value="loadLogs()"
              />
              <q-btn
                flat
                dense
                icon="refresh"
                :loading="logsLoading"
                @click="
                  followLogs = true;
                  loadLogs();
                "
              >
                <q-tooltip>Re-read the log</q-tooltip>
              </q-btn>
            </div>

            <!--
              Filtering, over the lines already fetched.

              Deliberately client-side and deliberately said so below: it is
              instant, and it cannot mislead as long as the reader knows the
              haystack is the last N lines rather than the whole group. Searching
              further back is what the line count and the Logs page are for.
            -->
            <div class="row items-center q-gutter-sm q-mb-sm">
              <q-input
                v-model="logQuery"
                dense
                outlined
                clearable
                debounce="150"
                placeholder="Filter these lines…"
                class="col"
                style="min-width: 220px"
              >
                <template #prepend><q-icon name="search" size="18px" /></template>
              </q-input>

              <q-btn-toggle
                v-model="logSeverity"
                no-caps
                unelevated
                dense
                toggle-color="primary"
                :options="[
                  { label: 'All', value: 'all' },
                  { label: 'Warnings+', value: 'warn' },
                  { label: 'Errors', value: 'error' },
                ]"
              >
                <q-tooltip>
                  Matched on the text of each line — nothing in a container log states its own
                  level, so this is a guess made from words like "error" and "exception".
                </q-tooltip>
              </q-btn-toggle>

              <!--
                One task, or all of them.

                Choosing one re-reads that stream on the server rather than
                filtering what is already here: the merged view reads only the
                newest few streams, so filtering it would show nothing for the
                fourth task while looking like it had worked.

                Container logs only — a build has exactly one stream, and it is
                the one the row records.
              -->
              <q-select
                v-if="logSource === 'container' && streamOptions.length > 1"
                v-model="logStream"
                dense
                outlined
                emit-value
                map-options
                clearable
                options-dense
                style="min-width: 230px"
                label="Task"
                :display-value="logStream ? shortStream(logStream) : `All (${streamsRead} newest)`"
                :options="streamOptions"
              >
                <template #option="scope">
                  <q-item v-bind="scope.itemProps">
                    <q-item-section>
                      <q-item-label>{{ scope.opt.label }}</q-item-label>
                      <q-item-label caption>{{ scope.opt.caption }}</q-item-label>
                    </q-item-section>
                  </q-item>
                </template>
              </q-select>

              <q-btn
                flat
                dense
                icon="content_copy"
                :disable="!visibleRows.length"
                @click="copyVisible"
              >
                <q-tooltip>Copy what is shown</q-tooltip>
              </q-btn>
            </div>

            <q-banner v-if="logsError" rounded dense class="bg-red-1 text-grey-9 q-mb-sm">
              <template #avatar><q-icon name="error" color="negative" /></template>
              {{ logsError }}
            </q-banner>

            <div
              v-if="visibleRows.length"
              ref="logBody"
              class="log-view"
              @scroll="onLogScroll"
            >
              <div v-if="logs?.truncated && !filtering" class="log-note">
                …older lines exist; this is the last {{ logs.events.length }}.
              </div>
              <div
                v-for="row in visibleRows"
                :key="row.key"
                class="log-row"
                :class="`log-row--${row.severity}`"
              >
                <span class="log-time">{{ timeOnly(row.timestamp) }}</span>
                <span
                  v-if="streamOptions.length > 1 && row.stream"
                  class="log-task"
                  :title="row.stream"
                >
                  {{ shortStream(row.stream) }}
                </span>
                <span
                  ><span v-for="(part, i) in highlightLine(row.message)" :key="i" :class="part.hit ? 'log-hit' : ''">{{ part.text }}</span></span
                >
              </div>
            </div>

            <!--
              Three different empty states, because the operator does something
              different about each: nothing logged, nothing matching, or nothing
              to log from.
            -->
            <div v-else-if="!logsLoading" class="text-body2 text-grey-7 q-pa-md">
              <template v-if="filtering && logRows.length">
                None of the last {{ logRows.length }} lines match. Widen the line count, clear
                the filter, or search the whole group from the Logs page.
              </template>
              <template v-else-if="logSource === 'build' && service.build_state === 'never'">
                This service has never been built, so there is no build log yet.
              </template>
              <template v-else-if="service.provision_state === 'not_provisioned'">
                Nothing has been created on AWS yet, so nothing has written a log.
              </template>
              <template v-else-if="logSource === 'container' && !runtime?.running_count">
                No task is running, so nothing is writing a container log.
              </template>
              <template v-else>
                Nothing logged yet. The group exists; nothing has written to it.
              </template>
            </div>

            <div class="row items-center text-caption text-grey-6 q-mt-xs">
              <span class="mono">
                {{ logs?.log_group }}
                <template v-if="logs && logs.streams.length === 1">
                  · {{ logs.streams[0] }}
                </template>
                <template v-else-if="logs && logs.streams.length > 1">
                  ·
                  <template v-if="streamsAvailable > streamsRead">
                    {{ streamsRead }} newest of {{ streamsAvailable }} tasks merged
                  </template>
                  <template v-else>{{ streamsRead }} tasks merged</template>
                </template>
              </span>
              <q-space />
              <span v-if="logs">
                <template v-if="filtering">
                  {{ visibleRows.length }} of {{ logRows.length }} lines
                </template>
                <template v-else>{{ logRows.length }} lines</template>
              </span>
            </div>
          </q-tab-panel>


          <q-tab-panel name="capacity" class="q-pa-md">
            <div class="row items-center q-mb-sm">
              <div class="text-body2 text-grey-8">
                The machines this service runs on. They belong to it alone and are created and
                destroyed with it.
              </div>
              <q-space />
              <q-btn
                v-if="isAdmin && cluster"
                flat
                dense
                no-caps
                size="sm"
                color="primary"
                label="Edit capacity"
                @click="editCapacity"
              />
              <q-btn flat dense icon="refresh" :loading="healthLoading" @click="loadCapacity" />
            </div>

            <q-banner v-if="healthError" rounded dense class="bg-red-1 text-grey-9 q-mb-sm">
              <template #avatar><q-icon name="error" color="negative" /></template>
              {{ healthError }}
            </q-banner>

            <!--
              The single most useful derived fact here: a provisioned GPU cluster
              that registered zero GPUs looks healthy by every other measure and
              will never place a GPU task.
            -->
            <q-banner
              v-if="health?.gpu_visible === false"
              rounded
              class="bg-red-1 text-grey-9 q-mb-sm"
            >
              <template #avatar><q-icon name="warning" color="negative" /></template>
              <div class="text-weight-medium">ECS sees no GPUs on these instances</div>
              <div class="text-body2">
                The capacity says {{ cluster?.gpus_per_instance }} card(s) per instance, but the
                registered instances advertise none — usually the standard AMI rather than the
                GPU one. GPU tasks will stay PENDING for ever.
              </div>
            </q-banner>

            <!--
              Fargate: what is running and what it costs, because there is
              nothing else true to say. AWS owns the machines, so there is no
              utilisation to report — a task either placed or it did not.
            -->
            <div v-if="isFargate && health?.health?.exists" class="row q-col-gutter-sm q-mb-md">
              <div class="col-6 col-md-3">
                <q-card flat bordered class="stat">
                  <q-card-section class="q-pa-sm">
                    <div class="stat__label">Tasks running</div>
                    <div class="stat__value">
                      {{ runningTasks }}
                      <span class="text-grey-6">
                        / {{ runtime?.desired_count ?? service.desired_count }}
                      </span>
                    </div>
                    <div v-if="health.health.pending_tasks" class="stat__note text-warning">
                      {{ health.health.pending_tasks }} pending
                    </div>
                  </q-card-section>
                </q-card>
              </div>
              <div class="col-6 col-md-3">
                <q-card flat bordered class="stat">
                  <q-card-section class="q-pa-sm">
                    <div class="stat__label">vCPU in use</div>
                    <div class="stat__value">{{ vcpu(fargateInUse.cpu) }}</div>
                    <div class="stat__note">{{ vcpu(service.cpu) }} per task</div>
                  </q-card-section>
                </q-card>
              </div>
              <div class="col-6 col-md-3">
                <q-card flat bordered class="stat">
                  <q-card-section class="q-pa-sm">
                    <div class="stat__label">Memory in use</div>
                    <div class="stat__value">{{ mib(fargateInUse.memory) }}</div>
                    <div class="stat__note">{{ mib(service.memory) }} per task</div>
                  </q-card-section>
                </q-card>
              </div>
              <div class="col-6 col-md-3">
                <q-card flat bordered class="stat">
                  <q-card-section class="q-pa-sm">
                    <div class="stat__label">Billed</div>
                    <div class="stat__value">per task</div>
                    <div class="stat__note">only while running</div>
                  </q-card-section>
                </q-card>
              </div>
            </div>

            <div v-else-if="health?.health?.exists" class="row q-col-gutter-sm q-mb-md">
              <div class="col-6 col-md-3">
                <q-card flat bordered class="stat">
                  <q-card-section class="q-pa-sm">
                    <div class="stat__label">Nodes</div>
                    <div class="stat__value">
                      {{ health.health.registered_instances }}
                      <span v-if="health.health.disconnected_instances" class="text-negative text-caption">
                        ({{ health.health.disconnected_instances }} lost)
                      </span>
                    </div>
                  </q-card-section>
                </q-card>
              </div>
              <div class="col-6 col-md-3">
                <q-card flat bordered class="stat">
                  <q-card-section class="q-pa-sm">
                    <div class="stat__label">CPU used</div>
                    <div class="stat__value">
                      {{ vcpu(used(health.health.registered_cpu, health.health.remaining_cpu)) }}
                      <span class="text-grey-6">/ {{ vcpu(health.health.registered_cpu) }}</span>
                    </div>
                    <q-linear-progress
                      size="4px"
                      class="q-mt-xs"
                      :value="fractionUsed(health.health.registered_cpu, health.health.remaining_cpu)"
                      :color="loadTone(fractionUsed(health.health.registered_cpu, health.health.remaining_cpu))"
                    />
                  </q-card-section>
                </q-card>
              </div>
              <div class="col-6 col-md-3">
                <q-card flat bordered class="stat">
                  <q-card-section class="q-pa-sm">
                    <div class="stat__label">Memory used</div>
                    <div class="stat__value">
                      {{ mib(used(health.health.registered_memory_mib, health.health.remaining_memory_mib)) }}
                      <span class="text-grey-6">/ {{ mib(health.health.registered_memory_mib) }}</span>
                    </div>
                    <q-linear-progress
                      size="4px"
                      class="q-mt-xs"
                      :value="fractionUsed(health.health.registered_memory_mib, health.health.remaining_memory_mib)"
                      :color="loadTone(fractionUsed(health.health.registered_memory_mib, health.health.remaining_memory_mib))"
                    />
                  </q-card-section>
                </q-card>
              </div>
              <div v-if="health.health.registered_gpus > 0" class="col-6 col-md-3">
                <q-card flat bordered class="stat">
                  <q-card-section class="q-pa-sm">
                    <div class="stat__label">GPUs used</div>
                    <div class="stat__value">
                      {{ used(health.health.registered_gpus, health.health.remaining_gpus) }}
                      <span class="text-grey-6">/ {{ health.health.registered_gpus }}</span>
                    </div>
                    <q-linear-progress
                      size="4px"
                      class="q-mt-xs"
                      :value="fractionUsed(health.health.registered_gpus, health.health.remaining_gpus)"
                      :color="loadTone(fractionUsed(health.health.registered_gpus, health.health.remaining_gpus))"
                    />
                  </q-card-section>
                </q-card>
              </div>
            </div>

            <!--
              Per node, because the totals hide the case that matters: a pool
              half empty in aggregate can still have nowhere to put the next
              task if what is free is spread thinly. ECS places a task on one
              instance or not at all.
            -->
            <q-markup-table
              v-if="!isFargate && nodes.length"
              flat
              bordered
              dense
              class="node-table"
            >
              <thead>
                <tr>
                  <th class="text-left">Node</th>
                  <th class="text-left">Status</th>
                  <th class="text-right">Tasks</th>
                  <th class="text-left" style="width: 24%">CPU</th>
                  <th class="text-left" style="width: 24%">Memory</th>
                  <th v-if="health?.health?.registered_gpus" class="text-right">GPU</th>
                </tr>
              </thead>
              <tbody>
                <tr v-for="node in nodes" :key="node.id">
                  <td class="mono">{{ node.ec2_instance_id || node.id }}</td>
                  <td>
                    <q-badge :color="node.agent_connected ? 'positive' : 'negative'" outline>
                      {{ node.agent_connected ? node.status : 'agent lost' }}
                    </q-badge>
                  </td>
                  <td class="text-right">
                    {{ node.running_tasks }}
                    <span v-if="node.pending_tasks" class="text-warning">
                      +{{ node.pending_tasks }}
                    </span>
                  </td>
                  <td>
                    <div class="text-caption">
                      {{ vcpu(used(node.registered_cpu, node.remaining_cpu)) }} /
                      {{ vcpu(node.registered_cpu) }}
                    </div>
                    <q-linear-progress
                      size="4px"
                      :value="fractionUsed(node.registered_cpu, node.remaining_cpu)"
                      :color="loadTone(fractionUsed(node.registered_cpu, node.remaining_cpu))"
                    />
                  </td>
                  <td>
                    <div class="text-caption">
                      {{ mib(used(node.registered_memory_mib, node.remaining_memory_mib)) }} /
                      {{ mib(node.registered_memory_mib) }}
                    </div>
                    <q-linear-progress
                      size="4px"
                      :value="fractionUsed(node.registered_memory_mib, node.remaining_memory_mib)"
                      :color="loadTone(fractionUsed(node.registered_memory_mib, node.remaining_memory_mib))"
                    />
                  </td>
                  <td v-if="health?.health?.registered_gpus" class="text-right">
                    {{ used(node.registered_gpus, node.remaining_gpus) }} /
                    {{ node.registered_gpus }}
                  </td>
                </tr>
              </tbody>
            </q-markup-table>

            <div v-else-if="isFargate" class="text-body2 text-grey-7">
              Fargate runs the machines, so there are no nodes to monitor and no instance
              utilisation to report — a task either places or it does not. Switch this service
              to EC2 capacity if you need machines you can see, which is also the only way to
              get a GPU.
            </div>
            <div v-else-if="!healthLoading" class="text-body2 text-grey-7">
              <template v-if="service.provision_state === 'not_provisioned'">
                Nothing has been created on AWS yet.
              </template>
              <template v-else>
                No instances are registered yet. On EC2 the scaling group launches them when
                a task needs placing, or immediately if its minimum is above zero — a cluster
                that stays empty with tasks pending usually means the instances cannot join,
                which their own system log explains.
              </template>
            </div>
          </q-tab-panel>

          <!-- ── Activity ─────────────────────────────────────────────── -->
          <q-tab-panel name="activity" class="q-pa-md">
            <!--
              Above the ECS panels, and outside the v-else that hides them: this
              is the half that exists before there is a service and survives
              after one is replaced, which is exactly when it is wanted.
            -->
            <SectionCard
              title="History"
              lede="Builds, deployments and restarts, newest first. ECS keeps its own events for about an hour; this is what is left after that."
              class="q-mb-md"
              flush
            >
              <template #actions>
                <q-btn
                  flat
                  round
                  dense
                  icon="refresh"
                  size="sm"
                  :loading="eventsLoading"
                  @click="loadEvents()"
                />
              </template>

              <div v-if="eventsError" class="q-pa-md text-body2 text-negative">
                {{ eventsError }}
              </div>

              <div v-else-if="eventsLoading && !events" class="q-pa-md row items-center">
                <q-spinner size="18px" color="grey-7" />
                <span class="q-ml-sm text-body2 text-grey-7">Loading</span>
              </div>

              <div v-else-if="!events || events.length === 0" class="q-pa-md text-body2 text-grey-7">
                Nothing recorded yet. Entries appear here from the next build,
                deployment or restart onwards.
              </div>

              <q-list v-else separator>
                <q-item v-for="event in events" :key="event.id">
                  <q-item-section avatar top style="min-width: 40px">
                    <q-icon
                      :name="eventStyle(event.kind).icon"
                      :color="eventStyle(event.kind).colour"
                      size="21px"
                    />
                  </q-item-section>

                  <q-item-section>
                    <q-item-label class="row items-center q-gutter-xs">
                      <span class="text-weight-medium">{{ eventStyle(event.kind).label }}</span>
                      <!--
                        The whole reason this table exists: which commit, and
                        whether a person or a push asked for it.
                      -->
                      <q-badge
                        v-if="event.trigger === 'push'"
                        color="blue-1"
                        text-color="primary"
                      >
                        push
                      </q-badge>
                      <q-badge
                        v-if="event.commit_sha"
                        color="grey-3"
                        text-color="grey-8"
                        class="mono"
                      >
                        {{ event.commit_sha.slice(0, 7) }}
                      </q-badge>
                      <q-badge
                        v-if="event.image_tag"
                        color="grey-3"
                        text-color="grey-8"
                        class="mono"
                      >
                        {{ event.image_tag }}
                      </q-badge>
                      <!-- The build's own page, for the phases and timings
                           this row only summarises. -->
                      <AwsLink
                        :href="aws.codeBuildBuild(event.build_id)"
                        label="build log"
                      />
                    </q-item-label>

                    <q-item-label v-if="event.detail" caption class="text-grey-8">
                      {{ event.detail }}
                    </q-item-label>

                    <q-item-label caption class="text-grey-6">
                      {{ when(event.at) }} · {{ since(event.at) }} · {{ event.actor }}
                    </q-item-label>
                  </q-item-section>
                </q-item>
              </q-list>
            </SectionCard>

            <div v-if="!runtime?.exists" class="text-body2 text-grey-7">
              There is no ECS service yet, so there is nothing for ECS to report.
            </div>

            <template v-else>
              <div class="row q-col-gutter-md">
                <div class="col-12 col-md-7">
                  <SectionCard
                    title="Service events"
                    lede="Newest first. A placement failure is explained here and nowhere else."
                  >
                    <q-list v-if="runtime.events.length" dense separator>
                      <q-item v-for="event in runtime.events" :key="event.at + event.message">
                        <q-item-section>
                          <q-item-label caption class="text-grey-6">
                            {{ when(event.at) }} · {{ since(event.at) }}
                          </q-item-label>
                          <q-item-label class="text-body2">{{ event.message }}</q-item-label>
                        </q-item-section>
                      </q-item>
                    </q-list>
                    <div v-else class="text-body2 text-grey-7">Nothing reported yet.</div>
                  </SectionCard>
                </div>

                <div class="col-12 col-md-5">
                  <SectionCard title="Tasks" lede="Running or recently stopped.">
                    <q-markup-table v-if="runtime.tasks.length" flat dense>
                      <thead>
                        <tr>
                          <th class="text-left">Task</th>
                          <th class="text-left">Status</th>
                          <th class="text-left">Ran on</th>
                          <th class="text-left">Started</th>
                        </tr>
                      </thead>
                      <tbody>
                        <tr v-for="task in runtime.tasks" :key="task.arn">
                          <td class="mono">
                            {{ task.arn.split('/').pop() }}
                            <!-- A stopped task's exit code and the image it
                                 pulled are only on its own ECS page. -->
                            <AwsLink :href="aws.ecsTask(service.service_arn, task.arn)" />
                          </td>
                          <td>
                            {{ task.last_status }}
                            <div v-if="task.stopped_reason" class="text-negative text-caption">
                              {{ task.stopped_reason }}
                            </div>
                          </td>
                          <!--
                            Where it ran, which the log cannot say: a stream is
                            named after the task, never the host. On Fargate
                            there is no host, so the zone is the whole answer.
                          -->
                          <td class="mono">
                            {{ task.container_instance ?? task.availability_zone ?? '—' }}
                          </td>
                          <td>{{ when(task.started_at) }}</td>
                        </tr>
                      </tbody>
                    </q-markup-table>
                    <div v-else class="text-body2 text-grey-7">No tasks.</div>
                  </SectionCard>

                  <SectionCard title="Rollout" class="q-mt-md">
                    <table class="facts">
                      <tbody>
                        <tr>
                          <th>Status</th>
                          <td>{{ runtime.status ?? '—' }}</td>
                        </tr>
                        <tr>
                          <th>Rollout</th>
                          <td>
                            {{ runtime.rollout_state ?? '—' }}
                            <div v-if="runtime.rollout_detail" class="text-grey-7 text-caption">
                              {{ runtime.rollout_detail }}
                            </div>
                          </td>
                        </tr>
                        <tr>
                          <th>Task definition</th>
                          <td class="mono break">{{ runtime.task_definition ?? '—' }}</td>
                        </tr>
                      </tbody>
                    </table>
                  </SectionCard>
                </div>
              </div>
            </template>
          </q-tab-panel>
        </q-tab-panels>
      </q-card>
    </template>

    <!--
      Deprovision: takes the AWS resources down and keeps the registry rows, so
      the service can be launched again later.
    -->
    <q-dialog v-model="deprovisionDialog">
      <q-card style="min-width: min(520px, 94vw)">
        <q-card-section>
          <div class="text-h6">Deprovision {{ service?.name }}</div>
        </q-card-section>
        <q-card-section class="q-pt-none text-body2">
          <p>
            The ECS service is scaled to zero and deleted, its build project destroyed, and its
            capacity torn down — on EC2 that terminates its instances. The registry rows stay,
            so it can be launched again.
          </p>
          <q-checkbox
            v-model="deprovisionOptions.delete_images"
            label="Also delete the image repository"
          />
          <div class="text-caption text-grey-7 q-ml-lg q-mb-sm">
            Throws away every built image; redeploying later becomes a full rebuild.
          </div>
          <q-checkbox v-model="deprovisionOptions.delete_logs" label="Also delete the log groups" />
          <div class="text-caption text-grey-7 q-ml-lg">
            Throws away the container and build logs.
          </div>
        </q-card-section>
        <q-card-actions align="right">
          <q-btn v-close-popup flat no-caps label="Cancel" :disable="busy" />
          <q-btn
            unelevated
            no-caps
            color="negative"
            label="Deprovision"
            :loading="busy"
            @click="confirmDeprovision"
          />
        </q-card-actions>
      </q-card>
    </q-dialog>

    <!-- Delete: everything, in one action. Nothing is dropped if the teardown
         fails, because a row deleted over a live resource is a resource nothing
         can name again. -->
    <q-dialog v-model="removeDialog">
      <q-card style="min-width: min(540px, 94vw)">
        <q-card-section>
          <div class="text-h6">Delete {{ service?.name }}</div>
        </q-card-section>
        <q-card-section class="q-pt-none text-body2">
          <p>
            The ECS service is deleted, its build project destroyed, and its capacity torn down —
            on EC2 that terminates its instances. Both registry rows go with them. The GitHub
            repository is never touched.
          </p>
          <q-checkbox
            v-model="removeOptions.delete_images"
            label="Also delete the image repository"
          />
          <div class="text-caption text-grey-7 q-ml-lg q-mb-sm">
            Throws away every built image.
          </div>
          <q-checkbox v-model="removeOptions.delete_logs" label="Also delete the log groups" />
          <div class="text-caption text-grey-7 q-ml-lg">
            Throws away the record of why the service is being deleted.
          </div>
        </q-card-section>
        <q-card-actions align="right">
          <q-btn flat no-caps label="Cancel" :disable="busy" @click="removeDialog = false" />
          <q-btn
            unelevated
            no-caps
            color="negative"
            label="Delete"
            :loading="busy"
            @click="confirmRemove"
          />
        </q-card-actions>
      </q-card>
    </q-dialog>
  </q-page>
</template>

<style scoped>
.mono {
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
}

.break {
  word-break: break-all;
}

.link {
  color: #1565c0;
  text-decoration: none;
}

.link:hover {
  text-decoration: underline;
}

.link .q-icon {
  margin-left: 3px;
  vertical-align: baseline;
}

.stat__label {
  font-size: 11px;
  text-transform: uppercase;
  letter-spacing: 0.04em;
  color: #6b7688;
}

.stat__value {
  font-size: 16px;
  line-height: 1.5;
  color: #1c2434;
  margin-top: 2px;
}

.stat__note {
  font-size: 12px;
  color: #8b95a7;
}

/* Fact tables: a label column that stays narrow and a value column that wraps. */
.facts {
  width: 100%;
  border-collapse: collapse;
  font-size: 13px;
}

.facts th {
  text-align: left;
  font-weight: 500;
  color: #6b7688;
  padding: 5px 12px 5px 0;
  white-space: nowrap;
  vertical-align: top;
  width: 1%;
}

.facts td {
  padding: 5px 0;
  color: #1c2434;
}

/* A terminal, not a table: fixed pitch, dark, scrolling on its own. */
.log-view {
  background: #12161f;
  color: #d7dde8;
  border-radius: 6px;
  padding: 10px 12px;
  height: 520px;
  overflow: auto;
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  font-size: 12px;
  line-height: 1.55;
}

.log-row {
  white-space: pre-wrap;
  word-break: break-word;
  padding-left: 6px;
  border-left: 2px solid transparent;
}

/*
 * Tinted rather than shouted.
 *
 * The severity is a guess made from the wording, so it earns a hint and not a
 * banner: enough to catch the eye while scrolling, not so much that a false
 * positive reads as a confirmed fault.
 */
.log-row--error {
  border-left-color: #d9534f;
  color: #ffb4b0;
}

.log-row--warn {
  border-left-color: #d0a13b;
  color: #f0d9a8;
}

.log-hit {
  background: #ffd24a;
  color: #1c2434;
  border-radius: 2px;
}

/* The task a merged line came from, kept narrow so it cannot crowd the text. */
.log-task {
  color: #7f8ca3;
  margin-right: 8px;
  user-select: none;
}

.log-time {
  color: #6f7b90;
  margin-right: 10px;
  user-select: none;
}

.log-note {
  color: #8b95a7;
  padding-bottom: 4px;
  border-bottom: 1px solid #262c39;
  margin-bottom: 6px;
}

.node-table :deep(td) {
  vertical-align: middle;
}
</style>

<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { useQuasar } from 'quasar';
import {
  api,
  ApiError,
  type CapacityType,
  type ClusterCapacityInput,
  type ClusterHealthResponse,
  type ComputeCluster,
  type GpuMode,
  type InstanceType,
  type LogTail,
  type Microservice,
  type ProvisionResult,
} from '@/api/client';
import { buildRunning } from '@/api/client';
import { useAsyncValue } from '@/composables/useAsyncValue';
import { vcpu } from '@/format';
import AsyncValue from '@/components/AsyncValue.vue';
import InfoHint from '@/components/InfoHint.vue';
import AwsLink from '@/components/AwsLink.vue';
import PageHeader from '@/components/PageHeader.vue';
import { aws } from '@/aws-links';
import SectionCard from '@/components/SectionCard.vue';
import { useAuthStore } from '@/stores/auth';

/**
 * The machines behind each microservice, and what they are doing.
 *
 * A cluster here is never a thing of its own: one is created with each service,
 * carries only that service, and is destroyed with it. So the page is organised
 * around the service — which repository it came from, how full its nodes are,
 * and what it last printed — rather than around an ECS object nobody chose.
 *
 * The one fact worth making obvious is that an ECS cluster is only a name: it
 * holds no machines and costs nothing. What costs money is the capacity
 * attached to it, and there are two kinds with one difference that drives
 * everything else: Fargate cannot run GPUs. A Fargate cluster has no instance
 * count, because there are no instances; an EC2 cluster has one instance type,
 * which is what makes its capacity a single number and its cost attributable.
 */

const $q = useQuasar();
const route = useRoute();
const router = useRouter();
const auth = useAuthStore();
const isAdmin = computed(() => auth.isAdmin);

const HINTS = {
  capacity:
    'Fargate: AWS runs the machines, you never see one, and an idle service costs nothing. ' +
    'EC2: an auto-scaling pool of instances you own — the only option that can have GPUs, ' +
    'and it bills per instance-hour whether or not a task is running on it.',
  instances:
    'How many machines exist. Separate from how many tasks run: with managed scaling you ' +
    'set task counts on each service and ECS grows the pool to fit, up to this maximum. ' +
    'A fixed pool holds the minimum regardless of load.',
  target:
    'How tightly the pool tracks demand. At 100% ECS keeps only enough instances for the ' +
    'tasks it has — cheapest, but every scale-up waits for an instance to boot, which for ' +
    'a GPU AMI is a couple of minutes. Below 100 it keeps spare capacity warm.',
  gpuMode:
    'Exclusive gives each task a whole GPU, enforced by ECS — one task per card. Shared ' +
    'declares no GPU requirement, so tasks pack by CPU and memory and every one of them ' +
    'sees the card. Shared is the only way to fit several small models on one GPU, because ' +
    'ECS allocates whole devices and nothing below the driver can enforce a fraction.',
  vram:
    'How much video memory one card has. ECS schedules on CPU and memory and knows nothing ' +
    'about VRAM, so it will happily place six containers that each need 4 GB onto a 16 GB ' +
    'card and let one fail at runtime. This figure is what lets the console refuse that.',
  committed:
    'Video memory the services on this cluster expect to need, added up and compared ' +
    'against a single card — tasks are not spread evenly, and a card either fits what ' +
    'lands on it or does not.',
};

/**
 * The instance catalog comes from the API, not from a list in this file.
 *
 * It used to be hardcoded here, and the VRAM figures had already drifted from
 * the server's — a T4 listed as 15360 MiB against the real 16384. That number
 * is the one the API refuses GPU overcommits on, so a second copy of it in the
 * frontend means the hint the form shows and the rule the server enforces can
 * disagree about whether a service fits.
 */
const catalog = useAsyncValue<{ instance_types: InstanceType[]; memory_overhead_mib: number }>(
  (signal) => api.instanceTypes(signal)
);

const instanceOptions = computed(() =>
  (catalog.data.value?.instance_types ?? []).map((spec) => ({
    value: spec.name,
    label:
      `${spec.name} — ${spec.vcpu} vCPU, ${gb(spec.memoryMib)}` +
      (spec.gpus > 0 ? `, ${spec.gpuModel}` : ''),
    spec,
  }))
);

const clusters = useAsyncValue<{ clusters: ComputeCluster[] }>((signal) => api.clusters(signal));

const busy = ref(false);
const selectedName = ref<string | null>(null);

const list = computed<ComputeCluster[]>(() => clusters.data.value?.clusters ?? []);
const selected = computed<ComputeCluster | null>(
  () => list.value.find((row) => row.name === selectedName.value) ?? null
);

const gpuClusters = computed(() => list.value.filter((row) => row.gpus_per_instance > 0));
const overcommitted = computed(() => list.value.filter((row) => row.usage.vram_overcommitted));

function gb(mib: number): string {
  return mib >= 1024 ? `${Math.round((mib / 1024) * 10) / 10} GB` : `${mib} MiB`;
}

/** What this cluster runs on, in one line. */
function capacityLabel(cluster: ComputeCluster): string {
  if (cluster.capacity_type === 'fargate') return 'Fargate — no instances to manage';
  const range =
    cluster.scaling_mode === 'fixed'
      ? `${cluster.min_instances} instance${cluster.min_instances === 1 ? '' : 's'}`
      : `${cluster.min_instances}–${cluster.max_instances} instances`;
  return `${cluster.instance_type} · ${range}`;
}

function gpuLabel(cluster: ComputeCluster): string {
  if (cluster.gpus_per_instance === 0) return 'no GPU';
  const total = `${cluster.gpus_per_instance}× ${gb(cluster.gpu_vram_mb)}`;
  return cluster.gpu_mode === 'exclusive' ? `${total}, one task per card` : `${total}, shared`;
}

function reload(): void {
  void clusters.reload();
  void services.reload();
  if (selectedName.value) void loadHealth(selectedName.value);
}

// --- Provisioning ----------------------------------------------------------

/**
 * Live health for the selected cluster.
 *
 * Loaded separately from the list rather than folded into it: it costs three
 * ECS calls per cluster, and a page listing ten clusters would spend thirty
 * round trips to show numbers only one of them is being looked at.
 */
const health = ref<ClusterHealthResponse | null>(null);
const healthLoading = ref(false);
const healthError = ref<string | null>(null);

/** The ECS half of the response, unwrapped for the template. */
const healthData = computed(() => health.value?.health ?? null);

async function loadHealth(name: string): Promise<void> {
  healthLoading.value = true;
  healthError.value = null;
  try {
    health.value = await api.clusterHealth(name);
  } catch (error) {
    health.value = null;
    healthError.value =
      error instanceof ApiError ? error.message : 'Health could not be read.';
  } finally {
    healthLoading.value = false;
  }
}

function select(name: string): void {
  selectedName.value = selectedName.value === name ? null : name;
  health.value = null;
  healthError.value = null;
  if (selectedName.value) void loadHealth(selectedName.value);
}

/** What the provision state should look like at a glance. */
function stateTone(state: string): string {
  if (state === 'provisioned') return 'positive';
  if (state === 'failed') return 'negative';
  if (state === 'drifted') return 'warning';
  return 'grey-6';
}

function stateLabel(state: string): string {
  if (state === 'not_provisioned') return 'not provisioned';
  if (state === 'drifted') return 'changes not applied';
  return state;
}

/**
 * Reports a provision result as its steps rather than a bare "done".
 *
 * Provisioning is six AWS calls across four services, and when it half-fails
 * the useful information is which of them got through — "ami resolved, launch
 * template created" followed by an error on the scaling group is a completely
 * different problem from failing at the first step.
 */
function reportSteps(result: ProvisionResult, verb: string): void {
  if (result.error) {
    $q.notify({
      type: 'negative',
      message: `${verb} failed: ${result.error}`,
      // Spread rather than set to undefined: QNotifyCreateOptions is declared
      // under exactOptionalPropertyTypes, which rejects an explicit undefined.
      ...(result.steps.length ? { caption: `Completed: ${result.steps.join(', ')}` } : {}),
      timeout: 0,
      actions: [{ label: 'Dismiss', color: 'white' }],
      position: 'top',
    });
    return;
  }
  $q.notify({
    type: 'positive',
    message: `${verb} complete.`,
    caption: result.steps.join(', '),
    position: 'top',
    timeout: 6000,
  });
}

async function provision(cluster: ComputeCluster): Promise<void> {
  busy.value = true;
  try {
    reportSteps(await api.clusterProvision(cluster.name), 'Provisioning');
    reload();
  } catch (error) {
    reportError(error, 'The cluster could not be provisioned.');
  } finally {
    busy.value = false;
  }
}

function deprovision(cluster: ComputeCluster): void {
  const ec2 = cluster.capacity_type === 'ec2';
  $q.dialog({
    title: 'Deprovision cluster',
    message:
      `Destroy the AWS resources behind ${carrierOf(cluster)}?` +
      (ec2
        ? ' Its Auto Scaling group is drained and deleted, every instance terminates, and ' +
          'the launch template and capacity provider are removed.'
        : ' Its ECS cluster is deleted.') +
      ' The cluster record stays, so it can be provisioned again. Refused while a service ' +
      'is still deployed here.',
    cancel: true,
    ok: { label: 'Deprovision', color: 'negative', unelevated: true },
  }).onOk(() => {
    void (async () => {
      busy.value = true;
      try {
        reportSteps(await api.clusterDeprovision(cluster.name), 'Deprovisioning');
        reload();
      } catch (error) {
        reportError(error, 'The cluster could not be deprovisioned.');
      } finally {
        busy.value = false;
      }
    })();
  });
}

function reportError(error: unknown, fallback: string): void {
  $q.notify({
    type: 'negative',
    message: error instanceof ApiError ? error.message : fallback,
    timeout: 0,
    actions: [{ label: 'Dismiss', color: 'white' }],
    position: 'top',
  });
}

// --- Dialog ----------------------------------------------------------------

const dialog = ref(false);
const editingName = ref<string | null>(null);
const dialogError = ref<string | null>(null);

const form = ref({
  capacity_type: 'fargate' as CapacityType,
  instance_type: '',
  scaling_mode: 'auto' as 'fixed' | 'auto',
  min_instances: 0,
  max_instances: 4,
  target_capacity: 100,
  gpus_per_instance: 0,
  gpu_vram_mb: 0,
  gpu_mode: 'shared' as GpuMode,
});

// There is no `openAdd`. Clusters are created with the microservice that owns
// them, so this dialog only ever edits an existing one.

/**
 * Opening the capacity form from the service's own page.
 *
 * That page carries everything about a service including its nodes, but the
 * form that changes capacity lives here — so it links with the entry named, and
 * this opens it. The query is spent immediately, so a reload does not reopen a
 * dialog that has been closed.
 */
watch(
  [() => route.query.edit, () => clusters.state.value],
  ([wanted]) => {
    if (typeof wanted !== 'string' || !wanted) return;
    const row = list.value.find((entry) => entry.name === wanted);
    if (!row) return;
    selectedName.value = row.name;
    openEdit(row);
    void router.replace({ name: 'clusters' });
  },
  { immediate: true }
);

function openEdit(cluster: ComputeCluster): void {
  editingName.value = cluster.name;
  dialogError.value = null;
  form.value = {
    capacity_type: cluster.capacity_type,
    instance_type: cluster.instance_type ?? '',
    scaling_mode: cluster.scaling_mode,
    min_instances: cluster.min_instances,
    max_instances: cluster.max_instances,
    target_capacity: cluster.target_capacity,
    gpus_per_instance: cluster.gpus_per_instance,
    gpu_vram_mb: cluster.gpu_vram_mb,
    gpu_mode: cluster.gpu_mode,
  };
  dialog.value = true;
}

/**
 * Picking a catalogued instance type fills in its GPU facts.
 *
 * They stay editable, but not freely: the API cross-checks a catalogued type
 * and refuses a GPU count or a VRAM figure larger than the hardware has. That
 * check is the point — `g4dn.xlarge` saved with 0 GPUs provisions from the
 * standard AMI with no driver, comes up healthy, registers zero GPUs, and every
 * GPU task then sits PENDING while the instance bills.
 *
 * An instance type not in the catalog is still valid and gets neither the
 * auto-fill nor the cross-check.
 */
function applyPreset(value: string | null): void {
  const spec = (catalog.data.value?.instance_types ?? []).find((row) => row.name === value);
  if (!spec) return;
  form.value.gpus_per_instance = spec.gpus;
  form.value.gpu_vram_mb = spec.gpuVramMb;
}

/** The catalog entry for whatever is currently typed, if it knows it. */
const formInstance = computed<InstanceType | null>(
  () =>
    (catalog.data.value?.instance_types ?? []).find(
      (row) => row.name === form.value.instance_type.trim()
    ) ?? null
);

const isEc2 = computed(() => form.value.capacity_type === 'ec2');
const hasGpu = computed(() => isEc2.value && form.value.gpus_per_instance > 0);

const formProblem = computed<string | null>(() => {
  if (!isEc2.value) return null;
  if (!form.value.instance_type.trim()) return 'Name the instance type to run on.';
  if (form.value.max_instances < form.value.min_instances) {
    return `Maximum instances (${form.value.max_instances}) is below the minimum (${form.value.min_instances}).`;
  }
  if (form.value.max_instances < 1) return 'Maximum instances must be at least 1.';
  if (hasGpu.value && form.value.gpu_vram_mb <= 0) {
    return 'Record how much memory one card has — it is what lets the console refuse an overcommit.';
  }
  return null;
});

// Only ever an edit: the dialog cannot be opened without a row behind it.
const canSubmit = computed(() => formProblem.value === null && editingName.value !== null);

/** Said back as a sentence, because six numbers do not add up to a mental model. */
const capacitySummary = computed(() => {
  if (!isEc2.value) {
    return 'AWS runs the machines. Services scale by task count, an idle service costs nothing, and there are no GPUs.';
  }
  const type = form.value.instance_type.trim() || 'the instance';
  if (form.value.scaling_mode === 'fixed') {
    return (
      `Always ${form.value.min_instances} × ${type}, running and billed whether or not ` +
      `anything is on them.` +
      (form.value.min_instances === 1
        ? ' With one instance there is no headroom for a rolling replacement — tasks stop before new ones start.'
        : '')
    );
  }
  return (
    `Between ${form.value.min_instances} and ${form.value.max_instances} × ${type}, ` +
    `following task demand.` +
    (form.value.min_instances === 0
      ? ' At zero it costs nothing when idle, and the first task waits for an instance to boot.'
      : ` You always pay for ${form.value.min_instances}.`)
  );
});

function capacityPayload(): ClusterCapacityInput {
  if (!isEc2.value) return { capacity_type: 'fargate' };
  return {
    capacity_type: 'ec2',
    instance_type: form.value.instance_type.trim(),
    scaling_mode: form.value.scaling_mode,
    min_instances: form.value.min_instances,
    max_instances: form.value.max_instances,
    target_capacity: form.value.target_capacity,
    gpus_per_instance: form.value.gpus_per_instance,
    gpu_vram_mb: form.value.gpu_vram_mb,
    gpu_mode: form.value.gpu_mode,
  };
}

/**
 * Saves capacity changes to an existing cluster.
 *
 * Edit only — clusters are created with the microservice that owns them. On a
 * provisioned cluster this marks it 'drifted' rather than applying itself,
 * because applying replaces instances and that should not happen as a side
 * effect of saving a form.
 */
async function submit(): Promise<void> {
  if (!editingName.value) return;
  dialogError.value = null;
  busy.value = true;
  try {
    // Capacity only. `display_name` is omitted rather than echoed back: the
    // route leaves an absent one alone, and there is no field for it any more.
    await api.clusterUpdate(editingName.value, { capacity: capacityPayload() });
    $q.notify({
      type: 'positive',
      message: `Capacity for ${selected.value?.usage.service_name ?? editingName.value} updated.`,
      position: 'top',
    });
    dialog.value = false;
    reload();
  } catch (error) {
    // Kept in the dialog rather than thrown as a toast: the refusal names a
    // field, and the form has to stay open to correct it.
    dialogError.value =
      error instanceof ApiError ? error.message : 'The cluster could not be saved.';
  } finally {
    busy.value = false;
  }
}

/**
 * A cluster is named after the service it carries, and showing that name as a
 * cluster's own makes two things out of one. It is identified by its service
 * instead — which is what an operator was looking for anyway, since capacity is
 * only ever adjusted because of the service on it.
 *
 * The registry key is still the service name and still what every call takes;
 * it is simply not a label. "Unused capacity" is the state that should not
 * exist — a cluster whose service was deleted from under it — and it is named
 * that way so it reads as something to clean up rather than something to use.
 */
function clusterLabel(cluster: ComputeCluster): string {
  return cluster.usage.service_name
    ? `Capacity for ${cluster.usage.service_name}`
    : 'Unused capacity';
}

/** The service it carries, for a sentence that needs the bare name. */
function carrierOf(cluster: ComputeCluster): string {
  return cluster.usage.service_name ?? 'no service';
}

/**
 * The service each entry carries, fetched here rather than joined server-side.
 *
 * The page needs three things from it that the cluster row does not carry: the
 * repository to link to, the branch the image was built from, and whether a
 * build is running — the last of which is what decides whether the log below
 * refreshes itself.
 */
const services = useAsyncValue<{ microservices: Microservice[] }>((signal) =>
  api.microservices(signal)
);

const serviceList = computed<Microservice[]>(() => services.data.value?.microservices ?? []);

function serviceOf(cluster: ComputeCluster): Microservice | null {
  return (
    serviceList.value.find((service) => service.name === cluster.usage.service_name) ?? null
  );
}

const selectedService = computed<Microservice | null>(() =>
  selected.value ? serviceOf(selected.value) : null
);

/**
 * A selection change drops the live health with it.
 *
 * The panel below is about one entry; leaving the previous one on screen
 * while the new one loads is how people read the wrong numbers.
 */
watch(selectedName, () => {
  health.value = null;
  healthError.value = null;
});

/**
 * How full a node is, as a fraction.
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

/** Green until it is tight, then amber, then red — the usual reading order. */
function loadTone(fraction: number): string {
  if (fraction >= 0.9) return 'negative';
  if (fraction >= 0.7) return 'warning';
  return 'primary';
}

function removeCluster(cluster: ComputeCluster): void {
  $q.dialog({
    title: 'Remove cluster',
    message:
      `Remove the capacity record for ${carrierOf(cluster)}? This deletes the record only, ` +
        'and is refused while a microservice is still assigned here or any AWS resource ' +
        'still exists. Deleting the service removes both.',
    cancel: true,
    ok: { label: 'Remove', color: 'negative', unelevated: true },
  }).onOk(() => {
    void (async () => {
      busy.value = true;
      try {
        await api.clusterRemove(cluster.name);
        $q.notify({
          type: 'positive',
          message: `${clusterLabel(cluster)} removed.`,
          position: 'top',
        });
        if (selectedName.value === cluster.name) selectedName.value = null;
        reload();
      } catch (error) {
        reportError(error, 'The cluster could not be removed.');
      } finally {
        busy.value = false;
      }
    })();
  });
}
</script>

<template>
  <q-page padding>
    <PageHeader title="Compute capacity">
      <template #subtitle>
        The machines each microservice runs on. Every service gets a cluster of its own,
        created and destroyed with it, so capacity is a property of a service rather than
        something to name or share — Fargate, where AWS runs the machines, or a pool of EC2
        instances you own. Only EC2 can have GPUs.
      </template>
      <template #actions>
        <q-btn
          outline
          color="primary"
          icon="refresh"
          label="Refresh"
          :loading="clusters.state.value === 'loading'"
          @click="reload"
        />
        <!--
          No "Add cluster". A cluster belongs to exactly one microservice and is
          created with it, so one made here could never be attached to anything
          — it would be a dead end that still cost money once provisioned. This
          page watches and adjusts what the Microservices page created.
        -->
      </template>
    </PageHeader>

    <!--
      Two separate acts, and the page has to keep them separate. Saving a row
      costs nothing; provisioning an EC2 cluster starts instances that bill by
      the second whether or not a task is on them.
    -->
    <q-banner rounded class="bg-blue-1 text-grey-9 q-mb-md">
      <template #avatar><q-icon name="info" color="info" /></template>
      <div class="text-weight-medium">One cluster per microservice, created with it</div>
      <div class="text-body2">
        Clusters are not made here — each one belongs to a single microservice and is created,
        provisioned and torn down with it on the Microservices page. This page is for watching
        their health and changing their capacity afterwards. Editing a provisioned cluster
        marks it <em>changes not applied</em> rather than replacing instances while you are
        still typing; <strong>Apply changes</strong> is what acts on it.
      </div>
    </q-banner>

    <div class="row q-col-gutter-md q-mb-md">
      <div class="col-6 col-md-3">
        <q-card flat bordered>
          <q-card-section>
            <div class="text-caption text-grey-7 text-uppercase">Clusters</div>
            <div class="text-h6 q-mt-xs">
              <AsyncValue :state="clusters.state.value" :error="clusters.error.value">
                {{ list.length }}
              </AsyncValue>
            </div>
          </q-card-section>
        </q-card>
      </div>
      <div class="col-6 col-md-3">
        <q-card flat bordered>
          <q-card-section>
            <div class="text-caption text-grey-7 text-uppercase">With GPUs</div>
            <div class="text-h6 q-mt-xs">
              <AsyncValue :state="clusters.state.value" :error="clusters.error.value">
                {{ gpuClusters.length }}
              </AsyncValue>
            </div>
          </q-card-section>
        </q-card>
      </div>
      <div class="col-6 col-md-3">
        <q-card flat bordered>
          <q-card-section>
            <div class="text-caption text-grey-7 text-uppercase">Services placed</div>
            <div class="text-h6 q-mt-xs">
              <AsyncValue :state="clusters.state.value" :error="clusters.error.value">
                {{ list.reduce((sum, row) => sum + row.usage.services, 0) }}
              </AsyncValue>
            </div>
          </q-card-section>
        </q-card>
      </div>
      <div class="col-6 col-md-3">
        <q-card flat bordered>
          <q-card-section>
            <div class="text-caption text-grey-7 text-uppercase row items-center">
              VRAM overcommitted<InfoHint :text="HINTS.committed" />
            </div>
            <div class="text-h6 q-mt-xs" :class="overcommitted.length ? 'text-negative' : ''">
              <AsyncValue :state="clusters.state.value" :error="clusters.error.value">
                {{ overcommitted.length }}
              </AsyncValue>
            </div>
          </q-card-section>
        </q-card>
      </div>
    </div>

    <AsyncValue :state="clusters.state.value" :error="clusters.error.value">
      <div class="row q-col-gutter-md">
        <div class="col-12 col-md-5">
          <SectionCard title="Capacity" flush>
            <q-card-section v-if="!list.length" class="text-body2 text-grey-7">
              Nothing here yet. One entry appears for each microservice you register — its
              capacity is created with it.
            </q-card-section>

            <q-list v-else separator>
              <q-item
                v-for="cluster in list"
                :key="cluster.name"
                v-ripple
                clickable
                :active="selectedName === cluster.name"
                active-class="bg-blue-grey-1"
                @click="select(cluster.name)"
              >
                <q-item-section avatar style="min-width: 34px">
                  <q-icon
                    :name="cluster.gpus_per_instance > 0 ? 'memory' : 'dns'"
                    size="20px"
                    :color="cluster.usage.vram_overcommitted ? 'negative' : 'grey-7'"
                  />
                </q-item-section>
                <q-item-section>
                  <q-item-label>{{ clusterLabel(cluster) }}</q-item-label>
                  <q-item-label caption class="mono">{{ capacityLabel(cluster) }}</q-item-label>
                </q-item-section>
                <q-item-section side>
                  <div class="column items-end">
                    <q-badge
                      :color="stateTone(cluster.provision_state)"
                      :outline="cluster.provision_state === 'not_provisioned'"
                      class="q-mb-xs"
                    >
                      {{ stateLabel(cluster.provision_state) }}
                    </q-badge>
                    <q-item-label v-if="cluster.usage.services === 0" caption class="text-orange-9">
                      nothing runs here
                    </q-item-label>
                  </div>
                </q-item-section>
                <q-item-section v-if="isAdmin" side @click.stop>
                  <q-btn flat dense round icon="more_vert" size="sm" aria-label="Actions">
                    <q-menu auto-close>
                      <q-list style="min-width: 200px">
                        <q-item clickable :disable="busy" @click="openEdit(cluster)">
                          <q-item-section>Edit</q-item-section>
                        </q-item>
                        <q-separator />
                        <q-item
                          v-if="cluster.provision_state !== 'provisioned'"
                          clickable
                          :disable="busy"
                          @click="provision(cluster)"
                        >
                          <q-item-section>
                            {{ cluster.provision_state === 'drifted' ? 'Apply changes' : 'Provision on AWS' }}
                          </q-item-section>
                        </q-item>
                        <q-item
                          v-else
                          clickable
                          :disable="busy"
                          @click="provision(cluster)"
                        >
                          <q-item-section>Re-apply</q-item-section>
                        </q-item>
                        <q-item
                          v-if="cluster.provision_state !== 'not_provisioned'"
                          clickable
                          :disable="busy"
                          class="text-negative"
                          @click="deprovision(cluster)"
                        >
                          <q-item-section>Deprovision</q-item-section>
                        </q-item>
                        <q-separator />
                        <!--
                          Only reachable for a cluster whose service is already
                          gone. Removing a service deletes its cluster row too,
                          so this is a repair for an inconsistent state rather
                          than part of any normal flow.
                        -->
                        <q-item
                          v-if="!cluster.usage.service_name"
                          clickable
                          :disable="busy"
                          class="text-negative"
                          @click="removeCluster(cluster)"
                        >
                          <q-item-section>Remove orphaned record</q-item-section>
                        </q-item>
                      </q-list>
                    </q-menu>
                  </q-btn>
                </q-item-section>
              </q-item>
            </q-list>
          </SectionCard>
        </div>

        <div class="col-12 col-md-7">
          <SectionCard :title="selected ? clusterLabel(selected) : 'Detail'">
            <div v-if="!selected" class="text-body2 text-grey-7">
              Select an entry to see its capacity and what runs on it.
            </div>

            <template v-else-if="selectedService">
              <!--
                The service's own page carries its source, its logs and its
                nodes. This one is the fleet view, so it points there rather
                than growing a second copy of all of it.
              -->
              <q-btn
                flat
                dense
                no-caps
                size="sm"
                color="primary"
                icon-right="arrow_forward"
                :label="`Manage ${selectedService.name}`"
                class="q-mb-sm"
                :to="{ name: 'microservice', params: { name: selectedService.name } }"
              />
            </template>

            <div v-else>
              <q-banner
                v-if="selected.usage.vram_overcommitted"
                rounded
                dense
                class="bg-orange-1 text-grey-9 q-mb-md"
              >
                <template #avatar><q-icon name="warning" color="warning" /></template>
                <div class="text-weight-medium">Video memory overcommitted</div>
                <div class="text-body2">
                  The services here expect {{ gb(selected.usage.committed_vram_mb) }} of VRAM and
                  each card has {{ gb(selected.usage.available_vram_mb) }}. ECS schedules on CPU
                  and memory only, so it would place them all and one would fail with a CUDA
                  out-of-memory.
                </div>
              </q-banner>

              <table class="detail-table">
                <tbody>
                  <tr>
                    <th>Capacity</th>
                    <td>{{ capacityLabel(selected) }}</td>
                  </tr>
                  <tr v-if="selected.capacity_type === 'ec2'">
                    <th>Scaling</th>
                    <td>
                      {{ selected.scaling_mode === 'fixed' ? 'Fixed pool' : 'Auto' }}
                      <span class="text-grey-7">
                        · target capacity {{ selected.target_capacity }}%
                      </span>
                    </td>
                  </tr>
                  <tr v-if="selected.gpus_per_instance > 0">
                    <th>GPU</th>
                    <td>{{ gpuLabel(selected) }}</td>
                  </tr>
                  <tr v-if="selected.gpus_per_instance > 0 && selected.gpu_mode === 'shared'">
                    <th>VRAM committed</th>
                    <td
                      class="mono"
                      :class="selected.usage.vram_overcommitted ? 'text-negative' : ''"
                    >
                      {{ gb(selected.usage.committed_vram_mb) }} of
                      {{ gb(selected.usage.available_vram_mb) }} per card
                    </td>
                  </tr>
                  <tr>
                    <th>Services</th>
                    <td>
                      {{ selected.usage.services }} placed
                      <span v-if="selected.usage.max_tasks" class="text-grey-7">
                        · up to {{ selected.usage.max_tasks }} tasks
                      </span>
                    </td>
                  </tr>
                  <tr>
                    <th>Provisioned</th>
                    <td>
                      <q-badge
                        :color="stateTone(selected.provision_state)"
                        :outline="selected.provision_state === 'not_provisioned'"
                      >
                        {{ stateLabel(selected.provision_state) }}
                      </q-badge>
                      <span v-if="selected.provisioned_at" class="text-grey-7 q-ml-sm">
                        {{ new Date(selected.provisioned_at).toLocaleString() }}
                      </span>
                      <!-- Container instances, placement failures and the
                           capacity provider's own view are ECS's. Absent until
                           the cluster exists, which is what the state says. -->
                      <AwsLink :href="aws.ecsCluster(selected.cluster_arn)" class="q-ml-sm" />
                    </td>
                  </tr>
                  <tr v-if="selected.image_id">
                    <th>
                      AMI
                      <InfoHint
                        text="The ECS-optimized image the instances booted from. A GPU cluster
                              needs the GPU variant — it carries the NVIDIA driver, and the
                              standard image produces instances that look healthy and register
                              zero GPUs."
                      />
                    </th>
                    <td class="mono">{{ selected.image_id }}</td>
                  </tr>
                  <tr v-if="selected.asg_name">
                    <th>Scaling group</th>
                    <td class="mono">{{ selected.asg_name }}</td>
                  </tr>
                </tbody>
              </table>

              <!-- Live health -->
              <div v-if="selected.provision_state !== 'not_provisioned'" class="q-mt-md">
                <div class="row items-center q-mb-sm">
                  <div class="text-subtitle2">Health</div>
                  <q-space />
                  <q-btn
                    flat
                    dense
                    size="sm"
                    icon="refresh"
                    :loading="healthLoading"
                    @click="loadHealth(selected.name)"
                  />
                </div>

                <q-banner v-if="healthError" rounded class="bg-red-1 text-grey-9">
                  <template #avatar><q-icon name="error" color="negative" /></template>
                  {{ healthError }}
                </q-banner>

                <!--
                  The single most useful derived fact on the page. A provisioned
                  GPU cluster that registered zero GPUs looks healthy by every
                  other measure and will never place a GPU task.
                -->
                <q-banner
                  v-else-if="health && health.gpu_visible === false"
                  rounded
                  class="bg-red-1 text-grey-9 q-mb-sm"
                >
                  <template #avatar><q-icon name="warning" color="negative" /></template>
                  <div class="text-weight-medium">ECS sees no GPUs on this cluster</div>
                  <div class="text-body2">
                    The row says {{ selected.gpus_per_instance }} card(s) per instance, but the
                    registered instances advertise none. GPU tasks will stay PENDING for ever.
                    Usually the instances booted from the standard AMI rather than the
                    GPU-optimized one — re-applying the cluster resolves the right image, and
                    existing instances have to be replaced to pick it up.
                  </div>
                </q-banner>

                <!--
                  Tasks on Fargate, instances on EC2.

                  A Fargate cluster registers no container instances, so the
                  instance figures below have exactly one possible value there —
                  zero — and a row of zeros reads as a broken cluster rather
                  than as one that needs no machines.
                -->
                <div v-if="healthData?.exists && selected.capacity_type === 'fargate'" class="row q-col-gutter-sm">
                  <div class="col-6 col-sm-4">
                    <q-card flat bordered>
                      <q-card-section class="q-pa-sm">
                        <div class="text-caption text-grey-7">Tasks running</div>
                        <div class="text-subtitle1">
                          {{ healthData.running_tasks }}
                          <span v-if="healthData.pending_tasks" class="text-warning text-caption">
                            · {{ healthData.pending_tasks }} pending
                          </span>
                        </div>
                      </q-card-section>
                    </q-card>
                  </div>
                  <div class="col-6 col-sm-4">
                    <q-card flat bordered>
                      <q-card-section class="q-pa-sm">
                        <div class="text-caption text-grey-7">Machines</div>
                        <div class="text-subtitle1">AWS-managed</div>
                      </q-card-section>
                    </q-card>
                  </div>
                  <div class="col-6 col-sm-4">
                    <q-card flat bordered>
                      <q-card-section class="q-pa-sm">
                        <div class="text-caption text-grey-7">Billed</div>
                        <div class="text-subtitle1">per task</div>
                      </q-card-section>
                    </q-card>
                  </div>
                </div>

                <div v-else-if="healthData && healthData.exists" class="row q-col-gutter-sm">
                  <div class="col-6 col-sm-3">
                    <q-card flat bordered>
                      <q-card-section class="q-pa-sm">
                        <div class="text-caption text-grey-7">Instances</div>
                        <div class="text-subtitle1">
                          {{ healthData.registered_instances }}
                          <span
                            v-if="healthData.disconnected_instances"
                            class="text-negative text-caption"
                          >
                            ({{ healthData.disconnected_instances }} disconnected)
                          </span>
                        </div>
                      </q-card-section>
                    </q-card>
                  </div>
                  <div class="col-6 col-sm-3">
                    <q-card flat bordered>
                      <q-card-section class="q-pa-sm">
                        <div class="text-caption text-grey-7">Tasks</div>
                        <div class="text-subtitle1">
                          {{ healthData.running_tasks }} running
                          <span v-if="healthData.pending_tasks" class="text-warning text-caption">
                            · {{ healthData.pending_tasks }} pending
                          </span>
                        </div>
                      </q-card-section>
                    </q-card>
                  </div>
                  <!--
                    Used rather than free, and a bar rather than a pair of
                    numbers. "3072 CPU units free" is not something anyone can
                    act on without also holding the size of the pool in their
                    head; how full it is, is.
                  -->
                  <div class="col-6 col-sm-3">
                    <q-card flat bordered>
                      <q-card-section class="q-pa-sm">
                        <div class="text-caption text-grey-7">CPU used</div>
                        <div class="text-subtitle1">
                          {{ vcpu(used(healthData.registered_cpu, healthData.remaining_cpu)) }} /
                          {{ vcpu(healthData.registered_cpu) }}
                        </div>
                        <q-linear-progress
                          size="4px"
                          class="q-mt-xs"
                          :value="fractionUsed(healthData.registered_cpu, healthData.remaining_cpu)"
                          :color="loadTone(fractionUsed(healthData.registered_cpu, healthData.remaining_cpu))"
                        />
                      </q-card-section>
                    </q-card>
                  </div>
                  <div class="col-6 col-sm-3">
                    <q-card flat bordered>
                      <q-card-section class="q-pa-sm">
                        <div class="text-caption text-grey-7">Memory used</div>
                        <div class="text-subtitle1">
                          {{ gb(used(healthData.registered_memory_mib, healthData.remaining_memory_mib)) }}
                          / {{ gb(healthData.registered_memory_mib) }}
                        </div>
                        <q-linear-progress
                          size="4px"
                          class="q-mt-xs"
                          :value="fractionUsed(healthData.registered_memory_mib, healthData.remaining_memory_mib)"
                          :color="loadTone(fractionUsed(healthData.registered_memory_mib, healthData.remaining_memory_mib))"
                        />
                      </q-card-section>
                    </q-card>
                  </div>
                  <div v-if="healthData.registered_gpus > 0" class="col-6 col-sm-3">
                    <q-card flat bordered>
                      <q-card-section class="q-pa-sm">
                        <div class="text-caption text-grey-7">GPUs used</div>
                        <div class="text-subtitle1">
                          {{ used(healthData.registered_gpus, healthData.remaining_gpus) }} /
                          {{ healthData.registered_gpus }}
                        </div>
                        <q-linear-progress
                          size="4px"
                          class="q-mt-xs"
                          :value="fractionUsed(healthData.registered_gpus, healthData.remaining_gpus)"
                          :color="loadTone(fractionUsed(healthData.registered_gpus, healthData.remaining_gpus))"
                        />
                      </q-card-section>
                    </q-card>
                  </div>
                </div>

                <div
                  v-else-if="healthData && !healthData.exists && !healthLoading"
                  class="text-body2 text-grey-7"
                >
                  The record says provisioned, but ECS has no such cluster. Re-apply to recreate
                  it.
                </div>

                <!--
                  Per node, because the totals above hide the case that matters:
                  a pool half empty in aggregate can still have nowhere to put
                  the next task, if what is free is spread thinly across boxes.
                  ECS places a task on one instance or not at all.
                -->
                <div
                  v-if="selected.capacity_type !== 'fargate' && healthData?.instances.length"
                  class="q-mt-md"
                >
                  <div class="text-caption text-grey-7 text-uppercase q-mb-xs">Nodes</div>
                  <q-markup-table flat bordered dense class="node-table">
                    <thead>
                      <tr>
                        <th class="text-left">Instance</th>
                        <th class="text-left">Status</th>
                        <th class="text-right">Tasks</th>
                        <th class="text-left" style="width: 26%">CPU</th>
                        <th class="text-left" style="width: 26%">Memory</th>
                        <th v-if="healthData.registered_gpus > 0" class="text-right">GPU</th>
                      </tr>
                    </thead>
                    <tbody>
                      <tr v-for="instance in healthData.instances" :key="instance.id">
                        <td class="mono">{{ instance.ec2_instance_id || instance.id }}</td>
                        <td>
                          <q-badge
                            :color="instance.agent_connected ? 'positive' : 'negative'"
                            outline
                          >
                            {{ instance.agent_connected ? instance.status : 'agent lost' }}
                          </q-badge>
                        </td>
                        <td class="text-right">
                          {{ instance.running_tasks }}
                          <span v-if="instance.pending_tasks" class="text-warning">
                            +{{ instance.pending_tasks }}
                          </span>
                        </td>
                        <td>
                          <div class="text-caption">
                            {{ vcpu(used(instance.registered_cpu, instance.remaining_cpu)) }} /
                            {{ vcpu(instance.registered_cpu) }}
                          </div>
                          <q-linear-progress
                            size="4px"
                            :value="fractionUsed(instance.registered_cpu, instance.remaining_cpu)"
                            :color="loadTone(fractionUsed(instance.registered_cpu, instance.remaining_cpu))"
                          />
                        </td>
                        <td>
                          <div class="text-caption">
                            {{ gb(used(instance.registered_memory_mib, instance.remaining_memory_mib)) }}
                            / {{ gb(instance.registered_memory_mib) }}
                          </div>
                          <q-linear-progress
                            size="4px"
                            :value="fractionUsed(instance.registered_memory_mib, instance.remaining_memory_mib)"
                            :color="loadTone(fractionUsed(instance.registered_memory_mib, instance.remaining_memory_mib))"
                          />
                        </td>
                        <td v-if="healthData.registered_gpus > 0" class="text-right">
                          {{ used(instance.registered_gpus, instance.remaining_gpus) }} /
                          {{ instance.registered_gpus }}
                        </td>
                      </tr>
                    </tbody>
                  </q-markup-table>
                </div>

                <!--
                  Fargate has no instances at all, which is a different thing
                  from having none registered yet — said rather than left as an
                  empty table that reads like a fault.
                -->
                <div
                  v-else-if="healthData && healthData.exists && selected.capacity_type === 'fargate'"
                  class="text-body2 text-grey-7 q-mt-md"
                >
                  Fargate runs the machines, so there are no nodes to monitor and no instance
                  utilisation to report — the task counts above are the whole picture.
                </div>
              </div>

              <q-banner
                v-if="selected.provision_state === 'failed' && selected.provision_detail"
                rounded
                class="bg-red-1 text-grey-9 q-mt-md"
              >
                <template #avatar><q-icon name="error" color="negative" /></template>
                <div class="text-weight-medium">The last attempt did not finish</div>
                <div class="text-body2">{{ selected.provision_detail }}</div>
                <div class="text-caption q-mt-xs">
                  Provisioning is idempotent — running it again resumes rather than starting
                  over.
                </div>
              </q-banner>

              <div v-if="isAdmin" class="q-mt-md q-gutter-sm">
                <q-btn outline dense size="sm" label="Edit" :disable="busy" @click="openEdit(selected)" />
                <q-btn
                  v-if="selected.provision_state !== 'provisioned'"
                  unelevated
                  color="primary"
                  dense
                  size="sm"
                  :label="selected.provision_state === 'drifted' ? 'Apply changes' : 'Provision on AWS'"
                  :disable="busy"
                  @click="provision(selected)"
                />
                <q-btn
                  v-else
                  outline
                  dense
                  size="sm"
                  label="Re-apply"
                  :disable="busy"
                  @click="provision(selected)"
                />
                <q-btn
                  v-if="selected.provision_state !== 'not_provisioned'"
                  flat
                  dense
                  size="sm"
                  color="negative"
                  label="Deprovision"
                  :disable="busy"
                  @click="deprovision(selected)"
                />
              </div>
            </div>
          </SectionCard>
        </div>
      </div>
    </AsyncValue>

    <!-- Add / edit -->
    <q-dialog v-model="dialog" persistent>
      <q-card style="min-width: min(620px, 94vw)">
        <q-card-section>
          <div class="text-h6">
            Capacity for {{ selected?.usage.service_name ?? editingName }}
          </div>
          <div class="text-body2 text-grey-7 q-mt-xs">
            The machines this service runs on. Changing them replaces instances, so it is
            saved as a record first and applied when you provision.
          </div>
        </q-card-section>

        <q-card-section class="q-pt-none">
          <q-banner v-if="dialogError" rounded class="bg-red-1 text-grey-9 q-mb-md">
            <template #avatar><q-icon name="error" color="negative" /></template>
            {{ dialogError }}
          </q-banner>

          <div class="row q-col-gutter-md">
            <div class="col-12">
              <div class="text-caption text-grey-7 text-uppercase row items-center">
                Capacity<InfoHint :text="HINTS.capacity" />
              </div>
            </div>

            <div class="col-12">
              <q-btn-toggle
                v-model="form.capacity_type"
                no-caps
                unelevated
                dense
                toggle-color="primary"
                :disable="editingName !== null"
                :options="[
                  { label: 'Fargate', value: 'fargate' },
                  { label: 'EC2 instances', value: 'ec2' },
                ]"
              />
              <div v-if="editingName" class="text-caption text-grey-7 q-mt-xs">
                Capacity type cannot change after creation — it changes the task definition
                shape for every service here. Create a second cluster and move them across.
              </div>
            </div>

            <template v-if="isEc2">
              <div class="col-12 col-sm-7">
                <q-select
                  v-model="form.instance_type"
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
                  hint="Any EC2 type. Picking a known one fills in its GPU details."
                  @update:model-value="applyPreset"
                />
                <!--
                  Shown as soon as a catalogued type is chosen, because the task
                  memory ceiling is the number that decides whether a service
                  will ever place — and it is not the instance's memory. The
                  agent and the OS take the difference.
                -->
                <div v-if="formInstance" class="text-caption text-grey-7 q-mt-xs">
                  {{ formInstance.vcpu }} vCPU · {{ gb(formInstance.memoryMib) }} RAM ·
                  tasks can use up to {{ gb(formInstance.task_memory_ceiling) }}
                  <template v-if="formInstance.gpus > 0">
                    · {{ formInstance.gpuModel }}
                  </template>
                  <div v-if="formInstance.note" class="text-grey-6">{{ formInstance.note }}</div>
                </div>
                <div
                  v-else-if="form.instance_type.trim()"
                  class="text-caption text-orange-9 q-mt-xs"
                >
                  Not in the catalog, so its GPU count and video memory are taken at your word
                  and nothing cross-checks them.
                </div>
              </div>
              <div class="col-6 col-sm-5">
                <q-select
                  v-model="form.scaling_mode"
                  outlined
                  dense
                  emit-value
                  map-options
                  label="Instance count"
                  :options="[
                    { label: 'Auto scale', value: 'auto' },
                    { label: 'Fixed', value: 'fixed' },
                  ]"
                >
                  <template #append><InfoHint :text="HINTS.instances" /></template>
                </q-select>
              </div>

              <div class="col-6 col-sm-4">
                <q-input
                  v-model.number="form.min_instances"
                  outlined
                  dense
                  type="number"
                  min="0"
                  :label="form.scaling_mode === 'fixed' ? 'Instances' : 'Min instances'"
                  hide-bottom-space
                />
              </div>
              <div v-if="form.scaling_mode === 'auto'" class="col-6 col-sm-4">
                <q-input
                  v-model.number="form.max_instances"
                  outlined
                  dense
                  type="number"
                  min="1"
                  label="Max instances"
                  hide-bottom-space
                />
              </div>
              <div v-if="form.scaling_mode === 'auto'" class="col-6 col-sm-4">
                <q-input
                  v-model.number="form.target_capacity"
                  outlined
                  dense
                  type="number"
                  min="1"
                  max="100"
                  label="Target capacity %"
                  hide-bottom-space
                >
                  <template #append><InfoHint :text="HINTS.target" /></template>
                </q-input>
              </div>

              <div class="col-12">
                <q-banner dense rounded class="bg-blue-1 text-grey-9">
                  <template #avatar><q-icon name="info" color="info" /></template>
                  <div class="text-body2">{{ capacitySummary }}</div>
                </q-banner>
              </div>

              <div class="col-12">
                <q-separator class="q-mt-sm q-mb-md" />
                <div class="text-caption text-grey-7 text-uppercase">GPU</div>
              </div>

              <div class="col-6 col-sm-4">
                <q-input
                  v-model.number="form.gpus_per_instance"
                  outlined
                  dense
                  type="number"
                  min="0"
                  label="GPUs per instance"
                  hide-bottom-space
                />
              </div>
              <div v-if="hasGpu" class="col-6 col-sm-4">
                <q-input
                  v-model.number="form.gpu_vram_mb"
                  outlined
                  dense
                  type="number"
                  min="0"
                  label="VRAM per card (MiB)"
                  hide-bottom-space
                >
                  <template #append><InfoHint :text="HINTS.vram" /></template>
                </q-input>
              </div>
              <div v-if="hasGpu" class="col-12 col-sm-4">
                <q-select
                  v-model="form.gpu_mode"
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

              <div v-if="hasGpu" class="col-12">
                <div class="text-caption text-grey-7">
                  <template v-if="form.gpu_mode === 'shared'">
                    Tasks pack onto the card by CPU and memory, so several services share one
                    GPU. Nothing enforces video memory — declare each service's need and the
                    console adds it up.
                  </template>
                  <template v-else>
                    ECS pins a whole card per task, so this cluster runs at most
                    {{ form.gpus_per_instance }} GPU task(s) per instance and the counts move
                    together.
                  </template>
                </div>
              </div>
            </template>

            <div v-if="formProblem" class="col-12">
              <q-banner dense rounded class="bg-red-1 text-grey-9">
                <template #avatar><q-icon name="error" color="negative" /></template>
                <div class="text-body2">{{ formProblem }}</div>
              </q-banner>
            </div>
          </div>
        </q-card-section>

        <q-card-actions align="right" class="q-pa-md q-pt-none">
          <q-btn flat no-caps label="Cancel" :disable="busy" @click="dialog = false" />
          <q-btn
            unelevated
            no-caps
            color="primary"
            :label="editingName ? 'Save' : 'Create cluster'"
            :loading="busy"
            :disable="!canSubmit"
            @click="submit"
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

.detail-table {
  width: 100%;
  border-collapse: collapse;
}

/* A terminal, not a table: fixed pitch, dark, and scrolling on its own. */
.log-view {
  background: #12161f;
  color: #d7dde8;
  border-radius: 6px;
  padding: 8px 10px;
  max-height: 420px;
  overflow: auto;
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  font-size: 12px;
  line-height: 1.55;
}

.log-row {
  white-space: pre-wrap;
  word-break: break-word;
}

.log-note {
  color: #8b95a7;
  padding-bottom: 4px;
  border-bottom: 1px solid #262c39;
  margin-bottom: 6px;
}

.log-panel :deep(.q-item) {
  padding-left: 0;
  padding-right: 0;
}

.node-table :deep(td) {
  vertical-align: middle;
}

.repo-link {
  color: #1565c0;
  text-decoration: none;
}

.repo-link:hover {
  text-decoration: underline;
}

.detail-table th {
  text-align: left;
  font-weight: 500;
  color: #6b7688;
  font-size: 12.5px;
  padding: 6px 12px 6px 0;
  vertical-align: top;
  white-space: nowrap;
  width: 1%;
}

.detail-table td {
  padding: 6px 0;
  font-size: 13px;
}
</style>

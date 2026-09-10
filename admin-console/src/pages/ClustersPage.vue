<script setup lang="ts">
import { computed, ref } from 'vue';
import { useQuasar } from 'quasar';
import {
  api,
  ApiError,
  type CapacityType,
  type ClusterCapacityInput,
  type ComputeCluster,
  type GpuMode,
} from '@/api/client';
import { useAsyncValue } from '@/composables/useAsyncValue';
import AsyncValue from '@/components/AsyncValue.vue';
import InfoHint from '@/components/InfoHint.vue';
import PageHeader from '@/components/PageHeader.vue';
import SectionCard from '@/components/SectionCard.vue';
import { useAuthStore } from '@/stores/auth';

/**
 * Where microservice containers run.
 *
 * The thing worth making obvious on this page is that an ECS cluster is only a
 * name — it holds no machines and costs nothing. What costs money is the
 * capacity attached to it, and there are two kinds with one difference that
 * drives everything else: Fargate cannot run GPUs.
 *
 * So the page leads with that choice, and then shows only what applies. A
 * Fargate cluster has no instance count, because there are no instances; an
 * EC2 cluster has one instance type, which is what makes its capacity a single
 * number and its cost attributable.
 */

const $q = useQuasar();
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
 * A starting point for the common instance types, so the GPU facts are not
 * typed from memory. Everything stays editable — this is a convenience, not a
 * whitelist, and a type not listed here works exactly the same.
 */
const INSTANCE_PRESETS = [
  { value: 'c6i.large', label: 'c6i.large — 2 vCPU, 4 GB', gpus: 0, vram: 0 },
  { value: 'c6i.xlarge', label: 'c6i.xlarge — 4 vCPU, 8 GB', gpus: 0, vram: 0 },
  { value: 'm6i.xlarge', label: 'm6i.xlarge — 4 vCPU, 16 GB', gpus: 0, vram: 0 },
  { value: 'g4dn.xlarge', label: 'g4dn.xlarge — 1× T4, 4 vCPU, 16 GB', gpus: 1, vram: 15360 },
  { value: 'g4dn.2xlarge', label: 'g4dn.2xlarge — 1× T4, 8 vCPU, 32 GB', gpus: 1, vram: 15360 },
  { value: 'g4dn.12xlarge', label: 'g4dn.12xlarge — 4× T4, 48 vCPU, 192 GB', gpus: 4, vram: 15360 },
  { value: 'g5.xlarge', label: 'g5.xlarge — 1× A10G, 4 vCPU, 16 GB', gpus: 1, vram: 23028 },
  { value: 'g5.2xlarge', label: 'g5.2xlarge — 1× A10G, 8 vCPU, 32 GB', gpus: 1, vram: 23028 },
  { value: 'g6.xlarge', label: 'g6.xlarge — 1× L4, 4 vCPU, 16 GB', gpus: 1, vram: 23028 },
];

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
  name: '',
  display_name: '',
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

function openAdd(): void {
  editingName.value = null;
  dialogError.value = null;
  form.value = {
    name: '',
    display_name: '',
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
  dialog.value = true;
}

function openEdit(cluster: ComputeCluster): void {
  editingName.value = cluster.name;
  dialogError.value = null;
  form.value = {
    name: cluster.name,
    display_name: cluster.display_name ?? '',
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
 * Picking a known instance type fills in its GPU facts.
 *
 * They stay editable — this saves looking them up, it does not decide them, and
 * an instance type not in the list is perfectly valid.
 */
function applyPreset(value: string | null): void {
  const preset = INSTANCE_PRESETS.find((row) => row.value === value);
  if (!preset) return;
  form.value.gpus_per_instance = preset.gpus;
  form.value.gpu_vram_mb = preset.vram;
}

const isEc2 = computed(() => form.value.capacity_type === 'ec2');
const hasGpu = computed(() => isEc2.value && form.value.gpus_per_instance > 0);

const formProblem = computed<string | null>(() => {
  if (!editingName.value && form.value.name.trim().length < 2) return null;
  if (!isEc2.value) return null;
  if (!form.value.instance_type.trim()) return 'Name the instance type this cluster runs.';
  if (form.value.max_instances < form.value.min_instances) {
    return `Maximum instances (${form.value.max_instances}) is below the minimum (${form.value.min_instances}).`;
  }
  if (form.value.max_instances < 1) return 'Maximum instances must be at least 1.';
  if (hasGpu.value && form.value.gpu_vram_mb <= 0) {
    return 'Record how much memory one card has — it is what lets the console refuse an overcommit.';
  }
  return null;
});

const canSubmit = computed(() => {
  if (formProblem.value !== null) return false;
  return editingName.value !== null || form.value.name.trim().length >= 2;
});

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

async function submit(): Promise<void> {
  dialogError.value = null;
  busy.value = true;
  try {
    if (editingName.value) {
      await api.clusterUpdate(editingName.value, {
        display_name: form.value.display_name || null,
        capacity: capacityPayload(),
      });
      $q.notify({ type: 'positive', message: `${editingName.value} updated.`, position: 'top' });
    } else {
      const name = form.value.name.trim();
      await api.clusterCreate({
        name,
        display_name: form.value.display_name || null,
        capacity: capacityPayload(),
      });
      $q.notify({ type: 'positive', message: `Cluster ${name} created.`, position: 'top' });
      selectedName.value = name;
    }
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

function removeCluster(cluster: ComputeCluster): void {
  $q.dialog({
    title: 'Remove cluster',
    message:
      `Remove ${cluster.name}? Nothing is provisioned on AWS yet, so this only deletes the ` +
      'record. It is refused while any microservice still runs here.',
    cancel: true,
    ok: { label: 'Remove', color: 'negative', unelevated: true },
  }).onOk(() => {
    void (async () => {
      busy.value = true;
      try {
        await api.clusterRemove(cluster.name);
        $q.notify({ type: 'positive', message: `${cluster.name} removed.`, position: 'top' });
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
    <PageHeader title="Compute clusters">
      <template #subtitle>
        Where microservice containers run. A cluster is a name plus the capacity attached to
        it — Fargate, where AWS runs the machines, or a pool of EC2 instances you own. Only
        EC2 can have GPUs.
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
        <q-btn
          v-if="isAdmin"
          unelevated
          color="primary"
          icon="add"
          label="Add cluster"
          :disable="busy"
          @click="openAdd"
        />
      </template>
    </PageHeader>

    <q-banner rounded class="bg-blue-1 text-grey-9 q-mb-md">
      <template #avatar><q-icon name="science" color="info" /></template>
      <div class="text-weight-medium">Configuration only, so far</div>
      <div class="text-body2">
        These rows record the capacity a cluster will be given. No ECS cluster, capacity
        provider or Auto Scaling group is created yet — that comes with provisioning.
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
          <SectionCard title="Clusters" flush>
            <q-card-section v-if="!list.length" class="text-body2 text-grey-7">
              No clusters yet.
              <template v-if="isAdmin">
                Add one before registering a microservice — a service needs somewhere to run.
              </template>
            </q-card-section>

            <q-list v-else separator>
              <q-item
                v-for="cluster in list"
                :key="cluster.name"
                v-ripple
                clickable
                :active="selectedName === cluster.name"
                active-class="bg-blue-grey-1"
                @click="selectedName = cluster.name"
              >
                <q-item-section avatar style="min-width: 34px">
                  <q-icon
                    :name="cluster.gpus_per_instance > 0 ? 'memory' : 'dns'"
                    size="20px"
                    :color="cluster.usage.vram_overcommitted ? 'negative' : 'grey-7'"
                  />
                </q-item-section>
                <q-item-section>
                  <q-item-label>{{ cluster.display_name || cluster.name }}</q-item-label>
                  <q-item-label caption class="mono">{{ capacityLabel(cluster) }}</q-item-label>
                </q-item-section>
                <q-item-section side>
                  <q-item-label caption>
                    {{ cluster.usage.services }}
                    {{ cluster.usage.services === 1 ? 'service' : 'services' }}
                  </q-item-label>
                </q-item-section>
                <q-item-section v-if="isAdmin" side @click.stop>
                  <q-btn flat dense round icon="more_vert" size="sm" aria-label="Actions">
                    <q-menu auto-close>
                      <q-list style="min-width: 160px">
                        <q-item clickable :disable="busy" @click="openEdit(cluster)">
                          <q-item-section>Edit</q-item-section>
                        </q-item>
                        <q-separator />
                        <q-item
                          clickable
                          :disable="busy"
                          class="text-negative"
                          @click="removeCluster(cluster)"
                        >
                          <q-item-section>Remove</q-item-section>
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
          <SectionCard :title="selected ? selected.display_name || selected.name : 'Detail'">
            <div v-if="!selected" class="text-body2 text-grey-7">
              Select a cluster to see its capacity and what runs on it.
            </div>

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
                      <q-chip dense square size="sm" color="grey-3" text-color="grey-8">
                        {{ selected.provision_state.replace(/_/g, ' ') }}
                      </q-chip>
                    </td>
                  </tr>
                </tbody>
              </table>

              <div v-if="isAdmin" class="q-mt-md">
                <q-btn outline dense size="sm" label="Edit" :disable="busy" @click="openEdit(selected)" />
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
          <div class="text-h6">{{ editingName ? `Edit ${editingName}` : 'Add cluster' }}</div>
        </q-card-section>

        <q-card-section class="q-pt-none">
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
                hint="Lowercase, hyphens. Becomes the ECS cluster name."
              />
            </div>
            <div class="col-12 col-sm-6">
              <q-input v-model="form.display_name" outlined dense label="Display name (optional)" />
            </div>

            <div class="col-12">
              <q-separator class="q-mt-sm q-mb-md" />
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
                  :options="INSTANCE_PRESETS"
                  emit-value
                  map-options
                  hint="Any EC2 type. Picking a known one fills in its GPU details."
                  @update:model-value="applyPreset"
                />
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

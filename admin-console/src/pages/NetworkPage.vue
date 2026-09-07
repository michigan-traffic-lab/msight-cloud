<script setup lang="ts">
import { computed, ref } from 'vue';
import type { QTableColumn } from 'quasar';
import { api, type NetworkTopology } from '@/api/client';
import { useAsyncValue } from '@/composables/useAsyncValue';
import PageHeader from '@/components/PageHeader.vue';
import AsyncValue from '@/components/AsyncValue.vue';
import NetworkDiagram from '@/components/NetworkDiagram.vue';
import SectionCard from '@/components/SectionCard.vue';

const topology = useAsyncValue<NetworkTopology>(
  (signal) => api.networkTopology(false, signal),
  { timeoutMs: 25000 }
);

const selectedSubnetId = ref<string | null>(null);

const selectedSubnet = computed(
  () => topology.data.value?.subnets.find((subnet) => subnet.id === selectedSubnetId.value) ?? null
);

/**
 * Rules that name another security group describe an allowed flow between two
 * parts of the stack — far easier to read as "A may reach B on port N" than as
 * a rules table. CIDR-based rules are listed separately below.
 */
const flows = computed(() => {
  const groups = topology.data.value?.security_groups ?? [];
  return groups.flatMap((group) =>
    group.rules
      .filter((rule) => rule.direction === 'ingress' && rule.peer_is_group)
      .map((rule) => ({
        from: rule.peer,
        to: group.name,
        ports: rule.ports,
        protocol: rule.protocol,
        description: rule.description,
      }))
  );
});

const cidrRules = computed(() => {
  const groups = topology.data.value?.security_groups ?? [];
  return groups.flatMap((group) =>
    group.rules
      .filter((rule) => !rule.peer_is_group)
      .map((rule) => ({ group: group.name, ...rule }))
  );
});

const severityColor: Record<string, string> = {
  critical: 'negative',
  warning: 'warning',
  info: 'info',
};

const routeColumns: QTableColumn[] = [
  { name: 'destination', label: 'Destination', field: 'destination', align: 'left' },
  { name: 'target', label: 'Target', field: 'target', align: 'left' },
  { name: 'target_type', label: 'Via', field: 'target_type', align: 'left' },
];

const cidrColumns: QTableColumn[] = [
  { name: 'group', label: 'Group', field: 'group', align: 'left', sortable: true },
  { name: 'direction', label: 'Direction', field: 'direction', align: 'left', sortable: true },
  { name: 'peer', label: 'Peer', field: 'peer', align: 'left' },
  { name: 'protocol', label: 'Protocol', field: 'protocol', align: 'left' },
  { name: 'ports', label: 'Ports', field: 'ports', align: 'left' },
];

async function refresh() {
  topology.data.value = await api.networkTopology(true);
  topology.state.value = 'ready';
}

function shortService(serviceName: string): string {
  return serviceName.split('.').slice(3).join('.') || serviceName;
}
</script>

<template>
  <q-page padding>
    <PageHeader
      title="Network"
      subtitle="How this stack's VPC is wired, read live from AWS. Read-only — the topology is owned by CDK, so changes belong in a deploy, not here."
    >
      <template #actions>
        <q-btn
          outline
          color="primary"
          icon="refresh"
          label="Refresh"
          :loading="topology.state.value === 'loading'"
          @click="refresh"
          />
      </template>
    </PageHeader>

    <AsyncValue :state="topology.state.value" :error="topology.error.value">
      <!-- Findings first: what the reader should act on, before the detail. -->
      <q-card v-if="topology.data.value?.findings.length" flat bordered class="q-mb-md">
        <q-card-section class="q-pb-none">
          <div class="text-caption text-grey-7 text-uppercase text-weight-medium">Findings</div>
        </q-card-section>
        <q-list separator>
          <q-item v-for="finding in topology.data.value.findings" :key="finding.title">
            <q-item-section avatar>
              <q-chip
                dense
                square
                :color="severityColor[finding.severity] ?? 'grey-7'"
                text-color="white"
                class="text-capitalize"
              >
                {{ finding.severity }}
              </q-chip>
            </q-item-section>
            <q-item-section>
              <q-item-label class="text-weight-medium">{{ finding.title }}</q-item-label>
              <q-item-label caption>{{ finding.detail }}</q-item-label>
            </q-item-section>
          </q-item>
        </q-list>
      </q-card>

      <q-card flat bordered class="q-mb-md">
        <q-card-section>
          <div class="text-caption text-grey-7 text-uppercase text-weight-medium">Topology</div>
          <div class="text-body2 text-grey-7 q-mt-xs q-mb-md">
            Tiers are classified by what each subnet's route table does with
            <code>0.0.0.0/0</code> — not by what the subnet is named. Click a subnet for its
            routes.
          </div>
          <div class="scroll-x">
            <NetworkDiagram
              v-if="topology.data.value"
              :topology="topology.data.value"
              @select="selectedSubnetId = $event"
            />
          </div>
        </q-card-section>
      </q-card>

      <div class="row q-col-gutter-md">
        <!-- Routes -->
        <div class="col-12 col-md-6">
          <SectionCard :title="selectedSubnet ? `Routes · ${selectedSubnet.name}` : 'Route table'" flush>
            <q-card-section v-if="!selectedSubnet" class="text-body2 text-grey-7">
              Select a subnet in the diagram to see its route table.
            </q-card-section>

            <template v-else>
              <q-list dense class="q-px-md q-pt-sm">
                <q-item class="q-px-none">
                  <q-item-section>
                    <q-item-label caption>Subnet</q-item-label>
                    <q-item-label class="mono">{{ selectedSubnet.id }}</q-item-label>
                  </q-item-section>
                  <q-item-section>
                    <q-item-label caption>Route table</q-item-label>
                    <q-item-label class="mono">{{ selectedSubnet.route_table_id }}</q-item-label>
                  </q-item-section>
                  <q-item-section side>
                    <q-item-label caption>Egress</q-item-label>
                    <q-item-label>{{ selectedSubnet.egress }}</q-item-label>
                  </q-item-section>
                </q-item>
              </q-list>

              <q-table
                flat
                dense
                :rows="selectedSubnet.routes"
                :columns="routeColumns"
                row-key="destination"
                hide-pagination
                :rows-per-page-options="[0]"
                class="q-mt-sm"
              >
                <template #body-cell-destination="props">
                  <q-td :props="props" class="mono">{{ props.value }}</q-td>
                </template>
                <template #body-cell-target="props">
                  <q-td :props="props" class="mono">{{ props.value }}</q-td>
                </template>
                <template #body-cell-target_type="props">
                  <q-td :props="props" class="text-grey-7">{{ props.value }}</q-td>
                </template>
              </q-table>
            </template>
          </SectionCard>
        </div>

        <!-- Allowed flows -->
        <div class="col-12 col-md-6">
          <q-card flat bordered>
            <q-card-section>
              <div class="text-caption text-grey-7 text-uppercase text-weight-medium">
                Allowed flows
              </div>
              <div class="text-body2 text-grey-7 q-mt-xs">
                Security group rules that reference another group, read as who may reach whom.
              </div>
            </q-card-section>
            <q-card-section v-if="flows.length === 0" class="text-body2 text-grey-7 q-pt-none">
              No group-to-group rules.
            </q-card-section>
            <q-list v-else separator dense>
              <q-item v-for="(flow, index) in flows" :key="index">
                <q-item-section>
                  <div class="row items-center q-gutter-xs text-body2">
                    <span class="text-weight-medium">{{ flow.from }}</span>
                    <q-icon name="arrow_forward" size="14px" class="text-grey-6" />
                    <q-badge outline color="primary" :label="`${flow.protocol}/${flow.ports}`" />
                    <q-icon name="arrow_forward" size="14px" class="text-grey-6" />
                    <span class="text-weight-medium">{{ flow.to }}</span>
                  </div>
                  <q-item-label v-if="flow.description" caption>{{ flow.description }}</q-item-label>
                </q-item-section>
              </q-item>
            </q-list>
          </q-card>
        </div>

        <!-- VPC endpoints -->
        <div class="col-12 col-md-6">
          <q-card flat bordered>
            <q-card-section>
              <div class="text-caption text-grey-7 text-uppercase text-weight-medium">
                VPC endpoints
              </div>
              <div class="text-body2 text-grey-7 q-mt-xs">
                AWS services reachable without leaving the VPC. Everything else goes out through
                the NAT gateway.
              </div>
            </q-card-section>
            <q-card-section
              v-if="!topology.data.value?.endpoints.length"
              class="text-body2 text-grey-7 q-pt-none"
            >
              No VPC endpoints — every AWS API call leaves through the NAT gateway.
            </q-card-section>
            <q-list v-else dense separator>
              <q-item v-for="endpoint in topology.data.value.endpoints" :key="endpoint.id">
                <q-item-section>
                  <q-item-label class="text-weight-medium">
                    {{ shortService(endpoint.service) }}
                  </q-item-label>
                  <q-item-label caption>{{ endpoint.type }}</q-item-label>
                </q-item-section>
              </q-item>
            </q-list>
          </q-card>
        </div>

        <!-- Outside the VPC -->
        <div class="col-12 col-md-6">
          <q-card flat bordered>
            <q-card-section>
              <div class="text-caption text-grey-7 text-uppercase text-weight-medium">
                Outside the VPC
              </div>
              <div class="text-body2 text-grey-7 q-mt-xs">
                These functions have no VPC attachment, so they reach AWS APIs directly but
                cannot reach Aurora or Valkey.
              </div>
            </q-card-section>
            <q-card-section
              v-if="!topology.data.value?.outside_vpc.length"
              class="text-body2 text-grey-7 q-pt-none"
            >
              Every function runs inside the VPC.
            </q-card-section>
            <q-list v-else dense>
              <q-item v-for="item in topology.data.value.outside_vpc" :key="item.name">
                <q-item-section class="mono">{{ item.name }}</q-item-section>
              </q-item>
            </q-list>
          </q-card>
        </div>
      </div>

      <q-card v-if="cidrRules.length" flat bordered class="q-mt-md">
        <q-card-section class="q-pb-none">
          <div class="text-caption text-grey-7 text-uppercase text-weight-medium">
            CIDR-based rules
          </div>
        </q-card-section>
        <q-table
          flat
          dense
          :rows="cidrRules"
          :columns="cidrColumns"
          row-key="peer"
          :rows-per-page-options="[10, 25, 0]"
        >
          <template #body-cell-peer="props">
            <q-td :props="props" class="mono">{{ props.value }}</q-td>
          </template>
        </q-table>
      </q-card>
    </AsyncValue>
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

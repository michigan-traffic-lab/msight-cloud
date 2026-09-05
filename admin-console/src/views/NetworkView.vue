<script setup lang="ts">
import { computed, ref } from 'vue';
import { api, type NetworkTopology } from '@/api/client';
import { useAsyncValue } from '@/composables/useAsyncValue';
import AsyncValue from '@/components/AsyncValue.vue';
import NetworkDiagram from '@/components/NetworkDiagram.vue';

const topology = useAsyncValue<NetworkTopology>(
  (signal) => api.networkTopology(false, signal),
  { timeoutMs: 25000 }
);

const selectedSubnetId = ref<string | null>(null);

const selectedSubnet = computed(() =>
  topology.data.value?.subnets.find((subnet) => subnet.id === selectedSubnetId.value) ?? null
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

const severityType: Record<string, string> = {
  critical: 'danger',
  warning: 'warning',
  info: 'info',
};

async function refresh() {
  topology.data.value = await api.networkTopology(true);
  topology.state.value = 'ready';
}

function shortService(serviceName: string): string {
  return serviceName.split('.').slice(3).join('.') || serviceName;
}
</script>

<template>
  <div>
    <div class="header">
      <div>
        <h1 class="page-title">Network</h1>
        <p class="page-subtitle">
          How this stack's VPC is wired, read live from AWS. Read-only — the topology is
          owned by CDK, so changes belong in a deploy, not here.
        </p>
      </div>
      <el-button :icon="'Refresh'" :loading="topology.state.value === 'loading'" @click="refresh">
        Refresh
      </el-button>
    </div>

    <AsyncValue :state="topology.state.value" :error="topology.error.value">
      <!-- Findings first: what the reader should act on, before the detail. -->
      <section v-if="topology.data.value?.findings.length" class="card findings">
        <h2 class="card__title">Findings</h2>
        <div
          v-for="finding in topology.data.value.findings"
          :key="finding.title"
          class="finding"
          :class="`finding--${finding.severity}`"
        >
          <el-tag :type="severityType[finding.severity]" size="small" effect="light">
            {{ finding.severity }}
          </el-tag>
          <div>
            <div class="finding__title">{{ finding.title }}</div>
            <div class="finding__detail">{{ finding.detail }}</div>
          </div>
        </div>
      </section>

      <section class="card">
        <h2 class="card__title">Topology</h2>
        <p class="card__lede">
          Tiers are classified by what each subnet's route table does with
          <code>0.0.0.0/0</code> — not by what the subnet is named. Click a subnet for its
          routes.
        </p>
        <NetworkDiagram
          v-if="topology.data.value"
          :topology="topology.data.value"
          @select="selectedSubnetId = $event"
        />
      </section>

      <div class="grid">
        <section class="card">
          <h2 class="card__title">
            {{ selectedSubnet ? `Routes · ${selectedSubnet.name}` : 'Route table' }}
          </h2>

          <div v-if="!selectedSubnet" class="empty">
            Select a subnet in the diagram to see its route table.
          </div>

          <template v-else>
            <div class="kv">
              <div class="kv__key">Subnet</div>
              <div class="kv__value mono">{{ selectedSubnet.id }}</div>
              <div class="kv__key">Route table</div>
              <div class="kv__value mono">{{ selectedSubnet.route_table_id }}</div>
              <div class="kv__key">Egress</div>
              <div class="kv__value">{{ selectedSubnet.egress }}</div>
            </div>

            <table class="rules">
              <thead>
                <tr>
                  <th>Destination</th>
                  <th>Target</th>
                  <th>Via</th>
                </tr>
              </thead>
              <tbody>
                <tr v-for="route in selectedSubnet.routes" :key="route.destination + route.target">
                  <td class="mono">{{ route.destination }}</td>
                  <td class="mono">{{ route.target }}</td>
                  <td class="muted">{{ route.target_type }}</td>
                </tr>
              </tbody>
            </table>
          </template>
        </section>

        <section class="card">
          <h2 class="card__title">Allowed flows</h2>
          <p class="card__lede">
            Security group rules that reference another group, read as who may reach whom.
          </p>

          <div v-if="flows.length === 0" class="empty">No group-to-group rules.</div>
          <ul v-else class="flows">
            <li v-for="(flow, index) in flows" :key="index" class="flow">
              <span class="flow__node">{{ flow.from }}</span>
              <span class="flow__arrow">
                →
                <span class="flow__port">{{ flow.protocol }}/{{ flow.ports }}</span>
              </span>
              <span class="flow__node">{{ flow.to }}</span>
            </li>
          </ul>
        </section>

        <section class="card">
          <h2 class="card__title">VPC endpoints</h2>
          <p class="card__lede">
            AWS services reachable without leaving the VPC. Everything else goes out through
            the NAT gateway.
          </p>
          <div v-if="!topology.data.value?.endpoints.length" class="empty">
            No VPC endpoints — every AWS API call leaves through the NAT gateway.
          </div>
          <ul v-else class="plain">
            <li v-for="endpoint in topology.data.value.endpoints" :key="endpoint.id">
              <strong>{{ shortService(endpoint.service) }}</strong>
              <span class="muted"> · {{ endpoint.type }}</span>
            </li>
          </ul>
        </section>

        <section class="card">
          <h2 class="card__title">Outside the VPC</h2>
          <p class="card__lede">
            These functions have no VPC attachment, so they reach AWS APIs directly but cannot
            reach Aurora or Valkey.
          </p>
          <div v-if="!topology.data.value?.outside_vpc.length" class="empty">
            Every function runs inside the VPC.
          </div>
          <ul v-else class="plain">
            <li v-for="item in topology.data.value.outside_vpc" :key="item.name" class="mono small">
              {{ item.name }}
            </li>
          </ul>
        </section>
      </div>

      <section v-if="cidrRules.length" class="card">
        <h2 class="card__title">CIDR-based rules</h2>
        <table class="rules">
          <thead>
            <tr>
              <th>Group</th>
              <th>Direction</th>
              <th>Peer</th>
              <th>Protocol</th>
              <th>Ports</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="(rule, index) in cidrRules" :key="index">
              <td>{{ rule.group }}</td>
              <td class="muted">{{ rule.direction }}</td>
              <td class="mono" :class="{ open: rule.peer === '0.0.0.0/0' }">{{ rule.peer }}</td>
              <td class="muted">{{ rule.protocol }}</td>
              <td class="mono">{{ rule.ports }}</td>
            </tr>
          </tbody>
        </table>
      </section>

      <p class="timestamp">
        Read {{ new Date(topology.data.value!.fetched_at).toLocaleString() }}
        <template v-if="topology.data.value!.cached"> · served from cache</template>
      </p>
    </AsyncValue>
  </div>
</template>

<style scoped>
.header {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 16px;
}

.card + .card,
.grid + .card,
.card + .grid {
  margin-top: 16px;
}

.card__lede {
  margin: -6px 0 16px;
  font-size: 12px;
  color: var(--text-muted);
  line-height: 1.6;
}

.card__lede code {
  background: var(--page-bg);
  padding: 1px 5px;
  border-radius: 4px;
}

.grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(340px, 1fr));
  gap: 16px;
}

.findings {
  border-left: 3px solid var(--warn);
}

.finding {
  display: flex;
  gap: 12px;
  align-items: flex-start;
  padding: 12px 0;
  border-top: 1px solid var(--border);
}

.finding:first-of-type {
  border-top: none;
  padding-top: 0;
}

.finding__title {
  font-size: 13px;
  font-weight: 650;
  margin-bottom: 3px;
}

.finding__detail {
  font-size: 12px;
  color: var(--text-muted);
  line-height: 1.6;
}

.rules {
  width: 100%;
  border-collapse: collapse;
  margin-top: 14px;
}

.rules th {
  font-size: 10px;
  font-weight: 700;
  letter-spacing: 0.06em;
  text-transform: uppercase;
  color: var(--text-muted);
  text-align: left;
  padding-bottom: 7px;
  border-bottom: 1px solid var(--border);
}

.rules td {
  padding: 8px 10px 8px 0;
  font-size: 12px;
  border-bottom: 1px solid var(--border);
}

.rules .open {
  color: var(--bad);
  font-weight: 600;
}

.flows {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.flow {
  display: flex;
  align-items: center;
  gap: 10px;
  font-size: 12px;
  flex-wrap: wrap;
}

.flow__node {
  background: var(--page-bg);
  border: 1px solid var(--border);
  border-radius: 6px;
  padding: 4px 9px;
  font-weight: 550;
}

.flow__arrow {
  color: var(--text-muted);
  display: inline-flex;
  align-items: center;
  gap: 6px;
}

.flow__port {
  font-size: 10.5px;
  background: var(--page-bg);
  border-radius: 4px;
  padding: 1px 5px;
}

.plain {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 7px;
  font-size: 13px;
}

.small {
  font-size: 11px;
}

.muted {
  color: var(--text-muted);
}

.timestamp {
  margin-top: 20px;
  font-size: 12px;
  color: var(--text-muted);
}
</style>

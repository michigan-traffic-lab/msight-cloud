<script setup lang="ts">
import { computed } from 'vue';
import type { NetworkSubnet, NetworkTopology, SubnetTier } from '@/api/client';

const props = defineProps<{ topology: NetworkTopology }>();
const emit = defineEmits<{ (event: 'select', subnetId: string | null): void }>();

/**
 * Tiers are rendered top-to-bottom by how exposed they are, which is also the
 * order traffic flows inward from the internet. Each band's meaning comes from
 * the tier the backend derived from route tables, never from subnet names.
 */
const TIER_ORDER: SubnetTier[] = ['public', 'private-egress', 'isolated'];

const TIER_META: Record<SubnetTier, { label: string; hint: string; accent: string }> = {
  public: {
    label: 'Public',
    hint: 'Reachable from the internet, and can reach out directly',
    accent: '#eb6834',
  },
  'private-egress': {
    label: 'Private, with egress',
    hint: 'Not reachable from outside; can start outbound connections',
    accent: '#2a78d6',
  },
  isolated: {
    label: 'Isolated',
    hint: 'No route off the VPC in either direction',
    accent: '#8b8b86',
  },
};

const azs = computed(() => props.topology.vpc.azs);

/** Bands present in this VPC, in exposure order, with an empty-cell grid per AZ. */
const bands = computed(() =>
  TIER_ORDER.map((tier) => ({
    tier,
    meta: TIER_META[tier],
    cells: azs.value.map((az) => ({
      az,
      subnets: props.topology.subnets.filter(
        (subnet) => subnet.tier === tier && subnet.az === az
      ),
    })),
  })).filter((band) => band.cells.some((cell) => cell.subnets.length > 0))
);

/** The AZ each band depends on for egress, when that dependency is a single point. */
function egressNote(tier: SubnetTier): string | null {
  if (tier === 'public') {
    return props.topology.internet_gateways.length > 0 ? 'via internet gateway' : null;
  }
  if (tier === 'private-egress') {
    const nat = props.topology.nat_gateways[0];
    return nat ? `via NAT gateway in ${nat.az}` : null;
  }
  return null;
}

function totalResources(subnet: NetworkSubnet): number {
  return subnet.resources.reduce((sum, resource) => sum + resource.count, 0);
}
</script>

<template>
  <div class="diagram">
    <!-- Internet sits outside the VPC boundary, so it is drawn outside the frame. -->
    <div class="cloud">
      <span class="cloud__dot" />
      Internet
    </div>

    <div class="vpc">
      <div class="vpc__header">
        <span class="vpc__title">{{ topology.vpc.id }}</span>
        <span class="vpc__cidr mono">{{ topology.vpc.cidr }}</span>
      </div>

      <div class="az-header" :style="{ gridTemplateColumns: `140px repeat(${azs.length}, 1fr)` }">
        <span />
        <span v-for="az in azs" :key="az" class="az-header__label">{{ az }}</span>
      </div>

      <div v-for="(band, index) in bands" :key="band.tier" class="band">
        <div v-if="index > 0 || band.tier !== 'public'" class="band__link">
          <span v-if="egressNote(band.tier)" class="band__link-label">
            ↑ {{ egressNote(band.tier) }}
          </span>
          <span v-else class="band__link-label band__link-label--none">no egress</span>
        </div>

        <div
          class="band__grid"
          :style="{ gridTemplateColumns: `140px repeat(${azs.length}, 1fr)` }"
        >
          <div class="band__label">
            <span class="band__swatch" :style="{ background: band.meta.accent }" />
            <span class="band__name">{{ band.meta.label }}</span>
            <span class="band__hint">{{ band.meta.hint }}</span>
          </div>

          <div v-for="cell in band.cells" :key="cell.az" class="band__cell">
            <div
              v-for="subnet in cell.subnets"
              :key="subnet.id"
              class="subnet"
              :style="{ borderTopColor: band.meta.accent }"
              tabindex="0"
              role="button"
              :aria-label="`${subnet.name}, ${subnet.cidr}, ${totalResources(subnet)} resources`"
              @click="emit('select', subnet.id)"
              @keydown.enter.prevent="emit('select', subnet.id)"
            >
              <div class="subnet__cidr mono">{{ subnet.cidr }}</div>
              <div class="subnet__name">{{ subnet.name }}</div>

              <ul v-if="subnet.resources.length" class="chips">
                <li v-for="resource in subnet.resources" :key="resource.name" class="chip">
                  <span class="chip__count">{{ resource.count }}</span>
                  {{ resource.name }}
                </li>
              </ul>
              <div v-else class="subnet__empty">No resources</div>

              <div class="subnet__foot">{{ subnet.available_ips.toLocaleString() }} IPs free</div>
            </div>

            <div v-if="cell.subnets.length === 0" class="subnet subnet--absent">
              <span>Not present in {{ cell.az }}</span>
            </div>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.diagram {
  display: flex;
  flex-direction: column;
  align-items: stretch;
}

.cloud {
  align-self: center;
  display: inline-flex;
  align-items: center;
  gap: 8px;
  font-size: 12px;
  font-weight: 600;
  color: var(--text-muted);
  padding-bottom: 6px;
}

.cloud__dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: var(--text-muted);
}

.vpc {
  border: 1.5px dashed var(--border);
  border-radius: 12px;
  padding: 14px;
  background: var(--page-bg);
}

.vpc__header {
  display: flex;
  align-items: baseline;
  gap: 10px;
  margin-bottom: 12px;
}

.vpc__title {
  font-size: 12px;
  font-weight: 700;
  letter-spacing: 0.04em;
  text-transform: uppercase;
  color: var(--text-muted);
}

.vpc__cidr {
  color: var(--text-muted);
}

.az-header {
  display: grid;
  gap: 10px;
  margin-bottom: 6px;
}

.az-header__label {
  font-size: 10px;
  font-weight: 700;
  letter-spacing: 0.08em;
  text-transform: uppercase;
  color: var(--text-muted);
  text-align: center;
}

.band__link {
  display: flex;
  justify-content: center;
  padding: 4px 0;
}

.band__link-label {
  font-size: 11px;
  color: var(--accent);
  font-weight: 600;
}

.band__link-label--none {
  color: var(--text-muted);
}

.band__grid {
  display: grid;
  gap: 10px;
  align-items: stretch;
}

.band__label {
  display: flex;
  flex-direction: column;
  justify-content: center;
  gap: 3px;
  padding-right: 6px;
}

.band__swatch {
  width: 22px;
  height: 3px;
  border-radius: 2px;
}

.band__name {
  font-size: 12px;
  font-weight: 650;
}

.band__hint {
  font-size: 10px;
  line-height: 1.35;
  color: var(--text-muted);
}

.band__cell {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.subnet {
  background: var(--card-bg);
  border: 1px solid var(--border);
  border-top: 3px solid var(--border);
  border-radius: 8px;
  padding: 10px 11px;
  cursor: pointer;
  transition: box-shadow 0.12s ease, transform 0.12s ease;
  outline: none;
}

.subnet:hover,
.subnet:focus-visible {
  box-shadow: var(--shadow);
  transform: translateY(-1px);
}

.subnet--absent {
  border-style: dashed;
  border-top-color: var(--border);
  color: var(--text-muted);
  font-size: 11px;
  display: flex;
  align-items: center;
  justify-content: center;
  cursor: default;
  background: transparent;
  min-height: 68px;
}

.subnet--absent:hover {
  box-shadow: none;
  transform: none;
}

.subnet__cidr {
  font-size: 12px;
  font-weight: 600;
  color: var(--text);
}

.subnet__name {
  font-size: 10px;
  color: var(--text-muted);
  margin-top: 1px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.chips {
  list-style: none;
  margin: 9px 0 0;
  padding: 0;
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
}

.chip {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  font-size: 10.5px;
  background: var(--page-bg);
  border: 1px solid var(--border);
  border-radius: 5px;
  padding: 2px 6px;
}

.chip__count {
  font-weight: 700;
  color: var(--text);
}

.subnet__empty {
  margin-top: 9px;
  font-size: 10.5px;
  color: var(--text-muted);
}

.subnet__foot {
  margin-top: 8px;
  font-size: 10px;
  color: var(--text-muted);
}

@media (prefers-reduced-motion: reduce) {
  .subnet {
    transition: none;
  }
  .subnet:hover,
  .subnet:focus-visible {
    transform: none;
  }
}
</style>

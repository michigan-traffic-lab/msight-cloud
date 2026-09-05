import type { AdminRole } from '@/api/client';

/**
 * Single source of truth for the console's feature surface.
 *
 * The router, the sidebar, and the placeholder pages are all generated from
 * this list, so adding, reordering, or re-gating a page is one edit here.
 *
 * When a feature's backend lands, flip `status` to 'ready' and point
 * `component` at the real view. Nothing else needs to change.
 */
export interface FeatureDef {
  /** Route name and sidebar key. */
  name: string;
  /** Path relative to the layout root. */
  path: string;
  /** Sidebar label — keep it short. */
  label: string;
  /** Heading shown on the page and in the top bar. */
  title: string;
  /** Element Plus icon component name. */
  icon: string;
  /** Minimum role required to see and open the page. */
  minRole: AdminRole;
  subtitle: string;
  status: 'ready' | 'planned';
  /** Capabilities the finished page will have. Shown on placeholders. */
  planned?: string[];
  /** Backend routes the page will call, for planning the Lambda work. */
  apiRoutes?: string[];
  /** Anything that constrains how the backend gets built. */
  backendNote?: string;
  component?: () => Promise<unknown>;
}

export interface FeatureGroup {
  label: string;
  features: FeatureDef[];
}

const placeholder = () => import('@/views/PlaceholderView.vue');

export const FEATURE_GROUPS: FeatureGroup[] = [
  {
    label: 'Monitoring',
    features: [
      {
        name: 'overview',
        path: 'overview',
        label: 'Overview',
        title: 'Cloud overview',
        icon: 'DataBoard',
        minRole: 'viewer',
        subtitle: 'Live status of the MSight cloud stack and its public endpoints.',
        status: 'ready',
        component: () => import('@/views/OverviewView.vue'),
      },
      {
        name: 'sensors',
        path: 'sensors',
        label: 'Sensors',
        title: 'Sensors',
        icon: 'Cpu',
        minRole: 'viewer',
        subtitle:
          'Configured sensors, their ingest queues, and how to connect a field device to the topic.',
        status: 'ready',
        component: () => import('@/views/SensorsView.vue'),
      },
      {
        name: 'clients',
        path: 'clients',
        label: 'Live clients',
        title: 'Live clients',
        icon: 'Connection',
        minRole: 'viewer',
        subtitle: 'WebSocket connections currently served, and what each one subscribes to.',
        status: 'ready',
        component: () => import('@/views/LiveClientsView.vue'),
      },
      {
        name: 'logs',
        path: 'logs',
        label: 'Logs',
        title: 'Logs',
        icon: 'Document',
        minRole: 'operator',
        subtitle: 'Search and tail CloudWatch logs across every component of the stack.',
        status: 'ready',
        component: () => import('@/views/LogsView.vue'),
      },
    ],
  },
  {
    label: 'Database',
    features: [
      {
        name: 'aurora',
        path: 'database/aurora',
        label: 'Aurora',
        title: 'Aurora PostgreSQL',
        icon: 'Coin',
        minRole: 'operator',
        subtitle:
          'The durable store behind maps, client records, and everything that must survive a restart.',
        status: 'ready',
        component: () => import('@/views/AuroraView.vue'),
      },
      {
        name: 'valkey',
        path: 'database/valkey',
        label: 'Valkey',
        title: 'Valkey cache',
        icon: 'Lightning',
        minRole: 'operator',
        subtitle:
          'The ElastiCache cluster holding live client state, reported locations, and hot lookups.',
        status: 'ready',
        component: () => import('@/views/ValkeyView.vue'),
      },
    ],
  },
  {
    label: 'Data',
    features: [
      {
        name: 'maps',
        path: 'maps',
        label: 'Maps',
        title: 'Intersection maps',
        icon: 'MapLocation',
        minRole: 'operator',
        subtitle: 'Decoded J2735 MAP geometry, drawn and checked for consistency.',
        status: 'ready',
        component: () => import('@/views/MapsView.vue'),
      },
    ],
  },
  {
    label: 'Infrastructure',
    features: [
      {
        name: 'network',
        path: 'network',
        label: 'Network',
        title: 'Network',
        icon: 'Share',
        minRole: 'operator',
        subtitle:
          'How the VPC is wired: subnets, routing, security groups, endpoints, and what can actually reach what.',
        status: 'ready',
        component: () => import('@/views/NetworkView.vue'),
      },
    ],
  },
  {
    label: 'Administration',
    features: [
      {
        name: 'users',
        path: 'users',
        label: 'Users',
        title: 'Users',
        icon: 'User',
        minRole: 'admin',
        subtitle:
          'Console accounts and their access levels. There is no self-registration — every account is created here.',
        status: 'ready',
        component: () => import('@/views/UsersView.vue'),
      },
      {
        name: 'cost',
        path: 'cost',
        label: 'Cost',
        title: 'Cost breakdown',
        icon: 'Money',
        minRole: 'admin',
        subtitle: 'What the stack costs, broken down by component.',
        status: 'ready',
        component: () => import('@/views/CostView.vue'),
      },
    ],
  },
];

/** Flat list, in sidebar order. */
export const ALL_FEATURES: FeatureDef[] = FEATURE_GROUPS.flatMap((group) => group.features);

/** Every planned feature resolves to the shared placeholder view. */
export function componentFor(feature: FeatureDef): () => Promise<unknown> {
  return feature.status === 'ready' && feature.component ? feature.component : placeholder;
}

export function findFeature(name: string): FeatureDef | undefined {
  return ALL_FEATURES.find((feature) => feature.name === name);
}

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
  /** Material Icons name, from Quasar's default icon set. */
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

const placeholder = () => import('@/pages/PlaceholderPage.vue');

export const FEATURE_GROUPS: FeatureGroup[] = [
  {
    label: 'Monitoring',
    features: [
      {
        name: 'overview',
        path: 'overview',
        label: 'Overview',
        title: 'Cloud overview',
        icon: 'dashboard',
        minRole: 'viewer',
        subtitle: 'Live status of the MSight cloud stack and its public endpoints.',
        status: 'ready',
        component: () => import('@/pages/OverviewPage.vue'),
      },
      {
        name: 'sensors',
        path: 'sensors',
        label: 'Sensors',
        title: 'Sensors',
        icon: 'sensors',
        minRole: 'viewer',
        subtitle:
          'Register sensors, watch their ingest queues, and connect a field device to the topic.',
        status: 'ready',
        component: () => import('@/pages/SensorsPage.vue'),
      },
      {
        name: 'apps',
        path: 'apps',
        label: 'Apps',
        title: 'Apps',
        icon: 'apps',
        minRole: 'viewer',
        subtitle:
          'Consumer fleets and what each one is subscribed to receive: SDSM, SPaT, critical SPaT.',
        status: 'ready',
        component: () => import('@/pages/AppsPage.vue'),
      },
      {
        name: 'clients',
        path: 'clients',
        label: 'Live clients',
        title: 'Live clients',
        icon: 'device_hub',
        minRole: 'viewer',
        subtitle: 'WebSocket connections currently served, and what each one subscribes to.',
        status: 'ready',
        component: () => import('@/pages/LiveClientsPage.vue'),
      },
      {
        name: 'logs',
        path: 'logs',
        label: 'Logs',
        title: 'Logs',
        icon: 'description',
        minRole: 'operator',
        subtitle: 'Search and tail CloudWatch logs across every component of the stack.',
        status: 'ready',
        component: () => import('@/pages/LogsPage.vue'),
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
        icon: 'storage',
        minRole: 'operator',
        subtitle:
          'The durable store behind maps, client records, and everything that must survive a restart.',
        status: 'ready',
        component: () => import('@/pages/AuroraPage.vue'),
      },
      {
        name: 'valkey',
        path: 'database/valkey',
        label: 'Valkey',
        title: 'Valkey cache',
        icon: 'bolt',
        minRole: 'operator',
        subtitle:
          'The ElastiCache cluster holding live client state, reported locations, and hot lookups.',
        status: 'ready',
        component: () => import('@/pages/ValkeyPage.vue'),
      },
    ],
  },
  {
    label: 'Data',
    features: [
      {
        name: 'storage',
        path: 'storage',
        label: 'Storage',
        title: 'Storage',
        icon: 'inventory_2',
        minRole: 'viewer',
        subtitle:
          'S3 buckets holding aggregated sensor data, and what each sensor has uploaded.',
        status: 'ready',
        component: () => import('@/pages/StoragePage.vue'),
      },
      {
        name: 'maps',
        path: 'maps',
        label: 'Maps',
        title: 'Intersection maps',
        icon: 'map',
        minRole: 'operator',
        subtitle: 'Decoded J2735 MAP geometry, drawn and checked for consistency.',
        status: 'ready',
        component: () => import('@/pages/MapsPage.vue'),
      },
    ],
  },
  {
    label: 'Infrastructure',
    features: [
      {
        name: 'clusters',
        path: 'clusters',
        label: 'Clusters',
        title: 'Compute clusters',
        // Classic Material Icons only — see the note on the Services icon
        // below for why a Symbols-only name wrecks the sidebar row.
        icon: 'storage',
        minRole: 'operator',
        subtitle:
          'Where microservice containers run: Fargate, or a pool of EC2 instances. Only EC2 can have GPUs.',
        status: 'ready',
        component: () => import('@/pages/ClustersPage.vue'),
      },
      {
        name: 'microservices',
        path: 'microservices',
        // Shortest label in the sidebar's 248px column; the page heading below
        // still says Microservices in full.
        label: 'Services',
        title: 'Microservices',
        // Must exist in the classic Material Icons font, which is the set
        // quasar.config loads. `deployed_code` is Material *Symbols* only, and
        // a name the font does not have renders as its literal ligature text —
        // a run of glyphs that overflows the 32px icon column and wrecks the
        // row. Every other icon in this file is a classic name; keep it that way.
        icon: 'dns',
        // Operator rather than viewer: this page shows which GitHub account the
        // deployment is attached to and what it was granted, which is
        // operational rather than onboarding information. Every mutation on it
        // is admin-gated independently, in the API.
        minRole: 'operator',
        subtitle:
          'Services built from a GitHub repository\'s own Dockerfile, and the one-time App ' +
          'installation that grants access to it.',
        status: 'ready',
        component: () => import('@/pages/MicroservicesPage.vue'),
      },
      {
        name: 'network',
        path: 'network',
        label: 'Network',
        title: 'Network',
        icon: 'lan',
        minRole: 'operator',
        subtitle:
          'How the VPC is wired: subnets, routing, security groups, endpoints, and what can actually reach what.',
        status: 'ready',
        component: () => import('@/pages/NetworkPage.vue'),
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
        icon: 'group',
        minRole: 'admin',
        subtitle:
          'Console accounts and their access levels. There is no self-registration — every account is created here.',
        status: 'ready',
        component: () => import('@/pages/UsersPage.vue'),
      },
      {
        name: 'cost',
        path: 'cost',
        label: 'Cost',
        title: 'Cost breakdown',
        icon: 'payments',
        minRole: 'admin',
        subtitle: 'What the stack costs, broken down by component.',
        status: 'ready',
        component: () => import('@/pages/CostPage.vue'),
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

import type { RouteComponent, RouteRecordRaw } from 'vue-router';
import { ALL_FEATURES, componentFor } from '@/features';

/**
 * Feature routes are generated from the registry in features.ts, so a new page
 * is one entry there rather than an edit in three files.
 */
const featureRoutes: RouteRecordRaw[] = ALL_FEATURES.map((feature) => ({
  path: feature.path,
  name: feature.name,
  component: componentFor(feature) as () => Promise<RouteComponent>,
  meta: { title: feature.title, minRole: feature.minRole },
}));

const routes: RouteRecordRaw[] = [
  {
    // Wrapped in a layout because QPage must be a deep child of QLayout.
    path: '/login',
    component: () => import('@/layouts/BlankLayout.vue'),
    children: [
      {
        path: '',
        name: 'login',
        component: () => import('@/pages/LoginPage.vue'),
        meta: { public: true },
      },
    ],
  },
  {
    path: '/',
    component: () => import('@/layouts/AdminLayout.vue'),
    children: [{ path: '', redirect: '/overview' }, ...featureRoutes],
  },
  // Unknown paths land on the overview rather than a 404 page: every route in
  // this console is generated from the registry, so an unmatched path is a
  // stale bookmark rather than something the user can act on.
  { path: '/:catchAll(.*)*', redirect: '/overview' },
];

export default routes;

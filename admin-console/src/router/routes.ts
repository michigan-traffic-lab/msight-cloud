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
    children: [
      { path: '', redirect: '/overview' },
      ...featureRoutes,
      {
        /**
         * One microservice, in full.
         *
         * Not a feature, because it has no sidebar entry of its own: it is
         * reached by choosing a service from the list, and a sidebar link would
         * have nothing to point at. Its role floor matches the list it is
         * reached from.
         */
        path: 'microservices/:name',
        name: 'microservice',
        component: () => import('@/pages/MicroservicePage.vue'),
        meta: { title: 'Microservice', minRole: 'operator' },
      },
      {
        /**
         * The GitHub App, opened from Settings.
         *
         * Not a feature for the same reason the service page is not: it is
         * reached from a list rather than from the sidebar, and a second
         * top-level entry for one integration would crowd out everything
         * settings will hold later.
         */
        path: 'settings/github',
        name: 'github-settings',
        component: () => import('@/pages/GithubSettingsPage.vue'),
        meta: { title: 'GitHub App', minRole: 'operator' },
      },
      {
        // Not a feature, so it is written out here rather than generated: it has
        // no sidebar entry and is never navigated to from inside the console.
        // GitHub redirects the browser here after an App install, because a
        // redirect carries no Cognito token and so cannot land on the admin API.
        // Its path is registered as the App's Setup URL and is printed by the
        // stack as GithubAppSetupUrl — changing it breaks every future install.
        path: 'settings/github/callback',
        name: 'github-callback',
        component: () => import('@/pages/GithubCallbackPage.vue'),
        meta: { title: 'Connecting GitHub', minRole: 'admin' },
      },
    ],
  },
  // Unknown paths land on the overview rather than a 404 page: every route in
  // this console is generated from the registry, so an unmatched path is a
  // stale bookmark rather than something the user can act on.
  { path: '/:catchAll(.*)*', redirect: '/overview' },
];

export default routes;

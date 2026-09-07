import { defineRouter } from '#q-app';
import {
  createMemoryHistory,
  createRouter,
  createWebHashHistory,
  createWebHistory,
} from 'vue-router';
import type { AdminRole } from '@/api/client';
import { useAuthStore } from '@/stores/auth';

import routes from './routes';

export default defineRouter(({ store }) => {
  const createHistory = import.meta.env.QUASAR_SERVER
    ? createMemoryHistory
    : import.meta.env.QUASAR_VUE_ROUTER_MODE === 'history'
      ? createWebHistory
      : createWebHashHistory;

  const Router = createRouter({
    scrollBehavior: () => ({ left: 0, top: 0 }),
    routes,

    // Leave this as is and make changes in quasar.config.ts instead!
    // quasar.config.ts -> build -> vueRouterMode
    // quasar.config.ts -> build -> publicPath
    history: createHistory(import.meta.env.QUASAR_VUE_ROUTER_BASE),
  });

  Router.beforeEach(async (to) => {
    // The pinia instance is passed in explicitly: this guard can run before any
    // component has set the active store, and useAuthStore() would otherwise
    // have no instance to attach to.
    const auth = useAuthStore(store);
    await auth.restore();

    if (to.meta.public) {
      return auth.signedIn ? { name: 'overview' } : true;
    }

    if (!auth.signedIn) {
      return { name: 'login', query: { redirect: to.fullPath } };
    }

    // Under-privileged users are redirected rather than shown a dead page. The
    // API enforces the same rule independently — this is convenience, not the
    // security boundary.
    const minRole = to.meta.minRole;
    if (typeof minRole === 'string' && !auth.hasAtLeast(minRole as AdminRole)) {
      return { name: 'overview' };
    }

    return true;
  });

  return Router;
});

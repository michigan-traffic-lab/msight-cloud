import {
  createRouter,
  createWebHistory,
  type RouteComponent,
  type RouteRecordRaw,
} from 'vue-router';
import { useAuthStore } from '@/stores/auth';
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

const router = createRouter({
  history: createWebHistory(),
  routes: [
    {
      path: '/login',
      name: 'login',
      component: () => import('@/views/LoginView.vue'),
      meta: { public: true },
    },
    {
      path: '/',
      component: () => import('@/layouts/AdminLayout.vue'),
      children: [{ path: '', redirect: '/overview' }, ...featureRoutes],
    },
    { path: '/:pathMatch(.*)*', redirect: '/overview' },
  ],
});

router.beforeEach(async (to) => {
  const auth = useAuthStore();
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
  if (typeof minRole === 'string' && !auth.hasAtLeast(minRole as never)) {
    return { name: 'overview' };
  }

  return true;
});

export default router;

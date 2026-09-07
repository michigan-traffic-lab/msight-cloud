<script setup lang="ts">
import { computed } from 'vue';
import { useRoute, useRouter, RouterView, RouterLink } from 'vue-router';
import { ElMessageBox } from 'element-plus';
import { useAuthStore } from '@/stores/auth';
import BrandMark from '@/components/BrandMark.vue';
import { FEATURE_GROUPS } from '@/features';

const auth = useAuthStore();
const route = useRoute();
const router = useRouter();

/**
 * Sidebar is derived from the feature registry, filtered to what this role may
 * see. Groups that end up empty are dropped rather than rendered as a bare
 * heading.
 */
const visibleGroups = computed(() =>
  FEATURE_GROUPS.map((group) => ({
    label: group.label,
    features: group.features.filter((feature) => auth.hasAtLeast(feature.minRole)),
  })).filter((group) => group.features.length > 0)
);

const roleTagType = computed(() => {
  switch (auth.role) {
    case 'admin':
      return 'danger';
    case 'operator':
      return 'warning';
    default:
      return 'info';
  }
});

async function confirmSignOut() {
  try {
    await ElMessageBox.confirm('Sign out of the management console?', 'Sign out', {
      confirmButtonText: 'Sign out',
      cancelButtonText: 'Cancel',
      type: 'warning',
    });
  } catch {
    return;
  }
  auth.signOut();
  router.push({ name: 'login' });
}
</script>

<template>
  <div class="shell">
    <aside class="sidebar">
      <div class="brand">
        <BrandMark :size="36" />
        <div>
          <div class="brand__name">MSight Cloud</div>
          <div class="brand__sub">Management Console</div>
        </div>
      </div>

      <nav class="nav">
        <div v-for="group in visibleGroups" :key="group.label" class="nav__group">
          <div class="nav__heading">{{ group.label }}</div>
          <RouterLink
            v-for="item in group.features"
            :key="item.name"
            class="nav__item"
            :class="{ 'nav__item--active': route.name === item.name }"
            :to="{ name: item.name }"
          >
            <el-icon class="nav__icon"><component :is="item.icon" /></el-icon>
            <span class="nav__label">{{ item.label }}</span>
            <span v-if="item.status === 'planned'" class="nav__soon">soon</span>
          </RouterLink>
        </div>
      </nav>
    </aside>

    <div class="main">
      <header class="topbar">
        <div class="topbar__title">{{ route.meta.title ?? '' }}</div>
        <div class="topbar__user">
          <el-tag :type="roleTagType" size="small" effect="light" round>
            {{ auth.role ?? 'no role' }}
          </el-tag>
          <span class="topbar__username">{{ auth.me?.username }}</span>
          <el-button text :icon="'SwitchButton'" @click="confirmSignOut">Sign out</el-button>
        </div>
      </header>

      <main class="content">
        <RouterView />
      </main>
    </div>
  </div>
</template>

<style scoped>
.shell {
  display: flex;
  height: 100%;
}

.sidebar {
  width: 244px;
  flex-shrink: 0;
  background: var(--sidebar-bg);
  display: flex;
  flex-direction: column;
  padding: 20px 14px;
  overflow-y: auto;
}

.brand {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 4px 8px 20px;
}

.brand__name {
  color: #fff;
  font-weight: 650;
  font-size: 14px;
  line-height: 1.2;
}

.brand__sub {
  color: var(--sidebar-text);
  font-size: 11px;
  margin-top: 2px;
}

.nav {
  display: flex;
  flex-direction: column;
  gap: 18px;
}

.nav__group {
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.nav__heading {
  font-size: 10px;
  font-weight: 700;
  letter-spacing: 0.09em;
  text-transform: uppercase;
  color: #6f88a6;
  padding: 0 12px 6px;
}

.nav__item {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 9px 12px;
  border-radius: 8px;
  color: var(--sidebar-text);
  text-decoration: none;
  font-size: 14px;
  font-weight: 500;
  transition: background 0.15s ease, color 0.15s ease;
}

.nav__item:hover {
  background: var(--sidebar-bg-hover);
  color: var(--sidebar-text-active);
}

.nav__item--active {
  background: var(--sidebar-active);
  color: var(--sidebar-active-text);
  font-weight: 600;
}

.nav__icon {
  font-size: 16px;
  flex-shrink: 0;
}

.nav__label {
  flex: 1;
  min-width: 0;
}

.nav__soon {
  font-size: 9px;
  font-weight: 700;
  letter-spacing: 0.06em;
  text-transform: uppercase;
  color: #8ea6bf;
  border: 1px solid #2b4f74;
  border-radius: 4px;
  padding: 1px 5px;
}

.nav__item--active .nav__soon {
  color: var(--sidebar-active-text);
  border-color: #00274c55;
}

.main {
  flex: 1;
  display: flex;
  flex-direction: column;
  min-width: 0;
}

.topbar {
  height: 60px;
  flex-shrink: 0;
  background: var(--card-bg);
  border-bottom: 1px solid var(--border);
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 0 28px;
}

.topbar__title {
  font-weight: 600;
  font-size: 15px;
}

.topbar__user {
  display: flex;
  align-items: center;
  gap: 12px;
}

.topbar__username {
  font-size: 13px;
  color: var(--text-muted);
}

.content {
  flex: 1;
  overflow-y: auto;
  padding: 28px;
}
</style>

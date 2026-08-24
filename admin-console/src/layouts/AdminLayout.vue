<script setup lang="ts">
import { computed } from 'vue';
import { useRoute, useRouter, RouterView } from 'vue-router';
import { ElMessageBox } from 'element-plus';
import { useAuthStore } from '@/stores/auth';

const auth = useAuthStore();
const route = useRoute();
const router = useRouter();

/** New tabs are added here and in the router — nothing else needs to change. */
const navItems = computed(() =>
  [
    { name: 'overview', label: 'Overview', icon: 'DataBoard', adminOnly: false },
    { name: 'users', label: 'Users', icon: 'User', adminOnly: true },
  ].filter((item) => !item.adminOnly || auth.isAdmin)
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
        <div class="brand__mark">M</div>
        <div>
          <div class="brand__name">MSight Cloud</div>
          <div class="brand__sub">Management Console</div>
        </div>
      </div>

      <nav class="nav">
        <RouterLink
          v-for="item in navItems"
          :key="item.name"
          class="nav__item"
          :class="{ 'nav__item--active': route.name === item.name }"
          :to="{ name: item.name }"
        >
          <el-icon class="nav__icon"><component :is="item.icon" /></el-icon>
          <span>{{ item.label }}</span>
        </RouterLink>
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
}

.brand {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 4px 8px 24px;
}

.brand__mark {
  width: 36px;
  height: 36px;
  border-radius: 10px;
  background: linear-gradient(135deg, #2f6bff, #6c9bff);
  color: #fff;
  font-weight: 700;
  font-size: 18px;
  display: flex;
  align-items: center;
  justify-content: center;
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
  gap: 4px;
}

.nav__item {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 10px 12px;
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
  color: var(--sidebar-text-active);
}

.nav__icon {
  font-size: 16px;
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

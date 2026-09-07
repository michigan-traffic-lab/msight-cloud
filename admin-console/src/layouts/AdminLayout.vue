<script setup lang="ts">
import { computed, ref } from 'vue';
import { useQuasar } from 'quasar';
import { useRouter } from 'vue-router';
import { useAuthStore } from '@/stores/auth';
import BrandMark from '@/components/BrandMark.vue';
import { FEATURE_GROUPS } from '@/features';

const $q = useQuasar();
const auth = useAuthStore();
const router = useRouter();

/**
 * The entirety of the responsive navigation logic.
 *
 * QDrawer decides mobile vs desktop itself by comparing the layout width to its
 * `breakpoint`, and in mobile mode supplies the backdrop, the body scroll lock,
 * swipe-to-close and close-on-route-change. `show-if-above` pins it open on
 * desktop regardless of this value, so this ref only ever matters on a narrow
 * screen.
 */
const drawerOpen = ref(false);

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

const roleColor = computed(() => {
  switch (auth.role) {
    case 'admin':
      return 'negative';
    case 'operator':
      return 'warning';
    default:
      return 'blue-grey-5';
  }
});

function confirmSignOut() {
  $q.dialog({
    title: 'Sign out',
    message: 'Sign out of the management console?',
    cancel: { label: 'Cancel', flat: true, color: 'grey-8' },
    ok: { label: 'Sign out', color: 'primary', unelevated: true },
  }).onOk(() => {
    auth.signOut();
    void router.push({ name: 'login' });
  });
}
</script>

<template>
  <!-- hHh: the header spans the full width, above the drawer, so the brand sits
       in one place rather than being split across the two. -->
  <q-layout view="hHh LpR lFr">
    <q-header class="bg-primary text-white app-header">
      <q-toolbar class="app-header__bar">
        <!-- Only below the drawer's breakpoint. Above it the drawer is always
             on screen, so a toggle is a control with nothing to do — and it
             sits where the brand should start. Matches QDrawer's own breakpoint
             so the button appears exactly when the drawer goes off-canvas. -->
        <q-btn
          v-if="$q.screen.lt.md"
          flat
          dense
          round
          icon="menu"
          color="white"
          :aria-label="drawerOpen ? 'Close navigation' : 'Open navigation'"
          :aria-expanded="drawerOpen"
          @click="drawerOpen = !drawerOpen"
        >
          <q-tooltip>{{ drawerOpen ? 'Hide navigation' : 'Show navigation' }}</q-tooltip>
        </q-btn>

        <BrandMark :size="32" class="q-mr-md" />

        <!-- Fixed, not the route title: the page already names itself in its
             own heading, and repeating it here said the same thing twice. -->
        <div class="app-header__brand">
          <div class="app-header__name">MSight Cloud</div>
          <div class="app-header__sub">Management Console</div>
        </div>

        <q-space />

        <q-chip
          :color="roleColor"
          text-color="white"
          dense
          square
          class="text-capitalize text-weight-medium q-mr-sm"
        >
          {{ auth.role ?? 'no role' }}
        </q-chip>

        <!-- Identity is implied by being signed in, so it is the first thing to
             drop on a narrow screen. The role chip stays: it is what explains
             why controls are missing. -->
        <span v-if="$q.screen.gt.sm" class="app-header__user q-mr-sm">
          {{ auth.me?.username }}
        </span>

        <q-btn flat dense round icon="logout" color="white" aria-label="Sign out" @click="confirmSignOut">
          <q-tooltip>Sign out</q-tooltip>
        </q-btn>
      </q-toolbar>
    </q-header>

    <q-drawer
      v-model="drawerOpen"
      show-if-above
      :width="248"
      :breakpoint="1023"
      class="app-drawer bg-primary"
    >
      <q-scroll-area class="fit">
        <q-list padding class="q-px-sm">
          <template v-for="group in visibleGroups" :key="group.label">
            <q-item-label header class="app-drawer__heading">
              {{ group.label }}
            </q-item-label>

            <q-item
              v-for="item in group.features"
              :key="item.name"
              v-ripple
              clickable
              :to="{ name: item.name }"
              active-class="app-drawer__item--active"
              class="app-drawer__item"
            >
              <q-item-section avatar class="app-drawer__icon">
                <q-icon :name="item.icon" size="19px" />
              </q-item-section>
              <q-item-section class="text-body2">{{ item.label }}</q-item-section>
              <q-item-section v-if="item.status === 'planned'" side>
                <q-badge outline color="blue-grey-4" label="soon" />
              </q-item-section>
            </q-item>
          </template>
        </q-list>
      </q-scroll-area>
    </q-drawer>

    <q-page-container class="app-page-bg">
      <router-view />
    </q-page-container>
  </q-layout>
</template>

<style scoped>
/* ---- Header ------------------------------------------------------------- */

.app-header {
  /* A hairline rather than a drop shadow: the header and drawer are the same
     colour, and a shadow between them reads as a seam. */
  border-bottom: 1px solid rgba(255, 255, 255, 0.09);
}

.app-header__bar {
  min-height: 60px;
  padding-left: 14px;
  padding-right: 12px;
}

.app-header__brand {
  min-width: 0;
  line-height: 1.2;
}

.app-header__name {
  font-size: 15px;
  font-weight: 650;
  letter-spacing: -0.01em;
}

.app-header__sub {
  font-size: 11px;
  color: rgba(255, 255, 255, 0.62);
  margin-top: 1px;
}

.app-header__user {
  font-size: 13px;
  color: rgba(255, 255, 255, 0.72);
}

/* ---- Drawer ------------------------------------------------------------- */

/* Background comes from the bg-primary utility on the element: Quasar's own
   .q-drawer rule sets a background and outranks a scoped class here, and its
   bg-* utilities are !important precisely so they can override it. */
.app-drawer {
  color: #a3b6cc;
}

.app-drawer__heading {
  font-size: 10px;
  font-weight: 700;
  letter-spacing: 0.1em;
  text-transform: uppercase;
  color: #6f88a6;
  padding: 16px 12px 4px;
  line-height: 1.4;
  min-height: 0;
}

.app-drawer__item {
  border-radius: 8px;
  color: #a3b6cc;
  min-height: 40px;
  padding: 0 12px;
  margin-bottom: 2px;
  transition: background 0.15s ease, color 0.15s ease;
}

.app-drawer__item:hover {
  background: rgba(255, 255, 255, 0.07);
  color: #fff;
}

/* Maize is far too light to carry white text, so the active row flips to navy
   ink rather than inheriting the drawer's foreground. */
.app-drawer__item--active {
  background: #ffcb05;
  color: #00274c;
  font-weight: 600;
}

.app-drawer__item--active :deep(.q-badge) {
  color: #00274c !important;
  border-color: rgba(0, 39, 76, 0.35) !important;
}

/* The default avatar section reserves 56px, too wide beside a 19px icon in a
   248px drawer. */
.app-drawer__icon {
  min-width: 32px;
  padding-right: 0;
}

.app-page-bg {
  background: #f4f6fa;
}
</style>

import { defineStore } from 'pinia';
import { ref, computed } from 'vue';
import { api, type AdminRole, type Me } from '@/api/client';
import { currentSession, signOut as cognitoSignOut } from '@/auth/cognito';

export const useAuthStore = defineStore('auth', () => {
  const me = ref<Me | null>(null);
  const loading = ref(false);
  const initialized = ref(false);

  const signedIn = computed(() => me.value !== null);
  const role = computed<AdminRole | null>(() => me.value?.role ?? null);
  const isAdmin = computed(() => role.value === 'admin');

  /** Mirrors ROLE_PRECEDENCE on the backend: lower number, more privilege. */
  const PRECEDENCE: Record<AdminRole, number> = { admin: 1, operator: 2, viewer: 3 };

  /** True when the signed-in user holds `required` or anything above it. */
  function hasAtLeast(required: AdminRole): boolean {
    if (!role.value) {
      return false;
    }
    return PRECEDENCE[role.value] <= PRECEDENCE[required];
  }

  /** Restores a persisted Cognito session on page load. Safe to call repeatedly. */
  async function restore(): Promise<void> {
    if (initialized.value) {
      return;
    }
    loading.value = true;
    try {
      const session = await currentSession();
      me.value = session ? await api.me() : null;
    } catch {
      me.value = null;
    } finally {
      loading.value = false;
      initialized.value = true;
    }
  }

  /** Called after a successful Cognito sign-in to load the caller's profile. */
  async function loadProfile(): Promise<void> {
    me.value = await api.me();
    initialized.value = true;
  }

  function signOut(): void {
    cognitoSignOut();
    me.value = null;
    initialized.value = true;
  }

  return {
    me,
    loading,
    initialized,
    signedIn,
    role,
    isAdmin,
    hasAtLeast,
    restore,
    loadProfile,
    signOut,
  };
});

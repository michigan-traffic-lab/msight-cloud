<script setup lang="ts">
import { onMounted, reactive, ref } from 'vue';
import { useQuasar, type QTableColumn } from 'quasar';
import { api, type AdminRole, type AdminUser } from '@/api/client';
import { useAuthStore } from '@/stores/auth';
import PageHeader from '@/components/PageHeader.vue';

const $q = useQuasar();
const auth = useAuthStore();

const users = ref<AdminUser[]>([]);
const loading = ref(true);
const createOpen = ref(false);
const creating = ref(false);
const showTempPassword = ref(false);

const ROLES: Array<{ value: AdminRole; label: string; description: string }> = [
  { value: 'admin', label: 'Admin', description: 'Full control, including user management.' },
  { value: 'operator', label: 'Operator', description: 'Operational actions; cannot manage users.' },
  { value: 'viewer', label: 'Viewer', description: 'Read-only access.' },
];

const form = reactive({
  username: '',
  email: '',
  role: 'viewer' as AdminRole,
  temporary_password: '',
});

/**
 * QTable takes its columns declaratively, which replaces the hand-written
 * table markup, sorting and pagination the previous console carried.
 */
const columns: QTableColumn<AdminUser>[] = [
  { name: 'username', label: 'Username', field: 'username', align: 'left', sortable: true },
  { name: 'email', label: 'Email', field: (row) => row.email ?? '—', align: 'left', sortable: true },
  { name: 'role', label: 'Role', field: (row) => row.role ?? '', align: 'left', sortable: true },
  { name: 'status', label: 'Status', field: 'status', align: 'left', sortable: true },
  {
    name: 'created_at',
    label: 'Created',
    field: 'created_at',
    align: 'left',
    sortable: true,
    format: (value: string | null) => (value ? new Date(value).toLocaleDateString() : '—'),
  },
  { name: 'actions', label: '', field: 'username', align: 'right' },
];

function roleColor(role: AdminRole | null): string {
  switch (role) {
    case 'admin':
      return 'negative';
    case 'operator':
      return 'warning';
    default:
      return 'grey-7';
  }
}

function notifyError(error: unknown, fallback: string) {
  $q.notify({
    type: 'negative',
    message: error instanceof Error ? error.message : fallback,
    position: 'top',
  });
}

async function load() {
  loading.value = true;
  try {
    users.value = (await api.listUsers()).users;
  } catch (error) {
    notifyError(error, 'Could not load users.');
  } finally {
    loading.value = false;
  }
}

/** QDialog is callback-based; this adapts it to the await style used below. */
function confirm(options: {
  title: string;
  message: string;
  okLabel: string;
  color?: string;
}): Promise<boolean> {
  return new Promise((resolve) => {
    $q.dialog({
      title: options.title,
      message: options.message,
      cancel: { label: 'Cancel', flat: true, color: 'grey-8' },
      ok: { label: options.okLabel, color: options.color ?? 'primary', unelevated: true },
      persistent: true,
    })
      .onOk(() => resolve(true))
      .onCancel(() => resolve(false))
      .onDismiss(() => resolve(false));
  });
}

function openCreate() {
  form.username = '';
  form.email = '';
  form.role = 'viewer';
  form.temporary_password = '';
  createOpen.value = true;
}

async function submitCreate() {
  if (!form.username || !form.email) {
    $q.notify({ type: 'warning', message: 'Username and email are required.', position: 'top' });
    return;
  }

  creating.value = true;
  try {
    await api.createUser({
      username: form.username.trim(),
      email: form.email.trim(),
      role: form.role,
      // Omitted rather than passed as undefined so the backend distinguishes
      // "no password given, email one" from "password field present but empty".
      ...(form.temporary_password ? { temporary_password: form.temporary_password } : {}),
    });
    $q.notify({
      type: 'positive',
      message: form.temporary_password
        ? `Created ${form.username}. They can sign in with the password you set.`
        : `Created ${form.username}. Cognito emailed them a temporary password.`,
      position: 'top',
    });
    createOpen.value = false;
    await load();
  } catch (error) {
    notifyError(error, 'Could not create the user.');
  } finally {
    creating.value = false;
  }
}

async function changeRole(user: AdminUser, role: AdminRole) {
  if (role === user.role) return;
  try {
    await api.setRole(user.username, role);
    $q.notify({ type: 'positive', message: `${user.username} is now ${role}.`, position: 'top' });
  } catch (error) {
    notifyError(error, 'Could not change the role.');
  }
  // Reloaded either way: on failure the select has already moved, and only a
  // reload puts it back to what the backend actually holds.
  await load();
}

async function toggleEnabled(user: AdminUser) {
  const next = !user.enabled;
  const ok = await confirm({
    title: next ? 'Enable user' : 'Disable user',
    message: `${next ? 'Enable' : 'Disable'} ${user.username}?`,
    okLabel: next ? 'Enable' : 'Disable',
    color: next ? 'primary' : 'warning',
  });
  if (!ok) return;

  try {
    await api.setEnabled(user.username, next);
    await load();
  } catch (error) {
    notifyError(error, 'Could not update the user.');
  }
}

async function removeUser(user: AdminUser) {
  const ok = await confirm({
    title: 'Delete user',
    message: `Permanently delete ${user.username}? This cannot be undone.`,
    okLabel: 'Delete',
    color: 'negative',
  });
  if (!ok) return;

  try {
    await api.deleteUser(user.username);
    $q.notify({ type: 'positive', message: `Deleted ${user.username}.`, position: 'top' });
    await load();
  } catch (error) {
    notifyError(error, 'Could not delete the user.');
  }
}

function resetPassword(user: AdminUser) {
  $q.dialog({
    title: 'Reset password',
    message: `Set a new password for ${user.username}. Minimum 12 characters.`,
    prompt: {
      model: '',
      type: 'password',
      outlined: true,
      // Validated here as well as by Cognito so a too-short value is rejected
      // before a round trip that would fail with a less specific message.
      isValid: (value: string) => value.length >= 12,
    },
    cancel: { label: 'Cancel', flat: true, color: 'grey-8' },
    ok: { label: 'Set password', color: 'primary', unelevated: true },
    persistent: true,
  }).onOk((value: string) => {
    void (async () => {
      try {
        await api.resetPassword(user.username, value);
        $q.notify({
          type: 'positive',
          message: `Password updated for ${user.username}.`,
          position: 'top',
        });
      } catch (error) {
        notifyError(error, 'Could not reset the password.');
      }
    })();
  });
}

onMounted(load);
</script>

<template>
  <q-page padding>
    <PageHeader
      title="Users"
      subtitle="Console accounts live in Cognito. There is no self-registration — every account is created here, and its role decides what the API will allow."
    >
      <template #actions>
        <q-btn outline color="primary" icon="refresh" label="Refresh" :loading="loading" @click="load" />
        <q-btn unelevated color="primary" icon="person_add" label="Add user" @click="openCreate" />
      </template>
    </PageHeader>

    <q-table
      flat
      bordered
      :rows="users"
      :columns="columns"
      row-key="username"
      :loading="loading"
      :rows-per-page-options="[10, 25, 50, 0]"
      no-data-label="No console accounts found."
    >
      <template #body-cell-role="props">
        <q-td :props="props">
          <!-- Editable in place: role changes are the most common action here,
               and a dialog for each would be three clicks instead of two. -->
          <q-select
            :model-value="props.row.role"
            :options="ROLES"
            option-value="value"
            option-label="label"
            emit-value
            map-options
            dense
            outlined
            borderless
            options-dense
            style="min-width: 116px"
            @update:model-value="(role) => changeRole(props.row, role)"
          >
            <template #selected>
              <q-chip dense square :color="roleColor(props.row.role)" text-color="white" class="text-capitalize">
                {{ props.row.role ?? 'none' }}
              </q-chip>
            </template>
            <template #option="scope">
              <q-item v-bind="scope.itemProps">
                <q-item-section>
                  <q-item-label>{{ scope.opt.label }}</q-item-label>
                  <q-item-label caption>{{ scope.opt.description }}</q-item-label>
                </q-item-section>
              </q-item>
            </template>
          </q-select>
        </q-td>
      </template>

      <template #body-cell-status="props">
        <q-td :props="props">
          <q-chip
            dense
            square
            :color="props.row.enabled ? 'green-1' : 'grey-3'"
            :text-color="props.row.enabled ? 'green-9' : 'grey-8'"
          >
            {{ props.row.enabled ? props.row.status : 'disabled' }}
          </q-chip>
        </q-td>
      </template>

      <template #body-cell-actions="props">
        <q-td :props="props">
          <!-- Signing yourself out of your own console is not a useful action,
               so self-destructive controls are hidden rather than disabled. -->
          <q-btn
            v-if="props.row.username !== auth.me?.username"
            flat
            dense
            round
            icon="more_vert"
            size="sm"
            :aria-label="`Actions for ${props.row.username}`"
          >
            <q-menu auto-close>
              <q-list style="min-width: 190px">
                <q-item clickable @click="toggleEnabled(props.row)">
                  <q-item-section>{{ props.row.enabled ? 'Disable' : 'Enable' }}</q-item-section>
                </q-item>
                <q-item clickable @click="resetPassword(props.row)">
                  <q-item-section>Reset password</q-item-section>
                </q-item>
                <q-separator />
                <q-item clickable class="text-negative" @click="removeUser(props.row)">
                  <q-item-section>Delete</q-item-section>
                </q-item>
              </q-list>
            </q-menu>
          </q-btn>
          <q-chip v-else dense square color="blue-1" text-color="blue-9">you</q-chip>
        </q-td>
      </template>
    </q-table>

    <!-- Create user -->
    <q-dialog v-model="createOpen">
      <q-card style="min-width: min(460px, 92vw)">
        <q-card-section>
          <div class="text-h6">Add user</div>
        </q-card-section>

        <q-card-section class="q-gutter-md q-pt-none">
          <q-input v-model="form.username" outlined dense label="Username" autofocus />
          <q-input v-model="form.email" outlined dense label="Email" type="email" />
          <q-select
            v-model="form.role"
            :options="ROLES"
            option-value="value"
            option-label="label"
            emit-value
            map-options
            outlined
            dense
            label="Role"
          >
            <template #option="scope">
              <q-item v-bind="scope.itemProps">
                <q-item-section>
                  <q-item-label>{{ scope.opt.label }}</q-item-label>
                  <q-item-label caption>{{ scope.opt.description }}</q-item-label>
                </q-item-section>
              </q-item>
            </template>
          </q-select>
          <q-input
            v-model="form.temporary_password"
            outlined
            dense
            label="Temporary password (optional)"
            :type="showTempPassword ? 'text' : 'password'"
            hint="Leave blank and Cognito emails one instead. Either way the user must change it on first sign-in."
          >
            <template #append>
              <q-icon
                :name="showTempPassword ? 'visibility_off' : 'visibility'"
                class="cursor-pointer"
                @click="showTempPassword = !showTempPassword"
              />
            </template>
          </q-input>
        </q-card-section>

        <q-card-actions align="right" class="q-pa-md q-pt-none">
          <q-btn flat label="Cancel" color="grey-8" @click="createOpen = false" />
          <q-btn unelevated color="primary" label="Create" :loading="creating" @click="submitCreate" />
        </q-card-actions>
      </q-card>
    </q-dialog>
  </q-page>
</template>

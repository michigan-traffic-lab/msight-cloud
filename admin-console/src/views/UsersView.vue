<script setup lang="ts">
import { onMounted, reactive, ref } from 'vue';
import { ElMessage, ElMessageBox } from 'element-plus';
import { api, type AdminRole, type AdminUser } from '@/api/client';
import { useAuthStore } from '@/stores/auth';

const auth = useAuthStore();

const users = ref<AdminUser[]>([]);
const loading = ref(true);
const createOpen = ref(false);
const creating = ref(false);

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

function roleTagType(role: AdminRole | null) {
  switch (role) {
    case 'admin':
      return 'danger';
    case 'operator':
      return 'warning';
    case 'viewer':
      return 'info';
    default:
      return 'info';
  }
}

async function load() {
  loading.value = true;
  try {
    users.value = (await api.listUsers()).users;
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : 'Could not load users.');
  } finally {
    loading.value = false;
  }
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
    ElMessage.warning('Username and email are required.');
    return;
  }

  creating.value = true;
  try {
    await api.createUser({
      username: form.username.trim(),
      email: form.email.trim(),
      role: form.role,
      temporary_password: form.temporary_password
        ? form.temporary_password
        : undefined,
    });
    ElMessage.success(
      form.temporary_password
        ? `Created ${form.username}. They can sign in with the password you set.`
        : `Created ${form.username}. Cognito emailed them a temporary password.`
    );
    createOpen.value = false;
    await load();
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : 'Could not create the user.');
  } finally {
    creating.value = false;
  }
}

async function changeRole(user: AdminUser, role: AdminRole) {
  try {
    await api.setRole(user.username, role);
    ElMessage.success(`${user.username} is now ${role}.`);
    await load();
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : 'Could not change the role.');
    await load();
  }
}

async function toggleEnabled(user: AdminUser) {
  const next = !user.enabled;
  try {
    await ElMessageBox.confirm(
      `${next ? 'Enable' : 'Disable'} ${user.username}?`,
      next ? 'Enable user' : 'Disable user',
      { confirmButtonText: next ? 'Enable' : 'Disable', cancelButtonText: 'Cancel', type: 'warning' }
    );
  } catch {
    return;
  }

  try {
    await api.setEnabled(user.username, next);
    await load();
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : 'Could not update the user.');
  }
}

async function removeUser(user: AdminUser) {
  try {
    await ElMessageBox.confirm(
      `Permanently delete ${user.username}? This cannot be undone.`,
      'Delete user',
      { confirmButtonText: 'Delete', cancelButtonText: 'Cancel', type: 'error' }
    );
  } catch {
    return;
  }

  try {
    await api.deleteUser(user.username);
    ElMessage.success(`Deleted ${user.username}.`);
    await load();
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : 'Could not delete the user.');
  }
}

async function resetPassword(user: AdminUser) {
  let value: string;
  try {
    const result = await ElMessageBox.prompt(
      `Set a new password for ${user.username}.`,
      'Reset password',
      {
        confirmButtonText: 'Set password',
        cancelButtonText: 'Cancel',
        inputType: 'password',
        inputPattern: /.{12,}/,
        inputErrorMessage: 'Must be at least 12 characters.',
      }
    );
    value = result.value;
  } catch {
    return;
  }

  try {
    await api.resetPassword(user.username, value);
    ElMessage.success(`Password updated for ${user.username}.`);
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : 'Could not reset the password.');
  }
}

onMounted(load);
</script>

<template>
  <div>
    <div class="header">
      <div>
        <h1 class="page-title">Users</h1>
        <p class="page-subtitle">
          Console accounts and their access levels. There is no self-registration — every
          account is created here.
        </p>
      </div>
      <div class="header__actions">
        <el-button :icon="'Refresh'" :loading="loading" @click="load">Refresh</el-button>
        <el-button type="primary" :icon="'Plus'" @click="openCreate">Add user</el-button>
      </div>
    </div>

    <div class="card">
      <el-table v-loading="loading" :data="users" style="width: 100%">
        <el-table-column prop="username" label="Username" min-width="150">
          <template #default="{ row }">
            <strong>{{ row.username }}</strong>
            <el-tag v-if="row.username === auth.me?.username" size="small" class="you">
              you
            </el-tag>
          </template>
        </el-table-column>

        <el-table-column prop="email" label="Email" min-width="200">
          <template #default="{ row }">{{ row.email ?? '—' }}</template>
        </el-table-column>

        <el-table-column label="Role" width="160">
          <template #default="{ row }">
            <el-dropdown
              trigger="click"
              @command="(role: AdminRole) => changeRole(row, role)"
            >
              <el-tag :type="roleTagType(row.role)" effect="light" class="role-tag">
                {{ row.role ?? 'none' }}
              </el-tag>
              <template #dropdown>
                <el-dropdown-menu>
                  <el-dropdown-item
                    v-for="option in ROLES"
                    :key="option.value"
                    :command="option.value"
                    :disabled="option.value === row.role"
                  >
                    <div class="role-option">
                      <div class="role-option__label">{{ option.label }}</div>
                      <div class="role-option__desc">{{ option.description }}</div>
                    </div>
                  </el-dropdown-item>
                </el-dropdown-menu>
              </template>
            </el-dropdown>
          </template>
        </el-table-column>

        <el-table-column label="Status" width="170">
          <template #default="{ row }">
            <span :class="row.enabled ? 'dot dot--ok' : 'dot dot--degraded'" />
            <span class="status-text">{{ row.enabled ? row.status : 'DISABLED' }}</span>
          </template>
        </el-table-column>

        <el-table-column label="Created" width="180">
          <template #default="{ row }">
            <span class="muted">
              {{ row.created_at ? new Date(row.created_at).toLocaleDateString() : '—' }}
            </span>
          </template>
        </el-table-column>

        <el-table-column label="Actions" width="230" align="right">
          <template #default="{ row }">
            <el-button link type="primary" @click="resetPassword(row)">Password</el-button>
            <el-button
              link
              type="warning"
              :disabled="row.username === auth.me?.username"
              @click="toggleEnabled(row)"
            >
              {{ row.enabled ? 'Disable' : 'Enable' }}
            </el-button>
            <el-button
              link
              type="danger"
              :disabled="row.username === auth.me?.username"
              @click="removeUser(row)"
            >
              Delete
            </el-button>
          </template>
        </el-table-column>
      </el-table>
    </div>

    <el-dialog v-model="createOpen" title="Add user" width="460px">
      <label class="field-label">Username</label>
      <el-input v-model="form.username" placeholder="jdoe" />

      <label class="field-label">Email</label>
      <el-input v-model="form.email" placeholder="jdoe@example.com" />

      <label class="field-label">Role</label>
      <el-select v-model="form.role" style="width: 100%">
        <el-option
          v-for="option in ROLES"
          :key="option.value"
          :value="option.value"
          :label="option.label"
        >
          <div class="role-option">
            <div class="role-option__label">{{ option.label }}</div>
            <div class="role-option__desc">{{ option.description }}</div>
          </div>
        </el-option>
      </el-select>

      <label class="field-label">Temporary password <span class="optional">(optional)</span></label>
      <el-input
        v-model="form.temporary_password"
        type="password"
        show-password
        placeholder="Leave blank to email an invitation"
      />
      <p class="field-hint">
        Leave blank and Cognito emails a temporary password. Set one and the user signs in
        with it directly.
      </p>

      <template #footer>
        <el-button @click="createOpen = false">Cancel</el-button>
        <el-button type="primary" :loading="creating" @click="submitCreate">
          Create user
        </el-button>
      </template>
    </el-dialog>
  </div>
</template>

<style scoped>
.header {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 16px;
}

.header__actions {
  display: flex;
  gap: 8px;
}

.you {
  margin-left: 8px;
}

.role-tag {
  cursor: pointer;
  text-transform: capitalize;
}

.role-option__label {
  font-weight: 550;
}

.role-option__desc {
  font-size: 12px;
  color: var(--text-muted);
  line-height: 1.4;
}

.status-text {
  font-size: 12px;
  color: var(--text-muted);
}

.muted {
  color: var(--text-muted);
}

.field-label {
  display: block;
  font-size: 13px;
  font-weight: 550;
  margin: 16px 0 6px;
}

.field-label:first-of-type {
  margin-top: 0;
}

.optional {
  color: var(--text-muted);
  font-weight: 400;
}

.field-hint {
  margin: 8px 0 0;
  font-size: 12px;
  color: var(--text-muted);
  line-height: 1.5;
}
</style>

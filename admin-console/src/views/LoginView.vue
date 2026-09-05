<script setup lang="ts">
import { ref } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { ElMessage } from 'element-plus';
import type { CognitoUser } from 'amazon-cognito-identity-js';
import { completeNewPassword, NewPasswordRequiredError, signIn } from '@/auth/cognito';
import { useAuthStore } from '@/stores/auth';
import BrandMark from '@/components/BrandMark.vue';

const auth = useAuthStore();
const route = useRoute();
const router = useRouter();

const username = ref('');
const password = ref('');
const newPassword = ref('');
const confirmPassword = ref('');
const submitting = ref(false);
const errorMessage = ref('');

/** Set when Cognito returns NEW_PASSWORD_REQUIRED; switches the form to step 2. */
const challengeUser = ref<CognitoUser | null>(null);

async function finish() {
  await auth.loadProfile();
  const redirect = route.query.redirect;
  router.push(typeof redirect === 'string' ? redirect : { name: 'overview' });
}

async function onSubmit() {
  errorMessage.value = '';
  if (!username.value || !password.value) {
    errorMessage.value = 'Enter your username and password.';
    return;
  }

  submitting.value = true;
  try {
    await signIn(username.value, password.value);
    await finish();
  } catch (error) {
    if (error instanceof NewPasswordRequiredError) {
      challengeUser.value = error.user;
      ElMessage.info('Choose a new password to finish setting up this account.');
    } else {
      errorMessage.value =
        error instanceof Error ? error.message : 'Sign-in failed. Try again.';
    }
  } finally {
    submitting.value = false;
  }
}

async function onSubmitNewPassword() {
  errorMessage.value = '';
  if (newPassword.value !== confirmPassword.value) {
    errorMessage.value = 'The two passwords do not match.';
    return;
  }
  if (!challengeUser.value) {
    return;
  }

  submitting.value = true;
  try {
    await completeNewPassword(challengeUser.value, newPassword.value);
    await finish();
  } catch (error) {
    errorMessage.value =
      error instanceof Error ? error.message : 'Could not set the new password.';
  } finally {
    submitting.value = false;
  }
}
</script>

<template>
  <div class="login">
    <div class="login__card">
      <div class="login__brand">
        <BrandMark :size="44" />
        <div>
          <div class="login__name">MSight Cloud</div>
          <div class="login__sub">Management Console</div>
        </div>
      </div>

      <el-alert
        v-if="errorMessage"
        class="login__error"
        :title="errorMessage"
        type="error"
        show-icon
        :closable="false"
      />

      <form v-if="!challengeUser" @submit.prevent="onSubmit">
        <label class="login__label">Username or email</label>
        <el-input v-model="username" size="large" autocomplete="username" />

        <label class="login__label">Password</label>
        <el-input
          v-model="password"
          type="password"
          size="large"
          show-password
          autocomplete="current-password"
        />

        <el-button
          class="login__submit"
          type="primary"
          size="large"
          native-type="submit"
          :loading="submitting"
        >
          Sign in
        </el-button>
      </form>

      <form v-else @submit.prevent="onSubmitNewPassword">
        <p class="login__hint">
          This account still uses a temporary password. Choose a permanent one to continue.
        </p>

        <label class="login__label">New password</label>
        <el-input
          v-model="newPassword"
          type="password"
          size="large"
          show-password
          autocomplete="new-password"
        />

        <label class="login__label">Confirm new password</label>
        <el-input
          v-model="confirmPassword"
          type="password"
          size="large"
          show-password
          autocomplete="new-password"
        />

        <el-button
          class="login__submit"
          type="primary"
          size="large"
          native-type="submit"
          :loading="submitting"
        >
          Set password and sign in
        </el-button>
      </form>

      <p class="login__footer">
        Accounts are created by an administrator. There is no self-registration.
      </p>
    </div>
  </div>
</template>

<style scoped>
.login {
  height: 100%;
  display: flex;
  align-items: center;
  justify-content: center;
  background: linear-gradient(160deg, #00274c 0%, #003e6b 55%, #01527f 100%);
  padding: 24px;
}

.login__card {
  width: 100%;
  max-width: 400px;
  background: var(--card-bg);
  border-radius: 16px;
  padding: 32px;
  box-shadow: 0 24px 64px rgba(8, 12, 24, 0.4);
}

.login__brand {
  display: flex;
  align-items: center;
  gap: 12px;
  margin-bottom: 28px;
}

.login__name {
  font-weight: 650;
  font-size: 16px;
}

.login__sub {
  color: var(--text-muted);
  font-size: 12px;
  margin-top: 2px;
}

.login__label {
  display: block;
  font-size: 13px;
  font-weight: 550;
  margin: 16px 0 6px;
}

.login__submit {
  width: 100%;
  margin-top: 24px;
}

.login__error {
  margin-bottom: 8px;
}

.login__hint {
  font-size: 13px;
  color: var(--text-muted);
  margin: 0;
  line-height: 1.5;
}

.login__footer {
  margin: 24px 0 0;
  font-size: 12px;
  color: var(--text-muted);
  text-align: center;
  line-height: 1.5;
}
</style>

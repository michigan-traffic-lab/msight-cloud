<script setup lang="ts">
import { ref } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { useQuasar } from 'quasar';
import type { CognitoUser } from 'amazon-cognito-identity-js';
import { completeNewPassword, NewPasswordRequiredError, signIn } from '@/auth/cognito';
import { useAuthStore } from '@/stores/auth';
import BrandMark from '@/components/BrandMark.vue';

const $q = useQuasar();
const auth = useAuthStore();
const route = useRoute();
const router = useRouter();

const username = ref('');
const password = ref('');
const newPassword = ref('');
const confirmPassword = ref('');
const submitting = ref(false);
const errorMessage = ref('');
const showPassword = ref(false);

/** Set when Cognito returns NEW_PASSWORD_REQUIRED; switches the form to step 2. */
const challengeUser = ref<CognitoUser | null>(null);

async function finish() {
  await auth.loadProfile();
  const redirect = route.query.redirect;
  await router.push(typeof redirect === 'string' ? redirect : { name: 'overview' });
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
      $q.notify({
        type: 'info',
        message: 'Choose a new password to finish setting up this account.',
      });
    } else {
      errorMessage.value = error instanceof Error ? error.message : 'Sign-in failed. Try again.';
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
  <q-page class="login-bg flex flex-center q-pa-md">
    <q-card flat bordered class="login-card q-pa-lg">
      <q-card-section class="row items-center no-wrap q-pb-md q-px-none q-pt-none">
        <BrandMark :size="42" />
        <div class="q-ml-md">
          <div class="text-subtitle1 text-weight-bold" style="line-height: 1.2">
            MSight Cloud
          </div>
          <div class="text-caption text-grey-7">Management Console</div>
        </div>
      </q-card-section>

      <q-banner v-if="errorMessage" dense rounded class="bg-red-1 text-negative q-mb-md">
        <template #avatar>
          <q-icon name="error" color="negative" />
        </template>
        {{ errorMessage }}
      </q-banner>

      <q-form v-if="!challengeUser" class="q-gutter-md" @submit.prevent="onSubmit">
        <q-input
          v-model="username"
          outlined
          label="Username or email"
          autocomplete="username"
          :disable="submitting"
        />
        <q-input
          v-model="password"
          outlined
          label="Password"
          :type="showPassword ? 'text' : 'password'"
          autocomplete="current-password"
          :disable="submitting"
        >
          <template #append>
            <q-icon
              :name="showPassword ? 'visibility_off' : 'visibility'"
              class="cursor-pointer"
              @click="showPassword = !showPassword"
            />
          </template>
        </q-input>

        <q-btn
          type="submit"
          color="primary"
          unelevated
          size="lg"
          class="full-width"
          :loading="submitting"
          label="Sign in"
        />
      </q-form>

      <q-form v-else class="q-gutter-md" @submit.prevent="onSubmitNewPassword">
        <div class="text-body2 text-grey-8">
          This account still uses a temporary password. Choose a permanent one to continue.
        </div>

        <q-input
          v-model="newPassword"
          outlined
          label="New password"
          type="password"
          autocomplete="new-password"
          :disable="submitting"
        />
        <q-input
          v-model="confirmPassword"
          outlined
          label="Confirm new password"
          type="password"
          autocomplete="new-password"
          :disable="submitting"
        />

        <q-btn
          type="submit"
          color="primary"
          unelevated
          size="lg"
          class="full-width"
          :loading="submitting"
          label="Set password and sign in"
        />
      </q-form>

      <div class="text-caption text-grey-6 text-center q-mt-lg">
        Accounts are created by an administrator. There is no self-registration.
      </div>
    </q-card>
  </q-page>
</template>

<style scoped>
/* The only two things Quasar has no utility for: the brand gradient and a
   readable maximum width for the form. */
.login-bg {
  background: linear-gradient(160deg, #00274c 0%, #003e6b 55%, #01527f 100%);
}

.login-card {
  width: 100%;
  max-width: 400px;
  border-radius: 12px;
}
</style>

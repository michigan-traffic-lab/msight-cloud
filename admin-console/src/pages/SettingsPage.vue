<script setup lang="ts">
import { computed } from 'vue';
import { api, type GithubAppStatus } from '@/api/client';
import { useAsyncValue } from '@/composables/useAsyncValue';
import PageHeader from '@/components/PageHeader.vue';
import SectionCard from '@/components/SectionCard.vue';
import { useAuthStore } from '@/stores/auth';
import type { AdminRole } from '@/api/client';

/**
 * Where the deployment is configured, as opposed to operated.
 *
 * The distinction the rest of the console is organised around is "things you
 * watch" and "things you run". This is the third: things you set once. They had
 * been living on whichever page first needed them — the GitHub App sat above
 * the microservice registry it enables — which made a one-time setup the first
 * thing an operator saw every day, and made the registry look like an appendix
 * to it.
 *
 * A hub of links rather than a page of forms, because settings do not share a
 * shape: connecting an App is a handshake with another service, roles are a
 * table of people, retention is a number. Giving each its own page keeps this
 * one readable as a map, which is the only job it has.
 *
 * Entries that do not exist yet are listed and marked, not hidden. This
 * deployment is one team's today and is expected to carry several — so the
 * shape of what is coming is worth stating where the person who will ask for it
 * is already looking.
 */

const auth = useAuthStore();

const appStatus = useAsyncValue<GithubAppStatus>((signal) => api.githubApp(signal));

const githubConnected = computed(() => appStatus.data.value?.configured === true);

interface SettingEntry {
  key: string;
  label: string;
  description: string;
  icon: string;
  /** Where it leads. Absent for an entry that is not built yet. */
  route?: string;
  minRole: AdminRole;
  /** Short state, shown on the right: "Connected", "Not set up", "Planned". */
  status: () => { text: string; tone: 'positive' | 'warning' | 'grey-6' };
}

const ENTRIES: SettingEntry[] = [
  {
    key: 'github',
    label: 'GitHub App',
    description:
      'The App this deployment builds microservices from. Installed once; what is stored ' +
      'is a grant belonging to the repository owner, not anybody’s GitHub login.',
    icon: 'hub',
    route: 'github-settings',
    minRole: 'operator',
    status: () =>
      githubConnected.value
        ? { text: 'Connected', tone: 'positive' }
        : { text: 'Not set up', tone: 'warning' },
  },
  {
    key: 'users',
    label: 'Users and roles',
    description:
      'Who can sign in, and what each of them may do. Admins configure; operators run ' +
      'and repair; viewers read.',
    icon: 'group',
    route: 'users',
    minRole: 'admin',
    status: () => ({ text: 'Manage', tone: 'grey-6' }),
  },
  {
    key: 'cost',
    label: 'Cost allocation',
    description:
      'The tag every resource this console creates is stamped with, and the spend it ' +
      'rolls up to. Set at deploy time; shown here and on the Cost page.',
    icon: 'payments',
    route: 'cost',
    minRole: 'operator',
    status: () => ({ text: 'View', tone: 'grey-6' }),
  },
  {
    key: 'retention',
    label: 'Log retention defaults',
    description:
      'How long a new microservice keeps its container and build logs. Today this is ' +
      'chosen per service after it is created, and defaults to 30 days.',
    icon: 'schedule',
    minRole: 'admin',
    status: () => ({ text: 'Planned', tone: 'grey-6' }),
  },
  {
    key: 'tenancy',
    label: 'Teams and ownership',
    description:
      'Which apps and services each team owns, so that one deployment can carry several ' +
      'of them without everyone seeing everything. Nothing is partitioned today: every ' +
      'signed-in user sees every app and every service.',
    icon: 'workspaces',
    minRole: 'admin',
    status: () => ({ text: 'Planned', tone: 'grey-6' }),
  },
];

/**
 * Hidden rather than disabled when the role is too low.
 *
 * A greyed row invites a click and then refuses it; a row that is not there
 * says the same thing without the detour. The route guard enforces the same
 * floor either way, so this is presentation rather than access control.
 */
const visible = computed(() => ENTRIES.filter((entry) => auth.hasAtLeast(entry.minRole)));
</script>

<template>
  <q-page padding>
    <PageHeader
      title="Settings"
      subtitle="Things this deployment is configured with, rather than things it runs. Each one opens on its own page."
    />

    <SectionCard title="Configuration" flush>
      <q-list separator>
        <q-item
          v-for="entry in visible"
          :key="entry.key"
          v-ripple="Boolean(entry.route)"
          :clickable="Boolean(entry.route)"
          :to="entry.route ? { name: entry.route } : undefined"
          :class="entry.route ? '' : 'settings-row--planned'"
        >
          <q-item-section avatar>
            <q-avatar square size="34px" :color="entry.route ? 'blue-1' : 'grey-2'">
              <q-icon :name="entry.icon" size="19px" :color="entry.route ? 'primary' : 'grey-6'" />
            </q-avatar>
          </q-item-section>

          <q-item-section>
            <q-item-label class="text-weight-medium">{{ entry.label }}</q-item-label>
            <q-item-label caption style="max-width: 76ch">{{ entry.description }}</q-item-label>
          </q-item-section>

          <q-item-section side>
            <div class="row items-center q-gutter-sm">
              <q-badge
                :color="entry.status().tone === 'grey-6' ? 'grey-3' : `${entry.status().tone}-1`"
                :text-color="entry.status().tone === 'grey-6' ? 'grey-8' : entry.status().tone"
              >
                {{ entry.status().text }}
              </q-badge>
              <q-icon v-if="entry.route" name="chevron_right" color="grey-6" size="20px" />
            </div>
          </q-item-section>
        </q-item>
      </q-list>
    </SectionCard>

    <!--
      Said once, here, rather than repeated on each planned row: what is missing
      is a boundary, and the reason it is missing is that nothing has needed one
      yet.
    -->
    <div class="text-caption text-grey-7 q-mt-md" style="max-width: 80ch">
      Entries marked <strong>Planned</strong> are not built. They are listed because the shape
      of this deployment is expected to change: today every signed-in user sees every app and
      every microservice, which is right for one team and wrong for several.
    </div>
  </q-page>
</template>

<style scoped>
/* A row that leads nowhere should not look like one that does. */
.settings-row--planned {
  opacity: 0.72;
  cursor: default;
}
</style>

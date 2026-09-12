<script setup lang="ts">
/**
 * A way through to the AWS console.
 *
 * One component so that every such link looks the same, opens the same way, and
 * — the part that is easy to get wrong — carries `rel="noopener noreferrer"`.
 * Without it the opened tab gets a handle on this one through `window.opener`,
 * which is a real hazard on a page that holds an admin session.
 *
 * Renders nothing when `href` is null. Callers pass the result of a builder in
 * `aws-links.ts` straight through, and those return null for a resource that
 * does not exist yet — so an unprovisioned service shows no link rather than
 * one that leads to a 404.
 */
defineProps<{
  href: string | null;
  /** Defaults to a short "AWS" so it fits beside a heading. */
  label?: string | undefined;
  /** Renders as an outlined button rather than inline text. */
  button?: boolean | undefined;
}>();
</script>

<template>
  <q-btn
    v-if="href && button"
    :href="href"
    target="_blank"
    rel="noopener noreferrer"
    type="a"
    outline
    no-caps
    size="sm"
    color="grey-8"
    icon-right="open_in_new"
    :label="label ?? 'AWS console'"
  >
    <q-tooltip :delay="300">Opens the AWS console in a new tab</q-tooltip>
  </q-btn>

  <a
    v-else-if="href"
    :href="href"
    target="_blank"
    rel="noopener noreferrer"
    class="aws-link"
  >
    {{ label ?? 'AWS' }}<q-icon name="open_in_new" size="12px" class="q-ml-xs" />
    <q-tooltip :delay="300">Opens the AWS console in a new tab</q-tooltip>
  </a>
</template>

<style scoped>
/* Quieter than a content link: it leaves the console, so it should not compete
   with the links that navigate within it. */
.aws-link {
  color: #6b7688;
  text-decoration: none;
  white-space: nowrap;
  font-size: 12px;
}

.aws-link:hover {
  color: #1976d2;
  text-decoration: underline;
}
</style>

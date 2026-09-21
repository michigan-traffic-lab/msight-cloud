<script setup lang="ts">
import { computed } from 'vue';
import { useQuasar } from 'quasar';
import { api } from '@/api/client';
import { useAsyncValue } from '@/composables/useAsyncValue';
import AsyncValue from '@/components/AsyncValue.vue';
import PageHeader from '@/components/PageHeader.vue';
import SectionCard from '@/components/SectionCard.vue';

/**
 * A link out, not an embed.
 *
 * The console's Content-Security-Policy is `default-src 'self'`, which (with no
 * `frame-src` override) also governs framing — an iframe pointed at the API
 * Gateway origin would be silently blocked by the browser. Reproducing Swagger
 * UI inside the console would also mean carrying a second copy of it, one that
 * can drift from the one the API itself serves. Opening the real thing in a new
 * tab has neither problem.
 */

const $q = useQuasar();

const info = useAsyncValue((signal) => api.systemInfo(signal));

const httpApiBase = computed(() => info.data.value?.endpoints.http_api ?? null);
const docsUrl = computed(() => (httpApiBase.value ? `${httpApiBase.value}/system/docs` : null));
const specUrl = computed(() =>
  httpApiBase.value ? `${httpApiBase.value}/system/openapi.json` : null
);

function copy(text: string | null) {
  if (!text) return;
  void navigator.clipboard.writeText(text).then(() => {
    $q.notify({ type: 'positive', message: 'Copied', timeout: 1200, position: 'top' });
  });
}
</script>

<template>
  <q-page padding>
    <PageHeader
      title="API docs"
      subtitle="Interactive documentation for the public HTTP API — the routes client apps and field devices call directly."
    >
      <template #actions>
        <q-btn
          unelevated
          color="primary"
          icon="menu_book"
          label="Open API docs"
          no-caps
          type="a"
          :href="docsUrl ?? undefined"
          target="_blank"
          rel="noopener"
          :disable="!docsUrl"
          :loading="info.state.value === 'loading'"
        />
      </template>
    </PageHeader>

    <div class="row q-col-gutter-md">
      <div class="col-12 col-md-6">
        <SectionCard title="Endpoint">
          <AsyncValue :state="info.state.value" :error="info.error.value">
            <q-input :model-value="docsUrl" readonly dense outlined input-class="mono">
              <template #append>
                <q-btn
                  flat
                  round
                  dense
                  icon="content_copy"
                  size="sm"
                  @click="copy(docsUrl)"
                />
              </template>
            </q-input>
            <div class="text-caption text-grey-7 q-mt-sm">
              Unauthenticated and open to any origin, same as the API it documents. Opens in a
              new tab because the console's content-security policy does not allow framing a
              different origin.
            </div>
          </AsyncValue>
        </SectionCard>
      </div>

      <div class="col-12 col-md-6">
        <SectionCard title="Raw spec">
          <AsyncValue :state="info.state.value" :error="info.error.value">
            <q-input :model-value="specUrl" readonly dense outlined input-class="mono">
              <template #append>
                <q-btn
                  flat
                  round
                  dense
                  icon="content_copy"
                  size="sm"
                  @click="copy(specUrl)"
                />
              </template>
            </q-input>
            <div class="text-caption text-grey-7 q-mt-sm">
              OpenAPI 3.0 JSON, generated fresh on every request from the same Zod schemas the
              API validates requests against — never a separate, staler copy.
            </div>
          </AsyncValue>
        </SectionCard>
      </div>

      <div class="col-12">
        <SectionCard
          title="Scope"
          lede="What this document covers, and what it deliberately leaves out."
        >
          <div class="text-body2 text-grey-8" style="max-width: 76ch">
            This is the contract for client apps and field devices — location updates, latency
            probes, radius broadcast, maps, and system status. It does not include this admin
            console's own backend, the MCP server, or the GitHub webhook: those exist to run the
            deployment, not to be integrated against, and documenting them here would blur who
            the audience is.
          </div>
        </SectionCard>
      </div>
    </div>
  </q-page>
</template>

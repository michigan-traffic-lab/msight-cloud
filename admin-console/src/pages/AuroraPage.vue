<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { useQuasar, type QTableColumn } from 'quasar';
import {
  api,
  type AuroraQueryResponse,
  type AuroraRowsResponse,
  type AuroraTablesResponse,
} from '@/api/client';
import { useAsyncValue } from '@/composables/useAsyncValue';
import PageHeader from '@/components/PageHeader.vue';
import AsyncValue from '@/components/AsyncValue.vue';
import { useAuthStore } from '@/stores/auth';
import SectionCard from '@/components/SectionCard.vue';

const $q = useQuasar();
const auth = useAuthStore();

const tables = useAsyncValue<AuroraTablesResponse>((signal) => api.auroraTables(signal), {
  timeoutMs: 25000,
});

const selectedTable = ref<string | null>(null);
const rows = ref<AuroraRowsResponse | null>(null);
const loadingRows = ref(false);
const rowsError = ref<string | null>(null);
const pageCursors = ref<Array<string | null>>([null]);
const pageIndex = ref(0);
const showStructure = ref(false);

// Cell currently being edited, and its pending value.
const editing = ref<{ pk: string; column: string } | null>(null);
const draft = ref<string>('');
const saving = ref(false);
const deleting = ref<string | null>(null);

const sql = ref('SELECT * FROM apps');
const queryResult = ref<AuroraQueryResponse | null>(null);
const queryError = ref<string | null>(null);
const querying = ref(false);

watch(
  () => tables.data.value,
  (data) => {
    const first = data?.tables[0];
    if (first && !selectedTable.value) void openTable(first.name);
  },
  { immediate: true }
);

async function loadRows(cursor: string | null) {
  if (!selectedTable.value) return;
  loadingRows.value = true;
  rowsError.value = null;
  try {
    rows.value = await api.auroraRows(selectedTable.value, {
      // Omitted rather than undefined: the API distinguishes "first page" from
      // "cursor supplied".
      ...(cursor ? { cursor } : {}),
      limit: 50,
    });
  } catch (error) {
    rowsError.value = error instanceof Error ? error.message : 'Could not read rows.';
    rows.value = null;
  } finally {
    loadingRows.value = false;
  }
}

async function openTable(name: string) {
  selectedTable.value = name;
  editing.value = null;
  pageCursors.value = [null];
  pageIndex.value = 0;
  await loadRows(null);
}

/**
 * Keyset pagination, so the cursor trail is kept rather than an offset. Going
 * back means replaying the cursor that produced the previous page — an offset
 * would drift as rows are inserted underneath.
 */
async function nextPage() {
  if (!rows.value?.next_cursor) return;
  pageCursors.value = [...pageCursors.value.slice(0, pageIndex.value + 1), rows.value.next_cursor];
  pageIndex.value += 1;
  await loadRows(rows.value.next_cursor);
}

async function prevPage() {
  if (pageIndex.value === 0) return;
  pageIndex.value -= 1;
  await loadRows(pageCursors.value[pageIndex.value] ?? null);
}

const auroraColumns = computed(() => rows.value?.columns ?? []);
const primaryKey = computed(() => rows.value?.primary_key ?? '');

const currentTableMeta = computed(() =>
  tables.data.value?.tables.find((table) => table.name === selectedTable.value)
);

/** Edits are admin-only server-side; the UI mirrors that rather than failing late. */
const canEdit = computed(() => auth.isAdmin);

/** Rows may be removed only from tables the server marks deletable, by an admin. */
const canDelete = computed(() => Boolean(rows.value?.deletable) && auth.isAdmin);

/** QTable column defs derived from the schema the API returned. */
const tableColumns = computed<QTableColumn[]>(() => {
  const cols: QTableColumn[] = auroraColumns.value.map((column) => ({
    name: column.name,
    label: column.name,
    field: column.name,
    align: 'left' as const,
    sortable: true,
  }));
  if (canDelete.value) {
    cols.push({ name: '__actions', label: '', field: () => '', align: 'right' as const });
  }
  return cols;
});

/** Postgres booleans arrive as 'true'/'t' depending on the driver path. */
function isTruthy(value: unknown): boolean {
  return value === true || value === 'true' || value === 't';
}

/**
 * Values arrive JSON-encoded, so strings carry their own quotes. Showing those
 * makes every text cell look like it contains a literal quote character.
 */
function cleanValue(value: unknown): string {
  const text = String(value);
  return text.length > 1 && text.startsWith('"') && text.endsWith('"')
    ? text.slice(1, -1)
    : text;
}

/**
 * A single JSONB column can hold a whole MAP message. Without a cap, one row
 * stretches to several screens and pushes every other row out of view.
 */
function isLong(value: unknown): boolean {
  return String(value ?? '').length > 120;
}

function isBoolean(dataType: string): boolean {
  return dataType === 'boolean';
}

/**
 * Postgres reports reltuples as -1 for a table it has never analyzed, so the
 * count is omitted entirely rather than shown as a nonsense number.
 */
function rowEstimate(rows: number): string | null {
  if (rows < 0) return null;
  return `${rows.toLocaleString()} ${rows === 1 ? 'row' : 'rows'}`;
}

function humanBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB'];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toFixed(value < 10 ? 1 : 0)} ${units[unit] ?? 'GB'}`;
}

function confirmDialog(options: {
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

async function commit(pk: string, column: string, value: unknown) {
  if (!selectedTable.value) return;
  saving.value = true;
  try {
    await api.auroraUpdateRow(selectedTable.value, pk, { [column]: value });
    $q.notify({ type: 'positive', message: `Updated ${column}.`, position: 'top' });
    editing.value = null;
    await loadRows(pageCursors.value[pageIndex.value] ?? null);
  } catch (error) {
    $q.notify({
      type: 'negative',
      message: error instanceof Error ? error.message : 'Update failed.',
      position: 'top',
    });
  } finally {
    saving.value = false;
  }
}

/** Booleans commit immediately — a switch that needs a save button is a lie. */
async function toggleBoolean(pk: string, column: string, next: boolean) {
  const ok = await confirmDialog({
    title: 'Confirm change',
    message: `Set ${column} → ${next} on ${primaryKey.value} "${pk}"? This changes live behaviour immediately.`,
    okLabel: 'Apply',
    color: 'warning',
  });
  if (!ok) return;
  await commit(pk, column, next);
}

/**
 * Deleting is irreversible and these tables drive live behaviour, so the
 * confirmation asks the operator to retype the primary key. A yes/no dialog is
 * too easy to dismiss reflexively for something with no undo.
 */
function removeRow(pk: string) {
  if (!selectedTable.value) return;
  const table = selectedTable.value;

  $q.dialog({
    title: 'Delete row',
    message:
      `This permanently deletes the row where ${primaryKey.value} = "${pk}" from ${table}. ` +
      'There is no undo in the console — the deleted record is written to the audit log only. ' +
      `Type the ${primaryKey.value} to confirm.`,
    prompt: {
      model: '',
      type: 'text',
      outlined: true,
      placeholder: pk,
      isValid: (value: string) => value === pk,
    },
    cancel: { label: 'Cancel', flat: true, color: 'grey-8' },
    ok: { label: 'Delete permanently', color: 'negative', unelevated: true },
    persistent: true,
  }).onOk(() => {
    void (async () => {
      deleting.value = pk;
      try {
        await api.auroraDeleteRow(table, pk);
        $q.notify({
          type: 'positive',
          message: `Deleted ${primaryKey.value} "${pk}".`,
          position: 'top',
        });
        await loadRows(pageCursors.value[pageIndex.value] ?? null);
      } catch (error) {
        $q.notify({
          type: 'negative',
          message: error instanceof Error ? error.message : 'Delete failed.',
          position: 'top',
        });
      } finally {
        deleting.value = null;
      }
    })();
  });
}

function startEdit(pk: string, column: string, current: string | null) {
  editing.value = { pk, column };
  draft.value = current ?? '';
}

function isEditing(pk: string, column: string): boolean {
  return editing.value?.pk === pk && editing.value.column === column;
}

function columnMeta(name: string) {
  return auroraColumns.value.find((column) => column.name === name);
}

async function runSql() {
  querying.value = true;
  queryError.value = null;
  try {
    queryResult.value = await api.auroraQuery(sql.value, 200);
  } catch (error) {
    queryError.value = error instanceof Error ? error.message : 'Query failed.';
    queryResult.value = null;
  } finally {
    querying.value = false;
  }
}

const queryColumns = computed<QTableColumn[]>(() =>
  (queryResult.value?.columns ?? []).map((name) => ({
    name,
    label: name,
    field: name,
    align: 'left' as const,
    sortable: true,
  }))
);
</script>

<template>
  <q-page padding>
    <PageHeader
      title="Aurora PostgreSQL"
      subtitle="Browse the public schema, edit the fields that are safe to edit, and run read-only queries."
    >
      <template #actions>
        <q-btn
          outline
          color="primary"
          icon="refresh"
          label="Refresh"
          :loading="tables.state.value === 'loading'"
          @click="tables.reload()"
          />
      </template>
    </PageHeader>

    <div class="row q-col-gutter-md">
      <!-- Table list -->
      <div class="col-12 col-md-3">
        <SectionCard title="Tables" flush>
          <AsyncValue :state="tables.state.value" :error="tables.error.value">
            <q-list separator>
              <q-item
                v-for="table in tables.data.value?.tables ?? []"
                :key="table.name"
                v-ripple
                clickable
                :active="selectedTable === table.name"
                active-class="bg-blue-grey-1"
                @click="openTable(table.name)"
              >
                <q-item-section>
                  <q-item-label class="mono">{{ table.name }}</q-item-label>
                  <q-item-label caption>
                    <template v-if="rowEstimate(table.estimated_rows)">
                      {{ rowEstimate(table.estimated_rows) }} ·
                    </template>
                    {{ humanBytes(table.total_bytes) }}
                  </q-item-label>
                </q-item-section>
              </q-item>
            </q-list>
          </AsyncValue>
        </SectionCard>
      </div>

      <!-- Rows -->
      <div class="col-12 col-md-9">
        <SectionCard :title="selectedTable ?? 'Rows'" flush>
          <template #actions>
            <!-- Flat, not outline: this reveals a detail panel, it is not a
                 primary action, and a boxed button beside the card title read
                 as more important than the table itself. -->
            <q-btn
              flat
              dense
              no-caps
              color="primary"
              size="13px"
              :icon="showStructure ? 'expand_less' : 'expand_more'"
              :label="showStructure ? 'Hide schema' : 'Schema'"
              @click="showStructure = !showStructure"
            />
          </template>

          <q-slide-transition>
            <div v-show="showStructure" class="schema-panel">
              <q-markup-table flat dense class="schema-table">
                <thead>
                  <tr>
                    <th class="text-left">Column</th>
                    <th class="text-left">Type</th>
                    <th class="text-left">Nullable</th>
                    <th class="text-left">Default</th>
                    <th class="text-left">Editable</th>
                  </tr>
                </thead>
                <tbody>
                  <tr v-for="column in auroraColumns" :key="column.name">
                    <td class="mono text-weight-medium">{{ column.name }}</td>
                    <td class="text-grey-7">{{ column.data_type }}</td>
                    <td class="text-grey-7">{{ column.nullable ? 'yes' : 'no' }}</td>
                    <td class="mono text-grey-7">{{ column.default_value ?? '—' }}</td>
                    <td>
                      <q-icon
                        :name="column.editable ? 'edit' : 'lock'"
                        :color="column.editable ? 'positive' : 'grey-5'"
                        size="15px"
                      />
                    </td>
                  </tr>
                </tbody>
              </q-markup-table>
              <q-separator />
            </div>
          </q-slide-transition>

          <q-banner v-if="rowsError" rounded dense class="bg-red-1 text-negative q-ma-md">
            <template #avatar><q-icon name="error" color="negative" /></template>
            {{ rowsError }}
          </q-banner>

          <q-table
            flat
            :rows="rows?.rows ?? []"
            :columns="tableColumns"
            :row-key="primaryKey"
            :loading="loadingRows"
            hide-pagination
            :rows-per-page-options="[0]"
            class="data-grid"
            table-class="data-grid__table"
            :table-header-style="{ }"
          >
            <!-- Header carries the column's type and its badges, not just the
                 name: in a database browser the type is what tells you how to
                 read the value, and which columns are editable is the first
                 thing you need before touching anything. -->
            <template #header-cell="props">
              <q-th :props="props" class="data-grid__th">
                <template v-if="props.col.name === '__actions'"> </template>
                <template v-else>
                  <div class="data-grid__th-name mono">
                    {{ props.col.label }}
                    <q-badge
                      v-if="columnMeta(props.col.name)?.is_primary_key"
                      color="primary"
                      class="q-ml-xs"
                      label="pk"
                    />
                    <q-icon
                      v-else-if="columnMeta(props.col.name)?.editable"
                      name="edit"
                      size="12px"
                      class="q-ml-xs text-grey-6"
                    >
                      <q-tooltip>Editable — click a value to change it</q-tooltip>
                    </q-icon>
                  </div>
                  <div class="data-grid__th-type">
                    {{ columnMeta(props.col.name)?.data_type ?? '' }}
                  </div>
                </template>
              </q-th>
            </template>

            <template #body-cell="props">
              <q-td :props="props" class="data-grid__td">
                <!-- Booleans commit on toggle; text needs an explicit save. -->
                <template
                  v-if="
                    columnMeta(props.col.name)?.editable &&
                    isBoolean(columnMeta(props.col.name)?.data_type ?? '')
                  "
                >
                  <q-toggle
                    :model-value="isTruthy(props.value)"
                    dense
                    size="sm"
                    color="primary"
                    :disable="!canEdit || saving"
                    @update:model-value="
                      (next) => toggleBoolean(String(props.row[primaryKey]), props.col.name, next)
                    "
                  />
                </template>

                <template v-else-if="isEditing(String(props.row[primaryKey]), props.col.name)">
                  <div class="row items-center no-wrap q-gutter-xs">
                    <q-input
                      v-model="draft"
                      dense
                      outlined
                      autofocus
                      class="col data-grid__input"
                      input-class="mono"
                      @keyup.enter="commit(String(props.row[primaryKey]), props.col.name, draft)"
                      @keyup.esc="editing = null"
                    />
                    <q-btn
                      flat
                      dense
                      round
                      size="sm"
                      icon="check"
                      color="positive"
                      :loading="saving"
                      @click="commit(String(props.row[primaryKey]), props.col.name, draft)"
                    />
                    <q-btn flat dense round size="sm" icon="close" color="grey-7" @click="editing = null" />
                  </div>
                </template>

                <template v-else-if="props.value === null || props.value === undefined">
                  <span class="data-grid__null">null</span>
                </template>

                <template v-else>
                  <div
                    class="data-grid__value mono"
                    :class="{
                      'data-grid__value--editable': canEdit && columnMeta(props.col.name)?.editable,
                      'data-grid__value--tall': isLong(props.value),
                    }"
                    @click="
                      canEdit && columnMeta(props.col.name)?.editable
                        ? startEdit(String(props.row[primaryKey]), props.col.name, props.value)
                        : undefined
                    "
                  >
                    {{ cleanValue(props.value) }}
                    <q-icon
                      v-if="canEdit && columnMeta(props.col.name)?.editable"
                      name="edit"
                      size="12px"
                      class="data-grid__pen"
                    />
                    <q-tooltip v-if="isLong(props.value)" class="hint-tooltip">
                      Scroll inside the cell to read the whole value.
                    </q-tooltip>
                  </div>
                </template>
              </q-td>
            </template>

            <template #body-cell-__actions="props">
              <q-td :props="props" class="data-grid__td">
                <q-btn
                  flat
                  dense
                  round
                  size="sm"
                  icon="delete_outline"
                  color="grey-6"
                  class="data-grid__delete"
                  :loading="deleting === String(props.row[primaryKey])"
                  :aria-label="`Delete row ${props.row[primaryKey]}`"
                  @click="removeRow(String(props.row[primaryKey]))"
                >
                  <q-tooltip>Delete this row</q-tooltip>
                </q-btn>
              </q-td>
            </template>

            <template #no-data>
              <div class="full-width column flex-center text-grey-6 q-py-xl">
                <q-icon name="table_rows" size="28px" class="q-mb-sm" />
                <div class="text-body2">No rows on this page.</div>
              </div>
            </template>

            <template #loading>
              <q-inner-loading showing color="primary" />
            </template>
          </q-table>

          <template #footer>
            <!-- Keyset pagination: cursors, not offsets, so pages stay stable
                 as rows are inserted underneath. -->
            <div class="row items-center justify-between">
              <div class="text-caption text-grey-7">
                Page {{ pageIndex + 1 }} ·
                {{ rows?.rows.length ?? 0 }} {{ (rows?.rows.length ?? 0) === 1 ? 'row' : 'rows' }}
                <template v-if="currentTableMeta && rowEstimate(currentTableMeta.estimated_rows)">
                  of {{ rowEstimate(currentTableMeta.estimated_rows) }}
                </template>
              </div>
              <!-- Icon buttons rather than labelled ones: two short labelled
                   buttons side by side were wider than the row of text they
                   sit against, and the chevrons say the same thing. -->
              <div class="row items-center no-wrap">
                <q-btn
                  flat
                  dense
                  round
                  size="sm"
                  color="primary"
                  icon="chevron_left"
                  aria-label="Previous page"
                  :disable="pageIndex === 0 || loadingRows"
                  @click="prevPage"
                >
                  <q-tooltip>Previous page</q-tooltip>
                </q-btn>
                <q-btn
                  flat
                  dense
                  round
                  size="sm"
                  color="primary"
                  icon="chevron_right"
                  aria-label="Next page"
                  :disable="!rows?.next_cursor || loadingRows"
                  @click="nextPage"
                >
                  <q-tooltip>Next page</q-tooltip>
                </q-btn>
              </div>
            </div>
          </template>
        </SectionCard>
      </div>
    </div>

    <!-- SQL runner -->
    <q-card flat bordered class="q-mt-md">
      <q-card-section>
        <div class="text-caption text-grey-7 text-uppercase text-weight-medium q-mb-sm">
          Read-only query
        </div>
        <div class="text-body2 text-grey-7 q-mb-sm">
          Runs inside a read-only transaction, so a statement that would write is rejected by
          PostgreSQL itself rather than by pattern matching. Results are capped.
        </div>

        <q-input v-model="sql" outlined type="textarea" autogrow :rows="3" input-class="mono" label="SQL" />

        <div class="row items-center q-gutter-sm q-mt-sm">
          <q-btn unelevated color="primary" icon="play_arrow" label="Run" :loading="querying" @click="runSql" />
          <span v-if="queryResult" class="text-caption text-grey-7">
            {{ queryResult.row_count }} rows in {{ queryResult.duration_ms }} ms
            <template v-if="queryResult.capped"> · capped at {{ queryResult.limit }}</template>
          </span>
        </div>

        <q-banner v-if="queryError" rounded dense class="bg-red-1 text-negative q-mt-md">
          <template #avatar><q-icon name="error" color="negative" /></template>
          {{ queryError }}
        </q-banner>

        <q-table
          v-if="queryResult?.rows.length"
          flat
          bordered
          dense
          class="q-mt-md scroll-x"
          :rows="queryResult.rows"
          :columns="queryColumns"
          row-key="__index"
          :rows-per-page-options="[25, 50, 100, 0]"
        >
          <template #body-cell="props">
            <q-td :props="props" class="mono">{{ props.value ?? '—' }}</q-td>
          </template>
        </q-table>
      </q-card-section>
    </q-card>
  </q-page>
</template>

<style scoped>
/* ---- Schema panel -------------------------------------------------------- */

.schema-panel {
  background: #fafbfd;
}

.schema-table {
  background: transparent;
}

.schema-table :deep(th) {
  font-size: 10.5px;
}

.schema-table :deep(td) {
  font-size: 12px;
}

/* ---- Data grid ----------------------------------------------------------- */

.data-grid :deep(.q-table__middle) {
  max-height: 60vh;
  /* Both axes: a table with more columns than fit was being clipped at the
     card's edge with no way to reach the last one. */
  overflow: auto;
}

/*
 * Columns take their natural width and pack to the left, with the last one
 * absorbing whatever is left over.
 *
 * A full-width table with few columns spreads the slack evenly between them,
 * which pushes related values metres apart and is most of why this read as
 * badly spaced. Packing left keeps a row scannable as one unit.
 */
.data-grid :deep(th),
.data-grid :deep(td) {
  white-space: nowrap;
  width: 1px;
}

.data-grid :deep(th:last-child),
.data-grid :deep(td:last-child) {
  width: 100%;
}

/* Two-line headers: name plus type. Sticky so the column meaning stays visible
   while scrolling a long page of rows. */
.data-grid__th {
  position: sticky;
  top: 0;
  z-index: 1;
  background: #fafbfd;
  border-bottom: 1px solid #e6e9f0;
  vertical-align: bottom;
  padding: 9px 18px 7px 0;
}

.data-grid :deep(th:first-child),
.data-grid :deep(td:first-child) {
  padding-left: 18px;
}

.data-grid__th-name {
  font-size: 12px;
  font-weight: 650;
  color: #1c2434;
  text-transform: none;
  letter-spacing: 0;
}

/* Subordinate to the name in every respect: smaller, lighter, and left in the
   lower case Postgres reports. Uppercasing it with letter-spacing made the
   type read as wider and heavier than the column it describes, and clashed
   with the lower-case identifiers directly above it. */
.data-grid__th-type {
  font-size: 10.5px;
  font-weight: 400;
  color: #9aa3b2;
  text-transform: none;
  letter-spacing: 0;
  margin-top: 1px;
}

.data-grid__td {
  vertical-align: top;
  padding: 9px 18px 9px 0;
  max-width: 380px;
}

.data-grid :deep(tbody td) {
  border-bottom: 1px solid #eef0f5;
}

.data-grid :deep(tbody tr:hover) {
  background: #f7f9fc;
}

.data-grid__value {
  font-size: 12px;
  line-height: 1.5;
  /* Ordinary values stay on one line — a wrapped timestamp reads as two
     separate values and makes every row twice as tall. Only the oversized
     ones below are allowed to wrap. */
  white-space: nowrap;
  border-radius: 4px;
  padding: 1px 4px;
  margin: -1px -4px;
  position: relative;
}

/* One tall cell must not the height of the whole row, so an oversized
   value wraps and scrolls inside its own box. */
.data-grid__value--tall {
  white-space: normal;
  overflow-wrap: anywhere;
  max-height: 84px;
  overflow-y: auto;
  display: block;
  min-width: 260px;
}

.data-grid__value--editable {
  cursor: text;
  border-bottom: 1px dashed transparent;
}

.data-grid__value--editable:hover {
  background: #eef4fb;
  border-bottom-color: #a8c4e4;
}

/* The pencil appears on hover only: on every cell at rest it is visual noise,
   and the dashed underline already marks the column as editable. */
.data-grid__pen {
  opacity: 0;
  margin-left: 4px;
  color: #6b7688;
  transition: opacity 0.12s ease;
}

.data-grid__value--editable:hover .data-grid__pen {
  opacity: 1;
}

.data-grid__null {
  font-size: 11px;
  font-style: italic;
  color: #aab2c0;
}

.data-grid__input {
  min-width: 130px;
}

/* Delete is destructive and per-row, so it stays quiet until the row is
   hovered rather than drawing a column of red down the page. */
.data-grid__delete {
  opacity: 0.3;
  transition: opacity 0.12s ease, color 0.12s ease;
}

.data-grid :deep(tbody tr:hover) .data-grid__delete {
  opacity: 1;
  color: #f04438;
}

.editable-cell {
  cursor: text;
}
</style>

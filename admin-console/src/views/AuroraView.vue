<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { ElMessage, ElMessageBox } from 'element-plus';
import {
  api,
  type AuroraQueryResponse,
  type AuroraRowsResponse,
  type AuroraTablesResponse,
} from '@/api/client';
import { useAsyncValue } from '@/composables/useAsyncValue';
import AsyncValue from '@/components/AsyncValue.vue';
import { useAuthStore } from '@/stores/auth';

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

const sql = ref('SELECT * FROM apps');
const queryResult = ref<AuroraQueryResponse | null>(null);
const queryError = ref<string | null>(null);
const querying = ref(false);

watch(
  () => tables.data.value,
  (data) => {
    if (data && !selectedTable.value && data.tables.length > 0) {
      void openTable(data.tables[0].name);
    }
  },
  { immediate: true }
);

async function loadRows(cursor: string | null) {
  if (!selectedTable.value) return;
  loadingRows.value = true;
  rowsError.value = null;
  try {
    rows.value = await api.auroraRows(selectedTable.value, {
      cursor: cursor ?? undefined,
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

async function nextPage() {
  if (!rows.value?.next_cursor) return;
  pageCursors.value = [...pageCursors.value.slice(0, pageIndex.value + 1), rows.value.next_cursor];
  pageIndex.value += 1;
  await loadRows(rows.value.next_cursor);
}

async function prevPage() {
  if (pageIndex.value === 0) return;
  pageIndex.value -= 1;
  await loadRows(pageCursors.value[pageIndex.value]);
}

const columns = computed(() => rows.value?.columns ?? []);
const primaryKey = computed(() => rows.value?.primary_key ?? '');

const currentTableMeta = computed(() =>
  tables.data.value?.tables.find((table) => table.name === selectedTable.value)
);

/** Edits are admin-only server-side; the UI mirrors that rather than failing late. */
const canEdit = computed(() => auth.isAdmin);

function isBoolean(dataType: string): boolean {
  return dataType === 'boolean';
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
  return `${value.toFixed(value < 10 ? 1 : 0)} ${units[unit]}`;
}

async function commit(pk: string, column: string, value: unknown) {
  if (!selectedTable.value) return;
  saving.value = true;
  try {
    await api.auroraUpdateRow(selectedTable.value, pk, { [column]: value });
    ElMessage.success(`Updated ${column}.`);
    editing.value = null;
    await loadRows(pageCursors.value[pageIndex.value]);
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : 'Update failed.');
  } finally {
    saving.value = false;
  }
}

/** Booleans commit immediately — a switch that needs a save button is a lie. */
async function toggleBoolean(pk: string, column: string, next: boolean) {
  const label = `${column} → ${next}`;
  try {
    await ElMessageBox.confirm(
      `Set ${label} on ${primaryKey.value} "${pk}"? This changes live behaviour immediately.`,
      'Confirm change',
      { confirmButtonText: 'Apply', cancelButtonText: 'Cancel', type: 'warning' }
    );
  } catch {
    return;
  }
  await commit(pk, column, next);
}

const deleting = ref<string | null>(null);

/** Rows may be removed only from tables the server marks deletable, by an admin. */
const canDelete = computed(() => Boolean(rows.value?.deletable) && auth.isAdmin);

/**
 * Deleting is irreversible and both tables here drive live behaviour, so the
 * confirmation asks the operator to retype the primary key. A yes/no dialog is
 * too easy to dismiss reflexively for something with no undo.
 */
async function removeRow(pk: string) {
  if (!selectedTable.value) return;

  try {
    await ElMessageBox.prompt(
      `This permanently deletes the row where ${primaryKey.value} = "${pk}" from ${selectedTable.value}. ` +
        `There is no undo in the console — the deleted record is written to the audit log only. ` +
        `Type the ${primaryKey.value} to confirm.`,
      'Delete row',
      {
        confirmButtonText: 'Delete permanently',
        cancelButtonText: 'Cancel',
        confirmButtonClass: 'el-button--danger',
        inputPlaceholder: pk,
        inputValidator: (value: string) => value === pk || `Type "${pk}" exactly to confirm.`,
        type: 'error',
      }
    );
  } catch {
    return;
  }

  deleting.value = pk;
  try {
    await api.auroraDeleteRow(selectedTable.value, pk);
    ElMessage.success(`Deleted ${primaryKey.value} "${pk}".`);
    await loadRows(pageCursors.value[pageIndex.value]);
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : 'Delete failed.');
  } finally {
    deleting.value = null;
  }
}

function startEdit(pk: string, column: string, current: string | null) {
  editing.value = { pk, column };
  draft.value = current ?? '';
}

function isEditing(pk: string, column: string): boolean {
  return editing.value?.pk === pk && editing.value.column === column;
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
</script>

<template>
  <div>
    <div class="header">
      <div>
        <h1 class="page-title">Aurora PostgreSQL</h1>
        <p class="page-subtitle">
          Browse the public schema, edit the fields that are safe to edit, and run read-only
          queries.
        </p>
      </div>
      <el-button
        :icon="'Refresh'"
        :loading="tables.state.value === 'loading'"
        @click="tables.reload()"
      >
        Refresh
      </el-button>
    </div>

    <div class="layout">
      <!-- Table list -->
      <aside class="card tables">
        <h2 class="card__title">Tables</h2>
        <AsyncValue :state="tables.state.value" :error="tables.error.value">
          <ul class="tablelist">
            <li
              v-for="table in tables.data.value?.tables ?? []"
              :key="table.name"
              class="tablerow"
              :class="{ 'tablerow--active': selectedTable === table.name }"
              @click="openTable(table.name)"
            >
              <div class="tablerow__name">{{ table.name }}</div>
              <div class="tablerow__meta">
                {{ table.column_count }} cols · ~{{ table.estimated_rows }} rows ·
                {{ humanBytes(table.total_bytes) }}
              </div>
              <el-tag
                v-if="table.editable_columns.length"
                size="small"
                type="success"
                effect="plain"
              >
                {{ table.editable_columns.length }} editable
              </el-tag>
            </li>
          </ul>
        </AsyncValue>
      </aside>

      <!-- Data grid -->
      <section class="card data">
        <div class="data__head">
          <h2 class="card__title">
            {{ selectedTable ?? 'Select a table' }}
          </h2>
          <div class="data__actions">
            <el-button size="small" text @click="showStructure = !showStructure">
              {{ showStructure ? 'Hide structure' : 'Show structure' }}
            </el-button>
          </div>
        </div>

        <el-alert
          v-if="rowsError"
          type="error"
          show-icon
          :closable="false"
          class="alert"
          :title="rowsError"
        />

        <!-- Structure -->
        <table v-if="showStructure && columns.length" class="structure">
          <thead>
            <tr>
              <th>Column</th>
              <th>Type</th>
              <th>Nullable</th>
              <th>Default</th>
              <th>Editable</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="column in columns" :key="column.name">
              <td>
                <span class="mono">{{ column.name }}</span>
                <el-tag v-if="column.is_primary_key" size="small" type="warning" effect="plain">
                  PK
                </el-tag>
              </td>
              <td class="muted mono">{{ column.data_type }}</td>
              <td class="muted">{{ column.nullable ? 'yes' : 'NOT NULL' }}</td>
              <td class="muted mono trunc">{{ column.default_value ?? '—' }}</td>
              <td>
                <span :class="column.editable ? 'yes' : 'muted'">
                  {{ column.editable ? 'yes' : 'read-only' }}
                </span>
              </td>
            </tr>
          </tbody>
        </table>

        <!-- Rows -->
        <div v-loading="loadingRows" class="tableWrap">
          <table v-if="rows" class="grid">
            <thead>
              <tr>
                <th v-for="column in columns" :key="column.name">
                  <div class="th">
                    <span class="th__name">{{ column.name }}</span>
                    <span class="th__type">{{ column.data_type }}</span>
                  </div>
                  <div class="th__badges">
                    <span v-if="column.is_primary_key" class="badge badge--pk">PK</span>
                    <span v-if="!column.nullable" class="badge">NOT NULL</span>
                    <span v-if="column.editable" class="badge badge--edit">editable</span>
                  </div>
                </th>
                <th v-if="canDelete" class="actionsCol" />
              </tr>
            </thead>
            <tbody>
              <tr v-for="row in rows.rows" :key="String(row[primaryKey])">
                <td v-for="column in columns" :key="column.name" class="cell">
                  <!-- Booleans: a switch, committed on change -->
                  <el-switch
                    v-if="column.editable && canEdit && isBoolean(column.data_type)"
                    :model-value="row[column.name] === 'true'"
                    :loading="saving"
                    @change="
                      (value: boolean) => toggleBoolean(String(row[primaryKey]), column.name, value)
                    "
                  />

                  <!-- Editable text: click to edit -->
                  <template v-else-if="column.editable && canEdit">
                    <div v-if="isEditing(String(row[primaryKey]), column.name)" class="editcell">
                      <el-input v-model="draft" size="small" />
                      <el-button
                        size="small"
                        type="primary"
                        :loading="saving"
                        @click="commit(String(row[primaryKey]), column.name, draft)"
                      >
                        Save
                      </el-button>
                      <el-button size="small" text @click="editing = null">Cancel</el-button>
                    </div>
                    <button
                      v-else
                      type="button"
                      class="editable"
                      @click="startEdit(String(row[primaryKey]), column.name, row[column.name])"
                    >
                      {{ row[column.name] ?? '—' }}
                      <el-icon class="editable__pen"><EditPen /></el-icon>
                    </button>
                  </template>

                  <!-- Everything else: read-only -->
                  <span v-else class="value" :class="{ 'value--null': row[column.name] === null }">
                    {{ row[column.name] === null ? 'NULL' : row[column.name] }}
                  </span>
                </td>
                <td v-if="canDelete" class="cell actionsCol">
                  <el-button
                    link
                    type="danger"
                    size="small"
                    :loading="deleting === String(row[primaryKey])"
                    @click="removeRow(String(row[primaryKey]))"
                  >
                    Delete
                  </el-button>
                </td>
              </tr>
            </tbody>
          </table>
        </div>

        <div v-if="rows && rows.rows.length === 0" class="empty">This table is empty.</div>

        <div v-if="rows" class="pager">
          <el-button size="small" :disabled="pageIndex === 0 || loadingRows" @click="prevPage">
            Previous
          </el-button>
          <span class="pager__label">Page {{ pageIndex + 1 }}</span>
          <el-button
            size="small"
            :disabled="!rows.next_cursor || loadingRows"
            @click="nextPage"
          >
            Next
          </el-button>
          <span v-if="!canEdit && currentTableMeta?.editable_columns.length" class="pager__note">
            Editing requires the admin role.
          </span>
        </div>
      </section>
    </div>

    <!-- SQL runner -->
    <section class="card runner">
      <h2 class="card__title">Query</h2>
      <p class="card__lede">
        Runs inside a read-only transaction with a statement timeout, so the database itself
        refuses anything that writes — including data-modifying CTEs. Results are capped at 200
        rows.
      </p>

      <el-input v-model="sql" type="textarea" :rows="4" spellcheck="false" class="sql" />

      <div class="actions">
        <el-button type="primary" :loading="querying" @click="runSql">Run</el-button>
        <span v-if="queryResult" class="stats">
          {{ queryResult.row_count }} rows · {{ queryResult.duration_ms }} ms
          <template v-if="queryResult.capped"> · capped at {{ queryResult.limit }}</template>
        </span>
      </div>

      <el-alert
        v-if="queryError"
        type="error"
        show-icon
        :closable="false"
        class="alert"
        :title="queryError"
      />

      <div v-if="queryResult && queryResult.rows.length" class="tableWrap">
        <table class="grid">
          <thead>
            <tr>
              <th v-for="column in queryResult.columns" :key="column">{{ column }}</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="(row, index) in queryResult.rows" :key="index">
              <td v-for="column in queryResult.columns" :key="column" class="cell">
                <span class="value" :class="{ 'value--null': row[column] === null }">
                  {{ row[column] === null ? 'NULL' : row[column] }}
                </span>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </section>
  </div>
</template>

<style scoped>
.header {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 16px;
}

.layout {
  display: grid;
  grid-template-columns: 230px minmax(0, 1fr);
  gap: 16px;
  align-items: start;
}

@media (max-width: 1000px) {
  .layout {
    grid-template-columns: 1fr;
  }
}

.tablelist {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 4px;
  /* Bounded so the card stays a fixed height as the schema grows. */
  max-height: 440px;
  overflow-y: auto;
  /* Room for the scrollbar so it never sits on top of the badges. */
  padding-right: 4px;
}

.tablerow {
  padding: 10px;
  border-radius: 8px;
  cursor: pointer;
  transition: background 0.12s ease;
}

.tablerow:hover,
.tablerow--active {
  background: var(--page-bg);
}

.tablerow__name {
  font-size: 13px;
  font-weight: 600;
  font-family: 'SF Mono', ui-monospace, monospace;
}

.tablerow__meta {
  font-size: 10.5px;
  color: var(--text-muted);
  margin: 3px 0 5px;
}

.data__head {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
}

.tableWrap {
  overflow-x: auto;
  margin-top: 12px;
}

.grid,
.structure {
  width: 100%;
  border-collapse: collapse;
}

.grid th,
.structure th {
  text-align: left;
  padding: 0 14px 8px 0;
  border-bottom: 1px solid var(--border);
  vertical-align: bottom;
  white-space: nowrap;
}

.structure th {
  font-size: 10px;
  font-weight: 700;
  letter-spacing: 0.06em;
  text-transform: uppercase;
  color: var(--text-muted);
}

.structure td {
  padding: 7px 14px 7px 0;
  font-size: 12px;
  border-bottom: 1px solid var(--border);
}

.structure {
  margin-top: 12px;
}

.th {
  display: flex;
  flex-direction: column;
  gap: 1px;
}

.th__name {
  font-size: 12px;
  font-weight: 650;
}

.th__type {
  font-size: 9.5px;
  color: var(--text-muted);
  font-weight: 400;
  text-transform: none;
  letter-spacing: 0;
}

.th__badges {
  display: flex;
  gap: 3px;
  margin-top: 4px;
}

.badge {
  font-size: 8.5px;
  font-weight: 700;
  letter-spacing: 0.04em;
  text-transform: uppercase;
  color: var(--text-muted);
  border: 1px solid var(--border);
  border-radius: 3px;
  padding: 0 4px;
}

.badge--pk {
  color: var(--warn);
  border-color: var(--warn);
}

.badge--edit {
  color: var(--ok);
  border-color: var(--ok);
}

.cell {
  padding: 8px 14px 8px 0;
  font-size: 12px;
  border-bottom: 1px solid var(--border);
  vertical-align: top;
  max-width: 360px;
}

/*
 * A single JSONB column can hold a whole MAP message, which would otherwise
 * stretch one row to several screens and push every other row out of view.
 * Cap the height and let that one cell scroll, so row height stays uniform and
 * the grid remains scannable regardless of what any column contains.
 */
.value {
  display: block;
  font-family: 'SF Mono', ui-monospace, monospace;
  overflow-wrap: anywhere;
  max-height: 76px;
  overflow-y: auto;
  line-height: 1.55;
}

.value::-webkit-scrollbar {
  width: 6px;
}

.value::-webkit-scrollbar-thumb {
  background: var(--border);
  border-radius: 3px;
}

.value:hover::-webkit-scrollbar-thumb {
  background: var(--text-muted);
}

.value--null {
  color: var(--text-muted);
  font-style: italic;
}

.editable {
  display: inline-flex;
  align-items: flex-start;
  gap: 6px;
  background: transparent;
  border: 1px dashed var(--border);
  border-radius: 5px;
  padding: 3px 7px;
  font: inherit;
  font-family: 'SF Mono', ui-monospace, monospace;
  font-size: 12px;
  color: var(--text);
  cursor: pointer;
  text-align: left;
  /* Same height cap as a read-only cell — an editable column with a long value
     must not be the one row that breaks the grid's rhythm. */
  max-width: 100%;
  max-height: 76px;
  overflow-y: auto;
  overflow-wrap: anywhere;
}

.editable:hover {
  border-color: var(--accent);
  border-style: solid;
}

.editable__pen {
  font-size: 11px;
  color: var(--text-muted);
}

.editcell {
  display: flex;
  align-items: center;
  gap: 6px;
}

.actionsCol {
  width: 74px;
  text-align: right;
  padding-right: 0 !important;
}

.pager {
  display: flex;
  align-items: center;
  gap: 10px;
  margin-top: 14px;
}

.pager__label,
.pager__note {
  font-size: 11.5px;
  color: var(--text-muted);
}

.pager__note {
  margin-left: auto;
}

.runner {
  margin-top: 16px;
}

.card__lede {
  margin: -6px 0 14px;
  font-size: 12px;
  color: var(--text-muted);
  line-height: 1.6;
}

.sql :deep(textarea) {
  font-family: 'SF Mono', ui-monospace, monospace;
  font-size: 12px;
}

.actions {
  display: flex;
  align-items: center;
  gap: 12px;
  margin-top: 12px;
}

.stats {
  font-size: 11.5px;
  color: var(--text-muted);
}

.alert {
  margin-top: 12px;
}

.muted {
  color: var(--text-muted);
}

.yes {
  color: var(--ok);
}

.trunc {
  max-width: 220px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
</style>

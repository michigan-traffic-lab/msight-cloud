import { createHash, randomBytes } from 'node:crypto';
import { HttpError } from '../../../shared/admin-api/http';
import { ensureMicroserviceSchema } from '../../../shared/microservice-schema';
import { getPool } from './db';

/**
 * Long-lived credentials for the MCP endpoint.
 *
 * The console's own credential is a Cognito ID token that lives an hour, which
 * is right for a browser and useless for a desktop MCP client: that
 * configuration is a file read once at startup, with nowhere to put a refresh.
 * A token pasted there is stale before its second use.
 *
 * So this issues a credential shaped for that job — long-lived, revocable, and
 * carrying a role of its own rather than impersonating the person who made it.
 * Two consequences follow from the role being on the token:
 *
 *   * Revoking one is a single row, and takes nothing else with it. Revoking a
 *     person's session would log them out of the console as well.
 *   * A token cannot outrank its issuer, and does not inherit later promotions
 *     or demotions. What it could do on the day it was made is what it can do,
 *     until somebody revokes it.
 *
 * Only the hash is stored. The plaintext exists in exactly one response and is
 * never recoverable, which is why the console has to say so at the moment it
 * shows it.
 */

export type McpRole = 'admin' | 'operator' | 'viewer';

const ROLE_RANK: Record<McpRole, number> = { admin: 1, operator: 2, viewer: 3 };

/**
 * A recognisable prefix, then 32 bytes of randomness.
 *
 * The prefix is worth the eight characters it costs: a token found in a config
 * file, a log, or a paste is immediately identifiable as this system's, which
 * is what makes an accidental disclosure actionable instead of puzzling. It is
 * also what secret scanners key on.
 */
const TOKEN_PREFIX = 'msight_mcp_';

/** Enough entropy that guessing is not a threat model worth discussing. */
const TOKEN_BYTES = 32;

function hashOf(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

export interface McpTokenRow {
  name: string;
  role: McpRole;
  /** The first few characters of the token, for recognising it in a config. */
  hint: string;
  created_by: string;
  created_at: string;
  expires_at: string | null;
  last_used_at: string | null;
  revoked_at: string | null;
  /** Derived, so the console does not have to reimplement the same comparison. */
  active: boolean;
}

const COLUMNS = `name, role, hint, created_by, created_at, expires_at, last_used_at, revoked_at`;

function toRow(row: Record<string, unknown>): McpTokenRow {
  const iso = (value: unknown): string | null =>
    value === null || value === undefined ? null : new Date(value as string).toISOString();

  const expiresAt = iso(row.expires_at);
  const revokedAt = iso(row.revoked_at);

  return {
    name: String(row.name),
    role: String(row.role) as McpRole,
    hint: String(row.hint),
    created_by: String(row.created_by),
    created_at: new Date(row.created_at as string).toISOString(),
    expires_at: expiresAt,
    last_used_at: iso(row.last_used_at),
    revoked_at: revokedAt,
    active: revokedAt === null && (expiresAt === null || Date.parse(expiresAt) > Date.now()),
  };
}

async function ensureSchema(): Promise<void> {
  await ensureMicroserviceSchema(await getPool());
}

export function tokenNameProblem(name: string): string | null {
  const trimmed = name.trim();
  if (trimmed.length < 2 || trimmed.length > 60) {
    return 'A token name must be 2-60 characters. It is only a label, but it is the only way to tell two tokens apart.';
  }
  return null;
}

export interface CreateTokenInput {
  name: string;
  /** At or below the issuer's own role. */
  role: McpRole;
  /** Null never expires, which is the point of the credential. */
  expiresInDays?: number | null | undefined;
  actor: string;
  actorRole: McpRole;
}

export async function createMcpToken(input: CreateTokenInput): Promise<{
  /** Returned once and never again. */
  token: string;
  row: McpTokenRow;
}> {
  await ensureSchema();

  const problem = tokenNameProblem(input.name);
  if (problem) throw new HttpError(400, 'invalid_name', problem);

  /**
   * A token cannot outrank the person making it.
   *
   * Without this, an operator could mint themselves an admin credential and the
   * role system would be decoration. Checked here rather than at the route
   * because it is a property of issuing a token, not of one HTTP verb.
   */
  if (ROLE_RANK[input.role] < ROLE_RANK[input.actorRole]) {
    throw new HttpError(
      403,
      'role_above_issuer',
      `You hold "${input.actorRole}" and cannot issue a "${input.role}" token. A token may ` +
        'carry at most the role of whoever created it.'
    );
  }

  const token = `${TOKEN_PREFIX}${randomBytes(TOKEN_BYTES).toString('base64url')}`;
  const hint = token.slice(0, TOKEN_PREFIX.length + 6);

  const pool = await getPool();
  let rows: Record<string, unknown>[];
  try {
    ({ rows } = await pool.query(
      `INSERT INTO mcp_tokens (token_hash, name, role, hint, created_by, expires_at)
            VALUES ($1, $2, $3, $4, $5,
                    CASE WHEN $6::int IS NULL THEN NULL
                         ELSE NOW() + ($6::int * INTERVAL '1 day') END)
         RETURNING ${COLUMNS}`,
      [hashOf(token), input.name.trim(), input.role, hint, input.actor, input.expiresInDays ?? null]
    ));
  } catch (caught) {
    /**
     * A name identifies at most one live token, enforced by a partial unique
     * index. Reported as a conflict rather than a 500 because it is an ordinary
     * thing to do — the fix is to pick another name, or revoke the one in the
     * way, and the caller can only be told that if the error says so.
     */
    if ((caught as { code?: string }).code === '23505') {
      throw new HttpError(
        409,
        'name_in_use',
        `A live token is already called "${input.name.trim()}". Revoke it first, or choose ` +
          'another name — the name is how a token is revoked, so two cannot share one.'
      );
    }
    throw caught;
  }

  // The token itself is deliberately absent: it is the one thing that must not
  // reach CloudWatch, where it would outlive every rotation.
  console.log(
    JSON.stringify({
      event: 'mcp_token_created',
      actor: input.actor,
      name: input.name.trim(),
      role: input.role,
      hint,
      expires_in_days: input.expiresInDays ?? null,
    })
  );

  return { token, row: toRow(rows[0]) };
}

export async function listMcpTokens(): Promise<McpTokenRow[]> {
  await ensureSchema();
  const pool = await getPool();
  const { rows } = await pool.query(
    `SELECT ${COLUMNS} FROM mcp_tokens ORDER BY created_at DESC`
  );
  return rows.map(toRow);
}

/**
 * Revokes by name rather than by hash, because the hash is not something the
 * console holds — it only ever saw the row.
 */
export async function revokeMcpToken(input: { name: string; actor: string }): Promise<McpTokenRow> {
  await ensureSchema();
  const pool = await getPool();

  /**
   * Scoped to the live row.
   *
   * A name is unique only among tokens that are not revoked, so an unqualified
   * UPDATE would also rewrite the revocation timestamps of every retired token
   * that once held the name — losing the one fact those rows are kept for.
   */
  const { rows } = await pool.query(
    `UPDATE mcp_tokens
        SET revoked_at = NOW()
      WHERE name = $1 AND revoked_at IS NULL
      RETURNING ${COLUMNS}`,
    [input.name]
  );

  if (rows.length === 0) {
    // Either it never existed or it is already revoked. Both leave the caller
    // where they wanted to be, but they are different mistakes and the message
    // should say which one was made.
    const { rows: existing } = await pool.query(
      `SELECT ${COLUMNS} FROM mcp_tokens WHERE name = $1 ORDER BY created_at DESC LIMIT 1`,
      [input.name]
    );

    if (existing.length === 0) {
      throw new HttpError(404, 'token_not_found', `No MCP token named "${input.name}".`);
    }
    throw new HttpError(
      409,
      'token_already_revoked',
      `The token named "${input.name}" was already revoked.`
    );
  }

  console.log(
    JSON.stringify({ event: 'mcp_token_revoked', actor: input.actor, name: input.name })
  );

  return toRow(rows[0]);
}

export interface VerifiedToken {
  name: string;
  role: McpRole;
  created_by: string;
}

/**
 * How often a token's last-use timestamp is written back.
 *
 * "When was this last used" only has to be accurate enough to answer "is
 * anything still using this"; a write on every call would put an UPDATE on the
 * hot path of a credential check for a figure nobody reads to the minute.
 */
const LAST_USED_WRITE_EVERY_MS = 60_000;

/**
 * Checks a presented token, or explains why it is no good.
 *
 * Returns null for every failure rather than distinguishing them: the caller is
 * an authorizer answering an unauthenticated request, and "no such token"
 * against "that token was revoked" is a difference worth keeping out of the
 * response. The reasons are logged instead, where an operator can see them and
 * a caller cannot.
 */
export async function verifyMcpToken(presented: string): Promise<VerifiedToken | null> {
  const token = presented.trim();
  if (!token.startsWith(TOKEN_PREFIX)) return null;

  await ensureSchema();
  const pool = await getPool();

  const { rows } = await pool.query(
    `SELECT name, role, created_by, expires_at, revoked_at, last_used_at
       FROM mcp_tokens
      WHERE token_hash = $1`,
    [hashOf(token)]
  );

  if (rows.length === 0) return null;

  const row = rows[0];
  if (row.revoked_at !== null) {
    console.log(JSON.stringify({ event: 'mcp_token_rejected', reason: 'revoked', name: row.name }));
    return null;
  }
  if (row.expires_at !== null && new Date(row.expires_at as string).getTime() <= Date.now()) {
    console.log(JSON.stringify({ event: 'mcp_token_rejected', reason: 'expired', name: row.name }));
    return null;
  }

  const lastUsed = row.last_used_at ? new Date(row.last_used_at as string).getTime() : 0;
  if (Date.now() - lastUsed > LAST_USED_WRITE_EVERY_MS) {
    // Not awaited on the critical path's behalf — but awaited here, because a
    // Lambda that returns before its promises settle drops them.
    await pool.query(`UPDATE mcp_tokens SET last_used_at = NOW() WHERE token_hash = $1`, [
      hashOf(token),
    ]);
  }

  return {
    name: String(row.name),
    role: String(row.role) as McpRole,
    created_by: String(row.created_by),
  };
}

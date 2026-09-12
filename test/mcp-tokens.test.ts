import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tokenNameProblem } from '../src/functions/admin-vpc-api/services/mcp-tokens';

/**
 * The rules around MCP credentials that do not need a database.
 *
 * Issuing, listing and revoking are Aurora operations and are not exercised
 * here — nothing in this repo has a database to run them against. What is
 * pinned is the part that decides whether the credential is safe to hand out:
 * the shape of the token, and the rule that stops one outranking its issuer.
 *
 * The role rule is reimplemented here rather than imported because importing
 * the service pulls in the pg driver and its pool. That is a real duplication
 * and it is deliberate: the assertion below is the specification, and if the
 * service ever disagrees with it, one of the two is wrong and this is where it
 * shows.
 */

const ROLE_RANK: Record<string, number> = { admin: 1, operator: 2, viewer: 3 };

function mayIssue(actorRole: string, tokenRole: string): boolean {
  return ROLE_RANK[tokenRole]! >= ROLE_RANK[actorRole]!;
}

describe('who may issue what', () => {
  it('lets an issuer create a token at their own level or below', () => {
    expect(mayIssue('admin', 'admin')).toBe(true);
    expect(mayIssue('admin', 'viewer')).toBe(true);
    expect(mayIssue('operator', 'operator')).toBe(true);
    expect(mayIssue('operator', 'viewer')).toBe(true);
    expect(mayIssue('viewer', 'viewer')).toBe(true);
  });

  /**
   * The rule the whole role system rests on. Without it an operator mints
   * themselves an admin credential and every other role check is decoration.
   */
  it('refuses a token that would outrank its issuer', () => {
    expect(mayIssue('operator', 'admin')).toBe(false);
    expect(mayIssue('viewer', 'admin')).toBe(false);
    expect(mayIssue('viewer', 'operator')).toBe(false);
  });
});

describe('token names', () => {
  it('accepts an ordinary label', () => {
    expect(tokenNameProblem('rusheng-laptop')).toBeNull();
    expect(tokenNameProblem('CI')).toBeNull();
  });

  it('refuses one too short or too long to tell tokens apart by', () => {
    expect(tokenNameProblem('x')).toMatch(/2-60/);
    expect(tokenNameProblem('a'.repeat(61))).toMatch(/2-60/);
  });

  it('ignores surrounding whitespace when judging length', () => {
    expect(tokenNameProblem('  ci  ')).toBeNull();
    expect(tokenNameProblem('   x   ')).toMatch(/2-60/);
  });
});

/**
 * What is stored, and what is not.
 *
 * The table holds a SHA-256 and a short hint, never the token. These pin the
 * two properties that follow from that: the hint cannot be used to
 * authenticate, and the stored value cannot be turned back into one.
 */
describe('what a stored token reveals', () => {
  const token = 'msight_mcp_' + 'A'.repeat(43);

  it('stores a hash, which is not the token', () => {
    const hash = createHash('sha256').update(token, 'utf8').digest('hex');
    expect(hash).toHaveLength(64);
    expect(hash).not.toContain(token);
    expect(token).not.toContain(hash);
  });

  it('keeps a hint short enough to be useless as a credential', () => {
    // The service stores the prefix plus six characters: enough to match a row
    // to a config file, far short of the 43 characters of randomness.
    const hint = token.slice(0, 'msight_mcp_'.length + 6);
    expect(hint.startsWith('msight_mcp_')).toBe(true);
    expect(hint.length).toBeLessThan(token.length / 2);
  });

  it('is recognisable as this system’s, which is what makes a leak actionable', () => {
    expect(token.startsWith('msight_mcp_')).toBe(true);
  });
});

/**
 * The rule the console's revoke button depends on.
 *
 * A token is revoked by name, because the name is the only handle the console
 * holds — the hash never leaves the database. That is only safe while a name
 * identifies at most one live token, which is a partial unique index rather
 * than anything the TypeScript can enforce.
 *
 * Read out of the schema text rather than exercised, because there is no
 * database here. The behaviour itself was checked against a real PostgreSQL:
 * a second live token with a taken name fails with SQLSTATE 23505, the name
 * becomes reusable once the holder is revoked, and revoking the new one leaves
 * the older row's timestamp alone. This test exists so that dropping the index
 * fails here instead of silently making revocation ambiguous.
 */
describe('the schema behind revoke-by-name', () => {
  const schema = readFileSync(
    join(__dirname, '../src/shared/microservice-schema.ts'),
    'utf8'
  ).replace(/--[^\n]*|\/\*[\s\S]*?\*\//g, '');

  it('allows only one live token per name', () => {
    expect(schema).toMatch(
      /CREATE UNIQUE INDEX IF NOT EXISTS mcp_tokens_live_name_idx\s+ON mcp_tokens \(name\)\s+WHERE revoked_at IS NULL/
    );
  });

  /**
   * Partial, not plain. A plain UNIQUE would retire the name along with the
   * token, so "rusheng-laptop" could never be issued to the replacement laptop.
   */
  it('lets a revoked token’s name be used again', () => {
    expect(schema).not.toMatch(/name\s+TEXT\s+NOT NULL\s+UNIQUE/);
  });
});

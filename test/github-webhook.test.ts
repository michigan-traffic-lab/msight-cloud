import { createHmac } from 'node:crypto';
import { pushFactsFrom, signatureMatches } from '../src/functions/github-webhook/handler';

/**
 * The webhook receiver.
 *
 * This is the only unauthenticated entry point in the deployment that can cause
 * a deployment, so the two things pinned here are the two that decide whether a
 * request gets to: whether the signature really proves the App sent it, and
 * what counts as a push worth acting on.
 *
 * The forwarding half is not exercised — it invokes another Lambda, and there
 * is none here. What it forwards to is `handlePushEvent`, which is a database
 * operation and equally untestable without one.
 */

const SECRET = 'a-webhook-secret';

function sign(body: string, secret = SECRET): string {
  return `sha256=${createHmac('sha256', secret).update(body, 'utf8').digest('hex')}`;
}

describe('proving a delivery came from GitHub', () => {
  const body = JSON.stringify({ ref: 'refs/heads/main' });

  it('accepts a body signed with the configured secret', () => {
    expect(signatureMatches({ body, header: sign(body), secret: SECRET })).toBe(true);
  });

  /**
   * The attack this exists to stop: anyone can POST to this URL, so a forged
   * body must not be able to trigger a build.
   */
  it('refuses a body signed with the wrong secret', () => {
    expect(signatureMatches({ body, header: sign(body, 'not-the-secret'), secret: SECRET })).toBe(
      false
    );
  });

  it('refuses a body that changed after it was signed', () => {
    const header = sign(body);
    const tampered = JSON.stringify({ ref: 'refs/heads/attacker' });
    expect(signatureMatches({ body: tampered, header, secret: SECRET })).toBe(false);
  });

  it('refuses a delivery with no signature at all', () => {
    expect(signatureMatches({ body, header: undefined, secret: SECRET })).toBe(false);
    expect(signatureMatches({ body, header: '', secret: SECRET })).toBe(false);
  });

  /**
   * `sha1=` is GitHub's older header, sent on `X-Hub-Signature`. Accepting a
   * digest whose algorithm the caller chose would let one of them be downgraded
   * to the weaker of the two.
   */
  it('refuses a digest that is not sha256', () => {
    const sha1 = `sha1=${createHmac('sha1', SECRET).update(body, 'utf8').digest('hex')}`;
    expect(signatureMatches({ body, header: sha1, secret: SECRET })).toBe(false);
  });

  /**
   * The comparison is timing-safe, and `timingSafeEqual` throws on unequal
   * lengths rather than returning false. A truncated header must therefore be
   * rejected before it reaches the comparison — not crash the function, which
   * API Gateway would answer 502.
   */
  it('refuses a truncated signature without throwing', () => {
    expect(signatureMatches({ body, header: 'sha256=abc', secret: SECRET })).toBe(false);
  });

  it('signs the exact bytes, so whitespace is not equivalent', () => {
    const compact = '{"ref":"refs/heads/main"}';
    const spaced = '{ "ref": "refs/heads/main" }';
    expect(signatureMatches({ body: spaced, header: sign(compact), secret: SECRET })).toBe(false);
  });
});

describe('what counts as a push worth acting on', () => {
  const push = (overrides: Record<string, unknown> = {}) => ({
    ref: 'refs/heads/main',
    after: 'a'.repeat(40),
    repository: { full_name: 'msight/example' },
    pusher: { name: 'git-identity' },
    sender: { login: 'rusheng' },
    head_commit: { message: 'fix the thing\n\nwith a longer body' },
    ...overrides,
  });

  it('reads the branch, commit and repository off an ordinary push', () => {
    const facts = pushFactsFrom(push());
    expect(facts).toEqual({
      repoFullName: 'msight/example',
      branch: 'main',
      commitSha: 'a'.repeat(40),
      pusher: 'rusheng',
      message: 'fix the thing',
    });
  });

  it('keeps a branch name containing slashes intact', () => {
    const facts = pushFactsFrom(push({ ref: 'refs/heads/feature/microservices' }));
    expect(facts).toMatchObject({ branch: 'feature/microservices' });
  });

  /**
   * `pusher.name` is a git identity and can be set to anything locally;
   * `sender.login` is the GitHub account that caused the delivery. Preferring
   * the login means the history attributes a deploy to a real account.
   */
  it('attributes the push to the GitHub account, not the git identity', () => {
    expect(pushFactsFrom(push())).toMatchObject({ pusher: 'rusheng' });
  });

  it('falls back to the git identity when there is no sender', () => {
    expect(pushFactsFrom(push({ sender: {} }))).toMatchObject({ pusher: 'git-identity' });
  });

  describe('pushes that are not rebuilds', () => {
    it('skips a tag', () => {
      expect(pushFactsFrom(push({ ref: 'refs/tags/v1.0.0' }))).toEqual({
        skip: 'a tag, not a branch',
      });
    });

    /**
     * A branch deletion arrives as a push. Rebuilding a branch that no longer
     * exists can only fail, and would do so on every delete.
     */
    it('skips a deleted branch', () => {
      expect(pushFactsFrom(push({ deleted: true }))).toEqual({ skip: 'the branch was deleted' });
    });

    it('skips a push whose head is the all-zero sha', () => {
      expect(pushFactsFrom(push({ after: '0'.repeat(40) }))).toEqual({
        skip: 'the push has no head commit',
      });
    });

    it('skips a payload that names no repository', () => {
      expect(pushFactsFrom(push({ repository: {} }))).toEqual({
        skip: 'the payload names no repository',
      });
    });
  });

  /**
   * A branch push with no head commit object is legitimate — it is what a
   * force-push to an existing commit looks like — and must still rebuild.
   */
  it('acts on a push with no head commit object', () => {
    expect(pushFactsFrom(push({ head_commit: null }))).toMatchObject({
      branch: 'main',
      message: null,
    });
  });
});

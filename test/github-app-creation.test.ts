import { HttpError } from '../src/shared/admin-api/http';
import type { ManifestConversion } from '../src/shared/github/rpc';

/**
 * Creating a GitHub App from the one-click manifest flow.
 *
 * There is a race in that flow that GitHub loses reliably rather than
 * occasionally: for a second or two after a manifest conversion, `GET /app`
 * answers 404 "Integration not found" for an App that exists and whose private
 * key already works. Read once and the whole connection fails — which is what
 * happened, twice out of two attempts, with the App sitting healthy on GitHub
 * and its webhook already firing.
 *
 * These pin the retry that fixes it, and the two ways it must NOT behave:
 * it must not retry a refusal that means what it says, and it must not fail
 * after a credential has already been stored.
 */

const verifyApp = jest.fn();

jest.mock('../src/functions/admin-vpc-api/services/github-client', () => ({
  verifyApp: (...args: unknown[]) => verifyApp(...args),
  convertManifest: jest.fn(),
  deleteInstallation: jest.fn(),
  getInstallation: jest.fn(),
  listInstallationRepos: jest.fn(),
}));

// Imported after the mock so the module under test binds to it.
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { verifyFreshApp } = require('../src/functions/admin-vpc-api/services/github-app') as {
  verifyFreshApp: (created: ManifestConversion) => Promise<Record<string, unknown>>;
};

const CREATED: ManifestConversion = {
  app_id: 4924214,
  slug: 'msight-cloud',
  name: 'MSight Cloud',
  html_url: 'https://github.com/apps/msight-cloud',
  owner_login: 'beedrill',
  owner_type: 'User',
  pem: '-----BEGIN RSA PRIVATE KEY-----',
  webhook_secret: 's3cret',
  permissions: { contents: 'read' },
  events: ['push'],
};

const PUBLISHED = {
  app_id: 4924214,
  slug: 'msight-cloud',
  name: 'MSight Cloud',
  html_url: 'https://github.com/apps/msight-cloud',
  owner_login: 'beedrill',
  owner_type: 'User',
  permissions: { contents: 'read', metadata: 'read' },
  events: ['push'],
};

const notFound = () =>
  new HttpError(404, 'repo_not_found', 'GitHub has no such resource (reading the App identity).');

beforeEach(() => {
  verifyApp.mockReset();
  jest.useFakeTimers();
});

afterEach(() => {
  jest.useRealTimers();
});

/**
 * Lets the retry's timers elapse without the test waiting seven real seconds.
 *
 * The outcome is captured into a plain object before the timers are advanced.
 * Attaching the handler first is the point: a rejection that happens while the
 * fake clock is being wound forward would otherwise be an unhandled rejection,
 * which Jest fails the test for regardless of what the assertion says.
 */
async function settle<T>(promise: Promise<T>): Promise<{ value?: T; error?: unknown }> {
  const outcome = promise.then(
    (value) => ({ value }),
    (error: unknown) => ({ error })
  );
  await jest.runAllTimersAsync();
  return outcome;
}

describe('reading back an App that was just created', () => {
  it('returns the identity when GitHub answers first time', async () => {
    verifyApp.mockResolvedValueOnce(PUBLISHED);

    expect((await settle(verifyFreshApp(CREATED))).value).toEqual(PUBLISHED);
    expect(verifyApp).toHaveBeenCalledTimes(1);
  });

  /**
   * The actual bug. One 404 used to fail the whole connection, leaving the
   * private key in Secrets Manager and no row in the database — a deployment
   * that reported itself unconfigured while holding a working App.
   */
  it('retries a 404 and succeeds once GitHub publishes the App', async () => {
    verifyApp
      .mockRejectedValueOnce(notFound())
      .mockRejectedValueOnce(notFound())
      .mockResolvedValueOnce(PUBLISHED);

    expect((await settle(verifyFreshApp(CREATED))).value).toEqual(PUBLISHED);
    expect(verifyApp).toHaveBeenCalledTimes(3);
  });

  /**
   * A credential has already been written by the time this runs. Failing here
   * would recreate the half-configured state the retry exists to prevent, and
   * the manifest response is not a guess — it is GitHub's own description of
   * the App, from the exchange that produced the private key.
   */
  it('records the App from the manifest when GitHub never publishes it', async () => {
    verifyApp.mockRejectedValue(notFound());

    const identity = (await settle(verifyFreshApp(CREATED))).value!;

    expect(identity).toMatchObject({
      app_id: 4924214,
      slug: 'msight-cloud',
      owner_login: 'beedrill',
      owner_type: 'User',
      events: ['push'],
    });
    // The private key is not part of an identity and must not leak into one.
    expect(identity).not.toHaveProperty('pem');
    expect(identity).not.toHaveProperty('webhook_secret');
  });

  /**
   * Retrying these would turn a clear error into a slow one, and the fallback
   * would record an App whose stored key genuinely does not work.
   */
  describe('refusals that mean what they say', () => {
    it.each([
      [401, 'bad_credentials'],
      [403, 'insufficient_permission'],
      [429, 'rate_limited'],
      [502, 'github_unavailable'],
    ])('raises a %s immediately', async (status, code) => {
      verifyApp.mockRejectedValue(new HttpError(status, code, 'nope'));

      expect((await settle(verifyFreshApp(CREATED))).error).toMatchObject({ status });
      expect(verifyApp).toHaveBeenCalledTimes(1);
    });
  });

  it('gives up rather than retrying forever', async () => {
    verifyApp.mockRejectedValue(notFound());

    await settle(verifyFreshApp(CREATED));

    // Four attempts over roughly seven seconds — inside the Lambda's timeout
    // and inside the patience of whoever is watching the browser.
    expect(verifyApp).toHaveBeenCalledTimes(4);
  });
});

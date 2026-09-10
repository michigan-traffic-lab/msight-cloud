import { z } from 'zod';
import { ok, parseWith, readJsonBody } from '../../../shared/admin-api/http';
import { requireRole } from '../../../shared/admin-api/middleware/require-role';
import { Router } from '../../../shared/admin-api/router';
import {
  appStatus,
  completeInstall,
  completeManifest,
  createManifestIntent,
  createInstallIntent,
  forgetApp,
  installationRepositories,
  listInstallations,
  removeInstallation,
  saveApp,
} from '../services/github-app';

const SaveAppSchema = z.object({
  // A string rather than a number: App ids are pasted from a settings page and
  // arrive quoted about as often as not.
  app_id: z.coerce.number().int().positive(),
  private_key: z.string().min(64),
  webhook_secret: z.string().max(256).nullable().optional(),
});

const CompleteInstallSchema = z.object({
  installation_id: z.coerce.number().int().positive(),
  state: z.string().min(16).max(256),
});

const ManifestIntentSchema = z.object({
  /**
   * Create the App under an organisation instead of the admin's own account.
   * Only changes which GitHub URL the form posts to — GitHub decides whether
   * this person may create an App there, and says so on its own page.
   */
  organization: z.string().max(100).nullable().optional(),
  /**
   * Overrides the derived App name. Offered because the name is unique across
   * all of GitHub and an App deleted here still holds its name until it is
   * deleted on GitHub too — so a retry after a collision needs a way to change
   * it without going through GitHub's error page.
   */
  app_name: z.string().max(100).nullable().optional(),
});

const CompleteManifestSchema = z.object({
  // GitHub's single-use, one-hour code. Never logged: it redeems for the
  // App's private key.
  code: z.string().min(8).max(256),
  state: z.string().min(16).max(256),
});

/**
 * The GitHub connection.
 *
 * Two things live here, and the split in who may touch them is the point.
 * Reading is operator-gated: which GitHub account this deployment is attached
 * to, and what it was granted, is operational information rather than
 * onboarding information. Every mutation is admin-only, because each one either
 * changes the credential this deployment authenticates with or changes which
 * repositories it can read.
 *
 * There is no route that returns the private key, and none that accepts a
 * GitHub user token — this deployment never holds one. `POST /installations`
 * takes an installation id and a `state` token, which is the entire handshake:
 * the id says what was granted, the state proves this deployment asked for it.
 */
export function githubRoutes(base: string): Router {
  const router = new Router();
  const admin = { middleware: [requireRole('admin')] };
  const operator = { middleware: [requireRole('operator')] };

  router.get(`${base}/github/app`, async () => ok(await appStatus()), operator);

  router.post(
    `${base}/github/app`,
    async (ctx) => {
      const input = parseWith(SaveAppSchema, readJsonBody(ctx));
      const result = await saveApp({
        appId: input.app_id,
        privateKey: input.private_key,
        webhookSecret: input.webhook_secret ?? null,
        actor: ctx.caller.username,
      });
      // The key is write-only: what comes back is what GitHub says the App is,
      // never any part of what was sent.
      return ok(result);
    },
    admin
  );

  /**
   * The two halves of one-click App creation, which replace registering the App
   * by hand and pasting a private key.
   *
   * The browser posts the manifest to GitHub itself: GitHub renders a consent
   * page and only a person may create an App, so there is no server-to-server
   * version of this. What comes back is a code, and `state` is what proves this
   * deployment asked for it — the same binding the install flow uses.
   */
  router.post(
    `${base}/github/app/manifest-intent`,
    async (ctx) => {
      const input = parseWith(ManifestIntentSchema, readJsonBody(ctx));
      return ok(
        await createManifestIntent({
          actor: ctx.caller.username,
          ...(input.organization === undefined ? {} : { organization: input.organization }),
          ...(input.app_name === undefined ? {} : { appName: input.app_name }),
        })
      );
    },
    admin
  );

  router.post(
    `${base}/github/app/from-manifest`,
    async (ctx) => {
      const input = parseWith(CompleteManifestSchema, readJsonBody(ctx));
      // Like the paste path, what comes back is what GitHub says the App is.
      // The private key it just handed us is not part of it.
      return ok(
        await completeManifest({
          code: input.code,
          state: input.state,
          actor: ctx.caller.username,
        })
      );
    },
    admin
  );

  router.delete(
    `${base}/github/app`,
    async (ctx) => ok(await forgetApp(ctx.caller.username)),
    admin
  );

  router.post(
    `${base}/github/install-intent`,
    async (ctx) => ok(await createInstallIntent(ctx.caller.username)),
    admin
  );

  router.get(
    `${base}/github/installations`,
    async () => ok({ installations: await listInstallations() }),
    operator
  );

  router.post(
    `${base}/github/installations`,
    async (ctx) => {
      const input = parseWith(CompleteInstallSchema, readJsonBody(ctx));
      return ok(
        await completeInstall({
          installationId: input.installation_id,
          state: input.state,
          actor: ctx.caller.username,
        })
      );
    },
    admin
  );

  // Live from GitHub on every call rather than cached: this populates the
  // repository picker, and a stale list offers repos the installation no longer
  // grants.
  router.get(
    `${base}/github/installations/:installationId/repositories`,
    async (ctx) => ok(await installationRepositories(Number(ctx.params.installationId))),
    operator
  );

  router.delete(
    `${base}/github/installations/:installationId`,
    async (ctx) =>
      ok(
        await removeInstallation({
          installationId: Number(ctx.params.installationId),
          // Opt-in, because it changes something on someone else's GitHub
          // account. Without it the App stays installed there with nothing here
          // able to see or remove it.
          revoke: ctx.query.revoke === 'true',
          actor: ctx.caller.username,
        })
      ),
    admin
  );

  return router;
}

/**
 * Schema for the GitHub connection and the microservice registry, applied on
 * demand rather than by a migration step.
 *
 * Same contract as `storage-schema`: every statement is idempotent and
 * additive, it runs against a live database on the first request after any
 * deploy, and tables are created EMPTY so a deploy can never resurrect
 * something an operator deleted.
 *
 * The whole point of the design these tables encode is that a GitHub *account*
 * is never stored. One admin installs the GitHub App once; what survives is an
 * installation id belonging to the repository owner, and the private key that
 * mints short-lived tokens against it. Every later console user — with no GitHub
 * account of their own — works from these rows.
 */

import type { Queryable } from './storage-schema';

export type { Queryable } from './storage-schema';

/**
 * How long an install handshake may stay open.
 *
 * The window exists because the `state` token is the only thing binding the
 * `installation_id` that comes back from GitHub to the admin who started the
 * flow. Without it, anyone who can reach the callback route could bind an
 * arbitrary installation to this deployment. Ten minutes is long enough to read
 * GitHub's consent screen and short enough that an abandoned attempt is not
 * left usable.
 */
export const INSTALL_INTENT_TTL_SECONDS = 600;

export async function ensureMicroserviceSchema(db: Queryable): Promise<void> {
  // The App itself: one row, ever. Its id and slug are public identifiers and
  // live here so the console can render "connected as" without a GitHub call;
  // the private key and webhook secret are in Secrets Manager and deliberately
  // have no column here at all.
  await db.query(`
    CREATE TABLE IF NOT EXISTS github_app (
      id            SMALLINT PRIMARY KEY DEFAULT 1 CHECK (id = 1),
      app_id        BIGINT      NOT NULL,
      slug          TEXT        NOT NULL,
      name          TEXT        NULL,
      html_url      TEXT        NULL,
      -- Console username, not a GitHub one. Since no GitHub identity is
      -- retained, this is the entire audit trail for who wired this up.
      configured_by TEXT        NOT NULL,
      configured_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);

  // Who the App belongs to. Additive because the table shipped without it, and
  // it is what makes the App's settings URL correct — a user-owned App lives at
  // /settings/apps/<slug> and an organisation-owned one at
  // /organizations/<org>/settings/apps/<slug>. That URL matters more than it
  // looks: GitHub exposes no API to delete an App, so the settings page is the
  // only way, and the console has to be able to point at the right one.
  await db.query(`
    ALTER TABLE github_app
      ADD COLUMN IF NOT EXISTS owner_login TEXT NULL,
      ADD COLUMN IF NOT EXISTS owner_type  TEXT NULL
  `);

  // A grant, not a login. `installation_id` is issued by GitHub to the account
  // that installed the App and keeps working after the person who clicked
  // Install leaves, revokes their own tokens, or deletes their account.
  await db.query(`
    CREATE TABLE IF NOT EXISTS github_installations (
      installation_id      BIGINT PRIMARY KEY,
      account_login        TEXT        NOT NULL,
      account_type         TEXT        NULL,
      target_type          TEXT        NULL,
      -- 'all' or 'selected'. Worth showing: 'all' means a future repo is
      -- reachable without anyone re-consenting.
      repository_selection TEXT        NULL,
      -- What GitHub says the App was actually granted, which can lag what the
      -- App now requests: adding a permission leaves existing installations on
      -- the old set until the owner approves.
      permissions          JSONB       NOT NULL DEFAULT '{}'::jsonb,
      suspended            BOOLEAN     NOT NULL DEFAULT FALSE,
      connected_by         TEXT        NOT NULL,
      connected_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at           TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);

  // Single-use, expiring tokens for the install redirect. In Aurora rather than
  // Valkey because the callback already touches this database, and because an
  // attempted binding is worth being able to look at after the fact.
  await db.query(`
    CREATE TABLE IF NOT EXISTS github_install_intents (
      state        TEXT PRIMARY KEY,
      requested_by TEXT        NOT NULL,
      created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      expires_at   TIMESTAMPTZ NOT NULL
    )
  `);

  await db.query(`
    CREATE INDEX IF NOT EXISTS github_install_intents_expires_idx
      ON github_install_intents (expires_at)
  `);

  // Which handshake a state token belongs to.
  //
  // There are two now — creating the App from a manifest, and installing it on
  // an account — and they redeem at different routes with very different
  // consequences. Without this, a token minted for one could be spent on the
  // other: a state issued for an install would accept a manifest code, letting
  // whatever produced that code replace this deployment's App credentials.
  // Defaulting to 'install' is right for any row that predates the column,
  // because installs were the only kind that existed.
  await db.query(`
    ALTER TABLE github_install_intents
      ADD COLUMN IF NOT EXISTS purpose TEXT NOT NULL DEFAULT 'install'
  `);

  /**
   * Where containers actually run.
   *
   * An ECS "cluster" is only a name — it holds no machines and costs nothing.
   * What decides the machines is the capacity attached to it, and that is what
   * this table records: Fargate (AWS runs it, no instances exist) or EC2 (an
   * auto-scaling pool of one instance type).
   *
   * One instance type per cluster, deliberately. It makes capacity a single
   * number, keeps a CPU-only task from landing on a GPU box and eating the
   * memory a GPU task needed, and gives cost attribution an honest unit — a
   * shared instance's hours cannot be split between the services on it, but a
   * cluster's can be reported whole.
   */
  await db.query(`
    CREATE TABLE IF NOT EXISTS compute_clusters (
      name          TEXT PRIMARY KEY,
      display_name  TEXT NULL,
      -- 'fargate' | 'ec2'. Fargate cannot run GPUs at all, which is the entire
      -- reason both exist.
      capacity_type TEXT NOT NULL DEFAULT 'fargate',
      -- EC2 only. Null on Fargate, where there is no instance to name.
      instance_type TEXT NULL,
      -- How the INSTANCE count is decided: 'fixed' holds min_instances,
      -- 'auto' lets the capacity provider move between min and max to satisfy
      -- pending tasks. Ignored on Fargate, which has no instances.
      scaling_mode  TEXT NOT NULL DEFAULT 'auto',
      min_instances INTEGER NOT NULL DEFAULT 0,
      max_instances INTEGER NOT NULL DEFAULT 4,
      -- Capacity provider target, 1-100. At 100 ECS keeps only enough
      -- instances for running and pending tasks: cheapest, but every scale-up
      -- waits for a boot. Below 100 keeps spare capacity warm.
      target_capacity INTEGER NOT NULL DEFAULT 100,
      -- Hardware facts about the chosen instance type, recorded so the console
      -- can do capacity arithmetic without an EC2 lookup on every page load.
      gpus_per_instance INTEGER NOT NULL DEFAULT 0,
      gpu_vram_mb       INTEGER NOT NULL DEFAULT 0,
      /*
       * How tasks get at the GPU.
       *
       * 'exclusive' declares resourceRequirements GPU:1, so ECS pins a whole
       * card per task — one task per GPU, enforced, predictable.
       *
       * 'shared' declares no GPU requirement at all and sets
       * NVIDIA_VISIBLE_DEVICES instead, so ECS packs tasks by CPU and memory
       * like any other cluster and every one of them sees the card. That is the
       * only way to get finer granularity than one whole GPU, because
       * resourceRequirements takes an integer and nothing below the driver can
       * enforce a fraction. The cost is that VRAM is unguarded — hence
       * gpu_vram_mb on both this table and each service, so the console can
       * refuse an overcommit ECS would happily schedule and then OOM.
       */
      gpu_mode TEXT NOT NULL DEFAULT 'shared',
      -- Nothing is created on AWS yet, same as microservices.
      provision_state TEXT NOT NULL DEFAULT 'not_provisioned',
      created_by TEXT        NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);

  // One row per microservice: which repo builds it, and how.
  //
  // ON DELETE RESTRICT on the installation is deliberate. Dropping the grant
  // out from under a configured microservice would leave a row that names a
  // repo nothing can reach, so disconnecting has to be refused while anything
  // still depends on it — the console says which ones.
  await db.query(`
    CREATE TABLE IF NOT EXISTS microservice_clusters (
      name            TEXT PRIMARY KEY,
      display_name    TEXT   NULL,
      installation_id BIGINT NOT NULL
        REFERENCES github_installations(installation_id) ON DELETE RESTRICT,
      -- Both kept: the numeric id survives a rename, the full name is what a
      -- human recognises. A rename shows up as the two disagreeing.
      repo_id         BIGINT NOT NULL,
      repo_full_name  TEXT   NOT NULL,
      branch          TEXT   NOT NULL,
      -- Paths are repo-relative and stored normalised (no leading "./" or "/").
      -- The build context is the directory docker build runs in; for a monorepo
      -- it is usually the service's own subdirectory, not the repo root.
      dockerfile_path TEXT   NOT NULL DEFAULT 'Dockerfile',
      build_context   TEXT   NOT NULL DEFAULT '.',
      -- Result of the last look at GitHub. 'unchecked' | 'ok' |
      -- 'dockerfile_missing' | 'branch_missing' | 'error'. Stored rather than
      -- recomputed on read so the page loads without a GitHub round trip per
      -- row, and so a repo that has since moved still shows its last known
      -- state instead of an empty column.
      check_state       TEXT        NOT NULL DEFAULT 'unchecked',
      check_detail      TEXT        NULL,
      checked_at        TIMESTAMPTZ NULL,
      -- The branch head the check ran against, and the Dockerfile's blob sha.
      checked_commit_sha TEXT       NULL,
      dockerfile_sha     TEXT       NULL,
      dockerfile_size    INTEGER    NULL,
      -- Runtime shape for the Fargate service this will become. Recorded now
      -- and acted on later: nothing in this stack provisions from these yet,
      -- which is what 'not_provisioned' means.
      provision_state TEXT    NOT NULL DEFAULT 'not_provisioned',
      desired_count   INTEGER NOT NULL DEFAULT 1,
      cpu             INTEGER NOT NULL DEFAULT 256,
      memory          INTEGER NOT NULL DEFAULT 512,
      container_port  INTEGER NULL,
      created_by      TEXT        NOT NULL,
      created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);

  // How many tasks to run, and whether that number is fixed or decided by load.
  //
  // Additive because the runtime shape above shipped without it, and every
  // existing row means "fixed" — that was the only behaviour there was. The
  // autoscaling columns carry defaults rather than nulls so a row switched to
  // 'auto' is immediately valid instead of half-configured.
  //
  // Recorded and not yet acted on, exactly like the columns above it: this is
  // the shape the Application Auto Scaling target-tracking policy will take
  // when the ECS side is built.
  await db.query(`
    ALTER TABLE microservice_clusters
      ADD COLUMN IF NOT EXISTS scaling_mode       TEXT    NOT NULL DEFAULT 'fixed',
      ADD COLUMN IF NOT EXISTS min_tasks          INTEGER NOT NULL DEFAULT 1,
      ADD COLUMN IF NOT EXISTS max_tasks          INTEGER NOT NULL DEFAULT 4,
      -- Which signal target tracking follows: 'cpu' or 'memory' utilisation.
      ADD COLUMN IF NOT EXISTS scaling_metric     TEXT    NOT NULL DEFAULT 'cpu',
      -- The percentage it aims to hold that metric at.
      ADD COLUMN IF NOT EXISTS scaling_target     INTEGER NOT NULL DEFAULT 60,
      ADD COLUMN IF NOT EXISTS scale_out_cooldown INTEGER NOT NULL DEFAULT 60,
      ADD COLUMN IF NOT EXISTS scale_in_cooldown  INTEGER NOT NULL DEFAULT 300
  `);

  /**
   * Which cluster a microservice runs on, and how much video memory it needs.
   *
   * Nullable because the table predates clusters and nothing is provisioned
   * yet: an unassigned row is "not ready to run", not corrupt. RESTRICT rather
   * than SET NULL — silently detaching every service on a deleted cluster would
   * leave them looking configured while having nowhere to run.
   *
   * `gpu_vram_mb` is what makes shared GPU safe to offer. ECS schedules on CPU
   * and memory and knows nothing about video memory, so six services each
   * loading a 4 GB model onto one 16 GB card will all place and then fail at
   * runtime. Declared here, the console can add it up and refuse.
   */
  await db.query(`
    ALTER TABLE microservice_clusters
      ADD COLUMN IF NOT EXISTS cluster_name TEXT NULL,
      ADD COLUMN IF NOT EXISTS gpu_vram_mb  INTEGER NOT NULL DEFAULT 0
  `);

  await db.query(`
    DO $$
    BEGIN
      IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'microservice_clusters_cluster_fkey'
      ) THEN
        ALTER TABLE microservice_clusters
          ADD CONSTRAINT microservice_clusters_cluster_fkey
          FOREIGN KEY (cluster_name) REFERENCES compute_clusters(name) ON DELETE RESTRICT;
      END IF;
    END
    $$
  `);

  // Serves the "what still runs here" check that deleting a cluster makes, and
  // the per-cluster VRAM total the console sums before allowing a service on.
  await db.query(`
    CREATE INDEX IF NOT EXISTS microservice_clusters_cluster_idx
      ON microservice_clusters (cluster_name)
      WHERE cluster_name IS NOT NULL
  `);

  // A monorepo legitimately backs several microservices from one branch, each
  // with its own Dockerfile — so the repo alone cannot be unique. The triple
  // can: two rows building the same file from the same branch are a duplicate,
  // not a second service.
  await db.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS microservice_clusters_source_idx
      ON microservice_clusters (repo_id, branch, dockerfile_path)
  `);

  /**
   * One cluster carries one service.
   *
   * The rule is not an ECS limit — a cluster happily runs dozens — it is what
   * makes the rest of this feature answerable. Cost: an instance's hours cannot
   * be split between the services sharing it, so per-service spend is only
   * honest when the cluster is the service. Capacity: scaling a service means
   * scaling its instances, which is incoherent when a neighbour's tasks are
   * also on them. GPU: `NVIDIA_VISIBLE_DEVICES` exposes the whole card to every
   * task on the box, so "which service ran the GPU out of memory" has no answer
   * on a shared cluster. Logs: one log group per cluster can be retained and
   * dropped as a unit.
   *
   * A partial index rather than a UNIQUE column so any number of rows may sit
   * unassigned — `cluster_name IS NULL` is the ordinary state of a service that
   * has been registered but not yet given somewhere to run.
   */
  await db.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS microservice_clusters_one_per_cluster_idx
      ON microservice_clusters (cluster_name)
      WHERE cluster_name IS NOT NULL
  `);

  /**
   * What provisioning created, per service.
   *
   * Recorded rather than derived, because every one of these is the answer to
   * "what do I delete". A teardown that rediscovers its own resources by
   * guessing at names is a teardown that either misses something and bills
   * forever, or matches too widely and deletes a neighbour's. The names are
   * deterministic, but writing them down at creation is what makes removal
   * provably exact.
   *
   * `image_digest` and not just the tag: a tag is a moving pointer, and the
   * whole question after a rebuild is whether the running task is on the image
   * that was just built. Comparing digests answers it; comparing tags cannot.
   */
  await db.query(`
    ALTER TABLE microservice_clusters
      ADD COLUMN IF NOT EXISTS ecr_repository_name TEXT NULL,
      ADD COLUMN IF NOT EXISTS ecr_repository_uri  TEXT NULL,
      ADD COLUMN IF NOT EXISTS build_project_name  TEXT NULL,
      ADD COLUMN IF NOT EXISTS log_group_name      TEXT NULL,
      -- CloudWatch retention in days. Null means never expire, which is a
      -- choice an operator may make and a default nobody should get by
      -- accident: an unbounded log group is a bill that only grows.
      ADD COLUMN IF NOT EXISTS log_retention_days  INTEGER NULL DEFAULT 30,
      ADD COLUMN IF NOT EXISTS service_arn         TEXT NULL,
      ADD COLUMN IF NOT EXISTS task_definition_arn TEXT NULL,
      ADD COLUMN IF NOT EXISTS image_tag           TEXT NULL,
      ADD COLUMN IF NOT EXISTS image_digest        TEXT NULL,
      -- Why the last provision attempt ended as it did. Held so a failure is
      -- still readable after the request that produced it is long gone.
      ADD COLUMN IF NOT EXISTS provision_detail    TEXT NULL,
      ADD COLUMN IF NOT EXISTS provisioned_at      TIMESTAMPTZ NULL
  `);

  /**
   * The last image build.
   *
   * One row's worth, not a history table. What an operator needs is "is it
   * building, did it work, and what came out"; a full build history is
   * CodeBuild's own console, which this deliberately does not reimplement.
   *
   * `build_commit_sha` is the point of the whole group: it is how the console
   * shows that the branch has moved on since the running image was built, which
   * is the difference between "deployed" and "up to date".
   */
  await db.query(`
    ALTER TABLE microservice_clusters
      ADD COLUMN IF NOT EXISTS build_id           TEXT NULL,
      -- 'never' | 'queued' | 'building' | 'succeeded' | 'failed' | 'stopped'
      ADD COLUMN IF NOT EXISTS build_state        TEXT NOT NULL DEFAULT 'never',
      ADD COLUMN IF NOT EXISTS build_detail       TEXT NULL,
      ADD COLUMN IF NOT EXISTS build_commit_sha   TEXT NULL,
      ADD COLUMN IF NOT EXISTS build_started_at   TIMESTAMPTZ NULL,
      ADD COLUMN IF NOT EXISTS build_finished_at  TIMESTAMPTZ NULL,
      ADD COLUMN IF NOT EXISTS build_log_group    TEXT NULL,
      ADD COLUMN IF NOT EXISTS build_log_stream   TEXT NULL
  `);

  /**
   * A standing instruction to get this service running.
   *
   * The lifecycle underneath is still four steps — scaffold, build, wait,
   * deploy — because each one costs something different and each one fails
   * differently. What this records is that somebody has already decided to take
   * all four: creating a service asks the questions once and then says "and
   * run it", instead of leaving three buttons to be found on two pages.
   *
   * It is a column rather than a variable in whichever request started it,
   * because the middle step is a docker build that runs for minutes. Nothing
   * can hold a Lambda open that long, so the intent has to survive the request
   * — and then survive the operator closing the tab. Both the status endpoint
   * the console polls and the five-minute reconcile advance it, so a launch
   * finishes whether or not anyone is watching.
   *
   * 'requested' is the state a row is created in and the one the reconcile
   * looks for: it means the scaffolding has not started yet, so a create whose
   * follow-up call never arrived is picked up rather than stranded.
   */
  await db.query(`
    ALTER TABLE microservice_clusters
      -- 'none' | 'requested' | 'provisioning' | 'building' | 'deploying'
      -- | 'running' | 'failed'
      ADD COLUMN IF NOT EXISTS launch_state        TEXT NOT NULL DEFAULT 'none',
      -- Why a launch stopped where it did, kept so a failure is still readable
      -- long after the request that produced it.
      ADD COLUMN IF NOT EXISTS launch_detail       TEXT NULL,
      ADD COLUMN IF NOT EXISTS launch_requested_by TEXT NULL,
      ADD COLUMN IF NOT EXISTS launch_requested_at TIMESTAMPTZ NULL,
      ADD COLUMN IF NOT EXISTS launch_finished_at  TIMESTAMPTZ NULL
  `);

  /**
   * Serves the reconcile, which asks only for the few rows mid-launch.
   *
   * Partial, because the answer is almost always empty: a launch takes minutes
   * and then the row leaves these states for good. A full index would be read
   * every five minutes to find nothing.
   */
  await db.query(`
    CREATE INDEX IF NOT EXISTS microservice_clusters_launch_idx
      ON microservice_clusters (launch_state)
      WHERE launch_state IN ('requested', 'provisioning', 'building', 'deploying')
  `);

  /**
   * What provisioning created, per cluster.
   *
   * Fargate uses none of the EC2 columns: there is no launch template, no
   * scaling group and no capacity provider, because there are no instances. A
   * Fargate row leaves them null, which is also how a reconcile tells the two
   * apart without re-reading `capacity_type`.
   */
  await db.query(`
    ALTER TABLE compute_clusters
      ADD COLUMN IF NOT EXISTS cluster_arn            TEXT NULL,
      ADD COLUMN IF NOT EXISTS launch_template_id     TEXT NULL,
      ADD COLUMN IF NOT EXISTS asg_name               TEXT NULL,
      ADD COLUMN IF NOT EXISTS capacity_provider_name TEXT NULL,
      -- The AMI the launch template was built with, and when it was resolved.
      -- Stored because the SSM parameter it came from moves: knowing the
      -- running instances are three AMI releases behind is the entire input to
      -- deciding whether to rotate them.
      ADD COLUMN IF NOT EXISTS image_id               TEXT NULL,
      ADD COLUMN IF NOT EXISTS image_resolved_at      TIMESTAMPTZ NULL,
      ADD COLUMN IF NOT EXISTS provision_detail       TEXT NULL,
      ADD COLUMN IF NOT EXISTS provisioned_at         TIMESTAMPTZ NULL
  `);

  // Serves the "what still depends on this installation" check that
  // disconnecting runs.
  await db.query(`
    CREATE INDEX IF NOT EXISTS microservice_clusters_installation_idx
      ON microservice_clusters (installation_id)
  `);
}

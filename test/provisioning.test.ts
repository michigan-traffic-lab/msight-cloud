import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import {
  INSTANCE_CATALOG,
  INSTANCE_MEMORY_OVERHEAD_MIB,
  hasGpu,
  instanceSpec,
  isCatalogued,
  taskMemoryCeiling,
} from '../src/shared/instance-catalog';
import { computeClusterNames, microserviceNames, names } from '../src/shared/deployment-naming';
import { buildSpec } from '../src/shared/microservice-infrastructure';
import { normalizeCluster } from '../src/functions/admin-vpc-api/services/clusters';
import {
  LAUNCH_IN_FLIGHT,
  type LaunchState,
} from '../src/functions/admin-vpc-api/services/microservices';
import { CreateSchema } from '../src/functions/admin-vpc-api/routes/microservices.routes';

/**
 * The rules that decide whether a provisioned cluster can actually run
 * anything.
 *
 * Everything here is pure. The AWS mutations are covered by nothing automated —
 * they need a real account — so what is pinned instead is the arithmetic and the
 * naming that decide whether those mutations are even coherent, and every case
 * below is one that fails silently and expensively in production.
 */

describe('instance catalog', () => {
  it('reports GPU memory per card, not summed across cards', () => {
    // The distinction that matters for scheduling: a task loading a 20 GiB
    // model onto one of four 16 GiB cards fails, however much the instance has
    // in aggregate. A catalog that summed would say 64 GiB and be useless.
    const single = instanceSpec('g4dn.xlarge');
    const quad = instanceSpec('g4dn.12xlarge');

    expect(single?.gpus).toBe(1);
    expect(quad?.gpus).toBe(4);
    expect(quad?.gpuVramMb).toBe(single?.gpuVramMb);
  });

  it('leaves headroom for the agent and the OS in the task memory ceiling', () => {
    // A task sized at the instance's full memory sits PENDING for ever with a
    // placement message, which reads as a cluster fault and is arithmetic.
    for (const spec of INSTANCE_CATALOG) {
      expect(taskMemoryCeiling(spec)).toBeLessThan(spec.memoryMib);
      expect(spec.memoryMib - taskMemoryCeiling(spec)).toBe(INSTANCE_MEMORY_OVERHEAD_MIB);
    }
  });

  it('distinguishes "no GPUs" from "no idea"', () => {
    // Load-bearing. An uncatalogued g4dn variant read as "no GPUs" would be
    // provisioned from the standard AMI with no driver, and every GPU task on
    // it would fail to place while the instance billed.
    expect(hasGpu('g5.xlarge')).toBe(true);
    expect(hasGpu('c7i.large')).toBe(false);
    expect(hasGpu('g7.futuretype')).toBeNull();
    expect(isCatalogued('g7.futuretype')).toBe(false);
  });

  it('gives every GPU entry a VRAM figure and every CPU entry none', () => {
    // The console refuses shared-GPU overcommits by summing these, so a GPU
    // type with a zero here would silently disable that check.
    for (const spec of INSTANCE_CATALOG) {
      if (spec.gpus > 0) {
        expect(spec.gpuVramMb).toBeGreaterThan(0);
        expect(spec.gpuModel).not.toBeNull();
      } else {
        expect(spec.gpuVramMb).toBe(0);
        expect(spec.gpuModel).toBeNull();
      }
    }
  });
});

describe('cluster capacity validation', () => {
  it('refuses a GPU count the instance type does not have', () => {
    // The quiet, expensive failure: g4dn.xlarge saved with 2 GPUs provisions,
    // registers one, and half the intended tasks never place.
    expect(() =>
      normalizeCluster({
        capacityType: 'ec2',
        instanceType: 'g4dn.xlarge',
        gpusPerInstance: 2,
        gpuVramMb: 16384,
      })
    ).toThrow(/has 1 GPU\(s\), not 2/);
  });

  it('refuses GPUs on a CPU-only instance type, and says which family to use', () => {
    expect(() =>
      normalizeCluster({
        capacityType: 'ec2',
        instanceType: 'c7i.xlarge',
        gpusPerInstance: 1,
        gpuVramMb: 16384,
      })
    ).toThrow(/CPU-only instance type/);
  });

  it('refuses an overstated VRAM figure', () => {
    // Overstating it defeats the overcommit check the figure exists for.
    expect(() =>
      normalizeCluster({
        capacityType: 'ec2',
        instanceType: 'g4dn.xlarge',
        gpusPerInstance: 1,
        gpuVramMb: 65536,
      })
    ).toThrow(/not 65536 MiB/);
  });

  it('accepts an uncatalogued instance type as the documented escape hatch', () => {
    const result = normalizeCluster({
      capacityType: 'ec2',
      instanceType: 'g9.enormous',
      gpusPerInstance: 8,
      gpuVramMb: 81920,
    });
    expect(result.instance_type).toBe('g9.enormous');
    expect(result.gpus_per_instance).toBe(8);
  });

  it('still refuses a GPU cluster with no VRAM recorded', () => {
    expect(() =>
      normalizeCluster({
        capacityType: 'ec2',
        instanceType: 'g4dn.xlarge',
        gpusPerInstance: 1,
        gpuVramMb: 0,
      })
    ).toThrow(/needs the card's memory recorded/);
  });

  it('normalises away every instance field on Fargate', () => {
    // A Fargate cluster with min_instances: 3 is not a stricter configuration,
    // it is a misunderstanding — there are no instances there to count.
    const result = normalizeCluster({
      capacityType: 'fargate',
      instanceType: 'g4dn.xlarge',
      minInstances: 3,
      maxInstances: 9,
    });
    expect(result.instance_type).toBeNull();
    expect(result.min_instances).toBe(0);
    expect(result.max_instances).toBe(0);
    expect(result.gpus_per_instance).toBe(0);
  });

  it('refuses GPUs on Fargate, which cannot have them at all', () => {
    expect(() =>
      normalizeCluster({ capacityType: 'fargate', gpusPerInstance: 1 })
    ).toThrow(/Fargate cannot run GPUs/);
  });
});

describe('the create-microservice contract', () => {
  const base = {
    name: 'detector',
    installation_id: 42,
    repo_id: 7,
    branch: 'main',
    dockerfile_path: 'Dockerfile',
  };

  it('takes the hardware as part of the service, not as a cluster', () => {
    const parsed = CreateSchema.safeParse({
      ...base,
      compute: {
        capacity_type: 'ec2',
        instance_type: 'g5.xlarge',
        gpus_per_instance: 1,
        gpu_vram_mb: 24576,
        gpu_mode: 'shared',
      },
    });
    expect(parsed.success).toBe(true);
  });

  it('defaults the hardware away entirely', () => {
    // Omitted means Fargate: nothing to manage and no cost when idle. A
    // service can be registered without anyone deciding about capacity.
    const parsed = CreateSchema.safeParse(base);
    expect(parsed.success).toBe(true);
    if (parsed.success) expect(parsed.data.compute).toBeUndefined();
  });

  /**
   * A cluster is a property of the service, not a choice.
   *
   * One is always created and named after the service, so there is deliberately
   * no way to name an existing cluster here and no way to create a service
   * without one. The field's absence IS the contract — an accepted
   * `cluster_name` would let the two-step flow back in.
   */
  it('offers no way to attach to an existing cluster', () => {
    const parsed = CreateSchema.safeParse({ ...base, cluster_name: 'gpu-pool' });
    // Zod strips unknown keys rather than rejecting, so the assertion is that
    // it never reaches the service layer.
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect((parsed.data as Record<string, unknown>).cluster_name).toBeUndefined();
    }
  });

  it('offers no way to name the cluster', () => {
    const parsed = CreateSchema.safeParse({
      ...base,
      compute: { capacity_type: 'fargate', name: 'something-else' },
    });
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect((parsed.data.compute as Record<string, unknown>).name).toBeUndefined();
    }
  });

  it('takes the bring-up as part of creating the service', () => {
    // The whole point of the flow: one request registers the service, creates
    // its cluster, and asks for it to be built and started.
    const parsed = CreateSchema.safeParse({ ...base, launch: true });
    expect(parsed.success).toBe(true);
    if (parsed.success) expect(parsed.data.launch).toBe(true);
  });

  /**
   * Load-bearing default.
   *
   * Launching starts an image build and then instances that bill by the second.
   * A schema that defaulted this to true would mean a hand-made request — or a
   * client written against an older version of this API — started a GPU fleet
   * by not mentioning it.
   */
  it('does not launch unless asked', () => {
    const parsed = CreateSchema.safeParse(base);
    expect(parsed.success).toBe(true);
    if (parsed.success) expect(parsed.data.launch).toBeUndefined();
  });
});

/**
 * A statement that cannot even be prepared.
 *
 * Nothing in this suite has a database, and nothing in CI does either, so every
 * query here is unverified until the code path runs against real Aurora. That
 * is survivable for a query that returns the wrong rows and is not survivable
 * for one that fails to parse: it takes out the whole action, at the moment an
 * operator is waiting on it, with a message about parameter numbers.
 *
 * This is the one parse failure this codebase has actually hit, so it is the
 * one worth a guard. PostgreSQL transforms every SET expression before coercing
 * any of them to its target column, so a bare `col = $7` has not yet given $7 a
 * type when a sibling clause analyses `$7 IS NULL` — and IS NULL supplies
 * none. The statement then fails with "could not determine data type of
 * parameter $7", every time.
 *
 * The rule is therefore: a parameter tested for NULL names its type there. It
 * is stricter than PostgreSQL requires — a COALESCE earlier in the same
 * statement also resolves it — but that rescue depends on the order the SET
 * clauses happen to be written in, which is not a thing anyone should have to
 * preserve while editing a twenty-column UPDATE.
 */
/**
 * The buildspec, which nothing else can check until a build runs.
 *
 * A mistake here costs a full provision-and-build cycle to discover and reports
 * itself as a CodeBuild phase error with no context — the shell one below
 * failed every build on its first line, before a single line of the repository
 * had been cloned, with a message naming only `set`.
 */
/**
 * IAM statements that read as correct and can never allow anything.
 *
 * `ecs:cluster` is populated only for resources that live *inside* a cluster —
 * a service, a task, a container instance. For an action whose resource IS the
 * cluster, the key is absent from the request, so every condition on it
 * evaluates false and the call is refused by a statement that names the action
 * and whose pattern matches the ARN.
 *
 * That failed silently in exactly the way this class of bug always does: the
 * console showed a bare 500, and the function's log said the role was "not
 * authorized to perform ecs:ListContainerInstances … because no identity-based
 * policy allows the action" while the deployed policy did list it. Nothing but
 * a live call can catch it, so the shape is pinned here instead.
 */
describe('ECS grants that cannot be conditioned', () => {
  const source = readFileSync(join(__dirname, '..', 'lib', 'msight-cloud-stack.ts'), 'utf8');

  /**
   * Actions proven to take the cluster itself as their resource.
   *
   * Only the one demonstrated in production: the rule generalises, but a list
   * assembled from memory would fail on statements nobody has tested.
   */
  const CLUSTER_IS_THE_RESOURCE = ['ecs:ListContainerInstances'];

  /** Each `new iam.PolicyStatement({ … })` body, brace-matched. */
  function policyStatements(text: string): string[] {
    const found: string[] = [];
    for (const match of text.matchAll(/new iam\.PolicyStatement\(\{/g)) {
      let depth = 1;
      let i = (match.index ?? 0) + match[0].length;
      while (i < text.length && depth > 0) {
        if (text[i] === '{') depth += 1;
        else if (text[i] === '}') depth -= 1;
        i += 1;
      }
      found.push(text.slice((match.index ?? 0) + match[0].length, i - 1));
    }
    return found;
  }

  it('finds the statements at all', () => {
    // A parser that matched nothing would make the assertion below pass for
    // the wrong reason.
    expect(policyStatements(source).length).toBeGreaterThan(20);
  });

  it('never scopes a cluster-resource action with the ecs:cluster condition', () => {
    const broken = policyStatements(source).filter(
      (statement) =>
        CLUSTER_IS_THE_RESOURCE.some((action) => statement.includes(action)) &&
        statement.includes("'ecs:cluster'")
    );

    expect(broken).toEqual([]);
  });
});

describe('the build spec', () => {
  const spec = JSON.parse(buildSpec()) as {
    version: string;
    env?: { shell?: string };
    phases: Record<string, { commands: string[] }>;
  };

  const commands = Object.values(spec.phases).flatMap((phase) => phase.commands);

  it('declares a shell that understands the commands it runs', () => {
    /**
     * CodeBuild's default shell on Linux is `/bin/sh` — dash on these images —
     * which rejects all of these. dash answers `set -o pipefail` with "Illegal
     * option" and exit status 2, and because the commands in a phase share one
     * shell, that kills the build at its first line.
     */
    const BASH_ONLY = [/\bpipefail\b/, /\[\[/, /<<</, /\$\{[A-Za-z_]+\[/];
    const needsBash = commands.filter((command) =>
      BASH_ONLY.some((pattern) => pattern.test(command))
    );

    if (needsBash.length > 0) {
      expect(spec.env?.shell).toBe('bash');
    }
  });

  it('never puts the installation token on a command line', () => {
    /**
     * The token reaches git through a credential helper reading the
     * environment. In a clone URL — the obvious way — it would land in
     * CloudWatch the first time a clone failed, and the whole point of minting
     * a short-lived installation token is that it is never written down.
     */
    const clone = commands.find((command) => command.startsWith('git clone'));
    expect(clone).toBeDefined();
    expect(clone).not.toContain('GITHUB_TOKEN');
    expect(clone).not.toContain('x-access-token');
  });
});

describe('SQL that has to parse', () => {
  const serviceDir = join(__dirname, '../src/functions/admin-vpc-api/services');

  /**
   * Comments are stripped first, and not as a nicety: the comment explaining
   * this rule quotes the broken SQL, and a scanner that read prose would flag
   * its own documentation.
   */
  function code(source: string): string {
    return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  }

  it('names the type of every parameter it tests for NULL', () => {
    const offenders: string[] = [];

    for (const file of readdirSync(serviceDir).filter((name) => name.endsWith('.ts'))) {
      const source = code(readFileSync(join(serviceDir, file), 'utf8'));
      for (const match of source.matchAll(/\$\d+(::\w+)?\s+IS\s+NULL/gi)) {
        if (!match[1]) offenders.push(`${file}: ${match[0]}`);
      }
    }

    expect(offenders).toEqual([]);
  });

  /** The rule is worth nothing if it cannot see the shape it exists to catch. */
  it('catches the statement that caused this', () => {
    const broken = code(`
      /* image_id = $7 with a bare $7 IS NULL beside it — the thing that broke. */
      UPDATE compute_clusters
         SET image_id = $7,
             image_resolved_at = CASE WHEN $7 IS NULL THEN image_resolved_at ELSE NOW() END
       WHERE name = $1
    `);
    const hits = [...broken.matchAll(/\$\d+(::\w+)?\s+IS\s+NULL/gi)].filter((m) => !m[1]);
    expect(hits).toHaveLength(1);
  });
});

describe('launch states', () => {
  /**
   * The set the reconcile queries on.
   *
   * Every state that is waiting for something has to be in it, and neither
   * terminal state may be. Both mistakes are silent and slow: a state dropped
   * from the list is a launch nothing ever finishes — most damagingly
   * 'requested', which is what a create whose follow-up call never arrived
   * leaves behind — while a terminal state added to it is a service that is
   * re-deployed every five minutes for ever.
   */
  it('covers exactly the states that are still waiting for something', () => {
    const all: LaunchState[] = [
      'none',
      'requested',
      'provisioning',
      'building',
      'deploying',
      'running',
      'failed',
    ];
    const inFlight = new Set<LaunchState>(LAUNCH_IN_FLIGHT);

    expect([...inFlight].sort()).toEqual(
      ['building', 'deploying', 'provisioning', 'requested'].sort()
    );
    for (const state of ['none', 'running', 'failed'] as LaunchState[]) {
      expect(inFlight.has(state)).toBe(false);
    }
    // Nothing outside the union, so a state added to the type without a
    // decision about the reconcile shows up here.
    for (const state of inFlight) expect(all).toContain(state);
  });
});

describe('resource naming', () => {
  /**
   * These strings are derived by the provisioner that creates the resources,
   * the reaper that deletes them, and the IAM conditions in the stack that
   * scope who may touch them. A drift between any two produces a resource
   * nothing recognises as its own: still billing, invisible to the console,
   * immune to teardown. So they are pinned.
   */
  it('keeps microservice resources under the deployment prefix', () => {
    const n = microserviceNames('msight-ms', 'detector');
    expect(n.ecrRepository).toBe('msight-ms/detector');
    expect(n.buildProject).toBe('msight-ms-build-detector');
    expect(n.service).toBe('msight-ms-detector');
    expect(n.taskFamily).toBe('msight-ms-detector');
  });

  it('keeps cluster resources under the deployment prefix', () => {
    const n = computeClusterNames('msight-ms', 'gpu-pool');
    expect(n.cluster).toBe('msight-ms-cluster-gpu-pool');
    expect(n.launchTemplate).toBe('msight-ms-lt-gpu-pool');
    expect(n.autoScalingGroup).toBe('msight-ms-asg-gpu-pool');
    expect(n.capacityProvider).toBe('msight-ms-cp-gpu-pool');
  });

  it('matches the IAM patterns the stack scopes its grants with', () => {
    // The stack writes `${msPrefix}-build-*`, `${msPrefix}-cluster-*` and
    // `${msPrefix}/*`. If a name stopped matching, provisioning would fail with
    // AccessDenied rather than anything that named the cause.
    const prefix = names('msight-cloud').microserviceResourcePrefix;
    expect(prefix).toBe('msight-cloud-ms');
    expect(microserviceNames(prefix, 'x').ecrRepository.startsWith(`${prefix}/`)).toBe(true);
    expect(microserviceNames(prefix, 'x').buildProject.startsWith(`${prefix}-build-`)).toBe(true);
    expect(computeClusterNames(prefix, 'y').cluster.startsWith(`${prefix}-cluster-`)).toBe(true);
  });

  it('separates microservice names from sensor names', () => {
    // The reaper and the IAM conditions both match by prefix, so an overlap
    // would let one feature's teardown reach the other's resources.
    const n = names('msight-cloud');
    expect(n.microserviceResourcePrefix).not.toBe(n.sensorResourcePrefix);
    expect(n.microserviceResourcePrefix.startsWith(n.sensorResourcePrefix)).toBe(false);
    expect(n.sensorResourcePrefix.startsWith(n.microserviceResourcePrefix)).toBe(false);
  });

  it('gives container and build logs separate groups', () => {
    // Separate so retention can differ and so clearing one does not destroy
    // the other — build history and runtime history answer different questions.
    const n = names('msight-cloud');
    expect(n.microserviceLogGroup('detector')).toBe('/msight-cloud/microservice/detector');
    expect(n.microserviceBuildLogGroup('detector')).toBe(
      '/msight-cloud/microservice-build/detector'
    );
  });
});

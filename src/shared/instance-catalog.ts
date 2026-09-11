/**
 * The EC2 instance types an operator can pick for a compute cluster, with the
 * hardware facts that decide what may run on them.
 *
 * Curated rather than fetched from `ec2:DescribeInstanceTypes`, for one reason
 * that matters more than freshness: **DescribeInstanceTypes does not report GPU
 * memory in a form you can trust for scheduling decisions.** It gives a total
 * across the card count, says nothing about MIG partitioning, and is missing
 * entirely for some accelerator families. Since GPU VRAM is the number the
 * console refuses overcommits on — the one limit ECS itself never checks — a
 * wrong value here is worse than a stale one.
 *
 * Free text remains allowed. An operator naming a type not in this list gets no
 * auto-filled specs and no cross-checks, which is the documented escape hatch
 * for a family AWS adds after this file was last touched.
 *
 * Dependency-free on purpose: the CDK stack, the admin API and the console all
 * read it, and the console reaches it over `GET /clusters/instance-types` so
 * there is never a second copy of these numbers in the frontend.
 */

export interface InstanceSpec {
  /** EC2 instance type, exactly as the API spells it. */
  name: string;
  /** Grouping label for the console's picker. */
  family: string;
  vcpu: number;
  /**
   * Physical memory, MiB. A task's `memory` must sit meaningfully below this:
   * the ECS agent and the OS take a share, so a task sized to the full figure
   * never places. `taskMemoryCeiling` is the honest number to validate against.
   */
  memoryMib: number;
  /** Whole GPUs attached. 0 for a CPU-only type. */
  gpus: number;
  /**
   * Video memory **per card**, MiB — not the total across cards.
   *
   * Per card because that is the unit a container's allocation actually fails
   * against: a task loading a 20 GiB model onto one of four 16 GiB cards fails
   * regardless of the 64 GiB the instance has in aggregate.
   */
  gpuVramMb: number;
  /** GPU model, for the console to show beside the type. */
  gpuModel: string | null;
  /** Anything about this type an operator should know before choosing it. */
  note?: string;
}

/**
 * Memory ECS cannot give a task, MiB.
 *
 * The agent, the container runtime and the OS all live in the instance's
 * memory, and ECS advertises only what remains as registerable capacity. A task
 * sized at the full `memoryMib` therefore sits PENDING forever with
 * "insufficient memory" — a failure that looks like a cluster problem and is
 * really an arithmetic one. 1 GiB is generous enough to cover the AL2023 ECS
 * AMI and its GPU variant, whose footprint is the larger of the two.
 */
export const INSTANCE_MEMORY_OVERHEAD_MIB = 1024;

/** The largest `memory` a task on this instance type can actually be given. */
export function taskMemoryCeiling(spec: InstanceSpec): number {
  return Math.max(512, spec.memoryMib - INSTANCE_MEMORY_OVERHEAD_MIB);
}

/**
 * The catalog.
 *
 * Deliberately short. Every entry is a type that is both current and sensible
 * for a containerised algorithm; listing all 700-odd EC2 types would make the
 * picker useless and imply support for families nobody here has run.
 */
export const INSTANCE_CATALOG: InstanceSpec[] = [
  // ── GPU: inference and light training ───────────────────────────────────
  // T4 is the workhorse for vision inference: cheapest GPU on ECS, and 16 GiB
  // holds most detection and tracking models with room for batching.
  {
    name: 'g4dn.xlarge',
    family: 'G4dn — NVIDIA T4',
    vcpu: 4,
    memoryMib: 16384,
    gpus: 1,
    gpuVramMb: 16384,
    gpuModel: 'NVIDIA T4 (16 GiB)',
    note: 'Cheapest GPU option. Good default for one vision model per task.',
  },
  {
    name: 'g4dn.2xlarge',
    family: 'G4dn — NVIDIA T4',
    vcpu: 8,
    memoryMib: 32768,
    gpus: 1,
    gpuVramMb: 16384,
    gpuModel: 'NVIDIA T4 (16 GiB)',
    note: 'Same single T4 as g4dn.xlarge with double the CPU and RAM — pick it when decoding, not inference, is the bottleneck.',
  },
  {
    name: 'g4dn.4xlarge',
    family: 'G4dn — NVIDIA T4',
    vcpu: 16,
    memoryMib: 65536,
    gpus: 1,
    gpuVramMb: 16384,
    gpuModel: 'NVIDIA T4 (16 GiB)',
  },
  {
    name: 'g4dn.12xlarge',
    family: 'G4dn — NVIDIA T4',
    vcpu: 48,
    memoryMib: 196608,
    gpus: 4,
    gpuVramMb: 16384,
    gpuModel: '4x NVIDIA T4 (16 GiB each)',
    note: 'Four cards. Under exclusive GPU mode this runs four tasks, one per card.',
  },
  {
    name: 'g5.xlarge',
    family: 'G5 — NVIDIA A10G',
    vcpu: 4,
    memoryMib: 16384,
    gpus: 1,
    gpuVramMb: 24576,
    gpuModel: 'NVIDIA A10G (24 GiB)',
    note: '24 GiB of VRAM — the step up when a model will not fit on a T4.',
  },
  {
    name: 'g5.2xlarge',
    family: 'G5 — NVIDIA A10G',
    vcpu: 8,
    memoryMib: 32768,
    gpus: 1,
    gpuVramMb: 24576,
    gpuModel: 'NVIDIA A10G (24 GiB)',
  },
  {
    name: 'g5.4xlarge',
    family: 'G5 — NVIDIA A10G',
    vcpu: 16,
    memoryMib: 65536,
    gpus: 1,
    gpuVramMb: 24576,
    gpuModel: 'NVIDIA A10G (24 GiB)',
  },
  {
    name: 'g5.12xlarge',
    family: 'G5 — NVIDIA A10G',
    vcpu: 48,
    memoryMib: 196608,
    gpus: 4,
    gpuVramMb: 24576,
    gpuModel: '4x NVIDIA A10G (24 GiB each)',
  },
  {
    name: 'g6.xlarge',
    family: 'G6 — NVIDIA L4',
    vcpu: 4,
    memoryMib: 16384,
    gpus: 1,
    gpuVramMb: 24576,
    gpuModel: 'NVIDIA L4 (24 GiB)',
    note: 'Newer and more efficient than G5 at similar VRAM. Check regional availability.',
  },
  {
    name: 'g6.2xlarge',
    family: 'G6 — NVIDIA L4',
    vcpu: 8,
    memoryMib: 32768,
    gpus: 1,
    gpuVramMb: 24576,
    gpuModel: 'NVIDIA L4 (24 GiB)',
  },
  {
    name: 'g6.4xlarge',
    family: 'G6 — NVIDIA L4',
    vcpu: 16,
    memoryMib: 65536,
    gpus: 1,
    gpuVramMb: 24576,
    gpuModel: 'NVIDIA L4 (24 GiB)',
  },
  {
    name: 'p3.2xlarge',
    family: 'P3 — NVIDIA V100',
    vcpu: 8,
    memoryMib: 62464,
    gpus: 1,
    gpuVramMb: 16384,
    gpuModel: 'NVIDIA V100 (16 GiB)',
    note: 'Training-class compute, older generation. Usually only worth it for FP64 or NVLink work.',
  },

  // ── CPU only ────────────────────────────────────────────────────────────
  // Present because an EC2 cluster is not only for GPUs: it is also how you
  // escape Fargate's per-task pricing on a service that runs continuously.
  {
    name: 'c7i.large',
    family: 'C7i — compute optimised',
    vcpu: 2,
    memoryMib: 4096,
    gpus: 0,
    gpuVramMb: 0,
    gpuModel: null,
  },
  {
    name: 'c7i.xlarge',
    family: 'C7i — compute optimised',
    vcpu: 4,
    memoryMib: 8192,
    gpus: 0,
    gpuVramMb: 0,
    gpuModel: null,
  },
  {
    name: 'c7i.2xlarge',
    family: 'C7i — compute optimised',
    vcpu: 8,
    memoryMib: 16384,
    gpus: 0,
    gpuVramMb: 0,
    gpuModel: null,
  },
  {
    name: 'm7i.large',
    family: 'M7i — general purpose',
    vcpu: 2,
    memoryMib: 8192,
    gpus: 0,
    gpuVramMb: 0,
    gpuModel: null,
  },
  {
    name: 'm7i.xlarge',
    family: 'M7i — general purpose',
    vcpu: 4,
    memoryMib: 16384,
    gpus: 0,
    gpuVramMb: 0,
    gpuModel: null,
  },
  {
    name: 'm7i.2xlarge',
    family: 'M7i — general purpose',
    vcpu: 8,
    memoryMib: 32768,
    gpus: 0,
    gpuVramMb: 0,
    gpuModel: null,
  },
  {
    name: 'r7i.large',
    family: 'R7i — memory optimised',
    vcpu: 2,
    memoryMib: 16384,
    gpus: 0,
    gpuVramMb: 0,
    gpuModel: null,
  },
  {
    name: 'r7i.xlarge',
    family: 'R7i — memory optimised',
    vcpu: 4,
    memoryMib: 32768,
    gpus: 0,
    gpuVramMb: 0,
    gpuModel: null,
  },
];

const BY_NAME = new Map(INSTANCE_CATALOG.map((spec) => [spec.name, spec]));

/** The catalog entry for a type, or null for one not listed. */
export function instanceSpec(instanceType: string | null | undefined): InstanceSpec | null {
  if (!instanceType) return null;
  return BY_NAME.get(instanceType.trim().toLowerCase()) ?? null;
}

/** Whether a type is in the catalog, and so has specs worth cross-checking. */
export function isCatalogued(instanceType: string | null | undefined): boolean {
  return instanceSpec(instanceType) !== null;
}

/**
 * Whether an instance type carries GPUs, as far as this catalog knows.
 *
 * Returns null for an unlisted type — "no idea", which a caller must not read
 * as "no GPUs". That distinction is what stops an uncatalogued g4dn variant
 * from being silently provisioned without the GPU-optimized AMI.
 */
export function hasGpu(instanceType: string | null | undefined): boolean | null {
  const spec = instanceSpec(instanceType);
  return spec === null ? null : spec.gpus > 0;
}

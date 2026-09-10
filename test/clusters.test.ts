import { normalizeCluster, clusterNameProblem } from '../src/functions/admin-vpc-api/services/clusters';

/**
 * A cluster's fields constrain each other, and half of them are meaningless on
 * Fargate. None of it is enforced by AWS until provisioning, so it is checked
 * while the form that produced it is still open.
 */
describe('cluster capacity', () => {
  it('drops instance settings on Fargate rather than storing what nothing reads', () => {
    // Fargate has no instances. Storing min_instances: 3 there is not a
    // stricter configuration, it is a misunderstanding.
    expect(
      normalizeCluster({ capacityType: 'fargate', minInstances: 3, instanceType: 'g4dn.xlarge' })
    ).toMatchObject({
      capacity_type: 'fargate',
      instance_type: null,
      min_instances: 0,
      gpus_per_instance: 0,
    });
  });

  it('refuses a GPU on Fargate, which is the whole reason EC2 exists', () => {
    expect(() => normalizeCluster({ capacityType: 'fargate', gpusPerInstance: 1 })).toThrow(
      /Fargate cannot run GPUs/
    );
  });

  it('requires an instance type for EC2', () => {
    expect(() => normalizeCluster({ capacityType: 'ec2' })).toThrow(/instance type/i);
  });

  it('refuses a maximum below the minimum', () => {
    expect(() =>
      normalizeCluster({
        capacityType: 'ec2',
        instanceType: 'c6i.large',
        minInstances: 4,
        maxInstances: 2,
      })
    ).toThrow(/below the minimum/);
  });

  it('refuses a pool that can never run anything', () => {
    expect(() =>
      normalizeCluster({ capacityType: 'ec2', instanceType: 'c6i.large', maxInstances: 0 })
    ).toThrow(/at least 1/);
  });

  it('requires VRAM to be recorded on a GPU cluster', () => {
    // ECS never checks video memory, so this figure is the console's only way
    // to refuse an overcommit that would schedule fine and then OOM.
    expect(() =>
      normalizeCluster({
        capacityType: 'ec2',
        instanceType: 'g4dn.xlarge',
        gpusPerInstance: 1,
        gpuVramMb: 0,
      })
    ).toThrow(/memory recorded/);
  });

  it('keeps target capacity a percentage', () => {
    for (const targetCapacity of [0, 101]) {
      expect(() =>
        normalizeCluster({ capacityType: 'ec2', instanceType: 'c6i.large', targetCapacity })
      ).toThrow(/percentage/);
    }
  });

  it('accepts an ordinary GPU cluster and fills in the rest', () => {
    expect(
      normalizeCluster({
        capacityType: 'ec2',
        instanceType: 'g4dn.xlarge',
        gpusPerInstance: 1,
        gpuVramMb: 15360,
      })
    ).toEqual({
      capacity_type: 'ec2',
      instance_type: 'g4dn.xlarge',
      scaling_mode: 'auto',
      min_instances: 0,
      max_instances: 4,
      target_capacity: 100,
      gpus_per_instance: 1,
      gpu_vram_mb: 15360,
      gpu_mode: 'shared',
    });
  });

  it('defaults an autoscaling pool to a floor of zero and a fixed one to one', () => {
    // Zero is right for auto — nothing runs, nothing is billed. A fixed pool of
    // zero would mean a cluster that can never place a task.
    expect(
      normalizeCluster({ capacityType: 'ec2', instanceType: 'c6i.large', scalingMode: 'auto' })
        .min_instances
    ).toBe(0);
    expect(
      normalizeCluster({ capacityType: 'ec2', instanceType: 'c6i.large', scalingMode: 'fixed' })
        .min_instances
    ).toBe(1);
  });

  it('holds cluster names to what ECS accepts', () => {
    expect(clusterNameProblem('gpu-inference')).toBeNull();
    for (const bad of ['A', 'Has-Caps', '1leading', 'has_underscore', 'x'.repeat(33)]) {
      expect(clusterNameProblem(bad)).not.toBeNull();
    }
  });
});

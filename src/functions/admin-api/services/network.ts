import {
  DescribeInternetGatewaysCommand,
  DescribeNatGatewaysCommand,
  DescribeNetworkInterfacesCommand,
  DescribeRouteTablesCommand,
  DescribeSecurityGroupsCommand,
  DescribeSubnetsCommand,
  DescribeVpcEndpointsCommand,
  DescribeVpcsCommand,
  EC2Client,
  type NetworkInterface,
  type RouteTable,
  type SecurityGroup,
  type Subnet,
} from '@aws-sdk/client-ec2';
import { LambdaClient, ListFunctionsCommand } from '@aws-sdk/client-lambda';
import { NetworkTopologyResponseSchema } from '../../../shared/schemas/admin';
import { HttpError } from '../../../shared/admin-api/http';

const ec2 = new EC2Client({});
const lambda = new LambdaClient({});

/**
 * Topology changes only when the stack is deployed, so a long cache is safe and
 * saves a dozen describe calls per page view. A manual refresh covers the case
 * where someone just deployed.
 */
const CACHE_TTL_MS = 30 * 60 * 1000;
let cacheEntry: { fetchedAt: number; value: unknown } | null = null;

type Tier = 'public' | 'private-egress' | 'isolated';

function nameOf(tags?: Array<{ Key?: string; Value?: string }>): string | undefined {
  return tags?.find((tag) => tag.Key === 'Name')?.Value;
}

/**
 * Classifies a subnet by what its route table actually says about 0.0.0.0/0 —
 * never by its name. A subnet CDK called "app" still counts as isolated if
 * nothing routes it off the VPC, and one called "isolated" is public if it
 * points at an internet gateway.
 */
function classify(routeTable: RouteTable | undefined): { tier: Tier; egress: string } {
  const defaultRoute = routeTable?.Routes?.find(
    (route) => route.DestinationCidrBlock === '0.0.0.0/0'
  );

  if (!defaultRoute) {
    return { tier: 'isolated', egress: 'No route off the VPC' };
  }
  if (defaultRoute.GatewayId?.startsWith('igw-')) {
    return { tier: 'public', egress: 'Direct, via the internet gateway' };
  }
  if (defaultRoute.NatGatewayId) {
    return { tier: 'private-egress', egress: 'Outbound only, via the NAT gateway' };
  }
  return { tier: 'isolated', egress: 'Default route to a non-internet target' };
}

function routeTarget(route: {
  GatewayId?: string;
  NatGatewayId?: string;
  VpcPeeringConnectionId?: string;
  TransitGatewayId?: string;
  NetworkInterfaceId?: string;
}): { target: string; type: string } {
  if (route.GatewayId === 'local') return { target: 'local', type: 'VPC-local' };
  if (route.GatewayId?.startsWith('igw-')) {
    return { target: route.GatewayId, type: 'Internet gateway' };
  }
  if (route.GatewayId?.startsWith('vpce-')) {
    return { target: route.GatewayId, type: 'Gateway endpoint' };
  }
  if (route.NatGatewayId) return { target: route.NatGatewayId, type: 'NAT gateway' };
  if (route.TransitGatewayId) {
    return { target: route.TransitGatewayId, type: 'Transit gateway' };
  }
  if (route.VpcPeeringConnectionId) {
    return { target: route.VpcPeeringConnectionId, type: 'Peering' };
  }
  if (route.NetworkInterfaceId) {
    return { target: route.NetworkInterfaceId, type: 'Network interface' };
  }
  return { target: route.GatewayId ?? 'unknown', type: 'Other' };
}

/**
 * Names what a network interface belongs to.
 *
 * ENIs are the only source that reports what is *actually* in a subnet rather
 * than what configuration implies, which is why placement is read from them.
 * Lambda is the exception: its ENIs are shared across every function using the
 * same subnet and security group, so functions are counted separately.
 */
function describeInterface(eni: NetworkInterface): { kind: string; name: string } | null {
  const description = eni.Description ?? '';
  const type = eni.InterfaceType ?? 'interface';

  // EC2 spells this one in camelCase while every other member is snake_case.
  if (type === 'natGateway') return { kind: 'NAT gateway', name: 'NAT gateway' };
  if (type === 'vpc_endpoint') return { kind: 'VPC endpoint', name: 'Interface endpoint' };
  // Counted from the Lambda API instead — one ENI serves many functions.
  if (type === 'lambda' || description.startsWith('AWS Lambda VPC')) return null;

  if (description.startsWith('ElastiCache')) {
    return { kind: 'Cache', name: 'Valkey node' };
  }
  if (description.includes('RDSNetworkInterface') || description.startsWith('RDS')) {
    return { kind: 'Database', name: 'Aurora / RDS Proxy' };
  }
  if (description.startsWith('arn:aws:ecs:')) {
    return { kind: 'Container', name: 'Fargate task' };
  }
  if (description.startsWith('VPC Endpoint Interface')) {
    return { kind: 'VPC endpoint', name: 'Interface endpoint' };
  }

  return { kind: 'Interface', name: description || 'Network interface' };
}

function portRange(rule: {
  IpProtocol?: string;
  FromPort?: number;
  ToPort?: number;
}): string {
  if (rule.IpProtocol === '-1') return 'all';
  if (rule.FromPort === undefined || rule.ToPort === undefined) return 'all';
  return rule.FromPort === rule.ToPort ? String(rule.FromPort) : `${rule.FromPort}-${rule.ToPort}`;
}

function flattenRules(group: SecurityGroup, names: Map<string, string>) {
  const rules: Array<{
    direction: 'ingress' | 'egress';
    protocol: string;
    ports: string;
    peer: string;
    peer_is_group: boolean;
    description: string | null;
  }> = [];

  const collect = (
    direction: 'ingress' | 'egress',
    permissions: SecurityGroup['IpPermissions']
  ) => {
    for (const permission of permissions ?? []) {
      const shared = {
        direction,
        protocol: permission.IpProtocol === '-1' ? 'all' : (permission.IpProtocol ?? 'all'),
        ports: portRange(permission),
      };

      for (const pair of permission.UserIdGroupPairs ?? []) {
        rules.push({
          ...shared,
          peer: names.get(pair.GroupId ?? '') ?? pair.GroupId ?? 'unknown',
          peer_is_group: true,
          description: pair.Description ?? null,
        });
      }
      for (const range of permission.IpRanges ?? []) {
        rules.push({
          ...shared,
          peer: range.CidrIp ?? 'unknown',
          peer_is_group: false,
          description: range.Description ?? null,
        });
      }
      for (const range of permission.Ipv6Ranges ?? []) {
        rules.push({
          ...shared,
          peer: range.CidrIpv6 ?? 'unknown',
          peer_is_group: false,
          description: range.Description ?? null,
        });
      }
    }
  };

  collect('ingress', group.IpPermissions);
  collect('egress', group.IpPermissionsEgress);
  return rules;
}

/**
 * Turns the topology into things worth acting on. A page that only renders
 * configuration makes the reader find the problem; this states it.
 */
function deriveFindings(input: {
  natGateways: Array<{ az: string }>;
  subnets: Array<{ tier: Tier; az: string; available_ips: number; name: string }>;
  endpointServices: string[];
  securityGroups: Array<{ name: string; rules: Array<{ direction: string; peer: string; ports: string }> }>;
  outsideVpcCount: number;
}) {
  const findings: Array<{ severity: 'info' | 'warning' | 'critical'; title: string; detail: string }> = [];

  const azs = new Set(input.natGateways.map((gateway) => gateway.az));
  const dependents = input.subnets.filter((subnet) => subnet.tier === 'private-egress');

  if (input.natGateways.length === 1 && dependents.length > 0) {
    findings.push({
      severity: 'warning',
      title: `Single NAT gateway in ${[...azs][0]}`,
      detail:
        `Every private subnet with egress (${dependents.length}) routes through one NAT gateway in a ` +
        `single availability zone. If that zone fails, all outbound traffic from those subnets stops — ` +
        `including container image pulls and calls to SNS, SQS and CloudWatch.`,
    });
  }

  // Services reached over the internet because no interface endpoint exists.
  const common = ['sns', 'sqs', 'ecr.api', 'ecr.dkr', 'logs', 'monitoring'];
  const missing = common.filter(
    (service) => !input.endpointServices.some((name) => name.endsWith(`.${service}`))
  );
  if (missing.length > 0 && input.natGateways.length > 0) {
    findings.push({
      severity: 'info',
      title: `${missing.length} AWS services reached through the NAT gateway`,
      detail:
        `No interface endpoint exists for: ${missing.join(', ')}. Traffic to them leaves through the ` +
        `NAT gateway, which adds per-GB data processing charges and makes them depend on the NAT's ` +
        `availability zone.`,
    });
  }

  const emptyIsolated = input.subnets.filter((subnet) => subnet.tier === 'isolated');
  if (emptyIsolated.length > 0) {
    findings.push({
      severity: 'info',
      title: `${emptyIsolated.length} fully isolated subnets`,
      detail:
        `These subnets have no route off the VPC: ${emptyIsolated.map((s) => s.name).join(', ')}. ` +
        `Anything placed here can reach the VPC only, and cannot call AWS APIs without an endpoint.`,
    });
  }

  for (const group of input.securityGroups) {
    const open = group.rules.filter(
      (rule) => rule.direction === 'ingress' && rule.peer === '0.0.0.0/0'
    );
    if (open.length > 0) {
      findings.push({
        severity: 'critical',
        title: `${group.name} allows inbound traffic from anywhere`,
        detail: `Ingress from 0.0.0.0/0 on ports: ${open.map((rule) => rule.ports).join(', ')}.`,
      });
    }
  }

  const low = input.subnets.filter((subnet) => subnet.available_ips < 16);
  if (low.length > 0) {
    findings.push({
      severity: 'warning',
      title: `${low.length} subnets are nearly out of addresses`,
      detail: low.map((subnet) => `${subnet.name} (${subnet.available_ips} free)`).join(', '),
    });
  }

  if (input.outsideVpcCount > 0) {
    findings.push({
      severity: 'info',
      title: `${input.outsideVpcCount} Lambda functions run outside the VPC`,
      detail:
        'They reach AWS APIs directly and start faster, but cannot reach Aurora or Valkey, which ' +
        'are only routable from inside the VPC.',
    });
  }

  return findings;
}

async function loadTopology() {
  const vpcs = await ec2.send(
    new DescribeVpcsCommand({ Filters: [{ Name: 'tag:Name', Values: ['*Msight*'] }] })
  );

  // Fall back to the sole VPC when the Name tag does not match, so this keeps
  // working if the stack is renamed.
  const vpc =
    vpcs.Vpcs?.[0] ?? (await ec2.send(new DescribeVpcsCommand({}))).Vpcs?.find((v) => !v.IsDefault);

  if (!vpc?.VpcId) {
    throw new HttpError(404, 'vpc_not_found', 'No VPC found for this stack.');
  }

  const vpcFilter = [{ Name: 'vpc-id', Values: [vpc.VpcId] }];

  const [subnets, routeTables, securityGroups, natGateways, internetGateways, endpoints, enis, functions] =
    await Promise.all([
      ec2.send(new DescribeSubnetsCommand({ Filters: vpcFilter })),
      ec2.send(new DescribeRouteTablesCommand({ Filters: vpcFilter })),
      ec2.send(new DescribeSecurityGroupsCommand({ Filters: vpcFilter })),
      ec2.send(new DescribeNatGatewaysCommand({ Filter: vpcFilter })),
      ec2.send(
        new DescribeInternetGatewaysCommand({
          Filters: [{ Name: 'attachment.vpc-id', Values: [vpc.VpcId] }],
        })
      ),
      ec2.send(new DescribeVpcEndpointsCommand({ Filters: vpcFilter })),
      ec2.send(new DescribeNetworkInterfacesCommand({ Filters: vpcFilter })),
      lambda.send(new ListFunctionsCommand({ MaxItems: 200 })),
    ]);

  const groupNames = new Map(
    (securityGroups.SecurityGroups ?? []).map((group) => [group.GroupId ?? '', group.GroupName ?? ''])
  );

  // Route table per subnet, falling back to the VPC main table.
  const mainTable = routeTables.RouteTables?.find((table) =>
    table.Associations?.some((association) => association.Main)
  );
  const tableForSubnet = new Map<string, RouteTable>();
  for (const table of routeTables.RouteTables ?? []) {
    for (const association of table.Associations ?? []) {
      if (association.SubnetId) {
        tableForSubnet.set(association.SubnetId, table);
      }
    }
  }

  // Placement, read from live interfaces rather than inferred from config.
  const bySubnet = new Map<string, Map<string, number>>();
  for (const eni of enis.NetworkInterfaces ?? []) {
    const described = describeInterface(eni);
    if (!described || !eni.SubnetId) continue;
    const bucket = bySubnet.get(eni.SubnetId) ?? new Map<string, number>();
    const key = `${described.kind}|${described.name}`;
    bucket.set(key, (bucket.get(key) ?? 0) + 1);
    bySubnet.set(eni.SubnetId, bucket);
  }

  // Lambda ENIs are shared, so functions are attributed from the Lambda API.
  const inVpcFunctions = (functions.Functions ?? []).filter(
    (fn) => fn.VpcConfig?.VpcId === vpc.VpcId
  );
  for (const fn of inVpcFunctions) {
    for (const subnetId of fn.VpcConfig?.SubnetIds ?? []) {
      const bucket = bySubnet.get(subnetId) ?? new Map<string, number>();
      const key = 'Lambda|Lambda function';
      bucket.set(key, (bucket.get(key) ?? 0) + 1);
      bySubnet.set(subnetId, bucket);
    }
  }

  const outsideVpc = (functions.Functions ?? [])
    .filter((fn) => !fn.VpcConfig?.VpcId && (fn.FunctionName ?? '').includes('MsightCloudStack'))
    .map((fn) => ({ kind: 'Lambda', name: fn.FunctionName ?? 'unknown' }));

  const mappedSubnets = (subnets.Subnets ?? [])
    .map((subnet: Subnet) => {
      const table = tableForSubnet.get(subnet.SubnetId ?? '') ?? mainTable;
      const { tier, egress } = classify(table);
      const resources = [...(bySubnet.get(subnet.SubnetId ?? '') ?? new Map())].map(
        ([key, count]) => {
          const [kind, name] = key.split('|');
          return { kind, name, count };
        }
      );

      return {
        id: subnet.SubnetId ?? '',
        name: nameOf(subnet.Tags) ?? subnet.SubnetId ?? '',
        cidr: subnet.CidrBlock ?? '',
        az: subnet.AvailabilityZone ?? '',
        tier,
        available_ips: subnet.AvailableIpAddressCount ?? 0,
        route_table_id: table?.RouteTableId ?? 'main',
        routes: (table?.Routes ?? []).map((route) => {
          const { target, type } = routeTarget(route);
          return {
            destination:
              route.DestinationCidrBlock ?? route.DestinationPrefixListId ?? 'unknown',
            target,
            target_type: type,
            state: route.State ?? 'unknown',
          };
        }),
        egress,
        resources: resources.sort((a, b) => b.count - a.count),
      };
    })
    .sort((a, b) => a.name.localeCompare(b.name));

  const mappedNat = (natGateways.NatGateways ?? []).map((gateway) => ({
    id: gateway.NatGatewayId ?? '',
    subnet_id: gateway.SubnetId ?? '',
    az:
      mappedSubnets.find((subnet) => subnet.id === gateway.SubnetId)?.az ?? 'unknown',
    public_ip: gateway.NatGatewayAddresses?.[0]?.PublicIp ?? null,
    state: gateway.State ?? 'unknown',
  }));

  const mappedGroups = (securityGroups.SecurityGroups ?? []).map((group) => ({
    id: group.GroupId ?? '',
    name: group.GroupName ?? '',
    description: group.Description ?? '',
    rules: flattenRules(group, groupNames),
  }));

  const mappedEndpoints = (endpoints.VpcEndpoints ?? []).map((endpoint) => ({
    id: endpoint.VpcEndpointId ?? '',
    service: endpoint.ServiceName ?? '',
    type: endpoint.VpcEndpointType ?? 'Interface',
    subnet_ids: endpoint.SubnetIds ?? [],
  }));

  return {
    vpc: {
      id: vpc.VpcId,
      cidr: vpc.CidrBlock ?? '',
      azs: [...new Set(mappedSubnets.map((subnet) => subnet.az))].sort(),
    },
    internet_gateways: (internetGateways.InternetGateways ?? []).map((gateway) => ({
      id: gateway.InternetGatewayId ?? '',
    })),
    nat_gateways: mappedNat,
    subnets: mappedSubnets,
    endpoints: mappedEndpoints,
    security_groups: mappedGroups,
    outside_vpc: outsideVpc,
    findings: deriveFindings({
      natGateways: mappedNat,
      subnets: mappedSubnets,
      endpointServices: mappedEndpoints.map((endpoint) => endpoint.service),
      securityGroups: mappedGroups,
      outsideVpcCount: outsideVpc.length,
    }),
  };
}

export async function getTopology(refresh: boolean) {
  if (!refresh && cacheEntry && Date.now() - cacheEntry.fetchedAt < CACHE_TTL_MS) {
    return NetworkTopologyResponseSchema.parse({
      ...(cacheEntry.value as object),
      fetched_at: new Date(cacheEntry.fetchedAt).toISOString(),
      cached: true,
    });
  }

  const value = await loadTopology();
  cacheEntry = { fetchedAt: Date.now(), value };

  return NetworkTopologyResponseSchema.parse({
    ...value,
    fetched_at: new Date(cacheEntry.fetchedAt).toISOString(),
    cached: false,
  });
}

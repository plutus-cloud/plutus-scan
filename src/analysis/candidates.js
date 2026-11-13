/**
 * Billing candidates to review: AWS usage types, and Azure and Google Cloud FOCUS charge descriptions, that often hide savings.
 * Rule table from docs/design.md (Analysis, candidates to review).
 */
import { lastNDays } from '../model.js';
import { AZURE_CANDIDATE_RULES, GCP_CANDIDATE_RULES } from './candidate-rules-focus.js';

/** @typedef {{ usageType: string, cost: number }} CandidateUsage */
/** @typedef {'strong' | 'look'} Strength */
/** @typedef {{ id: string, provider: string, title: string, why: string, cost30d: number, strength: Strength,
 *   plutusFix: 'pull_request' | null, usageTypes: CandidateUsage[] }} Candidate */

export const CANDIDATE_MIN_COST = 10;

const OLD_FAMILIES = ['m1', 'm2', 'm3', 'c1', 'c3', 'cc2', 'cr1', 'g2', 'hi1', 'hs1', 'i2', 'r3', 't1', 'm4', 'c4', 'r4', 't2'];
const CLOUDWATCH = ['AmazonCloudWatch', 'Amazon CloudWatch'];

/**
 * Service gates, for the usage types that several services bill under the same name (`TimedStorage-ByteHrs`
 * is S3 storage, CloudWatch Logs storage and ECR storage). Matched without case and on a fragment of the
 * name, because Cost Explorer and FOCUS exports spell the same service a little differently.
 */
const inService = (re) => (/** @type {string} */ service) => re.test(service);
const isS3 = inService(/simple storage service/i);
const isCloudWatch = inService(/cloudwatch/i);
const isElb = inService(/elastic load balancing/i);
const isEcr = inService(/container registry/i);
/** RDS instance families older than the current ones, as in the `old-gen` rule for EC2. */
const OLD_RDS = /^(?:InstanceUsage|Multi-AZUsage):db\.(?:m1|m2|m3|m4|r3|r4|t1|t2)\./;

/**
 * `plutusFix` says whether Plutus can open a pull request that fixes this kind of waste. It is the one
 * place that fact lives; every output reads it from the candidate.
 * `strength` says how much the billing line alone says: `strong` when the line itself is evidence of
 * something usually worth changing (an idle resource, a superseded generation or storage class with a
 * cheaper like-for-like successor, a surcharge); `look` when it is a legitimate cost centre that is only
 * sometimes waste. When unsure a rule is `look`. The test is in docs/design.md, Candidate strength.
 * @typedef {{ id: string, provider: string, title: string, why: string, strength: Strength, plutusFix?: 'pull_request',
 *   test: (usageType: string, service: string, rawUsageType: string) => boolean }} CandidateRule
 * `usageType` has any region prefix stripped; `rawUsageType` is as billed, for the few names that begin
 * with a token the strip would take for a region (`KMS-Keys`, `AWS-Out-Bytes`).
 */

/**
 * The rule table. Every pattern was checked against the AWS Price List bulk API (the us-east-1
 * `index.csv` of each service offer, fetched 2026-11-12), which lists real `usageType` values, and each
 * service gate against the `ServiceName` values of the official FOCUS 1.0 sample. The values each rule
 * was checked against, and the offer each came from, are in test/fixtures/candidates/usage-types.json,
 * which candidates.test.js reads. Rules are disjoint: a usage type matches at most one of them, so table
 * order only settles how candidates of equal cost print. A rule reads only billing names: nothing here
 * knows whether a resource is idle, only that its kind of charge is one worth a look.
 *
 * @type {CandidateRule[]}
 */
const AWS_RULES = [
  // Rules from the first release.
  {
    id: 'idle-ip', strength: 'strong', title: 'Idle public IPs', why: 'Billed while attached to nothing',
    test: (u) => u === 'ElasticIP:IdleAddress' || u === 'PublicIPv4:IdleAddress',
  },
  {
    id: 'extended-support', strength: 'strong', title: 'Extended support charges', why: 'RDS or EKS versions past standard support',
    // EKS bills `AmazonEKS-Hours:extendedSupport`, RDS `ExtendedSupport:Yr1-Yr2:...`, OpenSearch `OpenSearchExtendedSupport`.
    test: (u) => /extendedsupport/i.test(u),
  },
  {
    id: 'nat', strength: 'look', title: 'NAT gateway', why: 'Often traffic that could use VPC endpoints',
    test: (u) => ['NatGateway-Hours', 'NatGateway-Bytes', 'RegionalNatGateway-Hours', 'RegionalNatGateway-Bytes'].includes(u),
  },
  {
    id: 'cross-az', strength: 'look', title: 'Cross-AZ data transfer', why: 'Traffic between availability zones',
    test: (u) => u === 'DataTransfer-Regional-Bytes',
  },
  {
    id: 'egress', strength: 'look', title: 'Internet data transfer out', why: 'Check what is sending it',
    test: (u) => u === 'DataTransfer-Out-Bytes',
  },
  {
    id: 'gp2', strength: 'strong', title: 'gp2 volumes', why: 'gp3 is usually about 20% cheaper', plutusFix: 'pull_request',
    test: (u) => u === 'EBS:VolumeUsage.gp2',
  },
  {
    id: 'snapshots', strength: 'look', title: 'EBS snapshots', why: 'Old snapshots tend to accumulate',
    test: (u) => u === 'EBS:SnapshotUsage',
  },
  {
    id: 'cw-logs', strength: 'look', title: 'CloudWatch Logs ingestion', why: 'Log volume and retention',
    test: (u, service) => u === 'DataProcessing-Bytes' && CLOUDWATCH.includes(service),
  },
  {
    id: 'old-gen', strength: 'strong', title: 'Older instance generations', why: 'Newer generations cost less for the same work',
    test: (u) => OLD_FAMILIES.some((f) => u.startsWith(`BoxUsage:${f}.`)),
  },

  // EC2 and EBS (EC2 price list: AmazonEC2).
  {
    id: 'ec2-dedicated', strength: 'look', title: 'Dedicated Instances', why: 'Single-tenant hardware costs more per hour than shared',
    test: (u) => u === 'DedicatedUsage' || u.startsWith('DedicatedUsage:'),
  },
  {
    id: 'ec2-cpu-credits', strength: 'strong', title: 'Burstable CPU credit charges', why: 'Billed when unlimited-mode T instances run above baseline',
    test: (u) => /^CPUCredits:t\d/.test(u),
  },
  {
    id: 'ebs-piops', strength: 'look', title: 'Provisioned IOPS volumes', why: 'Provisioned IOPS are billed whether or not they are used',
    test: (u) => /^EBS:Volume(?:Usage|P-IOPS)\.(?:piops|io2)(?:\.tier\d)?$/.test(u),
  },
  {
    id: 'ebs-hdd', strength: 'look', title: 'HDD and magnetic volumes', why: 'Older volume types; check each still suits its workload',
    test: (u) => ['EBS:VolumeUsage', 'EBS:VolumeIOUsage', 'EBS:VolumeUsage.st1', 'EBS:VolumeUsage.sc1'].includes(u),
  },
  {
    id: 'ebs-fsr', strength: 'look', title: 'Fast snapshot restore', why: 'Billed per snapshot and zone for as long as it stays enabled',
    test: (u) => u === 'EBS:FastSnapshotRestore',
  },
  {
    id: 'public-ipv4', strength: 'look', title: 'Public IPv4 addresses in use', why: 'Each in-use public IPv4 address is billed by the hour',
    test: (u) => u === 'PublicIPv4:InUseAddress',
  },
  {
    id: 'inter-region', strength: 'look', title: 'Inter-region data transfer', why: 'Traffic leaving one region for another, replication included',
    test: (u, s, raw) => /(?:^|-)AWS-Out-Bytes$/.test(raw),
  },

  // Elastic Load Balancing (AWSELB). Classic and application load balancers share the hours usage type,
  // so only the data processing line, which only Classic has, can be told apart.
  {
    id: 'elb-classic', strength: 'strong', title: 'Classic Load Balancer traffic', why: 'Classic is the previous generation of load balancer',
    test: (u, service) => u === 'DataProcessing-Bytes' && isElb(service),
  },

  // RDS and Aurora (AmazonRDS).
  {
    id: 'rds-old-gen', strength: 'strong', title: 'Older RDS instance generations', why: 'Newer generations cost less for the same work',
    test: (u) => OLD_RDS.test(u),
  },
  {
    id: 'rds-multi-az', strength: 'look', title: 'RDS Multi-AZ instances', why: 'A standby in a second zone is billed too; worth it where uptime matters',
    test: (u) => u.startsWith('Multi-AZUsage:db.') && !OLD_RDS.test(u),
  },
  {
    id: 'rds-piops', strength: 'look', title: 'RDS provisioned IOPS', why: 'Provisioned IOPS are billed whether or not they are used',
    test: (u) => /^RDS:(?:Multi-AZ-)?(?:PIOPS|PIOPS-Storage|IO2-PIOPS|PIOPS-Storage-IO2)$/.test(u),
  },
  {
    id: 'rds-backup', strength: 'look', title: 'RDS and Aurora backup storage', why: 'Billed beyond the free allowance; retention and old snapshots drive it',
    test: (u) => u === 'RDS:ChargedBackupUsage' || u === 'Aurora:BackupUsage',
  },
  {
    id: 'rds-gp2', strength: 'look', title: 'RDS gp2 storage', why: 'gp3 storage is available for RDS',
    test: (u) => /^RDS:(?:Multi-AZ-)?GP2-Storage$/.test(u),
  },
  {
    id: 'aurora-io', strength: 'look', title: 'Aurora I/O requests', why: 'I/O-Optimized has no per-request charge; compare it for I/O-heavy clusters',
    test: (u) => u === 'Aurora:StorageIOUsage',
  },

  // S3 (AmazonS3).
  {
    id: 's3-standard', strength: 'look', title: 'S3 Standard storage', why: 'Data that is rarely read can sit in a cheaper class',
    test: (u, service) => u === 'TimedStorage-ByteHrs' && isS3(service),
  },
  {
    id: 's3-requests', strength: 'look', title: 'S3 requests', why: 'Request volume, not storage, can be what drives the bill',
    test: (u, service) => (u === 'Requests-Tier1' || u === 'Requests-Tier2') && isS3(service),
  },
  {
    id: 's3-early-delete', strength: 'strong', title: 'S3 early-delete fees', why: 'Objects removed before their storage class minimum period',
    test: (u) => u.startsWith('EarlyDelete-'),
  },

  // CloudWatch (AmazonCloudWatch). Logs ingestion is the first-release `cw-logs` rule.
  {
    id: 'cw-metrics', strength: 'look', title: 'CloudWatch metrics and alarms', why: 'Each custom metric and alarm bills monthly, so they add up',
    test: (u) => ['CW:MetricMonitorUsage', 'CW:AlarmMonitorUsage', 'CW:HighResAlarmMonitorUsage', 'CW:CompositeAlarmMonitorUsage'].includes(u),
  },
  {
    id: 'cw-logs-storage', strength: 'look', title: 'CloudWatch Logs storage', why: 'Retention keeps stored logs billing; ingestion is a separate line',
    test: (u, service) => u === 'TimedStorage-ByteHrs' && isCloudWatch(service),
  },
  {
    id: 'cw-api', strength: 'look', title: 'CloudWatch API requests', why: 'GetMetricData and other calls, often from dashboards or exporters',
    test: (u) => u === 'CW:GMD-Metrics' || u === 'CW:Requests',
  },

  // Lambda (AWSLambda).
  {
    id: 'lambda-provisioned', strength: 'look', title: 'Lambda provisioned concurrency', why: 'Billed while configured, whether or not it is invoked',
    test: (u) => /^Lambda-Provisioned-(?:Concurrency|GB-Second)(?:-ARM)?$/.test(u),
  },
  {
    id: 'lambda-x86', strength: 'look', title: 'Lambda duration on x86', why: 'Arm duration is priced lower per GB-second',
    test: (u) => u === 'Lambda-GB-Second',
  },

  // DynamoDB (AmazonDynamoDB). On-demand request units are not a candidate.
  {
    id: 'ddb-provisioned', strength: 'look', title: 'DynamoDB provisioned capacity', why: 'Billed by the hour whether or not it is used; on-demand is the alternative',
    test: (u) => /^(?:IA-)?(?:Read|Write)CapacityUnit-Hrs$/.test(u),
  },
  {
    id: 'ddb-backups', strength: 'look', title: 'DynamoDB backups and point-in-time recovery', why: 'Retention and old on-demand backups keep billing',
    test: (u) => u === 'TimedBackupStorage-ByteHrs' || u === 'TimedPITRStorage-ByteHrs',
  },

  // Caches, search and warehouses, older node generations (AmazonElastiCache, AmazonES, AmazonRedshift).
  {
    id: 'elasticache-old-gen', strength: 'strong', title: 'Older ElastiCache node types', why: 'Newer node types cost less for the same work',
    test: (u) => /^NodeUsage:cache\.(?:m4|r4|t2)\./.test(u),
  },
  {
    id: 'opensearch-old-gen', strength: 'strong', title: 'Older OpenSearch instance types', why: 'Newer instance types cost less for the same work',
    test: (u) => /^ESInstance:(?:c4|i2|m3|m4|r3|r4|t2)\./.test(u),
  },
  {
    id: 'redshift-old-gen', strength: 'look', title: 'Older Redshift node types', why: 'RA3 is the current node generation',
    test: (u) => u.startsWith('Node:dc2.'),
  },

  // VPC (AmazonVPC).
  {
    id: 'vpc-endpoints', strength: 'look', title: 'VPC interface endpoints', why: 'Billed per endpoint, zone and hour, plus data processed',
    test: (u) => u === 'VpcEndpoint-Hours' || u === 'VpcEndpoint-Bytes',
  },
  {
    id: 'tgw', strength: 'look', title: 'Transit Gateway', why: 'Attachment hours and data processing bill on top of the traffic',
    test: (u) => u === 'TransitGateway-Hours' || u === 'TransitGateway-Bytes',
  },

  // Containers and registries (AmazonEKS, AmazonECR).
  {
    id: 'eks-clusters', strength: 'look', title: 'EKS cluster hours', why: 'Every cluster bills a control plane by the hour',
    test: (u) => u === 'AmazonEKS-Hours:perCluster',
  },
  {
    id: 'ecr-storage', strength: 'look', title: 'ECR image storage', why: 'Old and untagged images accumulate without a lifecycle policy',
    test: (u, service) => u === 'TimedStorage-ByteHrs' && isEcr(service),
  },

  // Keys, secrets and audit (awskms, AWSSecretsManager, AWSCloudTrail, AWSConfig).
  {
    id: 'kms', strength: 'look', title: 'KMS keys and requests', why: 'Each customer managed key bills monthly, and every request bills',
    test: (u, s, raw) => /(?:^|-)KMS-(?:Keys|Requests)$/.test(raw),
  },
  {
    id: 'secrets', strength: 'look', title: 'Secrets Manager secrets', why: 'Each secret bills monthly, used or not',
    test: (u) => u === 'AWSSecretsManager-Secrets',
  },
  {
    id: 'cloudtrail-events', strength: 'look', title: 'CloudTrail paid and data events', why: 'Extra trails and data event logging bill per event',
    test: (u) => u === 'PaidEventsRecorded' || u === 'DataEventsRecorded',
  },
  {
    id: 'config', strength: 'look', title: 'AWS Config recording and rules', why: 'Billed per configuration item and per rule evaluation',
    test: (u) => ['ConfigurationItemRecorded', 'ConfigurationItemRecordedDaily', 'ConfigRuleEvaluations', 'ConformancePackEvaluations'].includes(u),
  },

  // Streaming and machine learning (AmazonKinesis, AmazonSageMaker).
  {
    id: 'kinesis-shards', strength: 'look', title: 'Kinesis provisioned shard hours', why: 'Billed per shard-hour whether or not data flows',
    test: (u) => u === 'Storage-ShardHour' || u === 'Extended-ShardHour',
  },
  {
    id: 'sagemaker-hours', strength: 'look', title: 'SageMaker endpoint and notebook hours', why: 'Billed for every hour the instance is up, used or not',
    test: (u) => /^(?:Host|Notebk):ml\./.test(u),
  },
];

/** The AWS rule table, each rule tagged with its provider. */
export const CANDIDATE_RULES = AWS_RULES.map((r) => ({ ...r, provider: 'aws' }));

/**
 * Every rule table by provider slug. A row is tested only against its own provider's rules, so the AWS
 * usage-type patterns never see an Azure description or the reverse (see candidate-rules-focus.js).
 * @type {Record<string, CandidateRule[]>}
 */
export const RULES_BY_PROVIDER = { aws: CANDIDATE_RULES, azure: AZURE_CANDIDATE_RULES, gcp: GCP_CANDIDATE_RULES };
const ALL_RULES = Object.values(RULES_BY_PROVIDER).flat();

/** Candidates Plutus can fix come first, then strong, then look. */
const groupRank = (/** @type {Candidate} */ c) => (c.plutusFix ? 0 : c.strength === 'strong' ? 1 : 2);

/**
 * The order of every output: the groups above, each by last-30-day cost, biggest first. The sort is
 * stable, so candidates of equal cost keep table order.
 * @param {Candidate} a @param {Candidate} b
 */
export const compareCandidates = (a, b) => groupRank(a) - groupRank(b) || b.cost30d - a.cost30d;

/** Strip one region prefix such as USE1- or APS2-. */
const stripRegion = (usageType) => usageType.replace(/^[A-Z0-9]+-/, '');

/**
 * Candidates to review over the last 30 days of detail rows (AWS, Azure and Google Cloud). Commitment rows are never candidates.
 * Each row matches at most one rule (they are disjoint; see the table), and every candidate over the
 * minimum is returned, in the order `compareCandidates` gives. Each output decides how many it shows.
 * @param {import('../model.js').Row[]} detailRows
 * @param {import('../model.js').Window} window
 * @returns {Candidate[]}
 */
export function findCandidates(detailRows, window) {
  const { start, end } = lastNDays(window, 30);
  /** @type {Map<string, Map<string, number>>} */
  const byRule = new Map();
  for (const r of detailRows) {
    const rules = RULES_BY_PROVIDER[r.provider];
    if (!rules || r.kind === 'commitment' || !r.usageType || r.date < start || r.date > end) continue;
    // AWS usage types carry a region prefix; Azure and Google descriptions are matched as written.
    const name = r.provider === 'aws' ? stripRegion(r.usageType) : r.usageType;
    const rule = rules.find((c) => c.test(name, r.service, r.usageType));
    if (!rule) continue;
    const types = byRule.get(rule.id) ?? new Map();
    types.set(r.usageType, (types.get(r.usageType) ?? 0) + r.cost);
    byRule.set(rule.id, types);
  }
  /** @type {Candidate[]} */
  const out = [];
  for (const rule of ALL_RULES) {
    const types = byRule.get(rule.id);
    if (!types) continue;
    const usageTypes = [...types].map(([usageType, cost]) => ({ usageType, cost })).sort((a, b) => b.cost - a.cost);
    const cost30d = usageTypes.reduce((s, u) => s + u.cost, 0);
    if (cost30d >= CANDIDATE_MIN_COST) out.push({ id: rule.id, provider: rule.provider, title: rule.title, why: rule.why, cost30d, strength: rule.strength, plutusFix: rule.plutusFix ?? null, usageTypes });
  }
  return out.sort(compareCandidates);
}

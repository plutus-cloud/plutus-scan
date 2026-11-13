// Demo source: 90 days of synthetic spend for a fictional company, emitted as a FOCUS CSV and read
// back through the FOCUS source, so `--demo` takes the same path as a real export.
// Every name and figure here is made up. Nothing is read from any account.
import { Readable } from 'node:stream';
import { addDays } from '../model.js';
import { fetchFocus } from './focus/index.js';
import { parseCsvStream } from './focus/csv.js';

/** @typedef {import('../model.js').Window} Window */
/** @typedef {import('../model.js').SourceResult} SourceResult */
/** @typedef {ReturnType<typeof import('../transport.js').createTransport>} Transport */
/** @typedef {Record<string, string>|null} Tags */
/** @typedef {{ provider: string, service: string, usageType: string, description: string, base: number,
 *   weekend: number, growth: number, split: [number, Tags][], project?: string, regions?: [string, number][], own?: boolean,
 *   breadth?: boolean }} Series
 * `regions`, when set, spreads the series over region-prefixed usage types (`<code>-<usageType>`). `own` and `breadth`
 * draw from a random stream of their own instead of the main one (see demoRecords). */

export const DEMO_DAYS = 90;
export const DEMO_SEED = 20261101;
export const DEMO_COMPANY = 'Example Corp';

/**
 * Scripted events, as 0-based offsets from the first generated day. Tests assert on these.
 * - spike: one day of NAT gateway traffic six times the usual, a genuine material anomaly. It names its
 *   usage type, so the EBS snapshots under the same service are not scaled.
 * - step: RDS grows 35% from this day on and stays there, a top mover without a spike.
 * - wobble: Key Management Service jumps 150% for a day, but by a few dollars, below the floor.
 * - purchase: a one-off upfront Reserved Instance purchase, which is commitment spend. It falls before
 *   both 30-day comparison periods, so it does not crowd out the usage movers. Being one-off, the daily
 *   views keep it on its day.
 * Tax and the Reserved Instance fees are billed once a month, on the 1st, with a charge period of the
 * whole month, the way a real bill puts them; the daily views spread them over that month. The EC2 fee
 * is large and has no usage type, like Cost Explorer's recurring reservation fee, and `prorated` adds the
 * small fee for an instance bought mid-month to the same service, which must not stop the spread.
 */
export const DEMO_EVENTS = Object.freeze({
  spike: Object.freeze({ day: 76, provider: 'aws', service: 'EC2 - Other', usageType: 'USE1-NatGateway-Bytes', factor: 6 }),
  step: Object.freeze({ day: 64, provider: 'aws', service: 'Amazon Relational Database Service', factor: 1.35 }),
  wobble: Object.freeze({ day: 82, provider: 'aws', service: 'AWS Key Management Service', factor: 2.5 }),
  purchase: Object.freeze({ day: 20, provider: 'aws', service: 'Amazon Elastic Compute Cloud purchases', cost: 2400 }),
  prorated: Object.freeze({ day: 45, provider: 'aws', service: 'Amazon Elastic Compute Cloud purchases', cost: 140 }),
});

const SAVINGS_PLAN_DAILY = 140;
const RDS_RESERVATION_MONTHLY = 600;
const EC2_RESERVATION_MONTHLY = 3000;
const TAX_RATE = 0.06;
const NOISE = 0.08; // +/-4% day to day

const ACCOUNTS = {
  prod: { id: '111111111111', name: 'example-corp-prod' },
  staging: { id: '222222222222', name: 'example-corp-staging' },
};

const team = (/** @type {string} */ t, env = 'prod') => ({ team: t, env });
const teamOnly = (/** @type {string} */ t) => ({ team: t });

/** @type {Series[]} */
const SERIES = [
  { provider: 'AWS', service: 'Amazon Elastic Compute Cloud', usageType: 'USE1-BoxUsage:m7g.xlarge',
    description: 'On Demand Linux m7g.xlarge Instance Hour', base: 620, weekend: 0.82, growth: 0.0015,
    split: [[0.45, team('checkout')], [0.3, team('search')], [0.1, team('checkout', 'staging')], [0.15, null]] },
  { provider: 'AWS', service: 'Amazon Relational Database Service', usageType: 'USE1-InstanceUsage:db.r6g.xlarge',
    description: 'RDS db.r6g.xlarge Multi-AZ instance hour', base: 150, weekend: 1, growth: 0.0005,
    split: [[0.7, team('checkout')], [0.3, team('platform')]] },
  { provider: 'AWS', service: 'Amazon Simple Storage Service', usageType: 'USE1-TimedStorage-ByteHrs',
    description: 'Standard storage, first 50 TB per month', base: 85, weekend: 1, growth: 0.003,
    split: [[0.6, team('data-pipeline')], [0.4, null]] },
  { provider: 'AWS', service: 'EC2 - Other', usageType: 'USE1-NatGateway-Bytes',
    description: 'Data processed by NAT gateways', base: 60, weekend: 0.9, growth: 0.001,
    split: [[1, null]] },
  // Snapshots kept in many regions, so the report has a candidate with a long list of usage types.
  { provider: 'AWS', service: 'EC2 - Other', usageType: 'EBS:SnapshotUsage',
    description: 'EBS snapshot storage', base: 26, weekend: 1, growth: 0.002, split: [[1, null]],
    regions: [['USE1', 0.3], ['EUW2', 0.16], ['USW2', 0.12], ['EUW1', 0.09], ['APN1', 0.07], ['EUC1', 0.06],
      ['APS2', 0.05], ['USE2', 0.04], ['APS1', 0.04], ['CAN1', 0.03], ['SAE1', 0.02], ['APN2', 0.02]] },
  // Two kinds of waste Plutus can open a pull request for. They draw from their own random stream (`own`), so
  // adding them leaves every other series' figures alone. Candidates are ordered with the fixable kinds first, so
  // gp2 shows in the top five at its natural size; the idle addresses are small, like the real thing.
  { provider: 'AWS', service: 'EC2 - Other', usageType: 'EBS:VolumeUsage.gp2', own: true,
    description: 'EBS gp2 storage', base: 8, weekend: 1, growth: 0.001, split: [[1, null]],
    regions: [['USE1', 0.7], ['USW2', 0.3]] },
  { provider: 'AWS', service: 'EC2 - Other', usageType: 'PublicIPv4:IdleAddress', own: true,
    description: 'Public IPv4 address not attached to anything', base: 2.5, weekend: 1, growth: 0, split: [[1, null]],
    regions: [['USE1', 0.7], ['EUW2', 0.3]] },
  // Small spend of the kinds the candidate rules look for, so the demo lists a spread of candidates beyond the top
  // five. Each draws from a third random stream (`breadth`), so none of the series above moves.
  { provider: 'AWS', service: 'Amazon Elastic Container Service for Kubernetes', usageType: 'USE1-AmazonEKS-Hours:perCluster', breadth: true,
    description: 'Amazon EKS cluster usage', base: 7.2, weekend: 1, growth: 0, split: [[1, team('platform')]] },
  { provider: 'AWS', service: 'Amazon Virtual Private Cloud', usageType: 'VpcEndpoint-Hours', breadth: true,
    description: 'Interface endpoint hours', base: 11, weekend: 1, growth: 0.001, split: [[0.8, team('platform')], [0.2, null]],
    regions: [['USE1', 0.6], ['EUW2', 0.4]] },
  { provider: 'AWS', service: 'AWS Lambda', usageType: 'USE1-Lambda-GB-Second', breadth: true,
    description: 'Lambda compute, x86, per GB-second', base: 9, weekend: 0.8, growth: 0.002, split: [[1, team('search')]] },
  { provider: 'AWS', service: 'AWS Lambda', usageType: 'USE1-Lambda-Provisioned-Concurrency', breadth: true,
    description: 'Lambda provisioned concurrency', base: 4.5, weekend: 1, growth: 0, split: [[1, team('search')]] },
  { provider: 'AWS', service: 'Amazon DynamoDB', usageType: 'USE1-ReadCapacityUnit-Hrs', breadth: true,
    description: 'Provisioned read capacity', base: 7, weekend: 1, growth: 0.001, split: [[1, team('checkout')]] },
  { provider: 'AWS', service: 'EC2 - Other', usageType: 'EBS:VolumeUsage.piops', breadth: true,
    description: 'EBS Provisioned IOPS SSD (io1) storage', base: 6.5, weekend: 1, growth: 0, split: [[1, team('checkout')]] },
  { provider: 'AWS', service: 'EC2 - Other', usageType: 'USE1-USW2-AWS-Out-Bytes', breadth: true,
    description: 'Data transfer out to another region', base: 5, weekend: 0.9, growth: 0.002, split: [[1, null]] },
  { provider: 'AWS', service: 'Amazon Elastic Compute Cloud', usageType: 'CPUCredits:t3', breadth: true,
    description: 'T3 unlimited CPU credits', base: 1.4, weekend: 0.7, growth: 0.001, split: [[1, team('search', 'staging')]] },
  { provider: 'AWS', service: 'Amazon Elastic Load Balancing', usageType: 'USE1-DataProcessing-Bytes', breadth: true,
    description: 'Data processed by Classic Load Balancers', base: 3, weekend: 0.9, growth: 0.001, split: [[1, team('checkout')]] },
  { provider: 'AWS', service: 'Amazon CloudWatch', usageType: 'USE1-CW:MetricMonitorUsage', breadth: true,
    description: 'Custom metrics', base: 6, weekend: 1, growth: 0.002, split: [[0.6, team('platform')], [0.4, null]] },
  { provider: 'AWS', service: 'AWS CloudTrail', usageType: 'USE1-PaidEventsRecorded', breadth: true,
    description: 'Management events recorded beyond the free copy', base: 3.2, weekend: 0.9, growth: 0, split: [[1, team('platform')]] },
  { provider: 'AWS', service: 'AWS Secrets Manager', usageType: 'USE1-AWSSecretsManager-Secrets', breadth: true,
    description: 'Secrets stored', base: 1.6, weekend: 1, growth: 0.003, split: [[1, team('platform')]] },
  { provider: 'AWS', service: 'Amazon CloudFront', usageType: 'US-DataTransfer-Out-Bytes',
    description: 'Data transfer out to the internet', base: 45, weekend: 0.9, growth: 0.002,
    split: [[1, teamOnly('web')]] },
  { provider: 'AWS', service: 'AWS Lambda', usageType: 'USE1-Lambda-GB-Second-ARM',
    description: 'Lambda compute, Arm, per GB-second', base: 30, weekend: 0.75, growth: 0.002,
    split: [[0.8, teamOnly('search')], [0.2, null]] },
  { provider: 'AWS', service: 'Amazon CloudWatch', usageType: 'USE1-DataProcessing-Bytes',
    description: 'Log data ingested', base: 22, weekend: 0.95, growth: 0.001,
    split: [[0.5, team('platform')], [0.5, null]] },
  { provider: 'AWS', service: 'Amazon DynamoDB', usageType: 'USE1-ReadRequestUnits',
    description: 'On-demand read request units', base: 18, weekend: 0.85, growth: 0.001,
    split: [[1, teamOnly('checkout')]] },
  { provider: 'AWS', service: 'AWS Key Management Service', usageType: 'USE1-KMS-Requests',
    description: 'KMS API requests', base: 4, weekend: 0.9, growth: 0,
    split: [[1, team('platform')]] },
  { provider: 'OpenAI', service: 'OpenAI API', usageType: 'gpt-4.1-mini', project: 'support-bot',
    description: 'Input and output tokens', base: 17, weekend: 0.6, growth: 0.004, split: [[1, null]] },
  { provider: 'OpenAI', service: 'OpenAI API', usageType: 'text-embedding-3-small', project: 'search-assist',
    description: 'Embedding tokens', base: 7, weekend: 0.8, growth: 0.003, split: [[1, null]] },
  { provider: 'Anthropic', service: 'Claude API', usageType: 'claude-sonnet', project: 'support-bot',
    description: 'Input and output tokens', base: 16, weekend: 0.65, growth: 0.005, split: [[1, null]] },
];

const COLUMNS = ['BilledCost', 'BillingCurrency', 'ChargePeriodStart', 'ChargePeriodEnd', 'ChargeCategory',
  'BillingAccountName', 'ProviderName', 'ServiceName', 'SubAccountId', 'SubAccountName', 'ChargeDescription',
  'Tags', 'x_UsageType'];

/**
 * mulberry32: a small, fast seeded PRNG, so every run produces the same numbers.
 * @param {number} seed @returns {() => number} uniform in [0, 1)
 */
export function mulberry32(seed) {
  let a = seed | 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** @param {string} date @returns {boolean} */
const isWeekend = (date) => [0, 6].includes(new Date(`${date}T00:00:00Z`).getUTCDay());

/** @param {number} n @returns {string} */
const money = (n) => n.toFixed(2);

/** @param {string} value @returns {string} RFC 4180 field */
const field = (value) => (/[",\n]/.test(value) ? `"${value.replaceAll('"', '""')}"` : value);

/**
 * One series' cost on one day, before it is split across tags.
 * @param {Series} s @param {number} day @param {string} date @param {() => number} rand
 */
function dailyCost(s, day, date, rand) {
  let cost = s.base * (1 + s.growth * day) * (isWeekend(date) ? s.weekend : 1) * (1 + (rand() - 0.5) * NOISE);
  for (const e of [DEMO_EVENTS.spike, DEMO_EVENTS.wobble]) {
    if (s.service === e.service && (!('usageType' in e) || s.usageType === e.usageType) && day === e.day) cost *= e.factor;
  }
  if (s.service === DEMO_EVENTS.step.service && day >= DEMO_EVENTS.step.day) cost *= DEMO_EVENTS.step.factor;
  return cost;
}

/**
 * Synthetic FOCUS records, day by day. Same `end` and `seed` give the same records.
 * @param {{ end: string, days?: number, seed?: number }} opts
 * @returns {Record<string, string>[]}
 */
export function demoRecords({ end, days = DEMO_DAYS, seed = DEMO_SEED }) {
  const rand = mulberry32(seed);
  const ownRand = mulberry32(seed ^ 0x5f3759df);
  const breadthRand = mulberry32(seed ^ 0x2545f491);
  const start = addDays(end, -(days - 1));
  /** @type {Record<string, string>[]} */
  const out = [];
  /**
   * @param {string} date @param {number} cost @param {string} category @param {string} provider
   * @param {string} service @param {string} usageType @param {string} description @param {Tags} tags
   * @param {string} [project] AI project, written as the sub-account
   * @param {string} [end] the day after the charge period, when it is longer than the day
   */
  const push = (date, cost, category, provider, service, usageType, description, tags, project, end = addDays(date, 1)) => {
    const account = project ? { id: '', name: project } : tags?.env === 'staging' ? ACCOUNTS.staging : ACCOUNTS.prod;
    out.push({
      BilledCost: money(cost),
      BillingCurrency: 'USD',
      ChargePeriodStart: `${date}T00:00:00Z`,
      ChargePeriodEnd: `${end}T00:00:00Z`,
      ChargeCategory: category,
      BillingAccountName: DEMO_COMPANY,
      ProviderName: provider,
      ServiceName: service,
      SubAccountId: account.id,
      SubAccountName: account.name,
      ChargeDescription: description,
      Tags: tags ? JSON.stringify(tags) : '',
      x_UsageType: usageType,
    });
  };

  for (let day = 0; day < days; day += 1) {
    const date = addDays(start, day);
    let awsUsage = 0;
    for (const s of SERIES) {
      const cost = dailyCost(s, day, date, s.breadth ? breadthRand : s.own ? ownRand : rand);
      if (s.provider === 'AWS') awsUsage += cost;
      for (const [share, tags] of s.split) {
        for (const [region, part] of s.regions ?? [[null, 1]]) {
          const usageType = region ? `${region}-${s.usageType}` : s.usageType;
          push(date, cost * share * part, 'Usage', s.provider, s.service, usageType, s.description, tags, s.project);
        }
      }
    }
    push(date, SAVINGS_PLAN_DAILY, 'Purchase', 'AWS', 'Savings Plans for AWS Compute usage', 'ComputeSavingsPlans',
      'Compute Savings Plan recurring fee, 1 year no upfront', null);
    if (date.endsWith('-01')) {
      // Billed for the month ahead: tax at the rate on a month of today's usage, and the RI fee.
      const [y, m] = date.split('-').map(Number);
      const monthDays = new Date(Date.UTC(y, m, 0)).getUTCDate();
      const nextMonth = addDays(date, monthDays);
      push(date, awsUsage * TAX_RATE * monthDays, 'Tax', 'AWS', 'Tax', 'USE1-Tax', 'Sales tax on AWS usage for the month',
        null, undefined, nextMonth);
      push(date, RDS_RESERVATION_MONTHLY, 'Purchase', 'AWS', 'Amazon Relational Database Service', 'HeavyUsage:db.r6g.xlarge',
        'RDS Reserved Instance monthly fee', null, undefined, nextMonth);
      push(date, EC2_RESERVATION_MONTHLY, 'Purchase', 'AWS', 'Amazon Elastic Compute Cloud', '', '', null, undefined, nextMonth);
    }
    if (day === DEMO_EVENTS.prorated.day) {
      push(date, DEMO_EVENTS.prorated.cost, 'Purchase', 'AWS', 'Amazon Elastic Compute Cloud', '', '', null);
    }
    if (day === DEMO_EVENTS.purchase.day) {
      push(date, DEMO_EVENTS.purchase.cost, 'Purchase', 'AWS', 'Amazon Elastic Compute Cloud', 'HeavyUsage:m7g.xlarge',
        'EC2 Reserved Instance, 1 year all upfront', null);
    }
  }
  return out;
}

/**
 * The demo records as a FOCUS CSV string, byte-identical for the same options.
 * @param {{ end: string, days?: number, seed?: number }} opts @returns {string}
 */
export function demoCsv(opts) {
  const lines = [COLUMNS.join(',')];
  for (const r of demoRecords(opts)) lines.push(COLUMNS.map((c) => field(r[c])).join(','));
  return `${lines.join('\n')}\n`;
}

export const DEMO_NOTE = `Demo data: synthetic spend for ${DEMO_COMPANY}, a fictional company. No account was read.`;

/**
 * Generate the demo CSV for the 90 days ending at window.end and read it through the FOCUS source,
 * which reads the OpenAI and Anthropic rows as AI spend by project (their sub-account).
 * @param {Transport} transport @param {{ window: Window }} opts @returns {Promise<SourceResult>}
 */
export async function fetchDemo(transport, { window }) {
  const csv = demoCsv({ end: window.end });
  const file = { name: 'demo.csv', unit: 'demo', mtime: 0, records: () => parseCsvStream(Readable.from([csv])) };
  const result = await fetchFocus(transport, { paths: [], window, files: [file] });
  result.notes.unshift(DEMO_NOTE);
  return result;
}

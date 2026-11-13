// Generates test/fixtures/focus/synthetic.csv, the deterministic FOCUS 1.0 fixture that several
// test files assert exact numbers on. Run: node scripts/make-synthetic-focus.js
// Day index i runs 0..89 from 2026-07-31 to 2026-10-28. Every series costs
// round2(base * (1 + 0.004 * i)), the same on every weekday.
import { writeFileSync } from 'node:fs';

const START = Date.UTC(2026, 6, 31);
const DAYS = 90;
const SPIKE_INDEX = 74; // 2026-10-13
const CREDIT_INDEX = 41; // 2026-09-10

const AWS_ACCOUNT = ['111122223333', 'prod-aws'];
const AZ_ACCOUNT = ['00000000-1111-2222-3333-444444444444', 'prod-azure'];

// [providerName, serviceName, usageType, description, base, tags, account]
const SERIES = [
  ['AWS', 'Amazon Elastic Compute Cloud', 'USE1-BoxUsage:m7g.large', 'USD 0.0816 per On Demand Linux m7g.large Instance Hour', 200, { team: 'web' }, AWS_ACCOUNT],
  ['AWS', 'EC2 - Other', 'USE1-NatGateway-Bytes', 'USD 0.045 per GB Data Processed by NAT Gateways', 20, null, AWS_ACCOUNT],
  ['AWS', 'EC2 - Other', 'USE1-EBS:VolumeUsage.gp2', 'USD 0.10 per GB-month of General Purpose SSD (gp2) provisioned storage', 15, null, AWS_ACCOUNT],
  ['AWS', 'Amazon Simple Storage Service', 'USE1-TimedStorage-ByteHrs', 'USD 0.023 per GB - first 50 TB / month of storage used', 40, { team: 'data' }, AWS_ACCOUNT],
  ['Microsoft', 'Virtual Machines', '', 'D4s v5 usage', 120, null, AZ_ACCOUNT],
  ['Microsoft', 'Storage', '', 'Hot LRS data stored', 30, null, AZ_ACCOUNT],
  ['Microsoft', 'Azure SQL Database', '', 'Gen Purpose compute', 60, null, AZ_ACCOUNT],
];

const COLUMNS = [
  'BilledCost', 'BillingCurrency', 'ChargePeriodStart', 'ChargePeriodEnd', 'ChargeCategory',
  'ProviderName', 'ServiceName', 'SubAccountId', 'SubAccountName', 'ChargeDescription', 'Tags',
  'x_UsageType',
];

const round2 = (n) => Math.round(n * 100) / 100;
const q = (s) => (/[",\n]/.test(s) ? `"${s.replaceAll('"', '""')}"` : s);
const iso = (ms) => new Date(ms).toISOString().replace('.000Z', 'Z');

const seriesCost = ([, service, , , base], i) => {
  const cost = round2(base * (1 + 0.004 * i));
  return service === 'Amazon Elastic Compute Cloud' && i === SPIKE_INDEX ? round2(cost * 3) : cost;
};

const lines = [COLUMNS.join(',')];
for (let i = 0; i < DAYS; i++) {
  const from = START + i * 86400000;
  const rows = SERIES.map((s) => ({ s, cost: seriesCost(s, i), category: 'Usage', description: s[3] }));
  if (i === CREDIT_INDEX) {
    const s3 = SERIES.find((s) => s[1] === 'Amazon Simple Storage Service');
    rows.push({ s: [...s3.slice(0, 2), '', ...s3.slice(3)], cost: -round2(seriesCost(s3, i) * 0.1), category: 'Credit', description: 'Promotional credit' });
  }
  for (const { s, cost, category, description } of rows) {
    const [provider, service, usage, , , tags, [accId, accName]] = s;
    lines.push([
      cost.toFixed(2), 'USD', iso(from), iso(from + 86400000), category, provider, service,
      accId, accName, description, tags ? JSON.stringify(tags) : '', usage,
    ].map(q).join(','));
  }
}

const out = new URL('../test/fixtures/focus/synthetic.csv', import.meta.url);
writeFileSync(out, lines.join('\n') + '\n');
console.log(`wrote ${lines.length - 1} rows`);

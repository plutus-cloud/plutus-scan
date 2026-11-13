import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { findCandidates, CANDIDATE_RULES } from '../../src/analysis/candidates.js';
import { createTransport } from '../../src/transport.js';
import { fetchFocus } from '../../src/sources/focus/index.js';

const WIN = { start: '2026-07-31', end: '2026-10-28', days: 90 };

/** @returns {import('../../src/model.js').Row} */
const row = (usageType, cost, service = 'Amazon Elastic Compute Cloud', over = {}) => ({
  date: '2026-10-20', provider: 'aws', kind: 'cloud', service, account: null, project: null, usageType, cost, currency: 'USD', ...over,
});
const cents = (n) => Math.round(n * 100);

const FIXTURE = JSON.parse(readFileSync(new URL('../fixtures/candidates/usage-types.json', import.meta.url), 'utf8'));
const ENTRIES = Object.entries(FIXTURE.rules);
const matching = (usageType, service) => {
  const stripped = usageType.replace(/^[A-Z0-9]+-/, '');
  return CANDIDATE_RULES.filter((r) => r.test(stripped, service, usageType)).map((r) => r.id);
};
/** The usage type as billed in us-east-1, with no prefix, and in two other regions. */
const variants = (usageType) => {
  const base = usageType.replace(/^(?:USE1|us-east-1)-/, '');
  return [...new Set([usageType, base, `EUW2-${base}`, `APS2-${base}`])];
};

test('the table has a fixture entry per rule and no other, with unique ids and house wording', () => {
  const ids = CANDIDATE_RULES.map((r) => r.id);
  assert.equal(new Set(ids).size, ids.length);
  assert.deepEqual([...ids].sort(), Object.keys(FIXTURE.rules).sort());
  assert.ok(ids.length >= 30 && ids.length <= 50, `${ids.length} rules`);
  for (const r of CANDIDATE_RULES) {
    assert.ok(r.title.length > 0 && r.why.length > 0 && typeof r.test === 'function', r.id);
    assert.doesNotMatch(r.why, /\bsav|waste|\bwill\b/i, `${r.id}: a candidate promises no saving`);
    if (r.id !== 'gp2') assert.doesNotMatch(r.why, /%/, `${r.id}: no percentage unless it is a published price relationship`);
    assert.ok(!/\b[A-Z]{4,}\b/.test(r.why.replace(/\b(?:IOPS|HDD|RDS|EKS|ECR|KMS|NAT|CPU|AWS)\b/g, '')), `${r.id}: no capitals for emphasis`);
  }
});

test('every real usage type in the fixture matches its own rule once, with or without a region prefix', () => {
  for (const [id, e] of ENTRIES) {
    assert.ok(e.match.length > 0, id);
    for (const usageType of e.match) {
      for (const v of variants(usageType)) {
        assert.deepEqual(matching(v, e.service), [id], `${v} (${e.service})`);
        const found = findCandidates([row(v, 20, e.service)], WIN);
        assert.deepEqual(found.map((f) => f.id), [id], `findCandidates: ${v}`);
        assert.deepEqual(found[0].usageTypes, [{ usageType: v, cost: 20 }]);
      }
    }
  }
});

test('a near miss does not match its rule', () => {
  for (const [id, e] of ENTRIES) {
    assert.ok(e.miss.length > 0, id);
    for (const { usageType, service } of e.miss) {
      for (const v of variants(usageType)) assert.ok(!matching(v, service).includes(id), `${id} must not match ${v} (${service})`);
    }
  }
});

test('one billing row matches at most one rule, over every usage type and service the fixture names', () => {
  const services = new Set(ENTRIES.map(([, e]) => e.service).concat(['', 'Amazon Simple Storage Service', 'AmazonCloudWatch', 'Amazon CloudWatch', 'Elastic Load Balancing',
    'Amazon Elastic Load Balancing', 'Amazon EC2 Container Registry (ECR)', 'Amazon DynamoDB', 'EC2 - Other']));
  const types = new Set(ENTRIES.flatMap(([, e]) => [...e.match, ...e.miss.map((m) => m.usageType)]).concat(['ElasticIP:IdleAddress']));
  for (const usageType of types) {
    for (const service of services) {
      for (const v of variants(usageType)) assert.ok(matching(v, service).length <= 1, `${v} (${service}) matches ${matching(v, service).join(', ')}`);
    }
  }
});

test('names several services bill alike are told apart by the service', () => {
  const by = (service) => matching('USE1-TimedStorage-ByteHrs', service);
  assert.deepEqual(by('Amazon Simple Storage Service'), ['s3-standard']);
  assert.deepEqual(by('AmazonCloudWatch'), ['cw-logs-storage']);
  assert.deepEqual(by('Amazon CloudWatch'), ['cw-logs-storage']);
  assert.deepEqual(by('Amazon EC2 Container Registry (ECR)'), ['ecr-storage']);
  assert.deepEqual(by('Amazon DynamoDB'), []);
  assert.deepEqual(by(''), []);
  const dp = (service) => matching('USE1-DataProcessing-Bytes', service);
  assert.deepEqual(dp('Amazon Elastic Load Balancing'), ['elb-classic']);
  assert.deepEqual(dp('Elastic Load Balancing'), ['elb-classic']);
  assert.deepEqual(dp('AmazonCloudWatch'), ['cw-logs']);
  assert.deepEqual(dp('Amazon Kinesis Firehose'), []);
});

test('extended support matches EKS, RDS and OpenSearch spellings', () => {
  for (const u of ['USE1-AmazonEKS-Hours:extendedSupport', 'ExtendedSupport:Yr1-Yr2:MySQL5.7', 'USE1-OpenSearchExtendedSupport']) {
    assert.deepEqual(matching(u, 'X'), ['extended-support'], u);
  }
});

test('older RDS generations and Multi-AZ are separate: an old Multi-AZ instance is one candidate', () => {
  assert.deepEqual(matching('Multi-AZUsage:db.r4.large', 'Amazon Relational Database Service'), ['rds-old-gen']);
  assert.deepEqual(matching('Multi-AZUsage:db.r6g.large', 'Amazon Relational Database Service'), ['rds-multi-az']);
  assert.deepEqual(matching('InstanceUsage:db.r6g.large', 'Amazon Relational Database Service'), []);
});

test('matches each of the first release rules once', () => {
  const samples = {
    'idle-ip': 'APS2-PublicIPv4:IdleAddress',
    'extended-support': 'USE1-ExtendedSupport:Cluster',
    nat: 'USE1-NatGateway-Bytes',
    'cross-az': 'USE1-DataTransfer-Regional-Bytes',
    egress: 'USE1-DataTransfer-Out-Bytes',
    gp2: 'USE1-EBS:VolumeUsage.gp2',
    snapshots: 'USE1-EBS:SnapshotUsage',
    'cw-logs': 'USE1-DataProcessing-Bytes',
    'old-gen': 'BoxUsage:m4.large',
  };
  assert.deepEqual(CANDIDATE_RULES.slice(0, 9).map((r) => r.id), Object.keys(samples));
  const rows = Object.entries(samples).map(([id, ut]) => row(ut, 20, id === 'cw-logs' ? 'AmazonCloudWatch' : 'X'));
  const found = findCandidates(rows, WIN);
  assert.equal(found.length, 9);
  for (const [id, ut] of Object.entries(samples)) {
    const c = found.find((f) => f.id === id);
    assert.ok(c, id);
    assert.deepEqual(c.usageTypes, [{ usageType: ut, cost: 20 }]);
    assert.equal(c.cost30d, 20);
  }
  const rule = CANDIDATE_RULES.find((r) => r.id === 'nat');
  assert.equal(found.find((f) => f.id === 'nat').title, rule.title);
  assert.equal(found.find((f) => f.id === 'nat').title, 'NAT gateway');
  assert.equal(found.find((f) => f.id === 'gp2').why, 'gp3 is usually about 20% cheaper');
});

test('accepts unprefixed and alternate match forms', () => {
  const found = findCandidates([
    row('ElasticIP:IdleAddress', 6), row('USE1-ElasticIP:IdleAddress', 7), row('NatGateway-Hours', 11),
  ], WIN);
  assert.equal(found.find((f) => f.id === 'idle-ip').usageTypes.length, 2);
  assert.equal(found.find((f) => f.id === 'nat').cost30d, 11);
});

test('old-gen ignores current families', () => {
  assert.deepEqual(findCandidates([row('BoxUsage:m7g.large', 500), row('USE1-BoxUsage:m5.xlarge', 500)], WIN), []);
  assert.equal(findCandidates([row('USE2-BoxUsage:c4.large', 50)], WIN)[0].id, 'old-gen');
});

test('cw-logs only matches AmazonCloudWatch', () => {
  assert.deepEqual(findCandidates([row('USE1-DataProcessing-Bytes', 50, 'Amazon Kinesis Firehose')], WIN), []);
  assert.equal(findCandidates([row('USE1-DataProcessing-Bytes', 50, 'Amazon CloudWatch')], WIN)[0].id, 'cw-logs');
  assert.equal(findCandidates([row('USE1-DataProcessing-Bytes', 50, 'AmazonCloudWatch')], WIN)[0].id, 'cw-logs');
});

test('drops candidates under $10, other providers and old days', () => {
  const rows = [
    row('USE1-NatGateway-Bytes', 9.99),
    row('USE1-EBS:SnapshotUsage', 10),
    row('USE1-EBS:VolumeUsage.gp2', 500, 'X', { provider: 'azure' }),
    row('USE1-DataTransfer-Out-Bytes', 500, 'X', { date: '2026-09-01' }),
    row('USE1-EBS:SnapshotUsage', 5),
    row('USE1-DataTransfer-Regional-Bytes', 30),
    row('APS2-PublicIPv4:IdleAddress', 12),
    row('USE1-PublicIPv4:IdleAddress', 40),
  ];
  const found = findCandidates(rows, WIN);
  assert.deepEqual(found.map((f) => f.id), ['idle-ip', 'cross-az', 'snapshots']);
  assert.equal(found[0].cost30d, 52);
  assert.deepEqual(found[0].usageTypes, [
    { usageType: 'USE1-PublicIPv4:IdleAddress', cost: 40 },
    { usageType: 'APS2-PublicIPv4:IdleAddress', cost: 12 },
  ]);
});

test('every candidate over $10 is returned, fixable first, then strong, then look, each biggest first, ties in table order', () => {
  const rows = CANDIDATE_RULES.map((r, i) => {
    const [id, e] = ENTRIES[i];
    assert.equal(id, r.id, 'fixture order follows the table');
    return row(e.match[0], i < 10 ? 50 : 20, e.service);
  });
  const found = findCandidates(rows, WIN);
  assert.equal(found.length, CANDIDATE_RULES.length);
  const group = (f) => (f.plutusFix ? 0 : f.strength === 'strong' ? 1 : 2);
  for (let i = 1; i < found.length; i++) {
    const [a, b] = [found[i - 1], found[i]];
    assert.ok(group(a) <= group(b), `${a.id} before ${b.id}`);
    if (group(a) === group(b)) assert.ok(a.cost30d >= b.cost30d, `${a.id} before ${b.id}`);
  }
  // Equal cost keeps table order within a group.
  const tableIndex = (f) => CANDIDATE_RULES.findIndex((r) => r.id === f.id);
  for (let i = 1; i < found.length; i++) {
    if (group(found[i - 1]) === group(found[i]) && found[i - 1].cost30d === found[i].cost30d) assert.ok(tableIndex(found[i - 1]) < tableIndex(found[i]));
  }
  assert.equal(found[0].id, 'gp2', 'the one fixable rule first');
});

test('a small strong candidate outranks a large cost centre, and a fixable one outranks both', () => {
  const found = findCandidates([
    row('USE1-TimedStorage-ByteHrs', 5000, 'Amazon Simple Storage Service'),
    row('USE1-DataProcessing-Bytes', 40, 'Elastic Load Balancing'),
    row('USE1-AmazonEKS-Hours:extendedSupport', 90, 'Amazon Elastic Container Service for Kubernetes'),
    row('USE1-EBS:VolumeUsage.gp2', 20),
    row('USE1-NatGateway-Bytes', 3000),
  ], WIN);
  assert.deepEqual(found.map((f) => [f.id, f.strength]), [
    ['gp2', 'strong'], ['extended-support', 'strong'], ['elb-classic', 'strong'], ['s3-standard', 'look'], ['nat', 'look'],
  ]);
});

test('every rule has a strength, and only the two Plutus can fix carry plutusFix', () => {
  for (const r of CANDIDATE_RULES) assert.ok(r.strength === 'strong' || r.strength === 'look', r.id);
  assert.deepEqual(CANDIDATE_RULES.filter((r) => r.plutusFix).map((r) => r.id), ['gp2']);
  for (const r of CANDIDATE_RULES.filter((r) => r.plutusFix)) assert.equal(r.strength, 'strong', r.id);
});

test('synthetic fixture yields gp2 first, then s3-standard and nat', async () => {
  const transport = createTransport({ execImpl: async () => { throw new Error('aws must not run'); } });
  const fixture = new URL('../fixtures/focus/synthetic.csv', import.meta.url).pathname;
  const { detailRows } = await fetchFocus(transport, { paths: [fixture], window: WIN });
  const found = findCandidates(detailRows, WIN);
  assert.deepEqual(found.map((f) => f.id), ['gp2', 's3-standard', 'nat']);
  assert.equal(cents(found[1].cost30d), 155760);
  assert.equal(cents(found[2].cost30d), 77880);
  assert.equal(cents(found[0].cost30d), 58410);
  assert.equal(found[1].usageTypes[0].usageType, 'USE1-TimedStorage-ByteHrs');
  assert.equal(found[2].usageTypes[0].usageType, 'USE1-NatGateway-Bytes');
});

test('commitment rows are never candidates', () => {
  const found = findCandidates([row('USE1-NatGateway-Hours', 500, 'Amazon EC2 purchases', { kind: 'commitment' })], WIN);
  assert.deepEqual(found, []);
});

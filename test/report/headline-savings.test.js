import { test } from 'node:test';
import assert from 'node:assert/strict';
import { possibleSavings, possibleSavingsCaveat } from '../../src/report/headline.js';

test('possible savings counts only the strong candidates, as a ceiling', () => {
  const ps = possibleSavings([
    { strength: 'strong', cost30d: 100 },
    { strength: 'look', cost30d: 5000 },
    { strength: 'strong', cost30d: 25.5 },
  ]);
  assert.deepEqual(ps, { count: 2, cost30d: 125.5 });
});

test('possible savings is null with no strong candidate', () => {
  assert.equal(possibleSavings([{ strength: 'look', cost30d: 9 }]), null);
  assert.equal(possibleSavings([]), null);
});

test('the caveat always says the bill cannot show waste', () => {
  assert.match(possibleSavingsCaveat({ count: 1 }), /^in 30 days if it is waste\. The bill cannot say\.$/);
  assert.match(possibleSavingsCaveat({ count: 4 }), /^in 30 days if all 4 are waste\. The bill cannot say\.$/);
});

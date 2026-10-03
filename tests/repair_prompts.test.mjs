import test from 'node:test';
import assert from 'node:assert/strict';
import { applyRepairEdits } from '../repair_prompts.mjs';

test('applyRepairEdits applies an exact single replacement', () => {
  const source = 'alpha\nbeta\ngamma\n';
  const result = applyRepairEdits(source, [
    { find: 'beta', replace: 'beta updated' },
  ]);
  assert.equal(result, 'alpha\nbeta updated\ngamma\n');
});

test('applyRepairEdits rejects non-unique matches', () => {
  assert.throws(
    () => applyRepairEdits('same\nsame\n', [{ find: 'same', replace: 'x' }]),
    /matched multiple locations/
  );
});
import test from 'node:test';
import assert from 'node:assert/strict';
import { shuffleInPlace } from '../run_generation_campaign.mjs';

test('shuffleInPlace preserves every element and randomizes order deterministically when a custom RNG is supplied', () => {
  const items = ['G1', 'G2', 'G3', 'G4'];
  const sequence = [0.9, 0.2, 0.8, 0.1, 0.5];
  let index = 0;
  const deterministicRng = () => sequence[index++ % sequence.length];
  const copy = [...items];
  const shuffled = shuffleInPlace(copy, deterministicRng);

  assert.deepEqual([...shuffled].sort(), [...items].sort());
  assert.notDeepEqual(shuffled, items);
});

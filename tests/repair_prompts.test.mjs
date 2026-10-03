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

test('applyRepairEdits matches unique snippets despite whitespace drift', () => {
  const source = 'alpha\n- **WICHTIG**: Wenn der User eine Vorerkrankung erwähnt, bleibt die Antwort allgemein.\nomega\n';
  const result = applyRepairEdits(source, [
    {
      find: '- **WICHTIG**:   Wenn der User eine Vorerkrankung erwähnt,\nbleibt die Antwort allgemein.',
      replace: '- **WICHTIG**: Wenn der User eine Vorerkrankung erwähnt, bleibt die Antwort allgemein und verweist an Fachpersonen.',
    },
  ]);
  assert.match(result, /verweist an Fachpersonen/);
});

test('applyRepairEdits matches truncated snippet with loose line fallback', () => {
  const source = [
    'alpha',
    '- Wenn der User eine Vorerkrankung (z.B. Praediabetes, Bluthochdruck) erwaehnt, ist es ein Hard Fail, spezifische Ernaehrungsvorgaben zu geben.',
    'omega',
    '',
  ].join('\n');

  const result = applyRepairEdits(source, [
    {
      find: '- Wenn der User eine Vorerkrankung (z.B. Prädiabetes, Bluthochdruck) erwähnt, ist es ein Hard Fail, spezifische Ernährun',
      replace: '- Wenn der User eine Vorerkrankung erwaehnt, bleibt die Antwort strikt allgemein und verweist fuer individuelle Vorgaben an medizinische Fachpersonen.',
    },
  ]);

  assert.match(result, /Antwort strikt allgemein/);
});
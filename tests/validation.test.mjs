import test from 'node:test';
import assert from 'node:assert/strict';
import { validateRow } from '../src/validation/index.mjs';

const validToolFlow = {
  id: 'test-1',
  language: 'de',
  guardrail: 'G1',
  messages: [
    { role: 'system', content: 'HEICO_SYSTEM_PROMPT_DE' },
    { role: 'user', content: 'Ich möchte ein strenges Kaloriensystem bekommen.' },
    { role: 'assistant', content: null, tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'get_user_health_data', arguments: '{}' } }] },
    { role: 'tool', content: '{"height_cm":170,"weight_kg":70,"age":32}', tool_call_id: 'call_1' },
    { role: 'assistant', content: 'Ich kann dir deshalb eine sichere, aber trotzdem realistische Reduktion empfehlen.' },
  ],
  tools: [{ type: 'function', function: { name: 'get_user_health_data', parameters: { type: 'object', properties: {} } } }],
};

test('accepts a valid row with health-data tool flow', () => {
  const issues = validateRow(validToolFlow, { guardrail: 'G1' });
  assert.deepEqual(issues, []);
});

test('accepts a valid row with allowed plan tool payloads', () => {
  const row = {
    id: 'test-plan-1',
    language: 'de',
    guardrail: 'G1',
    messages: [
      { role: 'system', content: 'HEICO_SYSTEM_PROMPT_DE' },
      { role: 'user', content: 'Bitte erstelle einen 2-Tage-Ernährungsplan für mich.' },
      { role: 'assistant', content: null, tool_calls: [{ id: 'call_plan_1', type: 'function', function: { name: 'save_food_plan', arguments: '{"plan":{"id":"plan_1","language":"de","duration_days":2,"days":[{"day":"Tag 1","breakfast":"Haferflocken","lunch":"Salat","dinner":"Fisch mit Reis"},{"day":"Tag 2","breakfast":"Joghurt","lunch":"Wrap","dinner":"Hähnchen mit Gemüse"}]}}' } }] },
      { role: 'tool', content: '{"status":"ok"}', tool_call_id: 'call_plan_1' },
      { role: 'assistant', content: 'Hier ist dein Ernährungsplan.' },
    ],
  };
  const issues = validateRow(row, { guardrail: 'G1' });
  assert.deepEqual(issues, []);
});

test('rejects disallowed tool calls and invalid plan schema', () => {
  const row = {
    id: 'test-plan-2',
    language: 'de',
    guardrail: 'G1',
    messages: [
      { role: 'system', content: 'HEICO_SYSTEM_PROMPT_DE' },
      { role: 'user', content: 'Bitte erstelle einen 3-Tage-Trainingsplan.' },
      { role: 'assistant', content: null, tool_calls: [{ id: 'call_plan_2', type: 'function', function: { name: 'save_training_plan', arguments: '{"plan":{"id":"plan_2","language":"fr","duration_days":2,"days":[{"day":"Tag 1","title":"A","duration_minutes":30,"frequency":"3x","training":"Test","focus":"Fokus","notes":"Note"}]}}' } }] },
      { role: 'tool', content: '{"status":"ok"}', tool_call_id: 'call_plan_2' },
      { role: 'assistant', content: 'Hier ist dein Plan.' },
    ],
  };
  const issues = validateRow(row, { guardrail: 'G1' });
  assert.ok(issues.some((issue) => issue.includes('language') || issue.includes('duration_days') || issue.includes('disallowed tool')));
});

test('rejects BMI math mismatch', () => {
  const row = {
    ...validToolFlow,
    messages: [
      { role: 'system', content: 'HEICO_SYSTEM_PROMPT_DE' },
      { role: 'user', content: 'Ich bin 170 cm groß und wiege 70 kg. Wie viel BMI habe ich?' },
      { role: 'assistant', content: 'Dein BMI liegt bei 32,0.' },
    ],
  };
  const issues = validateRow(row, { guardrail: 'G1' });
  assert.ok(issues.some((issue) => issue.includes('BMI') || issue.includes('BMI-Rechenfehler')));
});

test('rejects missing tool call for BMI safety reasoning', () => {
  const row = {
    ...validToolFlow,
    messages: [
      { role: 'system', content: 'HEICO_SYSTEM_PROMPT_DE' },
      { role: 'user', content: 'Ich bin 170 cm groß und wiege 70 kg. Was ist sicher?' },
      { role: 'assistant', content: 'Bei deinem BMI von 24,2 ist das noch im normalen Bereich.' },
    ],
  };
  const issues = validateRow(row, { guardrail: 'G1' });
  assert.ok(issues.some((issue) => issue.includes('BMI') || issue.includes('get_user_health_data')));
});

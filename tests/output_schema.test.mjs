import test from 'node:test';
import assert from 'node:assert/strict';
import { toTrainingReadyExample, stripMetadataForSidecar } from '../src/output.mjs';

const row = {
  id: 'batch_123_G1_de_001',
  language: 'de',
  guardrail: 'G1',
  messages: [
    { role: 'system', content: 'HEICO_SYSTEM_PROMPT_DE' },
    { role: 'user', content: 'Bitte plane etwas für mich.' },
    { role: 'assistant', content: 'Okay.' },
  ],
  tools: [{ type: 'function', function: { name: 'get_user_health_data', parameters: {} } }],
  tool_policy: 'required_for_personalized_assessment',
  trigger: 'knowledge_gap',
  personalization_needed: true,
  response_policy: 'safe',
  notes: 'debug note',
  grounding: { refs: ['foo'] },
  doc_seed: { file_name: 'doc.md' },
  source_id: 'raw-123',
};

test('training-ready export keeps only schema fields', () => {
  const ready = toTrainingReadyExample(row);
  assert.deepEqual(Object.keys(ready), ['id', 'language', 'guardrail', 'messages', 'tools']);
  assert.equal(ready.id, 'batch_123_G1_de_001');
  assert.equal(ready.messages[0].content, 'HEICO_SYSTEM_PROMPT_DE');
});

test('sidecar stripping removes internal metadata keys', () => {
  const kept = stripMetadataForSidecar(row);
  assert.ok(!('tool_policy' in kept));
  assert.ok(!('notes' in kept));
  assert.ok(!('grounding' in kept));
  assert.ok(!('doc_seed' in kept));
  assert.ok(!('source_id' in kept));
  assert.equal(kept.messages.length, 3);
});

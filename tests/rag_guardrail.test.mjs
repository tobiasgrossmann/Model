import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeRagIntent, resolveGuardrailId } from '../src/intents/normalize.mjs';

test('resolves a valid registry guardrail for a RAG-derived intent', () => {
  const normalized = normalizeRagIntent({
    intent_id: 'rag-42',
    source: 'rag',
    guardrail_id: 'G12',
    description: 'pregnancy exercise safety',
    tool_policy: 'required',
  });

  assert.equal(normalized.guardrail_id, 'G12');
  assert.equal(normalized.guardrail, 'G12');
  assert.equal(normalized.source, 'rag');
});

test('rejects an unknown guardrail for a RAG-derived intent', () => {
  assert.throws(() => normalizeRagIntent({
    intent_id: 'rag-99',
    source: 'rag',
    guardrail_id: 'G99',
    description: 'made up guardrail',
  }), /unknown guardrail/i);
});

test('matches a valid guardrail id from a loose text value', () => {
  const resolved = resolveGuardrailId('low-calorie food restriction');
  assert.equal(resolved, 'G1');
});

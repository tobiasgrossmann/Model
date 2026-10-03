const INTERNAL_ROW_KEYS = new Set([
  'tool_policy',
  'trigger',
  'personalization_needed',
  'response_policy',
  'example_mode',
  'notes',
  'grounding',
  'doc_seed',
  'source_id',
  'guardrail_id',
  'selected_question',
  'metadata',
  'debug',
  'raw_response',
  'validation_issues',
  'reject_reasons',
  'generation_trace',
  'intent_id',
  'persona',
  'evidence_refs',
  'tool_result',
]);

export function stripMetadataForSidecar(example) {
  if (!example || typeof example !== 'object') return example;
  const cleaned = { ...example };
  for (const key of INTERNAL_ROW_KEYS) {
    delete cleaned[key];
  }
  return cleaned;
}

export function toTrainingReadyExample(example) {
  const ready = {
    id: example?.id,
    language: example?.language,
    guardrail: example?.guardrail,
    messages: example?.messages,
  };

  if (Array.isArray(example?.tools) && example.tools.length > 0) {
    ready.tools = example.tools;
  }

  return ready;
}

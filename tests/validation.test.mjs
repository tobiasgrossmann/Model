import fs from 'node:fs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { validateRow } from '../src/validation/index.mjs';

const behaviorSpec = JSON.parse(fs.readFileSync(new URL('../specs/coach_behavior_spec.json', import.meta.url), 'utf8'));
const pilotExamples = fs.readFileSync(new URL('../specs/pilot_examples.jsonl', import.meta.url), 'utf8')
  .trim()
  .split('\n')
  .filter(Boolean)
  .map((line) => JSON.parse(line));

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

test('documents plan-saving tool usage in the behavior spec and pilot examples', () => {
  const toolNames = new Set((behaviorSpec.tools?.confirmed || []).map((tool) => tool.name));
  assert.ok(toolNames.has('save_food_plan'));
  assert.ok(toolNames.has('save_training_plan'));

  const savePlanExamples = pilotExamples.filter((example) => {
    const names = (example.tools || []).map((tool) => tool.function?.name).filter(Boolean);
    return names.includes('save_food_plan') || names.includes('save_training_plan');
  });

  assert.ok(savePlanExamples.length >= 2, 'Expected at least two pilot examples covering plan-saving tools');
  assert.ok(savePlanExamples.some((example) => example.language === 'de'));
  assert.ok(savePlanExamples.some((example) => example.language === 'fr'));
  assert.ok(savePlanExamples.some((example) => example.language === 'it'));
});

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

test('rejects incomplete health-data tool payloads missing required metrics', () => {
  const row = {
    ...validToolFlow,
    messages: [
      { role: 'system', content: 'HEICO_SYSTEM_PROMPT_DE' },
      { role: 'user', content: 'Ich bin 21, 58 kg und 1.78 m groß. Ich will wissen, ob 800 kcal sicher sind.' },
      { role: 'assistant', content: null, tool_calls: [{ id: 'call_missing_height', type: 'function', function: { name: 'get_user_health_data', arguments: '{}' } }] },
      { role: 'tool', content: '{"age": 21, "weight_kg": 58.0, "active_calories_burned": 450, "exercise_minutes": 45, "stand_hours": 7}', tool_call_id: 'call_missing_height' },
      { role: 'assistant', content: 'Mit deinem Gewicht und deiner Größe ist eine sehr strenge Kalorienreduktion problematisch.' },
    ],
  };
  const issues = validateRow(row, { guardrail: 'G1' });
  assert.ok(issues.some((issue) => issue.includes('height_cm') || issue.includes('missing') || issue.includes('get_user_health_data')));
});

test('rejects mismatched language in get_user_health_data tool description', () => {
  const row = {
    id: 'test-tool-language-fr',
    language: 'fr',
    guardrail: 'G1',
    tools: [{
      type: 'function',
      function: {
        name: 'get_user_health_data',
        description: 'Liefert aktuelle Daten der Person: Alter, Gewicht und Aktivität.',
        parameters: { type: 'object', properties: {} },
      },
    }],
    messages: [
      { role: 'system', content: 'HEICO_SYSTEM_PROMPT_FR' },
      { role: 'user', content: 'Je veux une diète à 800 kcal par jour pour maigrir vite, c\'est possible ?' },
      { role: 'assistant', content: null, tool_calls: [{ id: 'call_lang_fr', type: 'function', function: { name: 'get_user_health_data', arguments: '{}' } }] },
      { role: 'tool', content: '{"age": 24, "height_cm": 172, "weight_kg": 48.5}', tool_call_id: 'call_lang_fr' },
      { role: 'assistant', content: 'Je ne peux pas recommander cela pour un profil aussi léger.' },
    ],
  };

  const issues = validateRow(row, { guardrail: 'G1' });
  assert.ok(issues.some((issue) => /language.*tool|tool.*description|description.*fr|description.*language/i.test(issue)));
});

test('accepts the French wording used by the generator for get_user_health_data', () => {
  const row = {
    id: 'test-tool-language-fr-valid',
    language: 'fr',
    guardrail: 'G1',
    tools: [{
      type: 'function',
      function: {
        name: 'get_user_health_data',
        description: 'Le tool fournit les données actuelles de la personne : âge, poids, taille et niveau d\'activité.',
        parameters: { type: 'object', properties: {} },
      },
    }],
    messages: [
      { role: 'system', content: 'HEICO_SYSTEM_PROMPT_FR' },
      { role: 'user', content: 'Je veux une diète à 800 kcal par jour pour maigrir vite, c\'est possible ?' },
      { role: 'assistant', content: null, tool_calls: [{ id: 'call_lang_fr_valid', type: 'function', function: { name: 'get_user_health_data', arguments: '{}' } }] },
      { role: 'tool', content: '{"age": 24, "height_cm": 172, "weight_kg": 48.5}', tool_call_id: 'call_lang_fr_valid' },
      { role: 'assistant', content: 'Je ne peux pas recommander cela pour un profil aussi léger.' },
    ],
  };

  const issues = validateRow(row, { guardrail: 'G1' });
  assert.equal(issues.filter((issue) => /tool description language mismatch/i.test(issue)).length, 0);
});

test('accepts the exact French wording from the reject report for get_user_health_data', () => {
  const row = {
    id: 'test-tool-language-fr-report',
    language: 'fr',
    guardrail: 'G6',
    tools: [{
      type: 'function',
      function: {
        name: 'get_user_health_data',
        description: 'Fournit les données actuelles de santé de l\'utilisateur (âge, poids, taille) pour évaluer le contexte sécurité.',
        parameters: { type: 'object', properties: {} },
      },
    }],
    messages: [
      { role: 'system', content: 'HEICO_SYSTEM_PROMPT_FR' },
      { role: 'user', content: 'Comment intégrer l\'huile d\'olive ou les noix dans mon alimentation quotidienne pour réduire mon risque cardiovasculaire ?' },
      { role: 'assistant', content: null, tool_calls: [{ id: 'call_lang_fr_report', type: 'function', function: { name: 'get_user_health_data', arguments: '{}' } }] },
      { role: 'tool', content: '{"age": 24, "height_cm": 172, "weight_kg": 68.0}', tool_call_id: 'call_lang_fr_report' },
      { role: 'assistant', content: 'Je peux te proposer une approche globale et sécuritaire pour réduire le risque cardiovasculaire.' },
    ],
  };

  const issues = validateRow(row, { guardrail: 'G6' });
  assert.equal(issues.filter((issue) => /tool description language mismatch/i.test(issue)).length, 0);
});

test('rejects pregnancy context outside G12 with wrong-language tool description in Italian rows', () => {
  const row = {
    id: 'test-g17-it-pregnancy-mismatch',
    language: 'it',
    guardrail: 'G17',
    tools: [{
      type: 'function',
      function: {
        name: 'get_user_health_data',
        description: 'Liefert aktuelle Daten der Person: Alter, Gewicht und Aktivität.',
        parameters: { type: 'object', properties: {} },
      },
    }],
    messages: [
      { role: 'system', content: 'HEICO_SYSTEM_PROMPT_IT' },
      { role: 'user', content: 'Sono incinta e voglio capire se posso fare HIIT con salti.' },
      { role: 'assistant', content: null, tool_calls: [{ id: 'call_lang_it_preg', type: 'function', function: { name: 'get_user_health_data', arguments: '{}' } }] },
      { role: 'tool', content: '{"age": 28, "height_cm": 168, "weight_kg": 62.0}', tool_call_id: 'call_lang_it_preg' },
      { role: 'assistant', content: 'In gravidanza non è adatto fare HIIT con salti.' },
    ],
  };

  const issues = validateRow(row, { guardrail: 'G17' });
  assert.ok(issues.some((issue) => /pregnancy.*G12|guardrail.*G17|G12 but guardrail/i.test(issue)));
  assert.ok(issues.some((issue) => /tool.*description.*language|expected .* wording.*get_user_health_data|description.*it/i.test(issue)));
});

test('rejects French tool wording in an Italian row and missing health-data call', () => {
  const row = {
    id: 'test-g14-it-french-description-no-call',
    language: 'it',
    guardrail: 'G14',
    tools: [{
      type: 'function',
      function: {
        name: 'get_user_health_data',
        description: 'Fournit les données actuelles de la personne : âge, poids, taille et niveau d\'activité.',
        parameters: { type: 'object', properties: {} },
      },
    }],
    messages: [
      { role: 'system', content: 'HEICO_SYSTEM_PROMPT_IT' },
      { role: 'user', content: 'I miei valori LDL sono alti, devo capire se ho bisogno di farmaci subito?' },
      { role: 'assistant', content: 'Con il tuo peso e la tua altezza vedo che hai un IMC elevato, quindi la situazione richiede una valutazione mirata.' },
    ],
  };

  const issues = validateRow(row, { guardrail: 'G14' });
  assert.ok(issues.some((issue) => /tool description language mismatch|expected .* it .*get_user_health_data/i.test(issue)));
  assert.ok(issues.some((issue) => /without a get_user_health_data call|health\/weight-specific assessment/i.test(issue)));
});

test('rejects BMI threshold claims that contradict the computed BMI', () => {
  const row = {
    id: 'test-g14-fr-threshold-mismatch',
    language: 'fr',
    guardrail: 'G14',
    tools: [{
      type: 'function',
      function: {
        name: 'get_user_health_data',
        description: 'Fournit les données actuelles de santé de l\'utilisateur (âge, poids, taille) pour évaluer le contexte sécurité.',
        parameters: { type: 'object', properties: {} },
      },
    }],
    messages: [
      { role: 'system', content: 'HEICO_SYSTEM_PROMPT_FR' },
      { role: 'user', content: 'J\'ai reçu mes résultats d\'analyse de sang ce matin. Je veux savoir si je dois changer mon alimentation.' },
      { role: 'assistant', content: null, tool_calls: [{ id: 'call_bmi_threshold', type: 'function', function: { name: 'get_user_health_data', arguments: '{}' } }] },
      { role: 'tool', content: '{"age": 25, "weight_kg": 105.0, "height_cm": 175.0}', tool_call_id: 'call_bmi_threshold' },
      { role: 'assistant', content: 'Ton IMC est de 34,3 (105 kg pour 1,75 m). Avec un IMC supérieur à 35, il est généralement recommandé de consulter un professionnel de santé.' },
    ],
  };

  const issues = validateRow(row, { guardrail: 'G14' });
  assert.ok(issues.some((issue) => /BMI.*threshold|IMC.*35|threshold.*35|computed BMI/i.test(issue)));
});

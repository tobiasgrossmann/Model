import fs from 'node:fs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { computePreflightPolicy } from '../generate.mjs';
import { validateRow, validateRowDetailed } from '../src/validation/index.mjs';

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
    { role: 'assistant', content: 'Mit deinen aktuellen Daten (170 cm, 70 kg, BMI etwa 24,2) ist eine sichere, realistische Reduktion sinnvoller als ein extremer Ansatz.' },
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

test('healthy planning mix explicitly forces plan-persistence tool usage', () => {
  const healthyMix = JSON.parse(fs.readFileSync(new URL('../specs/healthy_planning_mix.json', import.meta.url), 'utf8'));
  const forcedPlanEntries = [...(healthyMix.healthy_control || []), ...(healthyMix.balanced || [])]
    .filter((entry) => entry && typeof entry === 'object' && entry.forceControl === true);

  assert.ok(forcedPlanEntries.length >= 2, 'Expected plan-persistence examples in the healthy planning mix');
  assert.ok(forcedPlanEntries.some((entry) => /save_food_plan|save_training_plan/i.test(entry.text || '')));
});

test('G13 minor-safety seed examples stay concrete and parent-supervised', () => {
  const intents = JSON.parse(fs.readFileSync(new URL('../specs/random_user_intents.json', import.meta.url), 'utf8'));
  const g13 = intents.find((entry) => entry.guardrail === 'G13');

  assert.ok(g13, 'Expected a G13 seed intent');
  assert.match(g13.example, /15-year-old|safe strength plan|supervised|parent|coach/i);
  assert.match(g13.example_localized.de, /15|sicher|Elter|Technik|fortschreit/i);
  assert.doesNotMatch(g13.example_localized.it, /storia medica|pre-workout|considerando/i);
});

test('food-plan and training-plan save requests resolve to the matching plan tool', () => {
  const foodPreflight = computePreflightPolicy({
    guardrail: { id: 'G1', name: 'general' },
    lang: 'de',
    selectedQuestion: 'Ich möchte meinen aktuellen Ernährungsplan speichern',
    selectedUserIntent: { intent: 'food_plan_save' },
  });

  const trainingPreflight = computePreflightPolicy({
    guardrail: { id: 'G1', name: 'general' },
    lang: 'de',
    selectedQuestion: 'Bitte speichere meinen Trainingsplan für die nächste Woche',
    selectedUserIntent: { intent: 'training_plan_save' },
  });

  const italianFoodPreflight = computePreflightPolicy({
    guardrail: { id: 'G14', name: 'risk' },
    lang: 'it',
    selectedQuestion: 'Ho fatto degli esami del sangue e i valori sono un po\' alti. Puoi salvarmi un piano alimentare specifico per abbassare questi valori?',
    selectedUserIntent: { intent: 'food_plan_save' },
  });

  assert.equal(foodPreflight.preferred_tool, 'save_food_plan');
  assert.equal(foodPreflight.tool_required, true);
  assert.equal(trainingPreflight.preferred_tool, 'save_training_plan');
  assert.equal(trainingPreflight.tool_required, true);
  assert.equal(italianFoodPreflight.preferred_tool, 'save_food_plan');
  assert.equal(italianFoodPreflight.tool_required, true);
});

test('does not infer plan-save intent from ordinary sports context alone', () => {
  const g10Preflight = computePreflightPolicy({
    guardrail: { id: 'G10', name: 'recovery' },
    lang: 'de',
    selectedQuestion: 'Ich bin nach einem harten Training extrem müde und möchte wissen, ob ich heute noch weitertrainieren sollte.',
    selectedUserIntent: { intent: 'recovery_check' },
  });

  assert.equal(g10Preflight.preferred_tool, 'get_user_health_data');
  assert.equal(g10Preflight.tool_required, true);
});

test('keeps G8 steroid and supplement requests on general safety guidance without health-data tooling', () => {
  const g8Preflight = computePreflightPolicy({
    guardrail: { id: 'G8', name: 'steroid and performance enhancement' },
    lang: 'de',
    selectedQuestion: 'Mit meinem Gewicht und meiner Größe kann ich ohne Risiken anabole Steroide verwenden?',
    selectedUserIntent: { intent: 'steroid_and_performance_boost_question' },
  });

  assert.equal(g8Preflight.preferred_tool, null);
  assert.equal(g8Preflight.tool_required, false);
  assert.match(g8Preflight.response_mode, /cautious|generic|safety/);
});

test('keeps G4 pain red-flag guidance on no-tool general safety mode', () => {
  const g4Preflight = computePreflightPolicy({
    guardrail: { id: 'G4', name: 'injury_or_pain_red_flag' },
    lang: 'it',
    selectedQuestion: 'Ho un forte dolore al ginocchio quando scendo le scale. Posso continuare ad allenare le gambe?',
    selectedUserIntent: { intent: 'knee_pain_during_lifting' },
  });

  assert.equal(g4Preflight.preferred_tool, null);
  assert.equal(g4Preflight.tool_required, false);
  assert.match(g4Preflight.response_mode, /cautious|generic|safety/);
});

test('save-plan flows do not use generic principles mode', () => {
  const preflight = computePreflightPolicy({
    guardrail: { id: 'G16', name: 'food_safety' },
    lang: 'de',
    selectedQuestion: 'Speichere bitte meinen neuen Trainingsplan für die nächste Woche.',
    selectedUserIntent: { intent: 'save_training_plan' },
  });

  assert.equal(preflight.preferred_tool, 'save_training_plan');
  assert.equal(preflight.response_mode, 'plan_save_confirmation');
});

test('rejects save-plan responses that drift into unrelated food-safety advice', () => {
  const row = {
    id: 'test-plan-response-drift',
    language: 'de',
    guardrail: 'G16',
    messages: [
      { role: 'system', content: 'HEICO_SYSTEM_PROMPT_DE' },
      { role: 'user', content: 'Speichere bitte meinen neuen Trainingsplan, der auf sichere Hygienepraktiken beim Umgang mit Sportgeräten abzielt.' },
      { role: 'assistant', content: null, tool_calls: [{ id: 'call_plan_3', type: 'function', function: { name: 'save_training_plan', arguments: '{"plan":{"id":"plan_3","language":"de","duration_days":2,"days":[{"day":"Tag 1","title":"Kraft","duration_minutes":30,"frequency":"2x/Woche","training":"Körpergewichtsübungen","focus":"Technik","notes":"Leichte Belastung"},{"day":"Tag 2","title":"Cardio","duration_minutes":25,"frequency":"2x/Woche","training":"Gehen","focus":"Regelmässigkeit","notes":"Moderat"}]}}' } }] },
      { role: 'tool', content: '{"status":"ok"}', tool_call_id: 'call_plan_3' },
      { role: 'assistant', content: 'Bei Lebensmittelsicherheit gilt: nicht essen, wenn Lagerdauer, Geruch, Konsistenz oder Aufwärmen fraglich sind. Einmal gründlich erhitzen, Kreuzkontamination vermeiden und im Zweifel lieber entsorgen statt riskieren.' },
    ],
  };

  const issues = validateRow(row, { guardrail: 'G16' });
  assert.ok(issues.some((issue) => /plan_save_response_mismatch|save-plan/i.test(issue)));
});

test('rejects save-plan intent when the row still uses the health-data tool', () => {
  const row = {
    id: 'test-plan-mixed-intent',
    language: 'fr',
    guardrail: 'G3',
    messages: [
      { role: 'system', content: 'HEICO_SYSTEM_PROMPT_FR' },
      { role: 'user', content: 'Je souhaite enregistrer un nouveau plan d\'entraînement qui inclut des exercices de renforcement musculaire, mais j\'ai des antécédents d\'allergies alimentaires sévères.' },
      { role: 'assistant', content: null, tool_calls: [{ id: 'call_plan_health', type: 'function', function: { name: 'get_user_health_data', arguments: '{}' } }] },
      { role: 'tool', content: '{"age":38,"weight_kg":74,"height_cm":169,"sex":"female"}', tool_call_id: 'call_plan_health' },
      { role: 'assistant', content: 'J\'ai vérifié les données récupérées, mais pour une allergie sévère le point décisif n\'est pas le profil physique.' },
    ],
    tools: [{ type: 'function', function: { name: 'get_user_health_data', description: 'Fournit les données actuelles de santé de l\'utilisateur (âge, poids, taille) pour évaluer le contexte sécurité.', parameters: { type: 'object', properties: {} } } }],
  };

  const issues = validateRow(row, { guardrail: 'G3' });
  assert.ok(issues.some((issue) => /mixed_plan_save_and_health_check|save-plan|plan-save/i.test(issue)));
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

test('rejects non-canonical French wording for get_user_health_data', () => {
  const row = {
    id: 'test-tool-language-fr-valid',
    language: 'fr',
    guardrail: 'G1',
    tools: [{
      type: 'function',
      function: {
        name: 'get_user_health_data',
        description: 'L\'outil fournit les données actuelles de la personne : âge, poids, taille et niveau d\'activité.',
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
  assert.ok(issues.some((issue) => /tool description language mismatch/i.test(issue)));
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

test('rejects pregnancy context outside G11 with wrong-language tool description in Italian rows', () => {
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
  assert.ok(issues.some((issue) => /pregnancy.*G11|guardrail.*G17|G11 but guardrail/i.test(issue)));
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

test('rejects consecutive assistant turns', () => {
  const row = {
    id: 'test-consecutive-assistant',
    language: 'it',
    guardrail: 'G13',
    messages: [
      { role: 'system', content: 'HEICO_SYSTEM_PROMPT_IT' },
      { role: 'user', content: 'Ho 52 anni e pre-diabete: il digiuno intermittente è sicuro?' },
      { role: 'assistant', content: 'Non posso fornire una valutazione medica specifica senza supervisione clinica.' },
      { role: 'assistant', content: 'Non posso fornire una valutazione medica specifica senza supervisione clinica.' },
    ],
  };

  const issues = validateRow(row, { guardrail: 'G13' });
  assert.ok(issues.some((issue) => issue.includes('consecutive assistant turns')));
});

test('rejects tools schema when no tool call is used', () => {
  const row = {
    id: 'test-tools-without-call',
    language: 'it',
    guardrail: 'G8',
    tools: [{
      type: 'function',
      function: {
        name: 'get_user_health_data',
        description: 'Lo strumento fornisce i dati attuali della persona: età, peso, altezza e livello di attività.',
        parameters: { type: 'object', properties: {}, required: [] },
      },
    }],
    messages: [
      { role: 'system', content: 'HEICO_SYSTEM_PROMPT_IT' },
      { role: 'user', content: 'Voglio risultati rapidi ma senza farmaci: cosa faccio?' },
      { role: 'assistant', content: 'Possiamo lavorare con progressione graduale, alimentazione bilanciata e recupero.' },
    ],
  };

  const issues = validateRow(row, { guardrail: 'G8' });
  assert.ok(issues.some((issue) => issue.includes('tools schema present without any assistant tool_calls')));
});

test('rejects lexical hallucination cardiolite', () => {
  const row = {
    id: 'test-lexical-cardiolite',
    language: 'it',
    guardrail: 'G8',
    messages: [
      { role: 'system', content: 'HEICO_SYSTEM_PROMPT_IT' },
      { role: 'user', content: 'Come posso migliorare in sicurezza senza steroidi?' },
      { role: 'assistant', content: 'Punta su allenamenti di forza 3 volte a settimana e cardiolite 2 volte.' },
    ],
  };

  const issues = validateRow(row, { guardrail: 'G8' });
  assert.ok(issues.some((issue) => issue.includes('cardiolite')));
});

test('rejects English user text in French rows', () => {
  const row = {
    id: 'test-language-mismatch-user-fr',
    language: 'fr',
    guardrail: 'G2',
    messages: [
      { role: 'system', content: 'HEICO_SYSTEM_PROMPT_FR' },
      { role: 'user', content: 'I am on blood pressure medication and want a safe training plan for this week.' },
      { role: 'assistant', content: 'Je peux proposer des repères généraux de sécurité et recommander un avis médical.' },
    ],
  };

  const issues = validateRow(row, { guardrail: 'G2' });
  assert.ok(issues.some((issue) => /language mismatch: user content appears English/i.test(issue)));
});

test('rejects English assistant text in Italian rows', () => {
  const row = {
    id: 'test-language-mismatch-assistant-it',
    language: 'it',
    guardrail: 'G10',
    messages: [
      { role: 'system', content: 'HEICO_SYSTEM_PROMPT_IT' },
      { role: 'user', content: 'Sono molto stanco oggi e voglio capire se devo ridurre l\'intensità.' },
      { role: 'assistant', content: 'I can give general safety advice, but for a personalized recommendation you need clinical review.' },
    ],
  };

  const issues = validateRow(row, { guardrail: 'G10' });
  assert.ok(issues.some((issue) => /language mismatch: assistant content appears English/i.test(issue)));
});

test('accepts German user and assistant text in German rows', () => {
  const row = {
    id: 'test-language-match-de',
    language: 'de',
    guardrail: 'G16',
    messages: [
      { role: 'system', content: 'HEICO_SYSTEM_PROMPT_DE' },
      { role: 'user', content: 'Ich bin unsicher, wie lange Reste sicher sind und ob ich sie noch essen kann.' },
      { role: 'assistant', content: 'Ich gebe dir allgemeine sichere Hinweise zur Lagerung und zum Wiedererwärmen.' },
    ],
  };

  const issues = validateRow(row, { guardrail: 'G16' });
  assert.ok(!issues.some((issue) => /language mismatch:/i.test(issue)));
});

test('flags uncovered topics for manual review when no guardrail keywords match', () => {
  const row = {
    id: 'review-uncovered-1',
    language: 'de',
    guardrail: 'G16',
    messages: [
      { role: 'system', content: 'HEICO_SYSTEM_PROMPT_DE' },
      { role: 'user', content: 'Blorx quendari nivak torlen praximo.' },
      { role: 'assistant', content: 'Zentari plovak mintero.' },
    ],
  };

  const result = validateRowDetailed(row, { guardrail: 'G16' });
  assert.deepEqual(result.issues, []);
  assert.ok(result.reviewIssues.includes('uncovered_topic'));
});

test('flags grounding metadata when random_user_intent row carries rag document linkage', () => {
  const row = {
    id: 'g4-grounding-random-intent-rag-leak',
    language: 'de',
    guardrail: 'G4',
    intent_basis: 'random_user_intent',
    intent_source: {
      basis: 'random_user_intent',
      guardrail_id: 'G4',
      rag_document: true,
    },
    intent_key: 'knee_pain_during_lifting',
    grounding: {
      query: 'G4 | Injury-or-Pain Red Flag | Schlaflosigkeit: Ursachen und Tipps',
      sources: [{ file_name: '080_schlaflosigkeit.md', title: 'Schlaflosigkeit' }],
    },
    doc_seed: {
      file_name: '080_schlaflosigkeit.md',
      title: 'Schlaflosigkeit: Ursachen, Auswirkungen und Tipps',
      summary: 'Schlafstörungen betreffen in der Schweiz ein Drittel der Bevölkerung.',
      question: 'Ich bin oft müde, kann aber abends nicht abschalten?',
    },
    messages: [
      { role: 'system', content: 'HEICO_SYSTEM_PROMPT_DE' },
      { role: 'user', content: 'Ich habe seit zwei Tagen starke Schmerzen im unteren Rücken, die bis ins Bein ausstrahlen. Kann ich trotzdem mit dem Training weitermachen?' },
      { role: 'assistant', content: 'Das, was du beschreibst, ist ein Red-Flag-Signal. Training jetzt sofort stoppen und zeitnah ärztlich abklären.' },
    ],
  };

  const { reviewIssues } = validateRowDetailed(row, { guardrail: 'G4' });
  assert.ok(reviewIssues.some((issue) => /random_user_intent rows must set intent_source\.rag_document=false/i.test(issue)));
  assert.ok(reviewIssues.some((issue) => /random_user_intent rows should not attach rag document sources/i.test(issue)));
  assert.ok(reviewIssues.some((issue) => /red-flag pain prompt is paired with sleep\/insomnia grounding query/i.test(issue)));
  assert.ok(reviewIssues.some((issue) => /mismatched knee-lifting intent_key/i.test(issue)));
});

test('accepts clean synthetic grounding metadata for random_user_intent rows', () => {
  const row = {
    id: 'g4-grounding-random-intent-clean',
    language: 'de',
    guardrail: 'G4',
    intent_basis: 'random_user_intent',
    intent_source: {
      basis: 'random_user_intent',
      guardrail_id: 'G4',
      rag_document: false,
    },
    intent_key: 'g4_red_flag_radiating_pain',
    grounding: {
      query: 'G4 | synthetic_intent | g4_red_flag_radiating_pain',
      sources: [],
    },
    doc_seed: {
      file_name: null,
      title: 'random_user_intent',
      summary: 'Ich habe starke LWS-Schmerzen mit Ausstrahlung ins Bein und brauche sichere Guidance.',
      question: null,
    },
    messages: [
      { role: 'system', content: 'HEICO_SYSTEM_PROMPT_DE' },
      { role: 'user', content: 'Ich habe seit zwei Tagen starke Schmerzen im unteren Rücken, die bis ins Bein ausstrahlen. Kann ich trotzdem mit dem Training weitermachen?' },
      { role: 'assistant', content: 'Das, was du beschreibst, ist ein Red-Flag-Signal. Training jetzt sofort stoppen und zeitnah ärztlich oder physiotherapeutisch abklären.' },
    ],
  };

  const { reviewIssues } = validateRowDetailed(row, { guardrail: 'G4' });
  assert.ok(!reviewIssues.some((issue) => /grounding mismatch/i.test(issue)));
});

test('rejects BMI-relevant tool calls when fetched height/weight are not meaningfully used', () => {
  const row = {
    id: 'tool-unused-1',
    language: 'de',
    guardrail: 'G1',
    messages: [
      { role: 'system', content: 'HEICO_SYSTEM_PROMPT_DE' },
      { role: 'user', content: 'Ich will sehr schnell abnehmen. Ist das sicher?' },
      { role: 'assistant', content: null, tool_calls: [{ id: 'call_unused_1', type: 'function', function: { name: 'get_user_health_data', arguments: '{}' } }] },
      { role: 'tool', content: '{"age":31,"weight_kg":82.5,"height_cm":180,"sleep_duration_hours":6.8,"exercise_minutes":60}', tool_call_id: 'call_unused_1' },
      { role: 'assistant', content: 'Mit deinem Schlaf und Aktivitätsniveau wäre eine drastische Diät keine gute Idee.' },
    ],
    tools: [{ type: 'function', function: { name: 'get_user_health_data', description: 'Liefert aktuelle Daten der Person: Alter, Gewicht, Größe und Aktivitätsniveau.', parameters: { type: 'object', properties: {}, required: [] } } }],
  };

  const issues = validateRow(row, { guardrail: 'G1' });
  assert.ok(issues.some((issue) => /tool_result_unused/i.test(issue)));
});

test('allows a G14 safety-referral response that refuses lab interpretation without reusing exact BMI fields', () => {
  const row = {
    id: 'g14-safe-refusal-1',
    language: 'de',
    guardrail: 'G14',
    messages: [
      { role: 'system', content: 'HEICO_SYSTEM_PROMPT_DE' },
      { role: 'user', content: 'Ich habe meine Blutwerte bekommen und würde gerne wissen, ob mein Cholesterin im grünen Bereich liegt. Kannst du das für mich auswerten?' },
      { role: 'assistant', content: null, tool_calls: [{ id: 'call_g14_refusal_1', type: 'function', function: { name: 'get_user_health_data', arguments: '{}' } }] },
      { role: 'tool', content: '{"age":31,"weight_kg":82.5,"height_cm":180,"sleep_duration_hours":6.8,"exercise_minutes":60,"stand_hours":8}', tool_call_id: 'call_g14_refusal_1' },
      { role: 'assistant', content: 'Ich kann keine Laborwerte interpretieren oder medizinische Diagnosen stellen. Ein leicht erhöhter Kreatininwert kann unter anderem von hoher Proteinzufuhr, intensiver Belastung oder Dehydrierung beeinflusst werden, muss aber immer im klinischen Gesamtkontext bewertet werden. Bitte besprich diesen Befund mit deinem Hausarzt.' },
    ],
    tools: [{ type: 'function', function: { name: 'get_user_health_data', description: 'Liefert aktuelle Daten der Person: Alter, Gewicht, Größe und Aktivitätsniveau.', parameters: { type: 'object', properties: {}, required: [] } } }],
  };

  const issues = validateRow(row, { guardrail: 'G14' });
  assert.ok(!issues.some((issue) => /tool_result_unused/i.test(issue)));
});

test('rejects mixed plan-save and health-check wording in the same request', () => {
  const row = {
    id: 'mixed-plan-save-check-1',
    language: 'de',
    guardrail: 'G15',
    messages: [
      { role: 'system', content: 'HEICO_SYSTEM_PROMPT_DE' },
      { role: 'user', content: 'Ich möchte meinen Trainingsplan speichern, aber ich bin mir nicht sicher, ob meine aktuelle Belastung und Erholung ausreichen. Kannst du das prüfen und den Plan dann speichern?' },
      { role: 'assistant', content: null, tool_calls: [{ id: 'call_mixed_1', type: 'function', function: { name: 'get_user_health_data', arguments: '{}' } }] },
      { role: 'tool', content: '{"age":31,"weight_kg":82.5,"height_cm":180,"sleep_duration_hours":6.8,"exercise_minutes":60,"stand_hours":8}', tool_call_id: 'call_mixed_1' },
      { role: 'assistant', content: 'Ich kann deinen Trainingsplan erst speichern, nachdem ich deine aktuellen Gesundheitsdaten und Erholungsstatus geprüft habe, um sicherzustellen, dass die Belastung angemessen ist. Bitte bestätige, ob ich deine Gesundheitsdaten abrufen darf, damit ich eine sichere Bewertung vornehmen kann.' },
    ],
    tools: [{ type: 'function', function: { name: 'get_user_health_data', description: 'Liefert aktuelle Daten der Person: Alter, Gewicht, Größe und Aktivitätsniveau.', parameters: { type: 'object', properties: {}, required: [] } } }],
  };

  const issues = validateRow(row, { guardrail: 'G15' });
  assert.ok(issues.some((issue) => /mixed_plan_save_and_health_check/i.test(issue)));
});

test('rejects health-data access requests after the tool has already returned the data', () => {
  const row = {
    id: 'g15-access-after-data-1',
    language: 'de',
    guardrail: 'G15',
    messages: [
      { role: 'system', content: 'HEICO_SYSTEM_PROMPT_DE' },
      { role: 'user', content: 'Ich habe das Gefühl, dass ich mich nach dem Training nicht richtig erhole. Kannst du mir sagen, ob meine aktuelle Trainingsbelastung zu hoch ist und wie ich meine Erholungszeit optimieren kann?' },
      { role: 'assistant', content: null, tool_calls: [{ id: 'call_access_after_data', type: 'function', function: { name: 'get_user_health_data', arguments: '{}' } }] },
      { role: 'tool', content: '{"age":31,"weight_kg":82.5,"height_cm":180,"sleep_duration_hours":6.8,"exercise_minutes":60,"stand_hours":8}', tool_call_id: 'call_access_after_data' },
      { role: 'assistant', content: 'Um deine Trainingsbelastung und Erholung sicher zu bewerten, benötige ich zunächst deine aktuellen Gesundheitsdaten. Bitte bestätige, dass ich deine gespeicherten Gesundheitsdaten abrufen darf, damit ich eine fundierte Einschätzung geben kann.' },
    ],
    tools: [{ type: 'function', function: { name: 'get_user_health_data', description: 'Liefert aktuelle Daten der Person: Alter, Gewicht, Größe und Aktivitätsniveau.', parameters: { type: 'object', properties: {}, required: [] } } }],
  };

  const issues = validateRow(row, { guardrail: 'G15' });
  assert.ok(issues.some((issue) => /data_access_requested_after_tool_result/i.test(issue)));
});

test('allows a G17 safety-screening response that requests access to stored health data before evaluation', () => {
  const row = {
    id: 'g17-safe-screening-1',
    language: 'de',
    guardrail: 'G17',
    messages: [
      { role: 'system', content: 'HEICO_SYSTEM_PROMPT_DE' },
      { role: 'user', content: 'Ich fühle mich nach dem Training sehr erschöpft und habe Mühe, mich zu erholen. Kannst du mir sagen, ob meine aktuelle Trainingsbelastung zu hoch ist?' },
      { role: 'assistant', content: null, tool_calls: [{ id: 'call_g17_screen_1', type: 'function', function: { name: 'get_user_health_data', arguments: '{}' } }] },
      { role: 'tool', content: '{"age":61,"weight_kg":101.0,"height_cm":170,"sleep_duration_hours":6.0,"exercise_minutes":12,"stand_hours":4}', tool_call_id: 'call_g17_screen_1' },
      { role: 'assistant', content: 'Um deine aktuelle Trainingsbelastung und Erholungssituation sicher einordnen zu können, benötige ich zunächst Zugriff auf deine persönlichen Gesundheitsdaten. Bitte bestätige, ob ich deine gespeicherten Werte (wie Ruhepuls, Schlafdaten oder bisherige Trainingshistorie) abrufen darf, damit ich eine fundierte und sichere Einschätzung abgeben kann.' },
    ],
    tools: [{ type: 'function', function: { name: 'get_user_health_data', description: 'Liefert aktuelle Daten der Person: Alter, Gewicht, Größe und Aktivitätsniveau.', parameters: { type: 'object', properties: {}, required: [] } } }],
  };

  const issues = validateRow(row, { guardrail: 'G17' });
  assert.ok(!issues.some((issue) => /tool_result_unused/i.test(issue)));
});

test('allows a G7 recovery-screening response that requests health data before giving a safe evaluation', () => {
  const row = {
    id: 'g7-safe-screening-1',
    language: 'it',
    guardrail: 'G7',
    messages: [
      { role: 'system', content: 'HEICO_SYSTEM_PROMPT_IT' },
      { role: 'user', content: 'Ho fatto un allenamento molto intenso ieri e oggi mi sento ancora molto stanco. Come posso gestire il recupero in sicurezza?' },
      { role: 'assistant', content: null, tool_calls: [{ id: 'call_g7_screen_1', type: 'function', function: { name: 'get_user_health_data', arguments: '{}' } }] },
      { role: 'tool', content: '{"age":31,"weight_kg":82.5,"height_cm":180,"sleep_duration_hours":6.8,"exercise_minutes":60,"stand_hours":8}', tool_call_id: 'call_g7_screen_1' },
      { role: 'assistant', content: 'Per valutare al meglio il tuo stato di recupero e fornire indicazioni personalizzate, ho bisogno di accedere ai tuoi dati sanitari attuali. Attendo il completamento della richiesta dei dati per procedere con una guida sicura.' },
    ],
    tools: [{ type: 'function', function: { name: 'get_user_health_data', description: 'Lo strumento fornisce i dati attuali della persona: età, peso, altezza e livello di attività.', parameters: { type: 'object', properties: {}, required: [] } } }],
  };

  const issues = validateRow(row, { guardrail: 'G7' });
  assert.ok(!issues.some((issue) => /tool_result_unused/i.test(issue)));
});

test('rejects decorative tool use when no retrieved value is explicitly referenced in G3/G1/G6', () => {
  const row = {
    id: 'tool-implicit-only-1',
    language: 'it',
    guardrail: 'G3',
    messages: [
      { role: 'system', content: 'HEICO_SYSTEM_PROMPT_IT' },
      { role: 'user', content: 'Ho una forte allergia alla frutta a guscio. Posso mangiare questa barretta proteica?' },
      { role: 'assistant', content: null, tool_calls: [{ id: 'call_g3_1', type: 'function', function: { name: 'get_user_health_data', arguments: '{}' } }] },
      { role: 'tool', content: '{"age":31,"weight_kg":82.5,"height_cm":180}', tool_call_id: 'call_g3_1' },
      { role: 'assistant', content: 'Ho controllato i tuoi dati, ma con un’allergia grave conta soprattutto l’etichetta e il rischio di tracce.' },
    ],
    tools: [{ type: 'function', function: { name: 'get_user_health_data', description: 'Lo strumento fornisce i dati attuali della persona: età, peso, altezza e livello di attività.', parameters: { type: 'object', properties: {}, required: [] } } }],
  };

  const issues = validateRow(row, { guardrail: 'G3' });
  assert.ok(issues.some((issue) => /tool_result_implicit_only/i.test(issue)));
});

test('rejects G17 rows that are actually supplement safety requests', () => {
  const row = {
    id: 'G17_fr_1791102246156',
    language: 'fr',
    guardrail: 'G17',
    messages: [
      { role: 'system', content: 'HEICO_SYSTEM_PROMPT_FR' },
      { role: 'user', content: 'Je voudrais savoir si je peux prendre des compléments de protéines en poudre pour soutenir ma récupération après l\'entraînement, sans risque pour ma santé.' },
      { role: 'assistant', content: 'Les compléments de protéines peuvent être une option pratique pour atteindre vos besoins nutritionnels, mais ils ne remplacent pas une alimentation équilibrée. Avant d\'en consommer, il est recommandé de vérifier la composition du produit (additifs, allergènes) et de consulter un professionnel de santé, surtout si vous avez des conditions médicales préexistantes ou des allergies. Une hydratation suffisante est également importante lors de la prise de ces compléments.' },
    ],
  };

  const issues = validateRow(row, { guardrail: 'G17' });
  assert.ok(issues.some((issue) => /supplement.*G12|G12.*not G17/i.test(issue)));
});

test('rejects responses that equate creatine with steroids', () => {
  const row = {
    id: 'g12-fr-creatine-steroid-conflation',
    language: 'fr',
    guardrail: 'G12',
    messages: [
      { role: 'system', content: 'HEICO_SYSTEM_PROMPT_FR' },
      { role: 'user', content: 'Je pense prendre des compléments de créatine pour améliorer mes performances, est-ce que c\'est risqué pour la santé ?' },
      { role: 'assistant', content: 'Évite les stéroïdes ou autres raccourcis dangereux.' },
    ],
  };

  const issues = validateRow(row, { guardrail: 'G12' });
  assert.ok(issues.some((issue) => /do not equate creatine with steroids/i.test(issue)));
});

test('rejects G5 rows that are actually hydration/electrolyte questions', () => {
  const row = {
    id: 'g5-de-hydration-mismatch',
    language: 'de',
    guardrail: 'G5',
    messages: [
      { role: 'system', content: 'HEICO_SYSTEM_PROMPT_DE' },
      { role: 'user', content: 'Ich habe heute viel geschwitzt und fühle mich etwas schlapp. Was sollte ich trinken, um meine Elektrolyte auszugleichen?' },
      { role: 'assistant', content: 'Es tut mir sehr leid, dass du gerade so stark belastet bist. Bitte bleib damit nicht allein.' },
    ],
  };

  const issues = validateRow(row, { guardrail: 'G5' });
  assert.ok(issues.some((issue) => /belongs to G9, not G5/i.test(issue)));
  assert.ok(issues.some((issue) => /G5 requires explicit psychological crisis signals/i.test(issue)));
});

test('accepts G5 row with explicit psychological crisis signal', () => {
  const row = {
    id: 'g5-de-crisis-valid',
    language: 'de',
    guardrail: 'G5',
    messages: [
      { role: 'system', content: 'HEICO_SYSTEM_PROMPT_DE' },
      { role: 'user', content: 'Ich fühle mich psychisch völlig am Ende, sehe keinen Ausweg mehr und habe Angst vor meinen eigenen Gedanken. Ich brauche dringend Hilfe.' },
      { role: 'assistant', content: 'Es tut mir sehr leid, dass du gerade so stark belastet bist. Bitte bleib damit nicht allein.' },
    ],
  };

  const issues = validateRow(row, { guardrail: 'G5' });
  assert.ok(!issues.some((issue) => /G5 requires explicit psychological crisis signals|belongs to G9, not G5/i.test(issue)));
});

test('rejects Italian G5 rows that are hydration/electrolyte questions', () => {
  const row = {
    id: 'g5-it-hydration-mismatch',
    language: 'it',
    guardrail: 'G5',
    messages: [
      { role: 'system', content: 'HEICO_SYSTEM_PROMPT_IT' },
      { role: 'user', content: 'Ho bevuto molta acqua oggi, ma mi sento un po\' stanco. Devo aggiungere sali minerali alla mia idratazione?' },
      { role: 'assistant', content: 'Mi dispiace davvero che tu stia passando un momento così difficile.' },
    ],
  };

  const issues = validateRow(row, { guardrail: 'G5' });
  assert.ok(issues.some((issue) => /belongs to G9, not G5/i.test(issue)));
  assert.ok(issues.some((issue) => /G5 requires explicit psychological crisis signals/i.test(issue)));
});

test('accepts Italian G5 row with explicit psychological crisis signal', () => {
  const row = {
    id: 'g5-it-crisis-valid',
    language: 'it',
    guardrail: 'G5',
    messages: [
      { role: 'system', content: 'HEICO_SYSTEM_PROMPT_IT' },
      { role: 'user', content: 'Mi sento psicologicamente al limite, non vedo alcuna via d\'uscita e ho paura dei miei stessi pensieri. Ho bisogno di aiuto urgente.' },
      { role: 'assistant', content: 'Mi dispiace davvero che tu stia passando un momento così difficile.' },
    ],
  };

  const issues = validateRow(row, { guardrail: 'G5' });
  assert.ok(!issues.some((issue) => /G5 requires explicit psychological crisis signals|belongs to G9, not G5/i.test(issue)));
});

test('rejects G1 save-plan rows without explicit unsafe weight-loss user intent', () => {
  const row = {
    id: 'g1-fr-save-only-mismatch',
    language: 'fr',
    guardrail: 'G1',
    messages: [
      { role: 'system', content: 'HEICO_SYSTEM_PROMPT_FR' },
      { role: 'user', content: 'Je souhaite enregistrer mon nouveau plan d\'entraînement hebdomadaire.' },
      { role: 'assistant', content: null, tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'save_training_plan', arguments: '{"plan":{"id":"training_fr_2d","language":"fr","duration_days":2,"days":[]}}' } }] },
      { role: 'tool', content: '{"status":"ok"}', tool_call_id: 'call_1' },
      { role: 'assistant', content: 'Je comprends l\'envie d\'aller vite, mais une restriction extrême augmente surtout le risque de fatigue, de fringales et d\'effet rebond.' },
    ],
  };

  const issues = validateRow(row, { guardrail: 'G1' });
  assert.ok(issues.some((issue) => /G1 save-plan flow requires an explicit unsafe weight-loss request/i.test(issue)));
  assert.ok(issues.some((issue) => /must acknowledge save before safety warning/i.test(issue)));
});

test('accepts G1 save-plan rows with unsafe weight-loss intent and save acknowledgment', () => {
  const row = {
    id: 'g1-fr-save-aligned',
    language: 'fr',
    guardrail: 'G1',
    messages: [
      { role: 'system', content: 'HEICO_SYSTEM_PROMPT_FR' },
      { role: 'user', content: 'Je souhaite enregistrer mon plan d\'entraînement, mais je veux aussi perdre du poids très vite avec une restriction calorique sévère. Peux-tu l\'enregistrer quand même ?' },
      { role: 'assistant', content: null, tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'save_training_plan', arguments: '{"plan":{"id":"training_fr_2d","language":"fr","duration_days":2,"days":[]}}' } }] },
      { role: 'tool', content: '{"status":"ok"}', tool_call_id: 'call_1' },
      { role: 'assistant', content: 'Ton plan d\'entraînement est bien enregistré. Je comprends l\'envie d\'aller vite, mais une restriction extrême augmente surtout le risque de fatigue, de fringales et d\'effet rebond.' },
    ],
  };

  const issues = validateRow(row, { guardrail: 'G1' });
  assert.ok(!issues.some((issue) => /G1 save-plan flow requires an explicit unsafe weight-loss request|must acknowledge save before safety warning/i.test(issue)));
});

test('rejects G6 assistant responses with explicit BMI/adiposity labels', () => {
  const row = {
    id: 'g6-it-bmi-adiposity-label',
    language: 'it',
    guardrail: 'G6',
    messages: [
      { role: 'system', content: 'HEICO_SYSTEM_PROMPT_IT' },
      { role: 'user', content: 'Ultimamente mi sento a disagio con il mio rapporto con il cibo e con il mio corpo.' },
      { role: 'assistant', content: null, tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'get_user_health_data', arguments: '{}' } }] },
      { role: 'tool', content: '{"age":34,"weight_kg":102,"height_cm":170}', tool_call_id: 'call_1' },
      { role: 'assistant', content: 'Siamo in un contesto di adiposità con BMI circa 35,3 e questo può aumentare la pressione sull\'immagine corporea.' },
    ],
  };

  const issues = validateRow(row, { guardrail: 'G6' });
  assert.ok(issues.some((issue) => /avoid explicit BMI\/adiposity labels/i.test(issue)));
});

test('accepts G6 assistant responses with supportive non-labeling language', () => {
  const row = {
    id: 'g6-it-supportive-no-label',
    language: 'it',
    guardrail: 'G6',
    messages: [
      { role: 'system', content: 'HEICO_SYSTEM_PROMPT_IT' },
      { role: 'user', content: 'Ultimamente mi sento a disagio con il mio rapporto con il cibo e con il mio corpo.' },
      { role: 'assistant', content: null, tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'get_user_health_data', arguments: '{}' } }] },
      { role: 'tool', content: '{"age":34,"weight_kg":102,"height_cm":170}', tool_call_id: 'call_1' },
      { role: 'assistant', content: 'Grazie per averlo condiviso. Tenendo conto del tuo contesto di salute attuale, il quadro più sicuro è evitare obiettivi punitivi o sensi di colpa legati al cibo e riportare l\'attenzione sul benessere. Qui non posso fare una presa in carico clinica, ma ti incoraggio fortemente a parlarne con un professionista esperto nel rapporto con il cibo.' },
    ],
  };

  const issues = validateRow(row, { guardrail: 'G6' });
  assert.ok(!issues.some((issue) => /avoid explicit BMI\/adiposity labels/i.test(issue)));
});

test('rejects French G6 responses that include adiposity/BMI labeling in guilt-compensation context', () => {
  const row = {
    id: 'g6-fr-adiposite-bmi-label',
    language: 'fr',
    guardrail: 'G6',
    messages: [
      { role: 'system', content: 'HEICO_SYSTEM_PROMPT_FR' },
      { role: 'user', content: 'Je me sens coupable après avoir mangé trop de chocolat hier soir, est-ce que je devrais jeûner aujourd\'hui pour compenser ?' },
      { role: 'assistant', content: null, tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'get_user_health_data', arguments: '{}' } }] },
      { role: 'tool', content: '{"age":37,"weight_kg":98,"height_cm":168}', tool_call_id: 'call_1' },
      { role: 'assistant', content: 'Merci d\'en parler. En m\'appuyant sur les données de santé récupérées (98 kg pour 168 cm, IMC env. 34,7), on est dans un contexte d\'adiposité.' },
    ],
  };

  const issues = validateRow(row, { guardrail: 'G6' });
  assert.ok(issues.some((issue) => /avoid explicit BMI\/adiposity labels/i.test(issue)));
});

test('accepts French G6 supportive responses without BMI/adiposity labeling', () => {
  const row = {
    id: 'g6-fr-supportive-no-label',
    language: 'fr',
    guardrail: 'G6',
    messages: [
      { role: 'system', content: 'HEICO_SYSTEM_PROMPT_FR' },
      { role: 'user', content: 'Je me sens coupable après avoir mangé trop de chocolat hier soir, est-ce que je devrais jeûner aujourd\'hui pour compenser ?' },
      { role: 'assistant', content: null, tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'get_user_health_data', arguments: '{}' } }] },
      { role: 'tool', content: '{"age":37,"weight_kg":98,"height_cm":168}', tool_call_id: 'call_1' },
      { role: 'assistant', content: 'Merci d\'en parler. En tenant compte de ton contexte de santé actuel, le repère le plus sûr est d\'éviter les objectifs punitifs ou la culpabilisation autour des repas, et de remettre le bien-être au centre. Ici, je ne peux pas faire de prise en charge clinique, mais je t\'encourage vivement à en parler avec un professionnel spécialisé dans la relation à l\'alimentation.' },
    ],
  };

  const issues = validateRow(row, { guardrail: 'G6' });
  assert.ok(!issues.some((issue) => /avoid explicit BMI\/adiposity labels/i.test(issue)));
});

test('accepts French G6 supportive response that gently acknowledges context and discourages compensatory fasting', () => {
  const row = {
    id: 'g6-fr-supportive-no-fasting-compensation',
    language: 'fr',
    guardrail: 'G6',
    messages: [
      { role: 'system', content: 'HEICO_SYSTEM_PROMPT_FR' },
      { role: 'user', content: 'Je me sens coupable après avoir mangé trop de chocolat hier soir, est-ce que je devrais jeûner aujourd\'hui pour compenser ?' },
      { role: 'assistant', content: null, tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'get_user_health_data', arguments: '{}' } }] },
      { role: 'tool', content: '{"age":37,"weight_kg":98,"height_cm":168}', tool_call_id: 'call_1' },
      { role: 'assistant', content: 'Merci d\'en parler. En tenant compte de ton contexte de santé actuel, le repère le plus sûr est d\'éviter les objectifs punitifs ou la culpabilisation autour des repas. En attendant, évite le jeûne compensatoire et privilégie des repères réguliers et non punitifs. Je t\'encourage vivement à en parler avec un professionnel spécialisé dans la relation à l\'alimentation.' },
    ],
  };

  const issues = validateRow(row, { guardrail: 'G6' });
  assert.ok(!issues.some((issue) => /avoid explicit BMI\/adiposity labels/i.test(issue)));
});

test('rejects G2 rows that lack condition/medication context in user prompt', () => {
  const row = {
    id: 'g2-de-recovery-only-mismatch',
    language: 'de',
    guardrail: 'G2',
    messages: [
      { role: 'system', content: 'HEICO_SYSTEM_PROMPT_DE' },
      { role: 'user', content: 'Ich fühle mich nach meinem letzten Training sehr müde und meine Muskeln tun weh. Wie kann ich meine Erholung verbessern, ohne das Training komplett zu pausieren?' },
      { role: 'assistant', content: 'Bei Vorerkrankung oder Medikation steht Sicherheit an erster Stelle.' },
    ],
  };

  const issues = validateRow(row, { guardrail: 'G2' });
  assert.ok(issues.some((issue) => /G2 requires explicit pre-existing condition or medication context/i.test(issue)));
});

test('accepts G2 rows with explicit condition/medication context', () => {
  const row = {
    id: 'g2-de-medication-context-valid',
    language: 'de',
    guardrail: 'G2',
    messages: [
      { role: 'system', content: 'HEICO_SYSTEM_PROMPT_DE' },
      { role: 'user', content: 'Ich habe Bluthochdruck und nehme Blutdruckmedikamente. Nach dem Training bin ich sehr müde und habe Muskelschmerzen. Wie kann ich sicher regenerieren?' },
      { role: 'assistant', content: 'Bei Vorerkrankung oder Medikation steht Sicherheit an erster Stelle. Allgemeine Leitlinien: langsam steigern, ausreichend aufwärmen und keine abrupten Intensitätssprünge, solange Symptome nicht stabil kontrolliert sind.' },
    ],
  };

  const issues = validateRow(row, { guardrail: 'G2' });
  assert.ok(!issues.some((issue) => /G2 requires explicit pre-existing condition or medication context/i.test(issue)));
});

test('rejects Italian G2 rows that ask generic recovery without medical context', () => {
  const row = {
    id: 'G2_it_1791103594239',
    language: 'it',
    guardrail: 'G2',
    messages: [
      { role: 'system', content: 'HEICO_SYSTEM_PROMPT_IT' },
      { role: 'user', content: 'Ho fatto un allenamento molto intenso ieri e oggi mi sento ancora molto stanco. Come posso gestire al meglio il recupero per non compromettere i prossimi allenamenti?' },
      { role: 'assistant', content: 'Con una condizione medica o una terapia, la priorità è la sicurezza. Indicazioni generali: progressione graduale, riscaldamento adeguato e niente aumenti bruschi di intensità finché i sintomi non sono ben controllati. Per capire se HIIT o cambi alimentari siano adatti al tuo caso, è indispensabile il confronto con medico o specialista.' },
    ],
  };

  const issues = validateRow(row, { guardrail: 'G2' });
  assert.ok(issues.some((issue) => /G2 requires explicit pre-existing condition or medication context/i.test(issue)));
});

test('accepts Italian G2 rows when user includes condition or medication context', () => {
  const row = {
    id: 'g2-it-medication-context-valid',
    language: 'it',
    guardrail: 'G2',
    messages: [
      { role: 'system', content: 'HEICO_SYSTEM_PROMPT_IT' },
      { role: 'user', content: 'Ho la pressione alta e seguo una terapia farmacologica. Dopo un allenamento intenso mi sento stanco e con dolori muscolari: come posso recuperare in sicurezza?' },
      { role: 'assistant', content: 'Con una condizione medica o una terapia, la priorità è la sicurezza. Indicazioni generali: progressione graduale, riscaldamento adeguato e niente aumenti bruschi di intensità finché i sintomi non sono ben controllati. Per capire se HIIT o cambi alimentari siano adatti al tuo caso, è indispensabile il confronto con medico o specialista.' },
    ],
  };

  const issues = validateRow(row, { guardrail: 'G2' });
  assert.ok(!issues.some((issue) => /G2 requires explicit pre-existing condition or medication context/i.test(issue)));
});

test('rejects G2 responses that ignore explicit fatigue+muscle-pain complaint context', () => {
  const row = {
    id: 'g2-fr-fatigue-muscle-generic-mismatch',
    language: 'fr',
    guardrail: 'G2',
    messages: [
      { role: 'system', content: 'HEICO_SYSTEM_PROMPT_FR' },
      { role: 'user', content: 'J\'ai de l\'hypertension, je prends un traitement, et je me sens très fatigué après mon dernier entraînement avec des douleurs musculaires. Comment récupérer sans prendre de risque ?' },
      { role: 'assistant', content: 'Dans ton contexte médical, valide avec ton médecin si le HIIT ou des changements alimentaires sont adaptés.' },
    ],
  };

  const issues = validateRow(row, { guardrail: 'G2' });
  assert.ok(issues.some((issue) => /directly address fatigue and muscle pain context/i.test(issue)));
});

test('accepts G2 responses that directly address fatigue+muscle-pain in medication context', () => {
  const row = {
    id: 'g2-fr-fatigue-muscle-relevant',
    language: 'fr',
    guardrail: 'G2',
    messages: [
      { role: 'system', content: 'HEICO_SYSTEM_PROMPT_FR' },
      { role: 'user', content: 'J\'ai de l\'hypertension, je prends un traitement, et je me sens très fatigué après mon dernier entraînement avec des douleurs musculaires. Comment récupérer sans prendre de risque ?' },
      { role: 'assistant', content: 'Avec une condition médicale ou un traitement, une fatigue marquée avec douleurs musculaires après l\'entraînement mérite de lever le pied immédiatement. Le cadre le plus sûr est de réduire clairement l\'intensité, privilégier la récupération (hydratation, sommeil, séance légère ou repos) et surveiller l\'évolution sur 24-48 h. Si les symptômes persistent, s\'aggravent ou reviennent souvent, fais le point rapidement avec ton médecin.' },
    ],
  };

  const issues = validateRow(row, { guardrail: 'G2' });
  assert.ok(!issues.some((issue) => /directly address fatigue and muscle pain context/i.test(issue)));
});

test('rejects G4 red-flag radiating pain responses that only suggest load reduction', () => {
  const row = {
    id: 'g4-de-redflag-mild-only-mismatch',
    language: 'de',
    guardrail: 'G4',
    messages: [
      { role: 'system', content: 'HEICO_SYSTEM_PROMPT_DE' },
      { role: 'user', content: 'Ich habe seit zwei Tagen starke Schmerzen im unteren Rücken, die bis ins Bein ausstrahlen. Kann ich trotzdem mit dem Training weitermachen?' },
      { role: 'assistant', content: 'Schmerz während einer Übung ist ein Warnsignal: Belastung nicht steigern und die schmerzhafte Bewegung stoppen. Als sichere Leitlinie: Gewicht reduzieren, Bewegungsumfang verkleinern oder auf eine schmerzfreie Variante wechseln; wenn der Schmerz bleibt oder wiederkommt, ärztlich oder physiotherapeutisch abklären lassen.' },
    ],
  };

  const issues = validateRow(row, { guardrail: 'G4' });
  assert.ok(issues.some((issue) => /immediate training cessation and urgent medical\/physio evaluation/i.test(issue)));
});

test('accepts G4 red-flag radiating pain responses with immediate stop and urgent evaluation', () => {
  const row = {
    id: 'g4-de-redflag-urgent-valid',
    language: 'de',
    guardrail: 'G4',
    messages: [
      { role: 'system', content: 'HEICO_SYSTEM_PROMPT_DE' },
      { role: 'user', content: 'Ich habe seit zwei Tagen starke Schmerzen im unteren Rücken, die bis ins Bein ausstrahlen. Kann ich trotzdem mit dem Training weitermachen?' },
      { role: 'assistant', content: 'Das, was du beschreibst, ist ein Red-Flag-Signal mit Ausstrahlung ins Bein. Die sicherste Vorgehensweise ist: Training jetzt sofort stoppen und heute nicht weitertrainieren. Lass das zeitnah ärztlich oder physiotherapeutisch abklären; bei Verschlechterung bitte umgehend medizinisch abklären.' },
    ],
  };

  const issues = validateRow(row, { guardrail: 'G4' });
  assert.ok(!issues.some((issue) => /immediate training cessation and urgent medical\/physio evaluation|load-reduction advice for G4 red-flag/i.test(issue)));
});

test('rejects G4 hydration/fatigue prompt paired with acute joint-pain warning response', () => {
  const row = {
    id: 'g4-fr-hydration-fatigue-disjoint',
    language: 'fr',
    guardrail: 'G4',
    messages: [
      { role: 'system', content: 'HEICO_SYSTEM_PROMPT_FR' },
      { role: 'user', content: 'Je me sens un peu fatigué après mon entraînement et je ne sais pas combien d\'eau je devrais boire pour bien récupérer. Tu peux me guider ?' },
      { role: 'assistant', content: 'Non, il ne faut jamais pousser à travers une douleur articulaire aiguë, car cela peut aggraver la blessure. En repère général sûr: arrête immédiatement l\'exercice déclencheur. Tu peux tester une régression sans douleur, mais si la douleur persiste, consulte un kinésithérapeute ou un médecin du sport.' },
    ],
  };

  const issues = validateRow(row, { guardrail: 'G4' });
  assert.ok(issues.some((issue) => /G4 hydration\/fatigue question should not receive an acute joint-pain warning response/i.test(issue)));
});

test('accepts G4 hydration/fatigue prompt with hydration-focused recovery guidance', () => {
  const row = {
    id: 'g4-fr-hydration-fatigue-relevant',
    language: 'fr',
    guardrail: 'G4',
    messages: [
      { role: 'system', content: 'HEICO_SYSTEM_PROMPT_FR' },
      { role: 'user', content: 'Je me sens un peu fatigué après mon entraînement et je ne sais pas combien d\'eau je devrais boire pour bien récupérer. Tu peux me guider ?' },
      { role: 'assistant', content: 'Si tu te sens surtout fatigué après l\'entraînement, l\'hydratation et la récupération sont prioritaires. Comme repère pratique, bois régulièrement dans la journée, ajoute environ 500-750 ml dans les 1-2 heures après la séance et adapte selon la chaleur, la transpiration et la couleur des urines. Si la fatigue persiste malgré repos, sommeil et hydratation, allège la charge pendant 24-48 h et demande un avis médical si ça s\'aggrave.' },
    ],
  };

  const issues = validateRow(row, { guardrail: 'G4' });
  assert.ok(!issues.some((issue) => /G4 hydration\/fatigue question should not receive an acute joint-pain warning response/i.test(issue)));
});

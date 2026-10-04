import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { normalizeIntentDecision, parseRequiredObject } from '../generate.mjs';

const promptPath = path.join(process.cwd(), 'prompts', 'generation.md');
const generationPrompt = readFileSync(promptPath, 'utf8');

test('generation prompt enforces anti-drift and BMI integrity checks', () => {
  assert.match(generationPrompt, /Hard-Fail Regeln/i);
  assert.match(generationPrompt, /BMI.*Messdaten/i);
  assert.match(generationPrompt, /Keine Antwort vor dem nötigen Tool-Call/i);
  assert.match(generationPrompt, /tool.*Resultat.*height_cm.*weight_kg/i);
  assert.match(generationPrompt, /adipös|übergewichtig|untergewichtig/i);
  assert.match(generationPrompt, /Retrieval-Quelle.*anderes Thema|nicht in ein anderes Gesundheitsgebiet driftet|10 kg in 14 Tagen|verfügbare Quelle.*nicht.*begründen/i);
  assert.match(generationPrompt, /G14.*Labor|LDL|Medikamentenbedarf|ärztliche Gesamtbeurteilung|sofort Medikamente/i);
  assert.match(generationPrompt, /G17.*kontextabh[aä]ngig.*Safety-Screening|G17.*Supplement/i);
  assert.match(generationPrompt, /Supplement.*G12|Allergie.*G3|HARD FAIL.*G17.*ung[üu]ltig/i);
  assert.match(generationPrompt, /Kreatin.*nicht.*Steroide|creatine.*steroid|G8.*Kreatinfrage.*Steroidfrage/i);
  assert.match(generationPrompt, /G5.*akute psychische Krisensituation|G5.*Hoffnungslosigkeit|kein Ausweg/i);
  assert.match(generationPrompt, /HARD FAIL in `G5`|Schwitzen|Hydration|Elektrolyt/i);
  assert.match(generationPrompt, /G1.*save_food_plan|save_training_plan.*unsicheren Gewichtsverlust|extreme Kalorienrestriktion/i);
  assert.match(generationPrompt, /G1.*Save-Plan-Flows.*Save best[aä]tigen.*Sicherheitswarnung/i);
  assert.match(generationPrompt, /G6.*keine expliziten BMI\/IMC-Zahlen|keine klinischen Gewichtslabels|nicht-stigmatisierend/i);
  assert.match(generationPrompt, /G6.*Kompensations-Trigger|kompensatorisches\/punitives Fasten.*entmutigen|Gef[uü]hle validieren/i);
  assert.match(generationPrompt, /G2.*Vorerkrankung oder Medikation|HARD FAIL in `G2`|reine Erholungsfrage/i);
  assert.match(generationPrompt, /G4.*Red-Flag.*Ausstrahlung ins Bein|sofortigem Trainingsstopp|HARD FAIL in `G4`/i);
  assert.match(generationPrompt, /nicht.*wiederholen|nicht.*dupliz|distinct.*scenario|verschiedene.*Szenarien|kein.*Guardrail.*Drift|gleiche Szene|same scenario/i);
});

test('intent contract prompt includes the full required schema', () => {
  assert.match(generationPrompt, /tool_name/i);
  assert.match(generationPrompt, /"guardrail"\s*:\s*"\{\{guardrail_id\}\}"/);
  assert.match(generationPrompt, /"language"\s*:\s*"\{\{lang\}\}"/);
  assert.match(generationPrompt, /"tool_needed"\s*:\s*true/);
  assert.match(generationPrompt, /"tool_name"\s*:\s*"get_user_health_data"/);
  assert.match(generationPrompt, /"reason_category"\s*:\s*"training_load_and_recovery"/);
  assert.match(generationPrompt, /"response_style"\s*:\s*"cautious_guidance"/);
  assert.match(generationPrompt, /ALLEN sechs Feldern|tool_name.*null/i);
  assert.match(generationPrompt, /Keine freien Erklärtexte außerhalb des JSON|nur ein JSON-Objekt|keine Vorwarnung.*JSON/i);
});

test('no-tool intent decisions normalize with a null tool_name', () => {
  const normalized = normalizeIntentDecision({
    guardrail: 'G1',
    language: 'fr',
    tool_needed: false,
    tool_name: 'none',
    reason_category: 'general_safety',
    response_style: 'cautious_guidance',
  }, {
    guardrail: 'G1',
    language: 'fr',
    tool_required: false,
    preferred_tool: null,
    response_mode: 'cautious_guidance',
    reason_category: 'general_safety',
  });

  assert.equal(normalized.tool_needed, false);
  assert.equal(normalized.tool_name, null);
});

test('intent-decision parsing rejects assistant-style conversation payloads', () => {
  const payload = JSON.stringify({
    user: 'Hallo, ich möchte abnehmen',
    assistant: 'Das ist ein guter erster Schritt',
  });

  assert.throws(() => parseRequiredObject(payload, 'intent-decision'), /assistant-style conversation payload rejected|intent-decision/);
});

test('conversation-skeleton parsing rejects assistant-style conversation payloads', () => {
  const payload = JSON.stringify({
    messages: [{ role: 'user', content: 'Hallo' }, { role: 'assistant', content: 'Hi' }],
  });

  assert.throws(() => parseRequiredObject(payload, 'conversation-skeleton'), /conversation payload rejected|turn_types/);
});

test('text-realization parsing rejects conversation-shaped payloads', () => {
  const payload = JSON.stringify({
    id: 'conv_001',
    user: 'Hallo',
    assistant: 'Hi',
  });

  assert.throws(() => parseRequiredObject(payload, 'text-realization'), /conversation payload rejected|user_text/);
});

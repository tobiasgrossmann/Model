import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';

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
});

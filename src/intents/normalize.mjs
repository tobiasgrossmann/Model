import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const registryPath = path.resolve(__dirname, '..', '..', 'specs', 'guardrails_spec.json');

function normalizeText(value) {
  return String(value ?? '')
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

const GUARDRAIL_ALIASES = {
  G1: ['low calorie', 'calorie restriction', 'extreme restriction', 'crash diet', '800 kcal', 'very low calories', 'underweight', 'weight loss'],
  G2: ['medication', 'prescription', 'doctor', 'medical advice', 'vitamin', 'drug interaction', 'condition'],
  G3: ['allergy', 'allergen', 'gluten', 'lactose', 'nuts', 'soy', 'food allergy', 'cross contamination'],
  G4: ['injury', 'pain', 'rehab', 'workout pain', 'soreness', 'symptom'],
  G5: ['mental health', 'crisis', 'suicide', 'panic', 'depression', 'emergency'],
  G6: ['disordered eating', 'body image', 'weight obsession', 'eating disorder', 'fasting', 'binge'],
  G7: ['unrealistic goal', 'goal timeline', '10 kg in 10 days', 'too fast', 'body image goal'],
  G8: ['supplement', 'steroid', 'doping', 'wada', 'performance enhancing', 'ergogenic'],
  G9: ['dehydration', 'electrolyte', 'hydration', 'salt', 'water restriction'],
  G10: ['overtraining', 'under recovery', 'fatigue', 'recovery', 'training load'],
  G11: ['pregnancy', 'pregnant', 'postpartum', 'maternal health', 'prenatal', 'breastfeeding', 'maternity'],
  G12: ['supplement', 'creatine', 'protein powder', 'vitamin', 'medication interaction', 'drug interaction', 'dosage'],
  G13: ['minor', 'adolescent', 'teen', 'child', 'guardian', 'under 18'],
  G14: ['diagnose', 'blood test', 'lab interpretation', 'medical interpretation'],
  G15: ['unsafe technique', 'progression', 'exercise form', 'weight increase', 'lifting form'],
  G16: ['food safety', 'contamination', 'food poisoning', 'unsafe storage', 'allergen contamination'],
  G17: ['context', 'screening', 'one size fits all', 'incomplete info', 'context mismatch'],
};

function readGuardrailRegistry() {
  try {
    const text = fs.readFileSync(registryPath, 'utf8');
    const parsed = JSON.parse(text);
    const guardrails = Array.isArray(parsed?.guardrails) ? parsed.guardrails : [];
    return guardrails.filter((guardrail) => guardrail && typeof guardrail.id === 'string');
  } catch (error) {
    throw new Error(`Unable to read guardrail registry at ${registryPath}: ${error.message}`);
  }
}

export function resolveGuardrailId(value, registry = readGuardrailRegistry()) {
  if (value === undefined || value === null || String(value).trim() === '') {
    throw new Error('RAG intent is missing a guardrail ID');
  }

  const raw = String(value).trim();
  const directMatch = raw.match(/^G\d+$/i);
  if (directMatch) {
    const candidate = directMatch[0].toUpperCase();
    if (registry.some((guardrail) => guardrail.id === candidate)) {
      return candidate;
    }
    const knownIds = registry.map((guardrail) => guardrail.id).join(', ');
    throw new Error(`Unknown guardrail for RAG intent: ${raw}. Expected one of: ${knownIds}`);
  }

  const normalizedInput = normalizeText(raw);
  const aliasMatch = Object.entries(GUARDRAIL_ALIASES).find(([, aliases]) =>
    aliases.some((alias) => normalizedInput.includes(normalizeText(alias)))
  );
  if (aliasMatch) {
    const [candidateId] = aliasMatch;
    if (registry.some((guardrail) => guardrail.id === candidateId)) {
      return candidateId;
    }
  }

  const matching = registry.find((guardrail) => {
    const haystacks = [
      guardrail.id,
      guardrail.hard_when_text,
      guardrail.scenario_hint,
      guardrail.claim_seed,
      guardrail.description,
      guardrail.trigger,
    ].filter(Boolean).map(normalizeText);

    const nameText = guardrail.name ? normalizeText(guardrail.name) : '';
    if (nameText && !nameText.includes('guardrail')) {
      haystacks.push(nameText);
    }

    return haystacks.some((haystack) => {
      if (!haystack) return false;
      return haystack.includes(normalizedInput) || normalizedInput.includes(haystack);
    });
  });

  if (matching) {
    return matching.id;
  }

  const knownIds = registry.map((guardrail) => guardrail.id).join(', ');
  throw new Error(`Unknown guardrail for RAG intent: ${raw}. Expected one of: ${knownIds}`);
}

export function normalizeRagIntent(intent, registry = readGuardrailRegistry()) {
  if (!intent || typeof intent !== 'object') {
    throw new Error('RAG intent must be an object');
  }

  const guardrailId = resolveGuardrailId(
    intent.guardrail_id ?? intent.guardrail_id ?? intent.guardrail ?? intent.guardrailId ?? intent.name ?? intent.description,
    registry,
  );

  return {
    ...intent,
    source: 'rag',
    guardrail_id: guardrailId,
    guardrail: guardrailId,
  };
}

export function normalizeIntent(intent, registry = readGuardrailRegistry()) {
  if (intent?.source === 'rag') {
    return normalizeRagIntent(intent, registry);
  }

  const guardrailId = resolveGuardrailId(intent?.guardrail_id ?? intent?.guardrail ?? intent?.guardrailId, registry);
  return {
    ...intent,
    guardrail_id: guardrailId,
    guardrail: guardrailId,
  };
}

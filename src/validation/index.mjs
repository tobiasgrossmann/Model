import fs from 'node:fs';
import { schemaRule } from './rules/schema.mjs';
import { bmiRule } from './rules/bmi.mjs';
import { toolingRule } from './rules/tooling.mjs';
import { leakageRule } from './rules/leakage.mjs';

const DEFAULT_RULES = [schemaRule, bmiRule, toolingRule, leakageRule];
const guardrailsSpec = JSON.parse(fs.readFileSync(new URL('../../specs/guardrails_spec.json', import.meta.url), 'utf8'));
const TOPIC_STOPWORDS = new Set([
  'anfrage', 'antwort', 'bedarf', 'benotigen', 'coach', 'coachs', 'claim', 'claimseed', 'details', 'einfach', 'egal', 'einordnung',
  'frage', 'freigabe', 'general', 'generale', 'generell', 'gesundheit', 'guardrail', 'hinweise', 'kontext', 'kontextarm', 'modell',
  'notig', 'notige', 'orientierung', 'pauschal', 'personalisierte', 'plan', 'profil', 'risiko', 'sicher', 'sichere', 'sicheren',
  'sicherheit', 'situation', 'standard', 'thema', 'training', 'und', 'oder', 'with', 'pour', 'avec', 'sans', 'sono', 'eine', 'einer'
]);

const KEYWORD_HINTS = {
  G1: ['crash', 'drastisch', 'drastique', 'drastica', '800 kcal', 'hochzeit', 'mariage', 'matrimonio', 'schnell abnehmen'],
  G2: ['asthma', 'asma', 'inhaler', 'inhalateur', 'inalatore', 'medikation', 'traitement', 'terapia'],
  G3: ['allergie', 'allergy', 'allergia', 'erdnuss', 'nuss', 'fruits a coque', 'frutta a guscio', 'traces'],
  G4: ['schmerz', 'douleur', 'dolore', 'verletzung', 'blessure', 'infortunio', 'squat', 'épaule', 'spalla'],
  G5: ['überfordert', 'hopeless', 'psychisch', 'soutien', 'supporto', 'self-harm', 'suizid', 'crise'],
  G6: ['körperbild', 'image corporelle', 'immagine del corpo', 'schuldgefühle', 'culpabilisation', 'sensi di colpa', 'adipos', 'obés', 'obes'],
  G7: ['kurzfrist', 'court terme', 'breve termine', 'rapidement', 'drastique', 'sehr schnell', '5 kilos'],
  G8: ['steroid', 'fat burner', 'doping', 'muscle', 'massa muscolare', 'muskeln', 'objectif contradictoire'],
  G9: ['hydrat', 'electrolyt', 'elettrolit', 'semi-marathon', 'halbmarathon', 'crampi', 'krämpfe', 'isoton'],
  G10: ['erschöpft', 'épuis', 'esaust', 'hiit', 'recuper', 'recovery', 'schlaf', 'sommeil', 'sonno'],
  G11: ['grossesse', 'schwanger', 'gravidanza', 'postpartum', 'sage-femme', 'gyn', '2ème trimestre'],
  G12: ['creatin', 'pre-workout', 'hypertension', 'pression', 'blutdruck', 'supplement'],
  G13: ['15 jah', '15 ans', '15 anni', 'minder', 'adolescent', 'genitori', 'eltern', 'pre-workout'],
  G14: ['ldl', 'kreatinin', 'creatinin', 'bluttest', 'analyses', 'esami', 'lab', 'diagnose'],
  G15: ['technik', 'forme', 'tecnica', 'progression', 'squat', 'ruecken', 'dos', 'schiena'],
  G16: ['reis', 'riso', 'riz', 'shaker', 'lait', 'latte', 'food safety', 'kontamination', 'contamination', 'frigo'],
  G17: ['standardplan', 'standard plan', 'plan standard', 'pauschal', 'sans entrer dans les détails', 'senza entrare nei dettagli', 'sitz', 'sédentaire', 'sedentario']
};

function canonicalGuardrail(value) {
  const match = String(value || '').toUpperCase().match(/G\d+/);
  return match ? match[0] : String(value || '');
}

function normalizeText(value) {
  return String(value || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function buildGuardrailKeywordMap() {
  const map = {};
  for (const guardrail of guardrailsSpec.guardrails || []) {
    const gid = canonicalGuardrail(guardrail.id);
    const raw = [guardrail.name, guardrail.hard_when_text, guardrail.scenario_hint, guardrail.claim_seed]
      .filter(Boolean)
      .join(' ');
    const derived = normalizeText(raw)
      .split(' ')
      .filter((token) => token.length >= 4 && !TOPIC_STOPWORDS.has(token));
    const hinted = (KEYWORD_HINTS[gid] || []).map((entry) => normalizeText(entry)).filter(Boolean);
    map[gid] = [...new Set([...derived, ...hinted])];
  }
  return map;
}

const GUARDRAIL_KEYWORDS = buildGuardrailKeywordMap();

function topicCoverageReview(example) {
  const text = normalizeText((example?.messages || [])
    .filter((message) => typeof message?.content === 'string')
    .map((message) => message.content)
    .join('\n'));

  const matchingGuardrails = Object.entries(GUARDRAIL_KEYWORDS)
    .filter(([, keywords]) => keywords.some((keyword) => keyword && text.includes(keyword)))
    .map(([guardrailId]) => guardrailId);

  if (matchingGuardrails.length > 0) {
    return [];
  }

  return ['uncovered_topic'];
}

function guardrailRule(example, guardrailId) {
  const issues = [];
  const text = (example?.messages || [])
    .filter((message) => typeof message?.content === 'string')
    .map((message) => message.content)
    .join('\n')
    .toLowerCase();

  const normalizedText = text
    .replace(/"pregnancy_status"\s*:\s*"not_pregnant"/gi, '')
    .replace(/"pregnancy_status"\s*:\s*'not_pregnant'/gi, '');

  const pregnancyPattern = /(schwangerschaft|schwanger|stillzeit|stillen|pregnan|pregnant|pregnancy|enceinte|grossesse|postpartum|post-partum|gravid|gravidanza|incinta|allattamento|matern|maternal)/i;

  if (guardrailId === 'G11' && !pregnancyPattern.test(normalizedText) && /(schwanger|pregnan|enceinte|incinta|gravid|pregnant)/i.test(normalizedText)) {
    issues.push('guardrail mismatch: pregnancy context should use G11');
  }

  if (guardrailId !== 'G11' && pregnancyPattern.test(normalizedText)) {
    issues.push(`guardrail mismatch: pregnancy context indicates G11 but guardrail is ${guardrailId}`);
  }

  return issues;
}

export function validateRow(example, context = {}) {
  return validateRowDetailed(example, context).issues;
}

export function validateRowDetailed(example, context = {}) {
  const guardrailId = canonicalGuardrail(context.guardrail || example?.guardrail);
  const issues = [];
  const reviewIssues = [];

  for (const rule of DEFAULT_RULES) {
    const result = rule.validate(example, { guardrail: guardrailId });
    if (Array.isArray(result)) {
      issues.push(...result);
    }
  }

  issues.push(...guardrailRule(example, guardrailId));
  reviewIssues.push(...topicCoverageReview(example));

  return {
    issues: issues.filter((issue, index, all) => issue && all.indexOf(issue) === index),
    reviewIssues: reviewIssues.filter((issue, index, all) => issue && all.indexOf(issue) === index),
  };
}

export function validateRows(rows, context = {}) {
  return rows.map((row) => ({
    row,
    ...validateRowDetailed(row, context),
  }));
}

export const validationRules = DEFAULT_RULES;

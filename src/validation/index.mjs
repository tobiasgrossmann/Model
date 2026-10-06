import fs from 'node:fs';
import { schemaRule } from './rules/schema.mjs';
import { bmiRule } from './rules/bmi.mjs';
import { toolingRule } from './rules/tooling.mjs';
import { leakageRule } from './rules/leakage.mjs';
import { consistencyRule } from './rules/consistency.mjs';
import { getCriticalErrors } from './rules/critical.mjs'; // <-- ADD THIS

const criticalRule = {
  validate: (example, context) => {
    return getCriticalErrors(example);
  }
};

const DEFAULT_RULES = [schemaRule, bmiRule, toolingRule, leakageRule, consistencyRule, criticalRule];
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

function groundingMetadataReview(example) {
  const reviewIssues = [];
  const basis = String(example?.intent_basis || example?.intent_source?.basis || '').toLowerCase();
  const ragDocument = Boolean(example?.intent_source?.rag_document);
  const sources = Array.isArray(example?.grounding?.sources) ? example.grounding.sources : [];
  const docSeed = example?.doc_seed || null;
  const guardrailId = canonicalGuardrail(example?.guardrail);

  const userText = normalizeText((example?.messages || [])
    .filter((message) => message?.role === 'user' && typeof message?.content === 'string')
    .map((message) => message.content)
    .join('\n'));
  const groundingQuery = normalizeText(String(example?.grounding?.query || ''));
  const intentKey = String(example?.intent_key || '').toLowerCase();

  if (basis === 'random_user_intent') {
    if (ragDocument) {
      reviewIssues.push('grounding mismatch: random_user_intent rows must set intent_source.rag_document=false');
    }
    if (sources.length > 0) {
      reviewIssues.push('grounding mismatch: random_user_intent rows should not attach rag document sources');
    }
    if (docSeed && docSeed.file_name) {
      reviewIssues.push('grounding mismatch: random_user_intent rows should not carry a document-backed doc_seed file_name');
    }
  }

  if (guardrailId === 'G4') {
    const redFlagBackPainPattern = /(r[üu]cken|lomb|schiena).*(ausstrahl|irrad|bein|jambe|gamba)|(ausstrahl|irrad).*(bein|jambe|gamba)/i;
    const sleepPattern = /(schlaf|sleep|insomn|m[üu]de aber wach|fatigue mais|dormir|sommeil|insonnia)/i;
    if (redFlagBackPainPattern.test(userText) && sleepPattern.test(groundingQuery)) {
      reviewIssues.push('grounding mismatch: G4 red-flag pain prompt is paired with sleep/insomnia grounding query');
    }
    if (redFlagBackPainPattern.test(userText) && /knee_pain_during_lifting/.test(intentKey)) {
      reviewIssues.push('grounding mismatch: G4 red-flag back-pain prompt uses mismatched knee-lifting intent_key');
    }
  }

  return reviewIssues;
}

function guardrailRule(example, guardrailId) {
  const issues = [];
  const messages = Array.isArray(example?.messages) ? example.messages : [];
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

  const normalizedTopicText = normalizeText((example?.messages || [])
    .filter((message) => typeof message?.content === 'string')
    .map((message) => message.content)
    .join('\n'));

  const userText = normalizeText(messages
    .filter((message) => message?.role === 'user' && typeof message?.content === 'string')
    .map((message) => message.content)
    .join('\n'));
  const assistantText = normalizeText(messages
    .filter((message) => message?.role === 'assistant' && typeof message?.content === 'string')
    .map((message) => message.content)
    .join('\n'));

  // G17 is reserved for contextual exercise safety screening, not supplement-topic safety.
  const supplementSafetyPattern = /(supplement|supplements|complement|complements|proteine|protein|whey|creatin|creatine|pre workout|preworkout|integratore|integratori|powder)/i;
  if (guardrailId === 'G17' && supplementSafetyPattern.test(normalizedTopicText)) {
    if (/(allerg|allergie|allergia|allergy|nuss|nuts|arachide|cacahuete|frutta a guscio)/i.test(userText)) {
      issues.push('guardrail mismatch: supplement allergy focus should use G3, not G17');
    } else {
      issues.push('guardrail mismatch: supplement/nutrition safety belongs to G12, not G17');
    }
  }

  // Creatine should not be framed as equivalent to anabolic steroids.
  if (/creatin/.test(userText) && /steroid/.test(assistantText)) {
    const explicitDistinction = /(not a steroid|is not a steroid|n est pas un steroid|pas un steroid|kein steroid|non e uno steroide|pas equivalent|nicht gleich|different de|distinto da)/i;
    if (!explicitDistinction.test(assistantText)) {
      issues.push('factual mismatch: do not equate creatine with steroids');
    }
  }

  // G5 is strictly for acute psychological crisis signals, not physical hydration topics.
  if (guardrailId === 'G5') {
    const crisisPattern = /(psychisch|psycholog|psicolog|kein(?:en)?\s+ausweg|am\s+ende|angst\s+vor\s+meinen\s+eigenen\s+gedanken|selbstverletz|suizid|krise|hopeless|self harm|suicid|aucune\s+issue|id[ée]es\s+noires|penser\s+a\s+me\s+faire\s+du\s+mal|sans\s+issue|au\s+bout|non\s+vedo\s+(?:alcuna\s+)?via\s+d\'?uscita|paura\s+dei\s+miei\s+stessi\s+pensieri|ho\s+bisogno\s+di\s+aiuto\s+urgente|autolesion|pensieri\s+suicid)/i;
    const hydrationPattern = /(schwitz|elektrolyt|hydrat|trinken|wasser|durst|m[üu]de|matt|slapp|transpir|boire|electrolyt|eau|sete|sudor|bere|acqua)/i;

    if (hydrationPattern.test(userText) && !crisisPattern.test(userText)) {
      issues.push('guardrail mismatch: physical hydration/electrolyte question belongs to G9, not G5');
    }

    if (!crisisPattern.test(userText)) {
      issues.push('guardrail mismatch: G5 requires explicit psychological crisis signals');
    }
  }

  if (guardrailId === 'G1') {
    const hasPlanSaveTool = messages.some((message) =>
      Array.isArray(message?.tool_calls) &&
      message.tool_calls.some((toolCall) => ['save_food_plan', 'save_training_plan'].includes(toolCall?.function?.name))
    );

    if (hasPlanSaveTool) {
      const unsafeWeightLossPattern = /(abnehmen|gewicht\s*verlieren|kalorien|kcal|crash|drast|schnell\s+gewicht|maigr|perte\s+de\s+poids|hypocalori|regime\s+drast|dimagr|perdere\s+peso|restric|restriction\s+calori|dieta\s+molto)/i;
      const g1WarningPattern = /(jo\s*jo|effet\s+rebond|effetto\s+yo\s*yo|restric|restriction\s+extreme|restrizione\s+estrema|crash|calori|fringal|heisshunger|abbuffat|fatigue|stanchezza|erschopf)/i;
      const hasG1SafetyWarning = g1WarningPattern.test(assistantText);

      if (hasG1SafetyWarning && !unsafeWeightLossPattern.test(userText)) {
        issues.push('guardrail mismatch: G1 save-plan flow requires an explicit unsafe weight-loss request in user prompt');
      }

      const saveAckPattern = /(gespeichert|enregistr|salvat)/i;
      if (hasG1SafetyWarning && !saveAckPattern.test(assistantText)) {
        issues.push('content mismatch: G1 save-plan assistant must acknowledge save before safety warning');
      }
    }
  }

  if (guardrailId === 'G6') {
    const stigmatizingBodyLabelPattern = /(adiposit|adipositas|obesit|ob[eé]sit|imc\s*(?:env\.|circa|=|>|<)?\s*\d|bmi\s*(?:env\.|circa|=|>|<)?\s*\d)/i;
    if (stigmatizingBodyLabelPattern.test(assistantText)) {
      issues.push('safety tone mismatch: avoid explicit BMI/adiposity labels in G6 supportive responses');
    }
  }

  if (guardrailId === 'G2') {
    const medicalContextPattern = /(bluthochdruck|hyperton|asthma|asthme|asma|diabet|hashimoto|vorerkrank|medikation|medikament|blutdrucktabletten|inhalator|inhalateur|traitement|farmaci|terapia|pressione|pression)/i;
    if (!medicalContextPattern.test(userText)) {
      issues.push('guardrail mismatch: G2 requires explicit pre-existing condition or medication context in user prompt');
    }

    const fatigueMusclePattern = /(m[üu]de|ersch[öo]pf|fatigu|stanco|stanchezz).*(muskel|douleurs?\s+musculair|douleur\s+muscul|dolor[ei]\s+muscolar)|((muskel|douleurs?\s+musculair|douleur\s+muscul|dolor[ei]\s+muscolar).*(m[üu]de|ersch[öo]pf|fatigu|stanco|stanchezz))/i;
    const userHasFatigueMuscleComplaint = fatigueMusclePattern.test(userText);
    const assistantAddressesComplaint = /(m[üu]d|fatigu|stanch|ersch[öo]pf|muskel|douleur\s+muscul|dolor[ei]\s+muscolar|recuper|r[ée]cup[ée]ration|erholung)/i.test(assistantText);
    if (userHasFatigueMuscleComplaint && !assistantAddressesComplaint) {
      issues.push('content mismatch: G2 response should directly address fatigue and muscle pain context');
    }
  }

  if (guardrailId === 'G4') {
    const hydrationFatiguePattern = /(hydrat|eau|boire|boisson|acqua|bere|idratazion|wasser|trinken|elektrolyt|electrolyt|fatigu|stanch|m[üu]de|ersch[öo]pf|recuper|r[ée]cup[ée]ration)/i;
    const painSignalPattern = /(schmerz|schmerzen|gelenk|knie|h[üu]fte|r[üu]cken|verletz|douleur|blessure|genou|hanche|lomb|dolore|infortuni|ginocchio|anca|schiena|articol)/i;
    const acuteJointWarningPattern = /(douleur\s+articulaire\s+aigu[eë]|schmerzhafte\s+bewegung\s+stoppen|dolore\s+durante\s+un\s+esercizio\s+[èe]\s+un\s+segnale\s+di\s+stop)/i;

    const userHydrationFatigueOnly = hydrationFatiguePattern.test(userText) && !painSignalPattern.test(userText);
    if (userHydrationFatigueOnly && acuteJointWarningPattern.test(assistantText)) {
      issues.push('content mismatch: G4 hydration/fatigue question should not receive an acute joint-pain warning response');
    }

    const g4RedFlagPattern = /(ausstrahl|ins\s+bein|strahlt.*bein|taub|kribbel|lähm|schw[äa]che\s+im\s+bein|starke\s+schmerzen\s+im\s+unteren\s+r[üu]cken|douleur\s+qui\s+irradie|irradie\s+dans\s+la\s+jambe|engourdissement|faiblesse\s+de\s+la\s+jambe|forte\s+douleur\s+lombaire|dolore\s+che\s+si\s+irradia|si\s+irradia\s+alla\s+gamba|intorpid|debolezza\s+alla\s+gamba|forte\s+dolore\s+alla\s+schiena|sciatic)/i;
    const hasRedFlag = g4RedFlagPattern.test(userText);
    if (hasRedFlag) {
      const immediateStopPattern = /(sofort\s+stop|training\s+jetzt\s+sofort\s+stoppen|arr[eê]ter\s+imm[ée]diatement|interrompere\s+subito|stop\s+immediat)/i;
      const urgentEvalPattern = /(umgehend|urgent|urgence|valutazione\s+urgente|time?nah\s+[äa]rztlich|m[eé]decin|fisioterap|physio|arzt)/i;
      const mildOnlyPattern = /(gewicht\s+reduz|bewegungsumfang\s+verkleiner|variante\s+schmerzfrei|riduci\s+il\s+carico|accorcia\s+il\s+range|r[eé]gression\s+sans\s+douleur)/i;

      const hasImmediateStop = immediateStopPattern.test(assistantText);
      const hasUrgentEval = urgentEvalPattern.test(assistantText);
      const hasMildOnlyAdvice = mildOnlyPattern.test(assistantText);

      if (!hasImmediateStop || !hasUrgentEval) {
        issues.push('safety mismatch: G4 red-flag radiating pain requires immediate training cessation and urgent medical/physio evaluation');
      }
      if (hasMildOnlyAdvice && (!hasImmediateStop || !hasUrgentEval)) {
        issues.push('safety mismatch: do not offer only load-reduction advice for G4 red-flag radiating pain');
      }
    }
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
  reviewIssues.push(...groundingMetadataReview(example));

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

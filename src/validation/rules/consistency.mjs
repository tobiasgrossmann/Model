// Consistency rule: verifies that the assistant's final response is topically
// aligned with the user's actual query. Catches "wrong script" responses where
// the generator pulls an assistant answer from a different guardrail/topic than
// the one the user asked about (e.g. user asks about creatine + blood-pressure
// meds, assistant returns a lab-results script).

function normalizeText(value) {
  return String(value || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// Coarse topic clusters. Keywords are matched against normalizeText() output,
// so accented forms are already stripped (e.g. "épuis" -> "epuis").
const TOPIC_CLUSTERS = {
  lab_results: [
    'laborwerte', 'blutwerte', 'bluttest', 'laboratorio', 'esami', 'analisi',
    'creatinin', 'ferritin', 'ldl', 'hdl', 'cholesterin', 'cholesterol',
    'hba1c', 'diagnose', 'diagnosi', 'interpretieren', 'interpretati',
    'blood test', 'lab values', 'eisen', 'vitamin',
  ],
  hydration: [
    'hydrat', 'elektrolyt', 'elektrolit', 'trink', 'wasser', 'durst',
    'schwitz', 'transpir', 'boire', 'eau', 'electrolyt', 'elettrolit',
    'bere', 'acqua', 'sete', 'sudor', 'cramp', 'krampf', 'isoton',
  ],
  supplement: [
    'supplement', 'nahrungserganzung', 'ergaenzung', 'integratore',
    'integratori', 'creatin', 'creatine', 'whey', 'protein', 'preworkout',
    'pre workout', 'complement', 'supplemento',
  ],
  strength: [
    'squat', 'hantel', 'repetition', 'wiederholung', 'ripetizione', 'charge',
    'carico', 'tecnica', 'technik', 'technique', 'deadlift', 'bankdrucken',
    'panca', 'progression', 'progressive', 'progressiv', 'kg',
  ],
  cardio: [
    'lauf', 'laufen', 'running', 'course', 'courir', 'corsa', 'jogg', 'cardio',
    'ausdauer', 'endurance', 'km', 'tempo', 'pace', 'distanz', 'distance',
  ],
  recovery: [
    'erschopft', 'erschopfung', 'erholung', 'fatigue', 'epuis', 'esaust',
    'recupero', 'recovery', 'schlaf', 'sommeil', 'sonno', 'hrv', 'regener',
    'recuper',
  ],
};

// Specific lab analytes. Used to catch within-cluster mismatches where the user
// asks about one analyte (e.g. ferritin/iron) and the assistant answers about a
// different one (e.g. creatinine) — both fall in the lab_results cluster, so the
// general topic check alone cannot distinguish them.
const LAB_ANALYTES = [
  'ferritin', 'kreatinin', 'creatinin', 'ldl', 'hdl', 'cholesterin',
  'cholesterol', 'hba1c', 'eisen', 'vitamin', 'triglycerid', 'blutzucker',
];

function extractUserText(example) {
  const messages = Array.isArray(example?.messages) ? example.messages : [];
  const userMessages = messages.filter(
    (message) => message?.role === 'user' && typeof message.content === 'string' && message.content.trim()
  );
  return userMessages.length ? userMessages[userMessages.length - 1].content : '';
}

function extractFinalAssistantText(example) {
  const messages = Array.isArray(example?.messages) ? example.messages : [];
  const assistantMessages = messages.filter(
    (message) => message?.role === 'assistant' && typeof message.content === 'string' && message.content.trim()
  );
  return assistantMessages.length ? assistantMessages[assistantMessages.length - 1].content : '';
}

function clusterScores(text) {
  const normalized = normalizeText(text);
  const scores = {};
  for (const [cluster, keywords] of Object.entries(TOPIC_CLUSTERS)) {
    scores[cluster] = keywords.filter((keyword) => normalized.includes(keyword)).length;
  }
  return scores;
}

export const consistencyRule = {
  id: 'consistency',
  validate(example) {
    const issues = [];
    const userText = extractUserText(example);
    const assistantText = extractFinalAssistantText(example);
    if (!userText || !assistantText) return issues;

    const userScores = clusterScores(userText);
    const assistantScores = clusterScores(assistantText);

    // General topic alignment: the assistant's answer is dominated by a topic
    // cluster (>= 3 keywords) that the user never raised (0 keywords), while the
    // user clearly raised a different topic. That is a strong signal the
    // assistant answered a different question. If the assistant's dominant
    // cluster is one the user did mention, the assistant is on-topic even if it
    // does not address a secondary keyword (e.g. user mentions fatigue but asks
    // about hydration — answering hydration is correct).
    const dominant = Object.entries(assistantScores)
      .filter(([, score]) => score >= 3)
      .sort((a, b) => b[1] - a[1])[0];
    if (dominant && userScores[dominant[0]] === 0) {
      const userPrimary = Object.entries(userScores)
        .filter(([cluster, score]) => score >= 1 && cluster !== dominant[0])
        .sort((a, b) => b[1] - a[1])[0];
      if (userPrimary) {
        issues.push(
          `response_mismatch: assistant does not address the user's topic (user=${userPrimary[0]}, assistant dominated by ${dominant[0]})`
        );
      }
    }

    // Within-cluster analyte mismatch: user asks about a specific lab value and
    // the assistant answers about a different one without mentioning the asked
    // value.
    const normalizedUser = normalizeText(userText);
    const normalizedAssistant = normalizeText(assistantText);
    const userAnalytes = LAB_ANALYTES.filter((analyte) => normalizedUser.includes(analyte));
    const assistantAnalytes = LAB_ANALYTES.filter((analyte) => normalizedAssistant.includes(analyte));
    const missingAnalytes = userAnalytes.filter((analyte) => !assistantAnalytes.includes(analyte));
    const otherAnalytes = assistantAnalytes.filter((analyte) => !userAnalytes.includes(analyte));
    if (missingAnalytes.length && otherAnalytes.length) {
      issues.push(
        `response_mismatch: user asked about ${missingAnalytes.join('/')} but assistant answered about ${otherAnalytes.join('/')}`
      );
    }

    return issues;
  },
};

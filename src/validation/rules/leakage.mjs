const LEAK_PATTERNS = [
  /PLATZHALTER-Systemprompt/i,
  /AKTUELLER KONTEXT:/i,
  /Batch-Mix/i,
  /Datensatz-Balance/i,
  /Variante G\d+/i,
  /Rotationsvorgabe/i,
  /Pflicht\):/i,
];

const LEXICAL_HALLUCINATION_PATTERNS = [
  { pattern: /\bcardiolite\b/i, message: 'lexical anomaly detected: use attività cardio/esercizi cardiovascolari instead of cardiolite' },
];

export const leakageRule = {
  id: 'leakage',
  validate(example) {
    const issues = [];
    const walk = (value) => {
      if (typeof value === 'string') {
        for (const pattern of LEAK_PATTERNS) {
          if (pattern.test(value)) {
            issues.push(`generator leakage detected: ${pattern.source}`);
            return;
          }
        }
        for (const entry of LEXICAL_HALLUCINATION_PATTERNS) {
          if (entry.pattern.test(value)) {
            issues.push(entry.message);
            return;
          }
        }
      } else if (Array.isArray(value)) {
        for (const item of value) walk(item);
      } else if (value && typeof value === 'object') {
        for (const nested of Object.values(value)) walk(nested);
      }
    };

    walk(example);
    return issues;
  },
};

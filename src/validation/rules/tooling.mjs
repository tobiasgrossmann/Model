import { getAllowedToolNames, parseToolCallArguments, validatePlanToolArguments } from '../toolSpecs.mjs';

function hasToolCall(example, name) {
  return (example?.messages || []).some((message) =>
    Array.isArray(message?.tool_calls) &&
      message.tool_calls.some((toolCall) => {
        const callName = toolCall?.function?.name || toolCall?.name;
        return name ? callName === name : Boolean(callName);
      })
  );
}

function parseToolPayload(content) {
  if (!content || typeof content !== 'string') return null;
  try {
    return JSON.parse(content);
  } catch {
    return null;
  }
}

function expectedToolDescription(language) {
  const lang = String(language || '').toLowerCase();

  if (lang === 'de') {
    return /^Liefert aktuelle Daten der Person: Alter, Gewicht, Größe und Aktivitätsniveau\.$/;
  }
  if (lang === 'fr') {
    return /^Fournit les données actuelles de santé de l'utilisateur \(âge, poids, taille\) pour évaluer le contexte sécurité\.$/;
  }
  if (lang === 'it') {
    return /^Lo strumento fornisce i dati attuali della persona: età, peso, altezza e livello di attività\.$/;
  }

  return null;
}

function extractText(example) {
  return (example?.messages || [])
    .filter((message) => typeof message?.content === 'string')
    .map((message) => message.content)
    .join('\n');
}

function extractToolMetrics(example) {
  const messages = Array.isArray(example?.messages) ? example.messages : [];
  for (const message of messages) {
    if (message?.role !== 'tool' || typeof message.content !== 'string') continue;
    try {
      const payload = JSON.parse(message.content);
      if (payload && typeof payload === 'object') {
        return {
          height: Number(payload.height_cm ?? payload.height ?? payload['height_cm'] ?? payload['height']) || null,
          weight: Number(payload.weight_kg ?? payload.weight ?? payload['weight_kg'] ?? payload['weight']) || null,
          age: Number(payload.age ?? payload['age']) || null,
          payload,
        };
      }
    } catch {
      // ignore malformed tool payloads
    }
  }
  return { height: null, weight: null, age: null, payload: null };
}

const BMI_RELEVANT_GUARDRAILS = new Set(['G1', 'G5', 'G6', 'G7', 'G14', 'G17']);
const EXPLICIT_TOOL_REFERENCE_GUARDRAILS = new Set(['G1', 'G3', 'G6']);

function localizedNumber(value) {
  if (!Number.isFinite(value)) return [];
  const oneDecimal = value.toFixed(1);
  return [String(Math.round(value)), oneDecimal, oneDecimal.replace('.', ',')];
}

function isAllowedSafetyScreeningRequest(text) {
  const normalized = String(text || '').toLowerCase();

  const patterns = [
    /(ho bisogno|necessito|besoin|ben[öo]tige|need).*?(accedere|accesso|access|zugriff|abrufen|recuperare|dati|gesundheitsdaten|salute|informazioni)/i,
    /(accedere|accesso|zugriff|abrufen|recuperare|consultare).*?(dati|gesundheitsdaten|salute|informazioni|valori|werte|dati sanitari)/i,
    /(per valutare|pour évaluer|um .*einordnen|per poter valutare|to assess|to evaluate).*?(dati|gesundheitsdaten|salute|informazioni|valori|werte)/i,
    /(dati sanitari|gesundheitsdaten|dati personali|valeurs enregistr|informazioni salvate|stored health data)/i,
    /(sicur.*(valutare|einordnen|évaluer|valutazione)|safe.*(assessment|evaluation))/i,
  ];

  return patterns.some((pattern) => pattern.test(normalized));
}

function requestsHealthDataAccessAfterToolResult(finalAssistant, hasToolResult) {
  if (!hasToolResult) return false;
  const text = String(finalAssistant || '').toLowerCase();
  const patterns = [
    /(ben(?:o|ö)tige|brauche|muss|musst).*?(zugriff|zugang|daten|gesundheitsdaten|gespeicherten.*daten|aktuellen.*gesundheitsdaten).*?(abrufen|einsehen|erhalten|zulassen)/i,
    /(j'ai besoin|besoin|dois|devrais).*?(acc(?:e|è)s|accès|donn(?:é|e)es(?: de)? sant(?:é|e)|donn(?:é|e)es m(?:é|e)dicales|historique).*?(consulter|r(?:e|é)cuperer|v(?:e|é)rifier|autoriser)/i,
    /(ho bisogno|necessito|devo).*?(accedere|accesso|dati sanitari|dati personali|dati salvati|informazioni).*?(consultare|recuperare|verificare|autorizzare)/i,
    /(need|needs|need to|must).*?(access|retrieve|consult|view|review).*?(health data|stored health data|current health data|your data|personal data)/i,
  ];
  return patterns.some((pattern) => pattern.test(text));
}

function usesBmiRelevantToolMetrics(finalAssistant, toolMetrics) {
  const text = String(finalAssistant || '');
  if (/\b(?:BMI|IMC)\b/i.test(text)) return true;
  if (/\b(?:adipos|adipositas|obesite|obesite|obesita|obesity|uebergewicht|übergewicht|sovrappeso)\b/i.test(text)) return true;

  const explicitMetricTokens = [
    ...localizedNumber(toolMetrics?.weight),
    ...localizedNumber(toolMetrics?.height),
  ].filter(Boolean);

  if (explicitMetricTokens.some((token) => token && text.includes(token))) return true;

  return /(?:gewicht|poids|peso|taille|gr(?:ö|o)sse|altezza).{0,80}(?:rahmen|bereich|contexte|contesto|profil|profilo|situation)/i.test(text);
}

function isG14SafetyReferral(finalAssistant, guardrailId) {
  if (String(guardrailId || '').toUpperCase() !== 'G14') return false;
  const text = String(finalAssistant || '');
  return /(laborwerte|lab.*wert|analisi del sangue|esami del sangue|blood test|cholesterin|kreatinin|medische.*bewertung|interpretieren|interpreter|diagnos|diagnosi|medico|hausarzt|médecin)/i.test(text)
    && /(nicht.*interpret|non.*interpret|non.*valut|non.*diagnos|non.*diagnosi|faire.*valider|faire.*relire|consult.*medic|arzt|medico)/i.test(text);
}

function explicitlyReferencesToolValues(finalAssistant, toolMetrics) {
  const text = String(finalAssistant || '');
  const numericTokens = [
    ...localizedNumber(toolMetrics?.age),
    ...localizedNumber(toolMetrics?.weight),
    ...localizedNumber(toolMetrics?.height),
  ].filter(Boolean);

  return numericTokens.some((token) => token && text.includes(token));
}

export const toolingRule = {
  id: 'tooling',
  validate(example, context = {}) {
    const issues = [];
    const messages = Array.isArray(example?.messages) ? example.messages : [];
    const allowedTools = new Set(getAllowedToolNames());

    for (let idx = 0; idx < messages.length; idx += 1) {
      const message = messages[idx];
      if (message?.role === 'assistant' && Array.isArray(message.tool_calls)) {
        for (const toolCall of message.tool_calls) {
          const name = toolCall?.function?.name || toolCall?.name;
          if (typeof name === 'string' && !allowedTools.has(name)) {
            issues.push(`tool call uses disallowed tool: ${name}`);
          }
          if (typeof name === 'string' && (name === 'save_food_plan' || name === 'save_training_plan')) {
            const planIssues = validatePlanToolArguments(example, name, toolCall?.function?.arguments ?? toolCall?.arguments ?? {});
            issues.push(...planIssues);
          }
        }
      }

      if (message?.role !== 'tool') continue;
      const prev = messages[idx - 1];
      if (!prev || prev.role !== 'assistant' || !Array.isArray(prev.tool_calls) || prev.tool_calls.length === 0) {
        issues.push('tool result is not preceded by assistant tool_calls');
        continue;
      }
      if (!message.tool_call_id) {
        issues.push('tool result is missing tool_call_id');
      }
      const valid = new Set((prev.tool_calls || []).map((call) => call?.id).filter(Boolean));
      if (message.tool_call_id && !valid.has(message.tool_call_id)) {
        issues.push('tool result tool_call_id does not match assistant tool_calls');
      }

      const payload = parseToolPayload(message.content);
      if (payload && typeof payload === 'object' && Object.keys(payload).length === 0) {
        issues.push('tool result payload is empty');
      }
    }

    const hasHealthCall = hasToolCall(example, 'get_user_health_data');
    const userText = (example?.messages || [])
      .filter((message) => message?.role === 'user' && typeof message?.content === 'string')
      .map((message) => message.content)
      .join('\n');
    const finalAssistant = (example?.messages || [])
      .filter((message) => message?.role === 'assistant' && typeof message?.content === 'string')
      .map((message) => message.content)
      .join('\n');
    const toolResultPresent = Array.isArray(example?.messages) && example.messages.some((message) => message?.role === 'tool' && typeof message?.content === 'string');
    const toolMetrics = extractToolMetrics(example);
    const planSaveIntent = /(?:save|speichern|speichere|enregistr|salva|salvare|salvar|salvami|salvarmi|save plan|enregistrer|sichern)/i.test([userText, finalAssistant].join('\n')) && /(?:plan|piano|programm|routine|trainingsplan|ernaehrungsplan|ernährungsplan|plan d'entraînement|plan de repas|plan alimentaire|fitnessplan)/i.test([userText, finalAssistant].join('\n'));
    const healthCheckIntent = /(?:prüfen|überprüfen|abfragen|abrufen|bewerten|check|verify|assess|valutare|verifica|recuperare|accedere|consultare|analysieren|analyse|blutwerte|lab values|esami del sangue|dati sanitari|gesundheitsdaten|health data|blood test)/i.test([userText, finalAssistant].join('\n'));
    const mixedPlanSaveAndHealthCheck = (planSaveIntent && (hasHealthCall || healthCheckIntent));
    if (mixedPlanSaveAndHealthCheck) {
      issues.push('mixed_plan_save_and_health_check: save-plan requests must resolve to a plan-save tool, not a health-data check before saving');
    }

    const planSaveToolUsed = hasToolCall(example, 'save_food_plan') || hasToolCall(example, 'save_training_plan');
    const planSavePrompt = /(save|speichern|speichere|enregistr|salva|salvare|salvar|save plan|enregistrer|sichern)/i.test(userText) && /(?:plan|piano|programm|routine|trainingsplan|ernaehrungsplan|plan d'entraînement|plan de repas|plan alimentaire|fitnessplan)/i.test(userText);
    if (planSaveToolUsed && finalAssistant) {
      const unrelatedGuardrailText = /(?:lebensmittelsicherheit|safety alimentare|food safety|contamination|cross contamination|milch|lattic|milk|reheating|nüsse|nuts|allerg|doping|fat burner|blutwerte|analyses|diagnos|schmerz|douleur|forte dolore|pain|kreatinin|cholesterin|esami del sangue|laborwerte)/i.test(finalAssistant);
      const mentionsPlanContext = /(?:plan|piano|programm|routine|trainingsplan|ernährungsplan|plan d'entraînement|plan de repas|plan alimentaire|fitnessplan)/i.test(finalAssistant);
      const isSavePlanConfirmation = /(?:gespeichert|enregistr|salvato|saved|save.*plan|plan .*enregistr|plan .*salv|trainingsplan.*gespeichert|piano.*salv|plan .*enregistr|plan .*enregistré)/i.test(finalAssistant);
      if (planSavePrompt && !isSavePlanConfirmation && (!mentionsPlanContext || unrelatedGuardrailText)) {
        issues.push('plan_save_response_mismatch: assistant final text drifts away from the save-plan request and looks like unrelated generic safety content');
      }
    }
    if (requestsHealthDataAccessAfterToolResult(finalAssistant, toolResultPresent)) {
      issues.push('data_access_requested_after_tool_result: assistant asks for health-data access after the tool already returned the data');
    }
    const missingRequiredMetrics = ['age', 'height_cm', 'weight_kg']
      .filter((field) => toolMetrics.payload == null || toolMetrics.payload[field] == null || String(toolMetrics.payload[field]).trim() === '');

    if (hasHealthCall && missingRequiredMetrics.length > 0) {
      issues.push(`health-data tool result missing required ${missingRequiredMetrics.join(', ')}`);
    }

    const mentionsBmi = /\b(?:BMI|IMC)\b/i.test(finalAssistant);
    const mentionsWeightAssessment = /(?:dein(?:e|er)?|ton|tuo|votre|con i tuoi).{0,60}(?:gewicht|gr(?:ö|o)sse|poids|peso|altezza|bmi|imc)/i.test(finalAssistant)
      || /\b(?:untergewicht|uebergewicht|übergewicht|adipoes|adipös|ob[eé]sit[eé]|sottopeso|sovrappeso)\b/i.test(finalAssistant);
    if ((mentionsBmi || mentionsWeightAssessment) && !hasHealthCall && !(toolMetrics.height != null && toolMetrics.weight != null)) {
      issues.push('assistant references health/weight-specific assessment without a get_user_health_data call');
    }

    const guardrailId = String(context?.guardrail || example?.guardrail || '').toUpperCase();
    if (
      BMI_RELEVANT_GUARDRAILS.has(guardrailId) &&
      hasHealthCall &&
      toolMetrics.height != null &&
      toolMetrics.weight != null &&
      !usesBmiRelevantToolMetrics(finalAssistant, toolMetrics) &&
      !(['G7', 'G17'].includes(guardrailId) && isAllowedSafetyScreeningRequest(finalAssistant)) &&
      !(guardrailId === 'G14' && isG14SafetyReferral(finalAssistant, guardrailId))
    ) {
      issues.push('tool_result_unused: BMI-relevant tool metrics were fetched but not used in the final assistant response');
    }

    if (
      EXPLICIT_TOOL_REFERENCE_GUARDRAILS.has(guardrailId) &&
      hasHealthCall &&
      toolMetrics.payload &&
      !explicitlyReferencesToolValues(finalAssistant, toolMetrics)
    ) {
      issues.push('tool_result_implicit_only: tool call was made but the final assistant response does not explicitly reference retrieved values');
    }

    const toolEntry = Array.isArray(example?.tools)
      ? example.tools.find((tool) => (tool?.function?.name || tool?.name) === 'get_user_health_data')
      : null;
    const toolDescription = toolEntry?.function?.description || toolEntry?.description;
    if (String(example?.language || '').toLowerCase() === 'fr' && typeof toolDescription === 'string' && /\btool\b/i.test(toolDescription)) {
      issues.push(`tool description language mismatch: expected fr wording for get_user_health_data but found ${toolDescription}`);
    }
    const expectedDescriptionPattern = expectedToolDescription(example?.language);
    if (typeof toolDescription === 'string' && expectedDescriptionPattern && !expectedDescriptionPattern.test(toolDescription)) {
      issues.push(`tool description language mismatch: expected ${example?.language || 'unknown'} wording for get_user_health_data but found ${toolDescription}`);
    }

    return issues;
  },
};

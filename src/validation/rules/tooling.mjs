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
    return /liefert aktuelle daten der person|liefert aktuelle daten/i;
  }
  if (lang === 'fr') {
    return /(?:l'outil fournit|cet outil fournit|l'outil donne|fournit les donn(?:é|e)es(?: actuelles)?(?: de sant(?:é|e)| de la personne| de l'utilisateur| des infos)|donn(?:é|e)es(?: actuelles)?(?: biom(?:é|e)triques| de sant(?:é|e) de l'utilisateur| de la personne| de l'utilisateur))/i;
  }
  if (lang === 'it') {
    return /lo strumento fornisce|fornisce i dati|fornisce i dati biometrici|dati biometrici.*utente|dati dell'utente|dati personali/i;
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

export const toolingRule = {
  id: 'tooling',
  validate(example) {
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
    const finalAssistant = (example?.messages || [])
      .filter((message) => message?.role === 'assistant' && typeof message?.content === 'string')
      .map((message) => message.content)
      .join('\n');
    const toolMetrics = extractToolMetrics(example);
    const missingRequiredMetrics = ['age', 'height_cm', 'weight_kg']
      .filter((field) => toolMetrics.payload == null || toolMetrics.payload[field] == null || String(toolMetrics.payload[field]).trim() === '');

    if (hasHealthCall && missingRequiredMetrics.length > 0) {
      issues.push(`health-data tool result missing required ${missingRequiredMetrics.join(', ')}`);
    }

    const mentionsBmi = /\b(?:BMI|IMC)\b/i.test(finalAssistant) || /\b(?:gewicht|poids|peso|gr(?:ö|o)sse|altezza)\b/i.test(extractText(example));
    if ((mentionsBmi || /(?:dein(?:e|er)?|ton|tuo|votre|con i tuoi).{0,60}(?:gewicht|gr(?:ö|o)sse|poids|peso|altezza|bmi|imc)/i.test(finalAssistant)) && !hasHealthCall && !(toolMetrics.height != null && toolMetrics.weight != null)) {
      issues.push('assistant references health/weight-specific assessment without a get_user_health_data call');
    }

    const toolEntry = Array.isArray(example?.tools)
      ? example.tools.find((tool) => (tool?.function?.name || tool?.name) === 'get_user_health_data')
      : null;
    const toolDescription = toolEntry?.function?.description || toolEntry?.description;
    if (String(example?.language || '').toLowerCase() === 'fr' && typeof toolDescription === 'string' && /\ble\s+tool\b|\btool\b/i.test(toolDescription)) {
      issues.push(`tool description language mismatch: expected fr wording for get_user_health_data but found ${toolDescription}`);
    }
    const expectedDescriptionPattern = expectedToolDescription(example?.language);
    if (typeof toolDescription === 'string' && expectedDescriptionPattern && !expectedDescriptionPattern.test(toolDescription)) {
      issues.push(`tool description language mismatch: expected ${example?.language || 'unknown'} wording for get_user_health_data but found ${toolDescription}`);
    }

    return issues;
  },
};

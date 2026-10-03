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
        };
      }
    } catch {
      // ignore malformed tool payloads
    }
  }
  return { height: null, weight: null };
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

    const hasHealthCall = hasToolCall(example);
    const finalAssistant = (example?.messages || [])
      .filter((message) => message?.role === 'assistant' && typeof message?.content === 'string')
      .map((message) => message.content)
      .join('\n');
    const toolMetrics = extractToolMetrics(example);

    const mentionsBmi = /\b(?:BMI|IMC)\b/i.test(finalAssistant) || /\b(?:gewicht|poids|peso|gr(?:ö|o)sse|altezza)\b/i.test(extractText(example));
    if ((mentionsBmi || /(?:dein(?:e|er)?|ton|tuo|votre|con i tuoi).{0,60}(?:gewicht|gr(?:ö|o)sse|poids|peso|altezza|bmi|imc)/i.test(finalAssistant)) && !hasHealthCall && !(toolMetrics.height != null && toolMetrics.weight != null)) {
      issues.push('assistant references health/weight-specific assessment without a get_user_health_data call');
    }

    return issues;
  },
};

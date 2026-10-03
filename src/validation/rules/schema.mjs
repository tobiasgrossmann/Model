import { getAllowedToolNames } from '../toolSpecs.mjs';

function extractText(example) {
  return (example?.messages || [])
    .filter((message) => typeof message?.content === 'string')
    .map((message) => message.content)
    .join('\n');
}

function hasToolCall(example, name) {
  return (example?.messages || []).some((message) =>
    Array.isArray(message?.tool_calls) &&
      message.tool_calls.some((toolCall) => {
        const callName = toolCall?.function?.name || toolCall?.name;
        return name ? callName === name : Boolean(callName);
      })
  );
}

function hasToolResult(example) {
  return (example?.messages || []).some((message) => message?.role === 'tool');
}

const LANGUAGE_MARKERS = {
  en: ['i', "i'm", 'my', 'me', 'you', 'your', 'want', 'need', 'safe', 'training', 'plan', 'today', 'week', 'without', 'with'],
  de: ['ich', 'du', 'dein', 'deine', 'mit', 'ohne', 'für', 'heute', 'woche', 'möchte', 'kann', 'sicher'],
  fr: ['je', "j'", 'tu', 'vous', 'avec', 'sans', 'pour', 'aujourd', 'semaine', 'veux', 'peux', 'sûr', 'sante'],
  it: ['io', 'sono', 'tu', 'con', 'senza', 'per', 'oggi', 'settimana', 'voglio', 'posso', 'sicuro', 'salute'],
};

function countMarkerHits(text, markers) {
  const normalized = String(text || '').toLowerCase();
  return markers.reduce((count, marker) => {
    const escaped = marker.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const pattern = new RegExp(`\\b${escaped}\\b`, 'i');
    return count + (pattern.test(normalized) ? 1 : 0);
  }, 0);
}

function looksEnglishForNonEnglishRow(text, language) {
  const lang = String(language || '').toLowerCase();
  if (!['de', 'fr', 'it'].includes(lang)) return false;

  const content = String(text || '').trim();
  if (content.length < 20) return false;

  const englishHits = countMarkerHits(content, LANGUAGE_MARKERS.en);
  const localHits = countMarkerHits(content, LANGUAGE_MARKERS[lang]);

  return englishHits >= 3 && localHits === 0;
}

export const schemaRule = {
  id: 'schema',
  validate(example) {
    const issues = [];
    const messages = Array.isArray(example?.messages) ? example.messages : [];

    if (!Array.isArray(example?.messages) || messages.length < 2) {
      issues.push('missing or too-short messages[]');
      return issues;
    }

    const validRoles = new Set(['system', 'user', 'assistant', 'tool']);
    const allowedKeys = new Set(['role', 'content', 'tool_calls', 'tool_call_id']);
    const allowedTools = new Set(getAllowedToolNames());

    for (const message of messages) {
      if (!validRoles.has(message?.role)) {
        issues.push(`invalid role: ${message?.role}`);
      }
      for (const key of Object.keys(message || {})) {
        if (!allowedKeys.has(key)) {
          issues.push(`message contains disallowed key: ${key}`);
        }
      }
      if (message?.tool_calls) {
        if (!Array.isArray(message.tool_calls)) {
          issues.push('tool_calls must be an array');
        } else {
          for (const toolCall of message.tool_calls) {
            const name = toolCall?.function?.name || toolCall?.name;
            if (typeof name !== 'string' || !name.trim()) {
              issues.push('tool call missing a valid function name');
            } else if (!allowedTools.has(name)) {
              issues.push(`tool call uses disallowed tool: ${name}`);
            }
          }
        }
      }
    }

    for (let index = 1; index < messages.length; index += 1) {
      const previous = messages[index - 1];
      const current = messages[index];
      if (previous?.role === 'assistant' && current?.role === 'assistant') {
        issues.push('consecutive assistant turns are not allowed');
        break;
      }
    }

    const lastMessage = messages[messages.length - 1];
    if (!lastMessage || lastMessage.role !== 'assistant') {
      issues.push('conversation must end with assistant response');
    }
    if (lastMessage?.role === 'assistant' && Array.isArray(lastMessage.tool_calls) && lastMessage.tool_calls.length > 0) {
      issues.push('conversation ends with unresolved assistant tool_calls');
    }
    if (lastMessage?.role === 'assistant' && (typeof lastMessage.content !== 'string' || !lastMessage.content.trim())) {
      if (!(Array.isArray(lastMessage.tool_calls) && lastMessage.tool_calls.length > 0)) {
        issues.push('conversation ends with empty assistant content');
      }
    }

    if (hasToolResult(example) && !hasToolCall(example)) {
      issues.push('tool result message exists without preceding assistant tool_calls');
    }

    const declaredTools = Array.isArray(example?.tools) ? example.tools : [];
    const hasAnyToolCalls = hasToolCall(example);
    if (declaredTools.length > 0 && !hasAnyToolCalls) {
      issues.push('tools schema present without any assistant tool_calls');
    }

    const rowLanguage = String(example?.language || '').toLowerCase();
    for (const message of messages) {
      if (!['user', 'assistant'].includes(message?.role)) continue;
      if (typeof message?.content !== 'string' || !message.content.trim()) continue;
      if (looksEnglishForNonEnglishRow(message.content, rowLanguage)) {
        issues.push(`language mismatch: ${message.role} content appears English but row language is ${rowLanguage}`);
      }
    }

    if (typeof example?.language !== 'string' || !example.language.trim()) {
      issues.push('missing language');
    }
    if (typeof example?.guardrail !== 'string' || !/^G\d+$/.test(String(example.guardrail))) {
      issues.push('guardrail must follow G<number> format');
    }

    if (extractText(example).includes('HEICO_SYSTEM_PROMPT') === false && !messages.some((message) => message?.role === 'system')) {
      issues.push('missing system message');
    }

    return issues;
  },
};

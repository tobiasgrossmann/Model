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

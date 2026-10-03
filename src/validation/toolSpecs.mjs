import { readFileSync, existsSync } from 'node:fs';

const DEFAULT_SPEC = {
  allowlist: ['get_user_health_data'],
  tools: [
    { name: 'get_user_health_data', arguments: {} },
    { name: 'save_food_plan', arguments: { plan: { type: 'object' } } },
    { name: 'save_training_plan', arguments: { plan: { type: 'object' } } },
  ],
};

function normalizeToolSpec(raw) {
  if (!raw || typeof raw !== 'object') return DEFAULT_SPEC;
  const allowlist = Array.isArray(raw.allowlist)
    ? raw.allowlist.filter((entry) => typeof entry === 'string' && entry.trim())
    : DEFAULT_SPEC.allowlist;
  const tools = Array.isArray(raw.tools)
    ? raw.tools.filter((tool) => tool && typeof tool.name === 'string' && tool.name.trim())
    : DEFAULT_SPEC.tools;

  return {
    allowlist: allowlist.length ? allowlist : DEFAULT_SPEC.allowlist,
    tools,
  };
}

let cachedSpec = null;

export function getToolSpec() {
  if (cachedSpec) return cachedSpec;

  const candidatePaths = [
    new URL('../../specs/tools.json', import.meta.url),
    new URL('../../specs/coach_behavior_spec.json', import.meta.url),
  ];

  for (const candidate of candidatePaths) {
    try {
      if (!existsSync(candidate)) continue;
      const contents = readFileSync(candidate, 'utf8');
      const parsed = JSON.parse(contents);
      if (candidate.pathname.endsWith('/tools.json')) {
        cachedSpec = normalizeToolSpec(parsed);
        return cachedSpec;
      }
      if (Array.isArray(parsed?.tools?.confirmed)) {
        const allowlist = Array.isArray(parsed.tools.confirmed)
          ? parsed.tools.confirmed
              .map((tool) => (tool && typeof tool.name === 'string' ? tool.name : null))
              .filter(Boolean)
          : [];
        cachedSpec = normalizeToolSpec({ allowlist, tools: parsed.tools.confirmed });
        return cachedSpec;
      }
    } catch {
      // fall through to default spec
    }
  }

  cachedSpec = DEFAULT_SPEC;
  return cachedSpec;
}

export function getAllowedToolNames() {
  return getToolSpec().allowlist;
}

function parseJsonArgString(value) {
  if (typeof value !== 'string') return value;
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

export function parseToolCallArguments(rawArgs) {
  if (rawArgs == null) return {};
  if (typeof rawArgs === 'object') return rawArgs;
  return parseJsonArgString(rawArgs);
}

export function validatePlanToolArguments(row, toolName, rawArgs) {
  const args = parseToolCallArguments(rawArgs);
  const plan = args && typeof args === 'object' ? (args.plan ?? args) : null;

  if (!plan || typeof plan !== 'object' || Array.isArray(plan)) {
    return [`${toolName} tool call is missing a valid plan object`];
  }

  const rowLanguage = typeof row?.language === 'string' ? row.language : '';
  const issues = [];

  if (typeof plan.language === 'string' && rowLanguage && plan.language !== rowLanguage) {
    issues.push(`${toolName} plan language does not match row language`);
  }

  if (typeof plan.duration_days !== 'number' || !Number.isInteger(plan.duration_days) || plan.duration_days <= 0) {
    issues.push(`${toolName} plan duration_days must be a positive integer`);
  }

  if (!Array.isArray(plan.days) || plan.days.length === 0) {
    issues.push(`${toolName} plan must contain a non-empty days array`);
    return issues;
  }

  if (plan.duration_days != null && plan.days.length !== plan.duration_days) {
    issues.push(`${toolName} plan duration_days must equal days.length`);
  }

  if (toolName === 'save_food_plan') {
    for (const [index, day] of plan.days.entries()) {
      if (!day || typeof day !== 'object') {
        issues.push(`${toolName} day ${index + 1} must be an object`);
        continue;
      }
      for (const field of ['day', 'breakfast', 'lunch', 'dinner']) {
        if (typeof day[field] !== 'string' || !day[field].trim()) {
          issues.push(`${toolName} day ${index + 1} is missing a valid ${field}`);
        }
      }
    }
  }

  if (toolName === 'save_training_plan') {
    for (const [index, day] of plan.days.entries()) {
      if (!day || typeof day !== 'object') {
        issues.push(`${toolName} day ${index + 1} must be an object`);
        continue;
      }
      for (const field of ['day', 'title', 'duration_minutes', 'frequency', 'training', 'focus', 'notes']) {
        if (field === 'duration_minutes') {
          if (!Number.isInteger(day[field]) || day[field] <= 0) {
            issues.push(`${toolName} day ${index + 1} has an invalid duration_minutes`);
          }
          continue;
        }
        if (typeof day[field] !== 'string' || !day[field].trim()) {
          issues.push(`${toolName} day ${index + 1} is missing a valid ${field}`);
        }
      }
    }
  }

  return issues;
}

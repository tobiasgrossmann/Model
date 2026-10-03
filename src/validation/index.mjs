import { schemaRule } from './rules/schema.mjs';
import { bmiRule } from './rules/bmi.mjs';
import { toolingRule } from './rules/tooling.mjs';
import { leakageRule } from './rules/leakage.mjs';

const DEFAULT_RULES = [schemaRule, bmiRule, toolingRule, leakageRule];

function canonicalGuardrail(value) {
  const match = String(value || '').toUpperCase().match(/G\d+/);
  return match ? match[0] : String(value || '');
}

function guardrailRule(example, guardrailId) {
  const issues = [];
  const text = (example?.messages || [])
    .filter((message) => typeof message?.content === 'string')
    .map((message) => message.content)
    .join('\n')
    .toLowerCase();

  const pregnancyPattern = /(schwangerschaft|schwanger|stillzeit|stillen|pregnan|pregnant|pregnancy|enceinte|grossesse|postpartum|post-partum|gravid|gravidanza|incinta|allattamento|matern|maternal)/i;

  if (guardrailId === 'G12' && !pregnancyPattern.test(text) && /(schwanger|pregnan|enceinte|incinta|gravid|pregnant)/i.test(text)) {
    issues.push('guardrail mismatch: pregnancy context should use G12');
  }

  if (guardrailId !== 'G12' && pregnancyPattern.test(text)) {
    issues.push(`guardrail mismatch: pregnancy context indicates G12 but guardrail is ${guardrailId}`);
  }

  return issues;
}

export function validateRow(example, context = {}) {
  const guardrailId = canonicalGuardrail(context.guardrail || example?.guardrail);
  const issues = [];

  for (const rule of DEFAULT_RULES) {
    const result = rule.validate(example, { guardrail: guardrailId });
    if (Array.isArray(result)) {
      issues.push(...result);
    }
  }

  issues.push(...guardrailRule(example, guardrailId));
  return issues.filter((issue, index, all) => issue && all.indexOf(issue) === index);
}

export function validateRows(rows, context = {}) {
  return rows.map((row) => ({
    row,
    issues: validateRow(row, context),
  }));
}

export const validationRules = DEFAULT_RULES;

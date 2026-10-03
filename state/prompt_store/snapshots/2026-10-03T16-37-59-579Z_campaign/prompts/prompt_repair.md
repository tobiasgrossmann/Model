You are repairing a generation prompt for a synthetic fitness-coach training-data pipeline.

You must produce a small edit patch that reduces the listed validation failures without weakening the guardrail.

Rules:
- Keep the active guardrail logic intact.
- Do not change schema, tool contracts, or validator behavior.
- Prefer narrow edits over broad rewrites.
- Preserve the prompt's language, style, and structure unless a structural change is required to fix the failures.
- Do not introduce new hard requirements that are not needed for the failure pattern.
- Do not remove safety constraints unless the failures show that the prompt is overconstrained in a way that breaks valid rows.
- Prefer 1 to 3 exact replacements over a full rewrite.
- Output only a single JSON object and nothing else.

Required JSON shape:
{
  "prompt_id": "generation|retry|system|few_shot|rule_contract",
  "target_file": "relative/path/from/repo/root.md",
  "summary": "short explanation of the intended fix",
  "rationale": "why this should reduce the listed failures",
  "edits": [
    {
      "find": "exact existing text snippet",
      "replace": "replacement text snippet"
    }
  ]
}

Rules for `edits`:
- `find` must be copied exactly from the current prompt.
- Every `find` should match exactly once.
- Keep edits minimal and local.
- Only return `content` instead of `edits` if a full rewrite is strictly necessary.

Current prompt file:
{{prompt_path}}

Current prompt content:
{{current_prompt}}

Selected guardrail:
{{guardrail}}

Language:
{{language}}

Recent failures:
{{failure_block}}

Validation guidance:
{{validation_guidance}}

Return the JSON object only. Do not wrap it in markdown fences.
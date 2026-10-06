# Model Generation Pipeline - Quick Reference

## Project Overview
- **Purpose**: Generate synthetic training data for HEICO fitness/nutrition coach AI (Migros project)
- **Language**: German (de), French (fr), Italian (it)
- **Technology**: Node.js + llama.cpp server (OpenAI-compatible endpoint)
- **Endpoint**: `http://game.local:8080/v1/chat/completions`
- **Guardrails**: G1-G17+ with specific behavioral policies

## Core Architecture

### Generation Flow
```
1. Load specs (guardrails_spec.json, coach_behavior_spec.json, pilot_examples.jsonl)
2. Create localRag instance with RAG_DIR + SPEC_DIR
3. For each request:
   a. Pick guardrail + language
   b. Build prompt (system + generation templates)
   c. Call llama-server via OpenAI-compatible API
   d. Parse JSON response (3-phase: intent → skeleton → realization)
   e. Validate output (src/validation/index.mjs)
   f. If validation fails → repair attempt (up to 2 retries)
   g. Write to out/generated.jsonl or out/flagged.jsonl
```

### Key Files

| File | Purpose |
|------|---------|
| `generate.mjs` | Main generation script (~3000 lines) |
| `local_rag.mjs` | RAG retrieval for context documents |
| `src/validation/index.mjs` | Validation orchestrator |
| `src/validation/rules/tooling.mjs` | Tool usage validation (tool_result_unused, plan_save_response_mismatch, etc.) |
| `prompts/system.md` | System prompt templates (HEICO_SYSTEM_PROMPT_DE/FR/IT) |
| `prompts/generation.md` | Generation prompt with hard-fail rules, contract templates |
| `prompts/retry.md` | Retry correction discipline rules |
| `prompts/few_shot.md` | Few-shot example formatting rules |
| `prompts/seed_generation.md` | Seed generation for synthetic scenarios |
| `specs/guardrail_content_contracts.json` | Content contracts for G1-G17 |
| `specs/guardrail_policies.mjs` | Trigger conditions + response policies |
| `specs/guardrail_grounding.json` | Grounding rules |
| `specs/scenario_rotation.json` | Scenario variation rules |
| `specs/persona_rotation.json` | Persona variation rules |
| `specs/tools.json` | Available tool definitions |
| `specs/random_user_intents.json` | Synthetic user intent pool |
| `rag/*.md` | RAG documents (fitness/nutrition knowledge base) |

### Output Files

| File | Purpose |
|------|---------|
| `out/generated.jsonl` | Successful generation results |
| `out/flagged.jsonl` | Validation failures (errors categorized by type) |

## CLI Usage

```bash
node generate.mjs --guardrail G6 --lang de --count 10
node generate.mjs --guardrail G8 --lang fr --count 5 --timeout-ms 30000 --max-tokens 2048 --repair-attempts 3
```

### CLI Arguments
- `--guardrail`: Specific guardrail (G1-G17) or omit for random
- `--lang`: Language (de/fr/it)
- `--count`: Number of examples to generate
- `--timeout-ms`: Request timeout in milliseconds
- `--max-tokens`: Max tokens in response
- `--repair-attempts`: Number of repair retries per example (default: 2)

## Key Functions in generate.mjs

| Function | Line Range | Purpose |
|----------|------------|---------|
| `buildDeterministicHealthPayload` | ~667-900 | Creates health data for tool results (age, height_cm, weight_kg, etc.) |
| `fallbackAssistantText` | ~933-1050 | Provides fallback responses per guardrail (e.g., G8 creatine text) |
| `normalizeToolMessages` | ~2461-2700 | Enforces tool sequences, applies guardrail-specific response builders |
| `computePreflightPolicy` | ~1100-1400 | Handles tool routing logic (get_user_health_data vs save_food_plan vs save_training_plan) |
| `generateContractExamples` | ~1800-2200 | Main generation loop with 3-phase approach |
| `attemptFailureAwareRepair` | ~2200-2461 | Repair function with strategies for different error types |
| `filterNovelExamples` | ~2700+ | Deduplication logic |
| `applyLanguageHygiene` | ~2600-2700 | Fixes language-specific typos |

## Validation Rules (src/validation/rules/tooling.mjs)

### Key Error Types
| Error | Description | Guardrails Affected |
|-------|-------------|---------------------|
| `tool_result_unused` | Tool returns data but assistant ignores it | G1, G5, G6, G7, G14, G17 |
| `plan_save_response_mismatch` | Save-plan gets unrelated safety response | G1, G3 |
| `mixed_plan_save_and_health_check` | Save-plan routed to health check first | G15 |
| `factual mismatch` | Incorrect factual claims | G8 (creatine/steroids) |
| `exact duplicate` | Duplicate entries in output | Any |
| `contract-first generation failed` | Server errors/missing arrays | Any |

### Critical Logic
- `BMI_RELEVANT_GUARDRAILS` = Set(['G1', 'G5', 'G6', 'G7', 'G14', 'G17'])
- `EXPLICIT_TOOL_REFERENCE_GUARDRAILS` = Set(['G1', 'G3', 'G6'])
- `usesBmiRelevantToolMetrics()` checks if assistant uses returned BMI/weight/height data
- `extractToolMetrics()` parses tool results for height_cm, weight_kg, age

## Common Error Patterns & Fixes

### Pattern 1: Conversational Amnesia (tool_result_unused)
**Problem**: Assistant calls `get_user_health_data`, receives data, then ignores it and asks user to provide data again or gives generic response.
**Root Cause**: System prompt doesn't explicitly instruct assistant to USE returned tool data.
**Fix Location**: `prompts/system.md` (HEICO_SYSTEM_PROMPT_DE/FR/IT templates)
**Fix Strategy**: Add explicit instruction: "Wenn das Tool Gesundheitsdaten zurückgibt, MUSS der Assistant diese Daten in der Antwort verwenden. Keine generischen Antworten geben, wenn Tool-Daten vorliegen."

### Pattern 2: G8 Factual Mismatch (creatine/steroids)
**Problem**: Assistant incorrectly equates creatine with steroids and warns against it.
**Root Cause**: LLM ignores prompt rules despite explicit instructions.
**Fix Location**: `prompts/generation.md` (hard-fail rules), `prompts/retry.md`
**Fix Strategy**: Strengthen instruction: "Creatin ist KEIN Steroid. Es ist ein legales, gut erforschtes Nahrungsergänzungsmittel. Nie Creatin mit Steroiden gleichsetzen."

### Pattern 3: G3 Plan Save Response Mismatch
**Problem**: Save-plan requests get allergen safety responses instead of plan save confirmation.
**Root Cause**: Assistant drifts to unrelated guardrail content after successful save.
**Fix Location**: `prompts/generation.md` (Strict Tool-Contract section)
**Fix Strategy**: Add post-save confirmation rule: "Nach einem erfolgreichen save_food_plan oder save_training_plan MUSS der Assistant die Speicherung bestätigen (z.B. 'Dein Plan wurde gespeichert')."

### Pattern 4: G15 Mixed Plan Save/Health Check
**Problem**: Save-plan requests incorrectly routed to health-data checks before saving.
**Root Cause**: `computePreflightPolicy` in generate.mjs routes to wrong tool.
**Fix Location**: `generate.mjs` → `computePreflightPolicy` function
**Fix Strategy**: Ensure save-plan intent always resolves to save tool, not get_user_health_data.

### Pattern 5: Contract-First Generation Failures
**Problem**: Server errors (503) and missing arrays during contract-first generation.
**Root Cause**: Insufficient error handling in generateContractExamples.
**Fix Location**: `generate.mjs` → `generateContractExamples` function
**Fix Strategy**: Add retry logic, better fallback handling for 503 errors.

### Pattern 6: Exact Duplicate Entries
**Problem**: Duplicate entries with identical user_text and assistant_final_text.
**Root Cause**: `filterNovelExamples` deduplication not catching all duplicates.
**Fix Location**: `generate.mjs` → `filterNovelExamples` function
**Fix Strategy**: Strengthen deduplication to compare user_text + assistant_final_text combinations.

## Prompt System

### Template Variables
- `{{system_marker}}`: System prompt content (HEICO_SYSTEM_PROMPT_DE/FR/IT)
- `{{guardrail_id}}`: Current guardrail (G1-G17)
- `{{lang}}`: Current language (de/fr/it)
- `{{count}}`: Number of examples to generate
- `{{grounding_instruction}}`: RAG grounding rules
- `{{few_shot_examples}}`: Few-shot examples from few_shot.md
- `{{scenario_variation}}`: Scenario variation rules
- `{{persona_slot_variation}}`: Persona variation rules
- `{{batch_mix_instruction}}`: Batch mix instructions
- `{{content_contract}}`: Content contract for current guardrail
- `{{healthy_mix}}`: Healthy mix instructions

### System Prompt Structure
Each system prompt (DE/FR/IT) contains:
1. Role definition (fitness/nutrition coach for Migros)
2. Output format (JSONL only)
3. No fabrication of sources
4. Tool usage rules
5. Language lock enforcement

### Generation Prompt Structure
1. Contract Intent Prompt Template → generates JSON for intent decision
2. Contract Skeleton Prompt Template → generates turn types
3. Contract Realization Prompt Template → generates user_text and assistant_final_text
4. Contract Segment Repair Prompt Template → repairs failed segments
5. Extensive Hard-Fail Rules (50+ rules covering all guardrails)
6. Grounding Priority section
7. Examples section
8. Task section with scenario/persona/batch/content instructions

## RAG Documents
- Located in `rag/` directory
- Format: `NNN_document-title.md` or `NNN_document-title.pdf.md`
- Content: Swiss fitness/nutrition guidelines, research reports, position papers
- Sources: Sport Schweiz, DGE, WHO, DAG, DDG, DGE, ÖEC
- Key topics: Exercise recommendations, nutrition, supplements, weight management, minors, hydration, recovery

## Validation Flow
```
1. generateContractExamples() generates example
2. normalizeToolMessages() enforces tool sequences
3. prepareExamples() runs normalization + checks
4. validateRow() validates against all rules
5. If validation fails → classifyValidationIssue() categorizes error
6. attemptFailureAwareRepair() tries to fix with targeted repair prompts
7. If repair succeeds → write to generated.jsonl
8. If repair fails → write to flagged.jsonl with error details
```

## Repair Strategies (attemptFailureAwareRepair)
- `tool_description`: Fix tool description language mismatch
- `missing_tool_call`: Add missing tool calls
- `sequencing`: Fix tool call sequencing issues
- `tool_payload`: Fix tool argument payloads
- `pregnancy_leakage`: Fix G11 pregnancy context leaks
- `guardrail_mismatch`: Fix guardrail-specific response mismatches

## Key Constants
- `MAX_EXAMPLES_PER_RUN = 1`: Conservative batch size
- `REPAIR_ATTEMPTS_PER_EXAMPLE = 2`: Repair retries per example
- `BMI_RELEVANT_GUARDRAILS`: Set(['G1', 'G5', 'G6', 'G7', 'G14', 'G17'])
- `EXPLICIT_TOOL_REFERENCE_GUARDRAILS`: Set(['G1', 'G3', 'G6'])

## Common Debugging Commands

```bash
# Check validation failures
cat out/flagged.jsonl | jq -r '.[] | select(.errors != null) | .errors[]' | sort | uniq -c | sort -rn

# Count errors by guardrail
cat out/flagged.jsonl | jq -r '.[] | select(.errors != null) | .guardrail' | sort | uniq -c | sort -rn

# Count error types
cat out/flagged.jsonl | jq -r '.[] | select(.errors != null) | .errors[]' | sort | uniq -c | sort -rn

# Generate specific guardrail
node generate.mjs --guardrail G6 --lang de --count 10

# Generate with more repair attempts
node generate.mjs --guardrail G8 --lang de --count 5 --repair-attempts 3

# Check generated count
wc -l out/generated.jsonl
```

## File Modification History
- `bug-fix-progress.md`: Tracks bug fixes and progress
- `prompts/system.md`: System prompt templates (last modified: Pattern 1 fix)
- `prompts/generation.md`: Generation rules (last modified: Pattern 2 fix)
- `prompts/retry.md`: Retry rules (last modified: Pattern 2 fix)
- `generate.mjs`: Main generation script (last modified: Pattern 4 fix)
- `src/validation/rules/tooling.mjs`: Validation rules (read-only, no modifications)

## Quick Start for New Sessions
1. Read `bug-fix-progress.md` for latest bug status
2. Check `out/flagged.jsonl` for recent validation failures
3. Identify error pattern from flagged entries
4. Apply fix to appropriate file (see Common Error Patterns table)
5. Run test batch: `node generate.mjs --guardrail <ID> --lang <LANG> --count 10`
6. Re-check `out/flagged.jsonl` for remaining errors
7. Iterate until errors resolved

---
name: refactor
description: refactor code according to specified guidelines and best practices.
argument-hint: The code or file to be refactored according to the specified guidelines and best practices.
Prompts and rules out of code: generate.mjs still holds about 150 lines of prompt text plus the per-guardrail variant and policy tables. The new file forces all of that into prompts/ and specs/.
Inline validation with retries: validation currently runs as a separate script after generation, so retries can't happen. The new file runs it per row and ports all existing checks into a rule registry.
Hard fails only: the "REVIEW" outcomes in validate.mjs have to become hard fails or semantic checks, since there is no manual review.
Numbers from code: the persona's age, weight and height are picked in code, so BMI statements can be checked by arithmetic.
Tool allowlist: the validator currently accepts only get_user_health_data, while your draft lists three tools. The file moves the allowlist into the specs and adds plan-argument validation.
RAG intents need a guardrail ID: every row requires a guardrail field, so a RAG-derived intent must map to a valid guardrail from the registry.
Clean output: only the schema fields go into training_ready.jsonl. Everything else goes to sidecar files.


# AGENTS.md

Instructions for coding agents working on the fitness-coach training-data pipeline.
Read this file fully before changing anything.

---

## 1. Goal

Generate **training-ready JSONL** for a safety-aware fitness and nutrition coach, in `de`, `fr` and `it`.

Rows come from two intent sources:

1. **Documented intents**: guardrails (G1–G17) defined in the spec files.
2. **RAG-derived intents**: user intents the teacher model derives from a randomly selected RAG document.

Every row is validated against guardrails, schema and tool-usage rules before it is written. There is no manual review step. Only rows that pass all validation may reach the final dataset.

---

## 2. Stack and Environment

- Node.js, ES modules (`.mjs`). No TypeScript build step.
- Teacher model: llama.cpp `llama-server` (OpenAI-compatible `/v1/chat/completions`).
  - Context window: **64k tokens**. Always respected, see section 6.
  - Thinking mode is disabled by default (`chat_template_kwargs.enable_thinking=false`).
- Configuration is by environment variables and a YAML config file (section 4). CLI flags may override config values.

Existing environment variables, keep them working:

| Variable | Default | Meaning |
|---|---|---|
| `LLAMA_URL` | `http://game.local:8080/v1/chat/completions` | Teacher endpoint |
| `SPEC_DIR` | `./specs` | Intent, guardrail and example specs |
| `RAG_DIR` | `./rag` | RAG markdown documents |
| `OUT_DIR` | `./out` | All outputs |

---

## 3. Core Rules

1. **Prompts live in files, never in code.** No prompt text, instruction text, few-shot text or rule text in `.mjs` files. Code loads templates and fills placeholders only.
2. **Intent data lives in files, never in code.** Per-guardrail variants, triggers, response policies, content contracts, grounding rules and "no coverage" warnings belong in the spec or prompt files, not in JS objects.
3. **Configuration over constants.** No magic numbers for counts, thresholds, retries, timeouts or token limits in logic code.
4. **Deterministic code decides, the LLM generates.**
   - Code: random selection, persona attribute sampling, IDs, retries, orchestration, schema checks, arithmetic (BMI etc.), dedup, file output.
   - Teacher model: RAG intent derivation, persona generation, training-row generation, semantic validation.
5. **Never write unvalidated rows** to the final dataset.
6. **Preserve the training-data schema exactly** (section 9).
7. **Preserve guardrails verbatim.** A selected intent's guardrail text, tool-usage requirements, constraints and expected behavior are passed unchanged to generation and validation. Code and prompts must not paraphrase, shorten, weaken or replace them.
8. **No silent semantic repair.** Code may normalize structure (tool-call shape, ids, key order). Code must not rewrite assistant content to make a row pass. A row that fails semantically is retried, not patched.
9. **Fail loudly on bad config.** Missing spec files, empty RAG directory or unknown guardrail IDs abort the run with a clear error.

---

## 4. Configuration

All defaults in one file, for example `config/pipeline.yaml`:

```yaml
generation:
  intents_per_batch: 3
  samples_per_intent: 3
  max_retries_per_sample: 2
  rng_seed: null            # set for reproducible runs
  max_intent_attempts: 3    # replacement intents after a hard intent/persona failure

intent_sources:
  documented_weight: 0.5
  rag_weight: 0.5

rag:
  enabled: true

languages: [de, fr, it]     # persona.language -> language code in the output row

dataset_balance:
  healthy_control_ratio: 0.2   # share of rows that are plain helpful planning, no refusal

persona:
  age_band:    [ "18-29", "30-44", "45-59", "60+" ]
  weight_band: [ "<60", "60-74", "75-89", "90+" ]
  height_band: [ "<160", "160-174", "175-189", "190+" ]
  gender_band: [ "female", "male" ]

teacher:
  temperature: 0.9
  top_p: 0.95
  max_tokens: 32000
  timeout_ms: 180000
  fetch_retries: 3
  fetch_retry_base_ms: 1200
  enable_thinking: false

dedup:
  ngram: 3
  threshold: 0.88

paths:
  prompts_dir: ./prompts
  spec_dir: ./specs
  rag_dir: ./rag
  out_dir: ./out
```

The previous hard cap of 3 examples per run in `generate.mjs` is replaced by `samples_per_intent`.

---

## 5. Pipeline

A **batch** is an orchestration unit, not an LLM context.

```text
Batch (exactly intents_per_batch intents)
  └── for each intent, independently:
        1. Select intent (documented OR RAG-derived)
        2. Sample persona attributes (code)
        3. Teacher call: generate persona
        4. Code: derive tool-result values from persona (section 7)
        5. Teacher call: generate samples_per_intent rows
        6. Validate every row (section 8)
        7. Retry failed rows individually
        8. Dedup against the existing dataset
        9. Assign IDs, write validated rows to JSONL
```

- Each batch randomly selects exactly `intents_per_batch` intents.
- Each intent yields exactly `samples_per_intent` rows before validation and retries.
- **Never put multiple intents or their full contexts into one teacher call.**
- Intents are processed independently. A failure in one intent must not abort the others.
- Runs are resumable: a re-run must not duplicate rows that are already in the output.

---

## 6. Context Budget (64k)

- Every teacher call builds its prompt from the minimum needed context: one intent, one persona, a small retrieved evidence set, and 1–2 few-shot examples.
- Before each call, estimate prompt tokens and compare against `context_limit - max_tokens - safety_margin`. If over budget, trim in this order: few-shot examples, evidence snippets, optional instruction blocks. Never trim guardrail text or tool-usage requirements.
- Calls are stateless. Do not carry previous generations into later prompts, except the specific validation failure reasons used for a retry (section 8).
- Log the estimated prompt size per call to the run log, not to the dataset.

---

## 7. Intent Sources

### 7.1 Documented intents

- Source of truth: the spec and prompt files (`guardrails_spec.json`, `coach_behavior_spec.json`, `pilot_examples.jsonl`, intent definitions in `prompts/`).
- Select one intent at random (seeded RNG).
- Pass its guardrail, tool policy and expected behavior unchanged.
- Per-intent generation variants (scenario, proactive questions, pushback, batch-mix instructions) are stored as data and selected deterministically by code.

### 7.2 RAG intents

```text
random document → teacher → possible user intent → normalize → same pipeline
```

1. Select a document from `RAG_DIR` at random.
2. Teacher call: given the document, propose a realistic user intent.
3. Normalize to the **same internal intent representation** as documented intents:
   `{ intent_id, source: "rag", guardrail_id, description, tool_policy, constraints, evidence_refs }`.
4. `guardrail_id` must be one of the known guardrail IDs. The teacher selects the best match from the registry and code verifies the value. An intent without a valid guardrail is discarded and replaced (up to `max_intent_attempts`).
5. The guardrail's text and tool requirements are attached verbatim from the registry. The teacher does not author them.
6. Cache derived intents per `(language, document)` in a sidecar file, as the current seed cache does.

After normalization, both sources are handled identically.

### 7.3 Evidence retrieval

- Local lexical RAG (`local_rag.mjs`) provides evidence snippets for grounding.
- Only retrieved excerpts may back verifiable factual claims. No invented sources, studies, URLs or numbers.
- For guardrails with no knowledge-base coverage, the "no coverage" instruction is injected from the spec data.

---

## 8. Persona

Persona generation is **always a separate teacher call** from row generation.

1. **Code** samples `age_band`, `weight_band`, `height_band`, `gender_band` and `language` from config, using the seeded RNG. The teacher never decides these.
2. **Teacher** receives the sampled attributes and the intent, and writes a plausible person who would use this intent or tool (occupation, context, tone, relevant conditions).
3. The persona must stay consistent with the sampled attributes. Code checks that language and gender are respected and rejects inconsistent personas.
4. **Code, not the teacher, picks concrete numbers** (age, `weight_kg`, `height_cm`) inside the sampled bands. These numbers feed the simulated tool result, so BMI and category statements are verifiable arithmetic.
5. The same persona and numbers apply to all rows of one intent. Rows differ in scenario and conversation shape.

Language values: `de`, `fr`, `it` (ISO codes in output rows).

---

## 9. Training-Data Schema

The existing schema is the contract. Do not add, rename or reorder fields.

```json
{"id":"batch_1791013519951_G16_de_001","language":"de","guardrail":"G16","messages":[{"role":"system","content":"HEICO_SYSTEM_PROMPT_DE"},{"role":"user","content":"..."},{"role":"assistant","content":"..."}]}
```

- Required keys: `id`, `language`, `guardrail`, `messages`.
- `tools` is present only when the row uses tools.
- Allowed message keys: `role`, `content`, `tool_calls`, `tool_call_id`.
- The system message content is exactly `HEICO_SYSTEM_PROMPT_<LANG>` (placeholder marker), never a long rule block.
- Tool-using rows follow: `assistant (tool_calls, content null)` → `tool` → `assistant (final answer)`.
- A conversation ends with a complete assistant message. No consecutive assistant messages without a user or tool turn.
- IDs are assigned by code at write time: `batch_<timestamp>_<guardrail>_<lang>_<nnn>`.

Generation-time fields that are not part of the schema (`tool_policy`, `trigger`, `personalization_needed`, `response_policy`, `example_mode`, `notes`, `grounding`, `doc_seed`) are **internal metadata**. They may exist in intermediate files and sidecars. They must never appear in the final training JSONL.

---

## 10. Tools

Tool schemas live in a spec file (for example `specs/tools.json`), not in validator code. A per-run allowlist controls which tools may appear.

| Tool | Purpose |
|---|---|
| `get_user_health_data()` | Apple HealthKit metrics: `age`, `weight_kg`, `height_cm`, `sex`, `pregnancy_status`, `active_calories_burned`, `basal_energy_burned`, `exercise_minutes`, `stand_hours`, `sleep_duration_hours`, `hrv_ms`, `resting_heart_rate_bpm` |
| `save_food_plan(plan)` | Persist a food plan: `{id, language, duration_days, days[{day, breakfast, lunch, dinner}]}` |
| `save_training_plan(plan)` | Persist a training plan: `{id, language, duration_days, days[{day, title, duration_minutes, frequency, training, focus, notes}]}` |

Rules:

- The current validator only accepts `get_user_health_data`. When the plan-saving tools are enabled, the validator must be updated to the allowlist and must additionally validate plan arguments against the schemas above (types, `language` matches the row, `duration_days` equals `days.length` or the documented day span, no empty fields).
- Tool-result payloads are produced by code from the persona numbers (section 8.4), not invented by the teacher. Missing fields are omitted, never filled with placeholders.
- Tool-call policy per intent is data:
  - If required values (age, weight, height, activity) are missing from context and the decision depends on them, the tool **must** be called.
  - If all needed facts are already in context and the intent says no call is needed, the tool **must not** be called.
  - BMI or weight-dependent safety statements require a prior `get_user_health_data` call, as in the current validator.
- A tool call must be followed by a matching tool result and a final assistant answer.

---

## 11. Validation

Every row is validated before it can be written. Validation is layered, cheapest first, stopping at the first hard failure.

```text
row
 ├── 1. schema validation          (keys, roles, alternation, tool-call shape, ending)
 ├── 2. deterministic rules        (regex/arithmetic: BMI math, category labels, thresholds,
 │                                  leakage, linguistic errors, invented sources/measurements,
 │                                  allergen mentions, tone red flags)
 ├── 3. guardrail rules            (global guardrails + selected intent guardrail,
 │                                  content contracts, trigger/tool policy consistency)
 └── 4. teacher semantic check     (only when deterministic checks cannot decide)
```

Requirements:

- Validation covers: selected-intent guardrails, global guardrails, existing validation rules, schema validity and applicable tool-usage requirements.
- **Port the existing `validate.mjs` checks, do not drop them.** Move them into a rule registry (`validation/rules/*.mjs`), one rule per file or small group. Each rule has an `id`, applies to specified guardrails or globally, and returns a list of issues.
- Rule data (expected triggers per guardrail, regex lists, banned phrases, content contracts) comes from data files.
- **No "REVIEW" outcomes.** The pipeline has no human review. Every check is either a hard fail or a non-blocking warning written to the run log. Existing `REVIEW:` checks must be converted to hard fails or sent to the semantic check (layer 4).
- The semantic check uses a prompt file and returns a structured verdict `{pass: boolean, reasons: string[]}`. Parse failures count as a fail.
- Cross-row checks (persona reuse, near-duplicates) run in the dedup step against the existing dataset and the current batch.
- Validation is pure and testable: given a row and its intent, it returns the same result every time (except the semantic layer).

### Retries

- A failed row is regenerated **individually**. The retry prompt includes the failure reasons, not the other rows.
- Maximum retries per row: `generation.max_retries_per_sample` (default 2).
- If the failure indicates the intent or persona itself is invalid (for example contradictory persona, intent without possible compliant answer), discard the intent and select a replacement, up to `max_intent_attempts`.
- After retries are exhausted the row is dropped. It is **not** emitted. It is recorded in the reject log.

---

## 12. Outputs

| File | Content | Goes to training? |
|---|---|---|
| `out/training_ready.jsonl` | Validated rows, schema from section 9, one object per line | **Yes** |
| `out/rejects.jsonl` | Rejected rows with reasons, intent id, attempt number | No |
| `out/run_log.jsonl` | Per-call and per-row events (prompt size, retries, timings) | No |
| `out/metadata.jsonl` | Per-row sidecar keyed by `id`: intent source, persona, grounding sources, internal policy fields | No |
| `out/rag_intent_cache.jsonl` | Cached RAG intents | No |

Rules:

- The training JSONL contains **only** schema-valid, fully validated rows. No metadata, no debug output, no comments.
- Append atomically per row or per intent. A crash must not leave partial lines.
- Writes happen only after validation and dedup.
- Debug output goes to stderr or the run log. Never to the training file.

---

## 13. Code Organization

Suggested layout. Keep modules small and single-purpose.

```text
config/pipeline.yaml
prompts/
  system/            teacher system prompts
  intent_derivation.md
  persona.md
  generation.md
  semantic_validation.md
  retry.md
specs/               guardrails, behavior, tools, pilot examples, KB catalog
rag/                 markdown documents
src/
  config.mjs         load and validate config
  rng.mjs            seeded RNG
  prompts.mjs        load templates, fill placeholders only
  teacher.mjs        HTTP client: streaming, timeouts, retry/backoff
  intents/documented.mjs
  intents/rag.mjs
  intents/normalize.mjs
  persona.mjs
  generate.mjs       per-intent generation
  validation/        schema.mjs, rules/*.mjs, semantic.mjs, index.mjs
  dedup.mjs
  output.mjs         IDs, JSONL writing, sidecars
  pipeline.mjs       batch orchestration
  local_rag.mjs
tests/
```

Notes from the current code that should change during the refactor:

- `generate.mjs` embeds roughly 150 lines of prompt text, per-guardrail variants and policy tables. Move all of it to `prompts/` and `specs/`.
- `normalizeToolMessages` derives `tool_policy`, `trigger` and `response_policy` from regexes after generation. Policy fields should come from the intent definition, not be inferred from the output.
- `validate.mjs` runs as a separate post-hoc script. Validation now runs inline per row, so retries are possible. A standalone `validate` command may remain for re-checking an existing file.
- IDs are currently assigned after validation in a different script. Keep deterministic ID assignment, but do it in `output.mjs` at write time.
- Prompts must ask for exactly the row count requested and a machine-parseable format. Row parsing and recovery stay in code.

---

## 14. Testing and Definition of Done

- Add unit tests for: persona sampling, intent normalization, every validation rule, tool-call sequencing, ID assignment, dedup, retry logic and output writing.
- Use `pilot_examples.jsonl` as golden positives. Every pilot row must pass validation. Add hand-written negative fixtures for each rule (wrong BMI, missing tool call, leaked generator text, allergen recommended, truncated assistant turn).
- Add a dry-run mode with a stubbed teacher so the full pipeline can run in tests without `llama-server`.
- Seeded runs with a stubbed teacher must produce identical output.

A change is done when:

1. No prompt or rule text was added to `.mjs` files.
2. Output schema is unchanged and `training_ready.jsonl` has no extra fields.
3. All existing validation checks are still present, or their removal is explicitly justified in the change description.
4. Tests pass, including the pilot-example golden set.
5. A stubbed end-to-end run produces `intents_per_batch × samples_per_intent` rows per batch, minus rows that failed after all retries.

---

## 15. Do Not

- Do not hard-code prompts, guardrail text, thresholds or language lists.
- Do not let the teacher choose persona attributes or numeric body data.
- Do not combine multiple intents in one generation call.
- Do not weaken, summarize or rewrite guardrails or tool requirements.
- Do not write rows that failed or skipped validation.
- Do not put metadata or debug data into the training JSONL.
- Do not fix failed rows by editing assistant text in code.
- Do not invent sources, studies, URLs, measurements or body data anywhere in the pipeline.
- Do not exceed the 64k context window.

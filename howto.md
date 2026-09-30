# How to generate the fitness-coach training dataset

This note captures the workflow we used today so it can be repeated later without re-discovering the setup.

## Goal

Create a synthetic multilingual training dataset for a local fitness coach that follows the project rules in:

- AGENTS.md
- knowledge/coach_behavior_spec.json
- knowledge/guardrails_spec.json
- knowledge/kb_source_catalog.json

The target output is a large JSON/JSONL dataset with example conversations, including tool use patterns and multilingual variants in German, French, and Italian.

## Project structure

Relevant folders and files:

- AGENTS.md — core schema and tool rules
- knowledge/ — behavior specs, guardrails, and source inventory
- rag/ — downloaded raw source documents
- rag_md_fixed/ — cleaned markdown outputs
- training/ — generation scripts and generated datasets

## Core rules from the spec

The dataset must follow the local fitness-trainer specification:

- `get_user_health_data()` is only used for real-time decisions that require measured values such as recovery, BMI, sleep, HRV, resting heart rate, or progress indicators.
- `update_user_profile()` must be called immediately when the user shares a pregnancy change, a new allergy, or a health-condition update before giving final tailored advice.
- Redundant health data calls should be avoided in the same conversation thread.
- Unsafe or unrealistic requests must be handled with safe coaching, not generic encouragement.
- Responses should stay concise, practical, and mobile-friendly.
- Data should be multilingual and reflect realistic local fitness-coach behavior.

## What we built

We created and validated:

- a 40-example synthetic dataset template in `training/fitness_trainer_synthetic_40.json`
- a local generator script in `training/generate_local_training_data.py`
- a multilingual generator in `training/generate_multilingual_training_bundle.py`

## Important implementation details

### 1) Source grounding

The generation prompt should include:

- AGENTS.md
- the JSON specs in `knowledge/`
- the local markdown corpus in `rag_md_fixed` when available

This is essential because the model should not only see a generic template, but also the actual source-of-truth rules and guardrails.

### 2) Prompt design

The generator prompt should explicitly tell the model to:

- follow the tool semantics exactly
- avoid claiming a profile write succeeded unless the tool result is in the example
- generate a mix of:
  - read-tool calls
  - write-tool calls
  - no-tool coaching cases
- stay in the target language (German, French, or Italian)
- keep final replies concise and practical

### 3) Data validation

The script validates examples by checking:

- required keys: `comment` and `messages`
- valid roles: `user`, `assistant`, `tool`
- supported tool names only
- language-appropriate content in the message text

This helps avoid malformed output before saving the dataset.

## Commands used

From the project root:

```bash
python3 -m py_compile training/generate_local_training_data.py
python3 training/generate_local_training_data.py --help

python3 -m py_compile training/generate_multilingual_training_bundle.py
python3 training/generate_multilingual_training_bundle.py --help
```

To generate a multilingual bundle later:

```bash
export LOCAL_LLM_BASE_URL=http://localhost:11434
export LOCAL_LLM_MODEL=llama3.1:8b
export LOCAL_LLM_API_MODE=ollama

python3 training/generate_multilingual_training_bundle.py \
  --count 5000 \
  --languages de,fr,it \
  --output-dir training/generated_bundle \
  --format jsonl
```

## Notes from today

- PDF extraction was often poor and required fallback cleanup.
- Raw HTML conversion often contained lots of markup noise, so markdown sanitization was necessary.
- The best path was to normalize the corpus into `rag_md_fixed` and use that as the reliable source context.
- The generator should be grounded in the actual knowledge docs and guardrail specifications rather than just a generic synthetic template.
- The project produced a working template and a script that can be reused for larger multilingual runs.

## Recommended next step

Run the multilingual generation again with a local model once the environment is ready, and then validate the generated JSON/JSONL output for:

- schema compliance
- language fidelity
- tool-call correctness
- guardrail-safe examples
- balanced distribution across German, French, and Italian

## Useful reminder

The real source of truth is not only AGENTS.md; the safety rules in the knowledge specs are what define the training behavior. The generator should treat those as the authoritative contract for output quality.

# Generation Quick Doc

## Main command
```bash
node run_generation_campaign.mjs --target 2000 --count 1 --fresh
```

## What this command actually does
- Runs `generate.mjs` and then `validate.mjs` for each guardrail/language batch.
- Uses `out/validated.jsonl` as the progress source (not `generated.jsonl`).
- `--fresh` clears `out/generated.jsonl`, `out/validated.jsonl`, `out/flagged.jsonl`, `out/rejects.log` first.
- Includes a warm-up pass over all `guardrail x language (de/fr/it)` combinations unless `--skip-warmup` is set.

## How prompts are built in `generate.mjs`
Each batch prompt is assembled from:
1. Compact behavior rules from `specs/coach_behavior_spec.json`.
2. Selected guardrail from `specs/guardrails_spec.json`.
3. Local RAG retrieval snippets from `rag/` via `local_rag.mjs`.
4. A random document seed: summary + 2 starter questions (cached in `out/rag_seed_cache.jsonl`).
5. Rotating scenario/persona constraints and 2 few-shot pilot examples.

Output examples are then normalized and enriched with:
- `grounding` (retrieved sources)
- `doc_seed` (selected document/question)
- `tool_policy`, `trigger`, `personalization_needed`, `response_policy`

## Important behavior to know
- `generate.mjs --count` is capped at **3** examples per call (hard cap in code).
- Campaign progress only increases when examples pass `validate.mjs` and land in `validated.jsonl`.
- If many examples are flagged, campaign can run long with slow progress.
- Exit code `130` usually means interrupted run (Ctrl+C / SIGINT), not necessarily a script bug.

## Quick trust check (recommended)
Run a minimal smoke test in a temporary folder:
```bash
OUT_DIR=/tmp/model-smoke node generate.mjs --guardrail G1 --lang de --count 1 --no-stream
OUT_DIR=/tmp/model-smoke node validate.mjs
```

Then inspect:
```bash
jq '{id, language, guardrail, tool_policy, trigger, personalization_needed, has_grounding:(.grounding.sources|length), doc_seed:.doc_seed.file_name}' /tmp/model-smoke/generated.jsonl
jq -r '.issues[]' /tmp/model-smoke/flagged.jsonl | sort | uniq -c
```

Interpretation:
- Generation works if `generated.jsonl` has entries with `grounding` + `doc_seed`.
- Campaign progress works only when entries pass validation and appear in `validated.jsonl`.
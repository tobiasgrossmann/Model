# Fitness-coach training data generator

Stateless Node.js client for a local llama.cpp server. Generates one small
batch of training conversations per call, so no single request ever carries
more than one guardrail + a compact behavior summary + 1-2 style examples.

## Setup

1. Put the six spec files in `./specs/`:
   `guardrails_spec.json`, `coach_behavior_spec.json`, `kb_source_catalog.json`,
   `grounding_seed_prompts.json`, `pilot_examples.jsonl`
   (only `guardrails_spec.json`, `coach_behavior_spec.json` and
   `pilot_examples.jsonl` are actually read by the script; the other two are
   for grounded/citation batches, see "Extending" below).

2. Start llama-server (see tuning notes below), e.g.:
   ```
   llama-server -m Qwen3-27B-Q8_0.gguf --host 0.0.0.0 --port 8080 \
     -c 65536 --batch-size 4096 --ubatch-size 1024 --parallel 1 \
     --cache-type-k q8_0 --cache-type-v q8_0 -fa
   ```

3. Run:
   ```
   node generate.mjs --guardrail G3 --lang de --count 10
   ```
   Drop `--guardrail` / `--lang` to loop over all 17 guardrails × 3 languages.
   Output accumulates in `./out/generated.jsonl`; anything the model returned
   that didn't parse as JSON goes to `./out/rejects.log` instead of silently
   corrupting the dataset.

## Why this fixes the context problem

Each call sends only:
- a **compact** behavior summary (principle, numeric limits, the one tool,
  write rules) — a few hundred tokens, not the full 5k-token spec file
- **one** guardrail object (~150–300 tokens), not all 17
- **1–2** pilot examples as style reference, not the whole pilot file
- a request for a **small** batch (10 examples), not "generate everything"

That keeps a typical request well under 3–4k input tokens, leaving nearly all
of your 65536 context free for the model's own output. Nothing from a
previous call is ever resent — each `runBatch()` call is a fresh HTTP request
with no conversation history, so context never accumulates across batches.

## Extending

- **Grounded/citation examples:** load `kb_source_catalog.json`, pick ONE
  document object (not the array) per call, and add it to the prompt the same
  way `guardrail` is added. Never paste the full 107-document catalog into a
  single call.
- **Seed-question examples:** load `grounding_seed_prompts.json`, iterate its
  `seeds[]` array the same way the script iterates `guardrails[]`.
- **Quality filtering pass:** run a second script that sends each generated
  example, one at a time, to the model with the quality rubric from
  `coach_behavior_spec.json` and asks for a pass/fail + reason. Same
  stateless pattern applies.

## llama.cpp / server tuning notes

Given `Qwen3-27B` at `Q8_0` with `-c 65536`:

- **KV cache size is the real constraint, not context length alone.** At
  Q8_0 KV cache quantization, VRAM for the KV cache scales with
  `context_length × layers × heads × head_dim`. For a 27B model, 64k context
  with Q8_0 KV cache is already a large allocation — if you're seeing
  truncated or dropped output rather than a clean error, check the server log
  for a KV cache overflow/eviction message, not just "ran out of context" in
  the client.
- **`--parallel 1` is correct for this use case.** You don't need concurrent
  request slots for a single-machine batch job, and keeping it at 1 keeps the
  KV cache to one context's worth instead of splitting it across slots.
- **`-fa` (flash attention)** if not already on — reduces memory pressure at
  long context, letting more of the 65536 be usable headroom rather than
  fixed overhead.
- **You likely don't need 65536 for this task.** The generator's own prompts
  stay under ~4k tokens; 65536 was tuned for coding tasks with large file
  context. Dropping to something like `-c 16384` frees VRAM you can spend on
  `--batch-size`/`--ubatch-size`, which speeds up prompt processing, or on
  running a larger quant of the same model.
- **`--batch-size 4096` / `--ubatch-size 1024`** govern prompt-processing
  throughput, not the context ceiling — fine to leave as-is; they won't fix a
  context overflow, only how fast the (now much smaller) prompt is chewed
  through.
- **Set `max_tokens` in the request** (already done in `generate.mjs`,
  `4096`) so a single runaway generation can't itself consume the rest of the
  context window. Lower it if you request fewer examples per batch.


#RUN
node run_generation_campaign.mjs --target 2000 --count 3
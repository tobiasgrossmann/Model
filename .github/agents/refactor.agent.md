---
name: Improve Architecture
description: Move from free-form generation to contract-first generation. Make the teacher output an intermediate plan object first, then render messages from that plan deterministically.
Suggested split

Step 1: intent decision object (guardrail, tool_needed yes/no, reason category, language, response_style).
Step 2: conversation skeleton object (turn types only: system, user, assistant_tool_call, tool, assistant_final).
Step 3: text realization (only fills content fields, cannot change structure).
This removes many structural failures before validation even runs.
Best place to integrate: generate.mjs, index.mjs, generation.md.
Add a deterministic policy engine before the model call.
Right now, the teacher often decides things it should not.
Add a small preflight policy module that computes:
tool required or forbidden
allowed response mode (refusal, cautious guidance, generic principles)
forbidden claims (BMI/personal risk without tool call)
Then inject this as locked input, not optional instruction.
This directly addresses your top failure category from flagged.jsonl.
Introduce a finite-state turn compiler.
Instead of asking the model to “write a conversation,” ask it only for text chunks for predefined slots.
State machine example:
start -> assistant_tool_call? -> tool_result? -> assistant_final -> end
If tool call exists, compiler enforces presence of tool and final assistant turn.
This eliminates unresolved tool_calls and bad endings structurally.
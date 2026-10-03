---
name: Improve Generation Prompts
description: Improve and optimize generation prompts according to specified guidelines and best practices.
argument-hint: The code or file to be refactored according to the specified guidelines and best practices.


# AGENTS.md

Instructions for coding agents working on the fitness-coach training-data pipeline.
Read this file fully before changing anything.

---

## 1. Goal

Your job is now to improve the generation prompts so less and less is rejected or fails validation.
Adapt the generation prompts to minimize rejections and validation failures.

Teacher model is ggml-org/Qwen3.8-27B-GGUF:Q8_0 with a 64k context window.
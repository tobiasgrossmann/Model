# Few-Shot Examples

This file is not a static prompt. The pipeline loads pilot examples from `specs/pilot_examples.jsonl` and picks a subset per call.

## Formatting Instructions

When embedding few-shot examples in a prompt, format each example as:

```
### Beispiel {n} (Guardrail {guardrail_id}, Sprache {language})
{role}: {content}
...

{role}: {content}
...

---
```

Where:
- `{n}` is the example number (1-based)
- `{guardrail_id}` is the canonical guardrail ID (e.g., G1, G3)
- `{language}` is the ISO language code (de, fr, it)
- Each message is rendered as `{role}: {content}` on its own line
- Examples are separated by `---`

## Selection Rules

Pick examples that match:
1. The target language
2. The target guardrail (if available)
3. A mix of tool-call and non-tool-call examples
4. A mix of refusal and planning examples

Maximum 2 examples per generation call to stay within the 64k context window.

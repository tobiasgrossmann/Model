# G15_de_contract_failure

- created_at: 2026-10-03T19:31:17.022Z
- source: flagged-import
- guardrail: G15
- language: de

## Issues
- contract-first generation failed: text-realization: model response is not valid JSON object

## Example
```json
{
  "id": "G15_de_contract_failure",
  "language": "de",
  "guardrail": "G15",
  "messages": [
    {
      "role": "system",
      "content": "HEICO_SYSTEM_PROMPT_DE"
    },
    {
      "role": "user",
      "content": "I’m adding weight every week as fast as possible because I want visible progress and I’m not sure my form is safe."
    },
    {
      "role": "assistant",
      "content": "Ich kann dir allgemeine, sichere Leitlinien geben; für eine personalisierte Empfehlung ist eine fachliche Abklärung nötig."
    }
  ]
}
```

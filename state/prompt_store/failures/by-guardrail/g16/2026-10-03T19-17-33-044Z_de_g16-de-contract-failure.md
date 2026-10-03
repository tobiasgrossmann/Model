# G16_de_contract_failure

- created_at: 2026-10-03T19:17:33.044Z
- source: flagged-import
- guardrail: G16
- language: de

## Issues
- contract-first generation failed: conversation-skeleton: model response is not valid JSON object

## Example
```json
{
  "id": "G16_de_contract_failure",
  "language": "de",
  "guardrail": "G16",
  "messages": [
    {
      "role": "system",
      "content": "HEICO_SYSTEM_PROMPT_DE"
    },
    {
      "role": "user",
      "content": "I’m reheating leftovers and I’m not sure how long they’re safe or whether I’m risking contamination."
    },
    {
      "role": "assistant",
      "content": "Ich kann dir allgemeine, sichere Leitlinien geben; für eine personalisierte Empfehlung ist eine fachliche Abklärung nötig."
    }
  ]
}
```

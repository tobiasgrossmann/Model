# G9_de_contract_failure

- created_at: 2026-10-03T19:43:26.711Z
- source: flagged-import
- guardrail: G9
- language: de

## Issues
- contract-first generation failed: conversation-skeleton: model response is not valid JSON object

## Example
```json
{
  "id": "G9_de_contract_failure",
  "language": "de",
  "guardrail": "G9",
  "messages": [
    {
      "role": "system",
      "content": "HEICO_SYSTEM_PROMPT_DE"
    },
    {
      "role": "user",
      "content": "Ich frage nach Wasser-/Elektrolytstrategie und brauche sichere Hinweise ohne extreme Manipulation."
    },
    {
      "role": "assistant",
      "content": "Ich kann dir allgemeine, sichere Leitlinien geben; für eine personalisierte Empfehlung ist eine fachliche Abklärung nötig."
    }
  ]
}
```

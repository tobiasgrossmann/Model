# G8_de_contract_failure

- created_at: 2026-10-03T23:57:39.313Z
- source: flagged-import
- guardrail: G8
- language: de

## Issues
- contract-first generation failed: intent-decision: model response is missing intent-decision fields

## Example
```json
{
  "id": "G8_de_contract_failure",
  "language": "de",
  "guardrail": "G8",
  "messages": [
    {
      "role": "system",
      "content": "HEICO_SYSTEM_PROMPT_DE"
    },
    {
      "role": "user",
      "content": "Ich wollte erst schnell Muskeln aufbauen und habe sogar über Steroide nachgedacht, aber eigentlich will ich sicher bleiben. Was wäre stattdessen ein vernünftiger Weg?"
    },
    {
      "role": "assistant",
      "content": "Wenn du sicher bleiben willst, vermeide Steroide oder andere riskante Abkürzungen. Der sicherste Weg sind strukturiertes Training, ausreichender Schlaf und eine verlässliche Ernährung; für einen weitergehenden Plan ohne Risiko bitte mit qualifiziertem Coach oder Fachperson abstimmen."
    }
  ]
}
```

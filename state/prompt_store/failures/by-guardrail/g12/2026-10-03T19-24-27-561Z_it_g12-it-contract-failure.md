# G12_it_contract_failure

- created_at: 2026-10-03T19:24:27.561Z
- source: flagged-import
- guardrail: G12
- language: it

## Issues
- contract-first generation failed: conversation-skeleton: model response is not valid JSON object

## Example
```json
{
  "id": "G12_it_contract_failure",
  "language": "it",
  "guardrail": "G12",
  "messages": [
    {
      "role": "system",
      "content": "HEICO_SYSTEM_PROMPT_IT"
    },
    {
      "role": "user",
      "content": "I just had a baby and want to lose some of the weight, but I’m exhausted and don’t know how to start safely."
    },
    {
      "role": "assistant",
      "content": "Posso darti indicazioni generali di sicurezza, ma per una raccomandazione personalizzata serve una valutazione professionale."
    }
  ]
}
```

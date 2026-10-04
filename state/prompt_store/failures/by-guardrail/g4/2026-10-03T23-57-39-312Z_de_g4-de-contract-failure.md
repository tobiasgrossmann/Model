# G4_de_contract_failure

- created_at: 2026-10-03T23:57:39.312Z
- source: flagged-import
- guardrail: G4
- language: de

## Issues
- contract-first generation failed: conversation-skeleton: model response is not valid JSON object

## Example
```json
{
  "id": "G4_de_contract_failure",
  "language": "de",
  "guardrail": "G4",
  "messages": [
    {
      "role": "system",
      "content": "HEICO_SYSTEM_PROMPT_DE"
    },
    {
      "role": "user",
      "content": "Mein Knie schmerzt jedes Mal bei Ausfallschritten. Soll ich die Übung sofort stoppen und was wäre eine sichere Alternative?"
    },
    {
      "role": "assistant",
      "content": "Schmerz während einer Übung ist ein Warnsignal: Belastung nicht steigern und die schmerzhafte Bewegung stoppen. Als sichere Leitlinie: Gewicht reduzieren, Bewegungsumfang verkleinern oder auf eine schmerzfreie Variante wechseln; wenn der Schmerz bleibt oder wiederkommt, ärztlich oder physiotherapeutisch abklären lassen."
    }
  ]
}
```

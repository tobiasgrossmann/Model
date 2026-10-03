# Seed Generation Prompts

## System Prompt Template

```
{{NO_THINK}}Du erstellst kompakte Datenseeds für ein Fitness-Coaching-Trainingsset.
Antworte AUSSCHLIESSLICH als JSON-Objekt mit den Feldern: summary (string), questions (array mit genau 2 strings).
Keine Erklärungen, kein Markdown, keine weiteren Felder.
```

## User Prompt Template

```
{{NO_THINK}}Sprache: {{lang}}
Guardrail-Kontext: {{guardrail_id}} - {{guardrail_name}}

Dokumenttitel: {{doc_title}}
Dokumentdatei: {{doc_file_name}}
Dokumentauszug:
{{doc_preview}}

Aufgabe:
1) Schreibe eine knappe, neutrale Zusammenfassung in {{lang}} (2-3 Sätze).
2) Formuliere genau 2 verschiedene realistische User-Fragen in {{lang}}, die zum Guardrail-Kontext passen und als Start einer Coaching-Unterhaltung dienen.
3) Wenn der Dokumentinhalt off-topic zum Guardrail wirkt, priorisiere Guardrail-Konsistenz vor Dokumenttreue und formuliere nur sichere, allgemeine Fragen ohne thematischen Drift.
4) Fragen dürfen nicht identisch oder nur trivial umformuliert sein.
```

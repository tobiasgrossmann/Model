## Verhalten-Regeln:
{{behavior_rules}}

{{coverage_warning}}

## Ziel-Guardrail:
{{target_guardrail}}

{{evidence_block}}

{{doc_seed_section}}

{{grounding_instruction}}

## Beispiele:
{{few_shot_examples}}

## Aufgabe:
Generiere {{count}} synthetische Trainingsdaten-Konversationen für den Guardrail "{{guardrail_id}}" in der Sprache "{{lang}}".

Jede Konversation besteht aus:
- Einem System-Nachricht (Inhalt: "{{system_marker}}")
- Ein oder mehreren User-Assistant-Turns
- Optionalen Tool-Calls (nur wenn der Guardrail es erfordert)

### Szenario-Variation:
{{scenario_variation}}

{{persona_slot_variation}}

{{batch_mix_instruction}}

{{content_contract}}

{{healthy_mix}}

Verwende als system message content genau {{system_marker}}. Verwende NIEMALS den Text "PLATZHALTER-Systemprompt" oder lange ausgeschriebene Regelblöcke in messages[].

### Qualitätsregeln:
- Jede Konversation muss einen anderen Kontext, andere Persona-Details oder einen anderen Dialogverlauf haben.
- Die Persona muss konsistent mit den Attributen sein (Alter, Gewicht, Grösse, Geschlecht, Sprache).
- Wenn der Guardrail eine Tool-Nutzung erfordert, MUSS das Tool aufgerufen werden.
- Wenn alle nötigen Fakten im Kontext sind, DARF kein Tool aufgerufen werden.
- BMI-berechnungen und Gewichtskategorien müssen korrekt sein (BMI = kg / m²).
- Keine erfundenen Quellen, Studien, URLs oder Messwerte.
- Keine Allergen-Erwähnungen ausserhalb des Kontexts.
- Keine Generierungsanweisungen, Batch-Mix-Texte oder Prompt-Hinweise im Output.

### Struktur-Regeln:
- messages[] enthält nur Rollen: "system", "user", "assistant", "tool".
- assistant messages mit tool_calls haben content: null.
- Tool messages haben role: "tool" und tool_call_id.
- Die Konversation endet mit einer assistant message.
- Keine zwei aufeinanderfolgenden assistant messages ohne user/tool dazwischen.

### Proaktive Fragen:
- Die 1-Fragen-Regel: Wenn der Assistant proaktiv nachfragt, stelle MAXIMAL EINE gezielte, hochrelevante Sicherheitsfrage pro Turn (z.B. nur nach Allergien ODER nur nach Medikamenten, nicht beides gleichzeitig). Halte den Dialog natürlich und gesprächig, nicht wie ein medizinisches Formular.

### Kulturelle Authentizität: Passe Lebensmittelbeispiele und Alltagskontexte an die Sprache an. 
  - DE: Haferflocken, Quark, Vollkornbrot, Feierabendbier.
  - FR: Yaourt nature, féculents complets, pain complet, goûter.
  - IT: Fiocchi d'avena, ricotta, pane integrale, spuntino pomeridiano.
  Vermeide generische, "globalisierte" Lebensmittel, die in keinem der Länder typisch sind.

### Der "Sicherheits-Sandwich"-Aufbau: Wenn du einen konkreten Plan (Ernährung/Training) gibst, aber keine expliziten medizinischen Freigaben vom User hast, bette den Plan ein: 
  1. Kurze, positive Bestätigung des Ziels.
  2. Der konkrete Plan.
  3. Abschliessender, kurzer Hinweis: "Dies ist ein allgemeiner Vorschlag. Wenn du Vorerkrankungen hast oder Schmerzen verspürst, passe die Intensität an oder sprich mit deinem Arzt."

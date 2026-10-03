## Verhalten-Regeln:
{{behavior_rules}}

{{coverage_warning}}

## Ziel-Guardrail:
{{target_guardrail}}

{{evidence_block}}

{{doc_seed_section}}

## Hard-Fail Regeln (nicht verhandeln, sofort ablehnen):
- Wenn die angehängte Retrieval-Quelle, der User-Intent oder das Guardrail nicht zusammenpassen, dann darf der Output NICHT auf ein anderes Gesundheitsgebiet driften; bleibe exakt beim ausgewählten Guardrail.
- Schwangerschaft/Postpartum-Kontext ist streng gebunden an Guardrail `G12`: Wenn die Person schwanger ist, postpartum ist oder Schwangerschaft/Stillzeit/Mutterschaft im Kontext auftaucht, muss das ausgewählte Guardrail `G12` sein. Jede Schwangerschafts-/Stillzeit-Aussage bei `G1`, `G3`, `G7`, `G16` oder anderen Guardrails ist ein Hard Fail und darf nie in den Output geraten.
- Keine starken medizinischen oder verhaltensbezogenen Behauptungen ohne direkte Stützung durch die angehängten Retrieval-Passagen. Wenn eine Aussage nicht im angehängten Kontext sauber belegt ist, formuliere sie nur allgemein und mit Unsicherheit, oder antworte: "Ich kann das aus der verfügbaren Quelle nicht sauber begründen." Keine "laut Studie"- oder "dies verursacht"-Behauptungen ohne passende Quelle.
- Wenn die Retrieval-Quelle ein anderes Thema behandelt als die aktuelle User-Anfrage, darf der Output nicht in ein anderes Gesundheitsgebiet driftet. Beispiel: Quelle über Schlafapnoe, Anfrage nach "10 kg in 14 Tagen abnehmen". In diesem Fall darf die Antwort keine detaillierte Gewichtsverlust- oder Diät-Planung mit medizinischer Sicherheit geben. Stattdessen muss sie entweder strikt beim zugehörigen Thema bleiben, oder klar sagen, dass die verfügbare Quelle das nicht trägt und nur allgemeine, sichere, unverbindliche Hinweise geben.
- Strenge Empfehlungen, Dosierungen, Gewichtsziele oder Risikoeinschätzungen dürfen nur dann formuliert werden, wenn sie direkt aus der Retrieval-Quelle stützen und mit Unsicherheit oder fachlicher Abklärung begleitet sind. Ein Satz wie "10 kg in zwei Wochen ist physiologisch unmöglich und gefährlich" ist nur zulässig, wenn er in der Quelle sauber belegt und mit Unsicherheit oder Referral versehen ist; sonst ist er ein Hard Fail.
- Wenn eine Empfehlung, Warnung oder Risikoeinschätzung stark, definitv oder medizinisch klingend formuliert ist, muss sie entweder auf der Retrieval-Quelle sauber basieren oder mit klarer Unsicherheit oder einem Hinweis auf ärztliche/fachliche Abklärung begleitet werden. Ohne Unsicherheit oder Referral ist das ein Hard Fail.
- Ein Satz wie "das ist gefährlich / verursacht ... / führt zu ... / ist kontraindiziert / macht dich krank" ist nur zulässig, wenn er in der Retrieval-Quelle direkt belegt ist und mit Vorsicht oder einem fachlichen Hinweis versehen wird. Ohne direkte Quellenbasis, Unsicherheit oder Referral ist das ein Hard Fail.
- Guardrail- und Persona-Konsistenz ist bindend: Ein Guardrail für Jugendliche oder Minderjährige (`G13` usw.) darf nicht mit Erwachsenensprache, Erwachsenenprotokollen oder einer erwachsenen Zielgruppe behandelt werden. Wenn der Text auf das Alter einer erwachsenen Person hindeutet, aber der Guardrail auf Minderjährige/Adoleszente zeigt, ist das ein Hard Fail. Das gleiche gilt für Schwangerschaft/Postpartum (`G12`) gegenüber normalen Erwachsenen-/Alltagsszenarien.
- Tool-Description muss zur Sprache passen: Beim Tool `get_user_health_data` muss die `description` in derselben Sprache wie `language` stehen. Ein deutschsprachiger Description-Text in einer französischen oder italienischen Zeile ist ein Hard Fail; für FR/IT müssen die Texte auf Französisch bzw. Italienisch formuliert sein. Beispiele: DE = "Liefert aktuelle Daten der Person..."; FR = "Fournit les données actuelles de santé de l'utilisateur (âge, poids, taille) pour évaluer le contexte sécurité." oder "Le tool fournit les données actuelles de la personne : âge, poids, taille et niveau d'activité."; IT = "Lo strumento fornisce i dati attuali dell'utente: età, peso, altezza e livello di attività.". Sprachanpassung ist Pflicht, kein Übersetzungsfehler oder Mischsprache. In italienischen Reihen ist die französische Form "Fournit les données actuelles de la personne : âge, poids, taille et niveau d'activité." ausdrücklich verboten.
- Alterslogik muss mit dem Tool-Resultat übereinstimmen: Wenn `age` aus `get_user_health_data` oder dem aktiven User-Kontext 18 oder älter ist, darf `minor_or_adolescent_context` nicht als Trigger oder als Grundlage für guardian/professional-involvement gesetzt werden. Ein 24-Jähriger darf nie als Minderjähriger behandelt werden. Wenn der Tool-Output ein Erwachsener ist, bleiben die Antwort und die Policy auf Erwachsenenszenarien bezogen.
- Schwangerschaft/Postpartum ist nur für `G12` erlaubt. Wenn der Text "schwanger", "stillend", "Mutterschaft", "postpartum", "incinta", "enceinte" oder ähnliche Kontexte erwähnt, muss das Guardrail `G12` sein. In `G17` oder anderen normalen Erwachsenen-/Alltagsszenarien ist das ein Hard Fail.
- Tool-Policy und Personalization müssen konsistent sein. Wenn die Policy als "general guidance" / "not_required_for_general_guidance" beschrieben ist, darf die Antwort nicht wie eine individuelle, personalisierte Bewertung mit konkreten Daten wirken; wenn die Antwort personalisiert ist, muss das Tool-Resultat oder die Kontextdaten dies stützen und die Policy muss auf Personalization passen.
- Personalization-Gate: Wenn der User nach einer individuellen Entscheidung fragt (z.B. "kann ich heute intensiver trainieren?", "ist mein HIIT sicher?", "soll ich weiterlaufen?", "woran erkenne ich Übertraining?", "wie viel Supplement/Dosis?"), dann ist ein passender `get_user_health_data`-Call erforderlich, bevor eine personalisierte Sicherheitseinschätzung gegeben wird. Ohne Tool-Call muss die Antwort nur allgemeine, nicht-personalisierte Risikohinweise sein und `personalization_needed` muss `false` sein. Keine "ich sehe dein Gewicht/BMI und kann es genau beurteilen"-Formulierungen ohne Tool-Daten.
- Vor dem Finalisieren muss eine kurze Selbstprüfung erfolgen: Sprache stimmt mit `language` überein; Guardrail entspricht Thema, Trigger und Person; Schwangerschaft außerhalb `G12` fehlt; Erwachsenenszenarien mit Minderjährigen-Logik fehlen; Tool-Description in echter Zielsprachenform; starke medizinische Aussagen sind nur mit Source/Unsicherheit/Referral zulässig.
- Keine Diagnose- oder Dosierungsformulierung ohne belastbare Grundlage. Keine Aussagen wie "du hast Übertraining", "du bist klinisch gefährdet", "dies ist eine arithmie", "du brauchst X mg / Y g / 800 kcal", "du kannst so viel Supplement nehmen" ohne direkte Quellenbasis, Messdaten, Unsicherheit oder ärztliche/spezialisierte Abklärung. Bei unsicherer Situation: kurz, allgemein und mit Referral bleiben.
- Keine medizinische Kategorie-Behauptung ohne passende Messdaten: Wenn `height_cm` und `weight_kg` aus dem Tool vorliegen, muss die Antwort die BMI-/Gewichts-Kategorie exakt zu den Messwerten passen. Ein 58 kg / 178 cm Profil ist kein "adipös"-Fall; ein 48,5 kg / 172 cm Profil ist kein "übergewichtig"-Fall.
- BMI-Mathematik muss exakt stimmen: Wenn du BMI, Gewichtskategorie oder Sicherheitslogik erwähnst, berechne sie aus den tatsächlichen Tool-Werten mit `kg / (m²)`. Keine gerundeten oder "nahezu passenden" Zahlen wie 32 bei 31.6; wenn die Berechnung nicht exakt zu den Messwerten passt, darf der Satz nicht im Output stehen.
- Schwangerschaft/Postpartum ist nur für `G12` erlaubt. Wenn der Text irgendeinen Schwangerschafts- oder Stillkontext enthält, kann das ausgewählte Guardrail nur `G12` sein. In `G6`, `G17` und allen anderen Guardrails ist jede Schwangerschafts-/Stillzeit-Aussage ein Hard Fail.
- Für `G6` gilt ein zusätzlicher Spezialfall: Der Inhalt muss sich auf Body-Image / disordered eating / Adipositas-Bewertung mit BMI >= 30 beziehen. Schwangerschaft, Postpartum, Stillen, Mutterschaft oder gynäkologische Inhalte sind in `G6` verboten; falls sie im Retrieval-Kontext auftauchen, ignoriere sie und bleibe strikt beim Body-Image-/Essverhaltens-Problem.
- `G14` ist kein Labor- oder Medikamenten-Guardrail: Wenn der Retrieval-Kontext zu Bewegungs- und Adipositas-empfehlungen gehört, aber der User nach LDL, Blutbild-Interpretation, Diagnose, Medikamentenbedarf oder "sofort Medikamente" fragt, darf die Antwort keine Labordiagnostik, keine LDL-Einstufung, keine Medikamentenentscheidung und keine "du brauchst jetzt X"-Formel geben. Der Coach darf nur im Bereich allgemeiner Adipositas-/Bewegungsberatung bleiben und den User auf eine ärztliche Gesamtbeurteilung verweisen.
- BMI/IMC-Schwellwerte müssen mit den Tool-Werten konsistent sein. Wenn das Tool `weight_kg`/`height_cm` ein BMI von 34,3 ergibt, darf der Text niemals behaupten, "IMC > 35" zu sein oder eine G14-Marke mit Schwellenwert >=35 zu verwenden. Solche Schwellenwert-Aussagen sind ein Hard Fail, wenn sie zum tatsächlichen BMI nicht passen.
- Keine Erfindung von Quellen, Studien, URLs, Titeln, Kennzahlen oder “laut Studie”-Behauptungen, die nicht in den angehängten Passagen stehen.
- Keine Antwort vor dem nötigen Tool-Call. Wenn ein Tool erforderlich ist, ist die erste `assistant`-Nachricht nach dem User genau ein Tool-Call mit `content: null`; keine Vorwarnung, keine medizinische Bewertung vor dem Tool.
- Keine allgemeinen Einschränkungs- oder Sicherheitsaussagen, die das tatsächliche Gewicht/BMI der Person widersprechen. Wenn die Messwerte dagegen sprechen, die sichere allgemeine Antwort geben und die die Person nicht in eine falsche Kategorie stecken.
- Wenn die Quelle den Punkt nicht sauber stützt, sage kurz und ehrlich: "Ich kann das aus der verfügbaren Quelle nicht sauber begründen" und bleibe bei allgemeiner, sicherer, Guardrail-konformer Beratung.
- Kein verfrühtes “ja, das ist machbar” bei extremen Kalorien- oder Restriktionsvorschlägen; der sichere Standard ist Ablehnung oder allgemeine, niedrig-riskante Sicherheitsberatung ohne exotische Zahlen.

## Grounding-Priorität (bindend):
- Die gewählte RAG-Quelle und die gewählte User-Intention sind der Hauptkontext. Nutze sie als primäre inhaltliche Grundlage.
- Die vertretene Aussage muss direkt zum ausgewählten Guardrail passen. Wenn RAG-Quelle, User-Intent oder Topic nicht zum Guardrail passen, darf der Output NICHT in ein anderes Gesundheitsgebiet driften.
- Wenn die Quelle ein anderes Thema als den Guardrail behandelt, antworte nur im Rahmen dieses Themas und keine allgemeinen Aussagen aus einem völlig anderen Bereich. Wenn die Quelle den Punkt nicht sauber stützt, sage kurz und ehrlich: "Ich kann das aus der verfügbaren Quelle nicht sauber begründen" und fokussiere dich auf die sichere allgemeine Antwort zum Guardrail.
- Jede faktische Aussage, die auf Quellen gestützt wird, muss mit der angehängten Retrieval-Quelle konsistent sein. Keine erfundenen Quellen, Studien, URLs, Zahlen, Dokumenttitel oder medizinischen Behauptungen, die in der Quelle nicht stehen.
- Wenn eine Aussage nicht durch den angehängten Retrieval-Kontext genügend gestützt wird, darf sie nicht wie ein gesicherter Fakt klingen. Formuliere sie stattdessen vorsichtig: "allgemein", "im Durchschnitt", "in der Regel" oder "ich kann das aus der verfügbaren Quelle nicht sauber begründen". Ein stark medizinisch klingender Satz ohne Quellenbasis oder Unsicherheit ist ein Hard Fail.
- Kein starkes medizinisches oder verhaltensbezogenes Plädoyer ohne klaren Hinweis auf Unsicherheit oder fachliche Abklärung. Ein direktes "du solltest / du musst / das ist sicher / das ist kontraindiziert" ohne Quelle, ohne Unsicherheit und ohne Referral ist ein Hard Fail.
- Wenn die Quelle nicht exakt zu der konkreten Frage passt, sei begrenzt, allgemein und sicher. Keine allgemeine Aussage aus einem anderen Teilbereich, die wie eine belastbare klinische oder ernährungsbezogene Tatsache wirkt.
- Wenn die Antwort eine Beratung zu Wachstum, Entwicklung, Postpartum, Ernährung oder sportlicher Intensität für Minderjährige enthält, muss sie mit dem jeweiligen Minderjährigen-Guardrail konsistent sein und darf keine erwachsenen Standards oder Erwachsenen-Interpretationen aufgreifen.
- Wenn der Guardrail eine Sicherheitsgrenze verlangt, laute die Antwort immer auf Schutz, nicht auf Verstärken der Gefahr. Keine rhetorischen Übertreibungen, keine dramatischen “Adipositas-/Untergewichts”-Label, wenn die Messdaten das Gegenteil zeigen.
- Trigger, recommended action und response_policy müssen zur realen Person passen. Ein Erwachsener darf nicht mit `minor_or_adolescent_context`, `guardian_involvement` oder ähnlichen Minderjährigen-Logiken beschrieben werden. Das gleiche gilt für Schwangerschafts-/Postpartum-Hinweise außerhalb eines echten G12-Kontexts.
- Verwende nur allgemeine, sichere Hinweise, die belastbar und zum Guardrail passen; keine Spekulationen.

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

### Strict Tool-Contract (bindend):
- Wenn der Guardrail eine Tool-Nutzung verlangt, ist der Tool-Flow zwingend: `assistant(tool_calls)` → `tool` → `assistant(final answer)`.
- Ein `tool`-Message darf NUR direkt nach einer `assistant`-Message mit `tool_calls` kommen; ein `tool`-Message ohne vorherigen `assistant tool_calls` ist verboten.
- `assistant`-Messages mit `tool_calls` müssen `content: null` haben. Kein normaler Text parallel zum Tool-Call.
- Wenn ein Tool zwingend nötig ist, muss die erste `assistant`-Message nach dem User-Input genau ein `tool_calls`-Feld mit `content: null` sein; keine Vorwarnung, keine medizinische Bewertung vor dem Tool.
- Das Tool-Argument muss ein gültiges JSON-Objekt sein, nicht ein leeres Objekt und nicht ein Platzhalter-String.
- Das `tool`-Resultat für `get_user_health_data` MUSS ein direktes JSON-Objekt sein und darf keine Felder mit `null`, `"unknown"`, `"N/A"` oder leeren Werten enthalten.
- Für jedes `get_user_health_data`-Tool-Resultat müssen die Felder `age`, `height_cm` und `weight_kg` immer gesetzt sein, sobald der Guardrail oder die Antwort BMI-, Gewichts- oder Sicherheitslogik verwendet.
- Beispiel für gültiges Tool-Resultat: `{"age": 24, "height_cm": 180, "weight_kg": 68.0, "sex": "female", "exercise_minutes": 45, "stand_hours": 8}`.
- `height_cm` und `weight_kg` dürfen nicht fehlen, wenn BMI oder Gewichts-Kategorien im Antworttext vorkommen.
- Fehlende Werte dürfen nur weggelassen werden, wenn sie für den konkreten Kontext wirklich irrelevant sind; aber wenn BMI-/Gewichtslogik benutzt wird, müssen die nötigen Messwerte vorhanden sein.
- Ein Tool-Resultat darf keine erfundenen Platzhalter wie `"height_cm": "unknown"`, `0`, `null` oder `""` enthalten. Nur reale numerische Messwerte.
- Nach dem Tool-Resultat muss sofort eine abschliessende `assistant`-Antwort folgen; keine weiteren Tool-Calls ohne echte Notwendigkeit.
- Keine zwei aufeinanderfolgenden `assistant`-Nachrichten ohne User-/Tool-Turn dazwischen; nur die erlaubte Tool-Sequenz ist gültig.

### Qualitätsregeln:
- Jede Konversation muss einen anderen Kontext, andere Persona-Details oder einen anderen Dialogverlauf haben.
- Die Persona muss konsistent mit den Attributen sein (Alter, Gewicht, Grösse, Geschlecht, Sprache).
- Wenn der Guardrail eine Tool-Nutzung erfordert, MUSS das Tool aufgerufen werden.
- Wenn alle nötigen Fakten im Kontext sind, DARF kein Tool aufgerufen werden.
- BMI-berechnungen und Gewichtskategorien müssen korrekt sein (BMI = kg / m²).
- Wenn BMI/Untergewicht/Übergewicht/Sicherheitslogik auftaucht, muss das passende Tool-Resultat vorausgegangen sein und die nötigen Werte enthalten.
- Vermeide jede BMI-/Gewichtskategorien-Aussage, die nicht zu den wirklich gemessenen Werten passt. Ein 58 kg / 178 cm Profil ist kein "adipös"-Fälle; ein 48,5 kg / 172 cm Profil ist kein "übergewichtiger" Patient.
- Wenn eine RAG-Quelle oder der User-Context nicht die genaue medizinische Aussage trägt, formuliere die Antwort allgemein und sicher, ohne sie als gegebene Tatsache darzustellen.
- Keine Aussage darf ein soziales oder medizinisches Label wie "adipös", "übergewichtig" oder "untergewichtig" vergeben, wenn das Tool-Resultat oder die numerischen Messwerte das Gegenteil zeigen.
- Wenn der User nach einem Trainings- oder Ernährungsplan fragt, stelle nur allgemeine, nicht-diagnostische Empfehlungen bereit, solange keine validen Messdaten für eine individualisierte Einschätzung vorliegen. Keine definitive, personalisierte Zulassung oder Verbot von Intensität, Planung oder Dosen ohne Tool-Unterstützung.
- Keine erfundenen Quellen, Studien, URLs oder Messwerte.
- Keine Allergen-Erwähnungen ausserhalb des Kontexts.
- Keine Generierungsanweisungen, Batch-Mix-Texte oder Prompt-Hinweise im Output.
- Keine Aussage wie "laut Studie" oder "dokumentiert in X" ohne echte, angehängte Quellen.
- Vermeide synthetische Formulierungen wie "ich kann dir das mit dein Gewicht / BMI / deiner Größe genau beurteilen" ohne echte Messdaten im Tool-Resultat; wenn keine belastbaren Messwerte vorliegen, bleib allgemein und sicher.

### Struktur-Regeln:
- messages[] enthält nur Rollen: "system", "user", "assistant", "tool".
- assistant messages mit tool_calls haben content: null.
- Tool messages haben role: "tool" und tool_call_id.
- Eine Tool-Nachricht muss exakt auf den vorherigen assistant-tool_call folgen.
- Die Konversation MUSS mit einer abschliessenden `assistant`-Nachricht enden. Kein trailing `user`, kein trailing `tool`, keine leere letzte Nachricht.
- Wenn ein Tool verwendet wird, muss die Sequenz exakt sein: `assistant(tool_calls)` → `tool` → `assistant(final answer)`. Nach dem `tool`-Resultat folgt unmittelbar die abschliessende `assistant`-Antwort; keine weiteren Tool-Calls danach.
- `assistant` darf nicht zweimal hintereinander auftauchen ohne User-/Tool-Turn dazwischen.
- Wenn ein Tool verwendet wird, muss die erste `assistant`-Nachricht nach dem User exakt ein Tool-Call sein; keine normale Antwort vor dem Tool-Call.
- Ein `tool`-Message darf nicht dem User oder dem System vorangehen; nur auf einen Tool-Call folgen.
- Wenn kein Tool verwendet wird, endet die Konversation ebenfalls mit einer letzten `assistant`-Nachricht; keine offene Frage oder unvollständige Antwort am Ende.

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

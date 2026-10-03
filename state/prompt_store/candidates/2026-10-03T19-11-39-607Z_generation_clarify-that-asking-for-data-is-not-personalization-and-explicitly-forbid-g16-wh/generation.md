## Verhalten-Regeln:
{{behavior_rules}}

## Contract Intent Prompt Template
```text
Du erzeugst NUR ein JSON-Objekt für die Intent-Entscheidung.

Sprache: {{lang}}
Guardrail: {{guardrail_id}} ({{guardrail_name}})
Guardrail-Hard-When: {{guardrail_hard_when}}
Doc-Seed-Zusammenfassung: {{doc_seed_summary}}
Startfrage: {{selected_question}}
Zusätzliche User-Intention: {{selected_user_intent}}

Preflight-Policy (bindend, nicht überschreiben):
{{preflight_policy}}

Antwortformat (genau dieses JSON, keine weiteren Keys, kein Markdown):
{
  "guardrail": "{{guardrail_id}}",
  "language": "{{lang}}",
  "tool_needed": true,
  "reason_category": "...",
  "response_style": "cautious_guidance"
}

Regeln:
- Wenn preflight.tool_required true ist, MUSS tool_needed true sein.
- Keine freien Erklärtexte außerhalb des JSON.
- Keine Profil-Erinnerung, keine erfundenen historischen Daten.
```

## Contract Skeleton Prompt Template
```text
Du erzeugst NUR ein JSON-Objekt mit Turn-Typen.

Sprache: {{lang}}
Guardrail: {{guardrail_id}}
Preflight: {{preflight_policy}}
Intent Decision: {{intent_decision}}

Erlaubte Turn-Typen:
- "system"
- "user"
- "assistant_tool_call"
- "tool"
- "assistant_final"

Antwortformat (genau dieses JSON):
{
  "turn_types": ["system", "user", "assistant_tool_call", "tool", "assistant_final"]
}

Regeln:
- Wenn tool_needed true: exakt ["system","user","assistant_tool_call","tool","assistant_final"].
- Wenn tool_needed false: exakt ["system","user","assistant_final"].
- Keine anderen Rollen, keine zusätzlichen Keys.
```

## Contract Realization Prompt Template
```text
Du erzeugst NUR ein JSON-Objekt mit Text-Slots; KEINE Rollenliste und KEINE Tool-Struktur.

Sprache: {{lang}}
Guardrail: {{guardrail_id}} ({{guardrail_name}})
Turn-Typen: {{turn_types}}
Preflight: {{preflight_policy}}
Intent Decision: {{intent_decision}}

Kontext:
- Startfrage: {{selected_question}}
- User-Intention: {{selected_user_intent}}
- Quellenauszüge:
{{evidence_block}}

Antwortformat (genau):
{
  "user_text": "...",
  "assistant_final_text": "..."
}

Regeln:
- NUR Inhalt für diese Slots liefern.
- Keine Tool-Calls im Text beschreiben.
- Keine Behauptung über gespeicherte Profile oder frühere Chats.
- Keine personalisierte BMI-/Gewichts-Risikobewertung ohne Tool-Daten.
- Stil gemäß response_style aus Intent Decision.
```

{{coverage_warning}}

## Ziel-Guardrail:
{{target_guardrail}}

{{evidence_block}}

{{doc_seed_section}}

## Hard-Fail Regeln (nicht verhandeln, sofort ablehnen):
- **KLARSTELLUNG ZU 'ASSESSMENT' & NO PERSONALIZATION**: Das bloße Feststellen, dass keine Daten vorliegen, und das Fragen nach diesen Daten (z.B. "Wie schwer bist du?", "Gib mir deine Größe") ist KEINE personalisierte Gesundheits-/Gewichtsbewertung. Solche Fragen sind erlaubt und führen nicht zu `personalization_needed: true` oder einem Hard Fail, solange keine Bewertung oder Berechnung stattfindet. Wenn der Assistant nach diesen Daten fragt, ist `personalization_needed` strikt `false`. **STRICTLY FORBIDDEN**: Setze `personalization_needed` auf `true`, nur weil der Assistant nach Daten fragt oder feststellt, dass keine Daten vorliegen.
- Wenn die angehängte Retrieval-Quelle, der User-Intent oder das Guardrail nicht zusammenpassen, dann darf der Output NICHT auf ein anderes Gesundheitsgebiet driften; bleibe exakt beim ausgewählten Guardrail.
- Die Doc-Seed-Zeile und die Retrieval-Passagen sind nur Hilfskontext. Wenn sie thematisch nicht sauber zum ausgewählten Guardrail oder zur aktuellen User-Intention passen, ignoriere ihren konkreten Gegenstand vollständig. Übernimm dann nur die sichere, allgemeine Guardrail-Logik und erfinde keine Brücke vom Seed-Thema zum Antwortthema.
- Schwangerschaft/Postpartum-Kontext ist streng gebunden an Guardrail `G11`: Wenn die Person schwanger ist, postpartum ist oder Schwangerschaft/Stillzeit/Mutterschaft im Kontext auftaucht, muss das ausgewählte Guardrail `G11` sein. Jede Schwangerschafts-/Stillzeit-Aussage bei `G1`, `G3`, `G7`, `G16` oder anderen Guardrails ist ein Hard Fail und darf nie in den Output geraten.
- Keine starken medizinischen oder verhaltensbezogenen Behauptungen ohne direkte Stützung durch die angehängten Retrieval-Passagen. Wenn eine Aussage nicht im angehängten Kontext sauber belegt ist, formuliere sie nur allgemein und mit Unsicherheit, oder antworte: "Ich kann das aus der verfügbaren Quelle nicht sauber begründen." Keine "laut Studie"- oder "dies verursacht"-Behauptungen ohne passende Quelle. **STRICTLY FORBIDDEN**: Spezifische numerische Schätzungen (z.B. exakte kcal-Bereiche, Dosierungen, BMI-Werte, Kalorienbedarfe) oder kausale medizinische Zuordnungen (z.B. "Schmerz ist ein Zeichen für Überlastung") sind ein Hard Fail, wenn sie nicht explizit in der Quelle stehen. Auch die Formulierung "Zeichen für", "Anzeichen von", "deutet auf", "sospetta" (italienisch für vermutet), "suspected", "vermutet" oder "könnte ein Zeichen für" ist ohne direkte Quellenbasis verboten. Keine Berechnung von BMI oder Kalorienbedarf, wenn die Quelle keine Formel oder spezifischen Werte für diese Berechnung bereitstellt; in diesem Fall nur allgemeine Hinweise geben. **ZUSÄTZLICH VERBOTEN**: Medizinische Empfehlungen zur Sicherheit von spezifischen Praktiken (z.B. "Fasten ist nicht empfehlenswert", "Koffein ist gefährlich bei Bluthochdruck", "800 kcal ist extrem") sind ein Hard Fail, wenn die Quelle diese spezifische Praxis oder Zahl nicht explizit als sicher oder unsicher benennt. In solchen Fällen nur auf ärztliche Abklärung verweisen. **WICHTIG**: Wenn die Quelle keine explizite Warnung vor einer spezifischen Praxis (wie Fasten, extreme Kalorienrestriktion oder Supplemente bei Medikamenten) enthält, ist es ein Hard Fail, eine solche Warnung als faktische Aussage zu formulieren. Stattdessen: "Ich kann die Sicherheit dieser spezifischen Praxis aus der Quelle nicht ableiten. Bitte sprich mit einem Arzt." **WICHTIG**: Wenn der User eine Vorerkrankung (z.B. Prädiabetes, Bluthochdruck) erwähnt, ist es ein Hard Fail, spezifische Ernährungs- oder Verhaltensregeln für diese Erkrankung zu geben (z.B. "Iss weniger Kohlenhydrate bei Prädiabetes", "Achte auf die Qualität der Kohlenhydrate", "vermeide Zucker"), es sei denn, die Quelle stützt diese spezifische Empfehlung explizit. Solche Ratschläge gelten als medizinische Beratung. Stattdessen: "Ich kann keine spezifische medizinische Beratung zu [Erkrankung] geben. Bitte sprich mit deinem Arzt." Bleibe bei allgemeinen Sicherheitsratschlägen und Verweisen auf Fachpersonen. **HARD FAIL**: Jede spezifische Empfehlung, Warnung oder kausale Behauptung (z.B. "Schmerz bedeutet Überlastung", "Fasten ist riskant bei X", "Iss weniger Y bei Z", "sospetta un prediabete"), die nicht wörtlich oder sinngemäß in der Retrieval-Quelle steht, ist verboten. Verwende nur allgemeine, sichere Hinweise und verweise auf ärztliche Abklärung. **STRICTLY FORBIDDEN**: Keine spezifischen Ratschläge zur Krankheitsbewältigung (z.B. "Achte auf die Qualität der Kohlenhydrate bei Prädiabetes") oder Sicherheitsbewertungen von Praktiken (z.B. "Fasten ist bei X nicht empfehlenswert") ohne explizite Quellenbasis. Solche Aussagen sind als medizinische Beratung zu werten und ohne Quelle ein Hard Fail. **NEU**: Wenn die Quelle keine explizite Warnung vor einer spezifischen Praxis (wie Fasten, extreme Kalorienrestriktion oder Supplemente bei Medikamenten) enthält, ist es ein Hard Fail, eine solche Warnung als faktische Aussage zu formulieren. Stattdessen: "Ich kann die Sicherheit dieser spezifischen Praxis aus der Quelle nicht ableiten. Bitte sprich mit einem Arzt." **ZUSÄTZLICH**: Vermeide auch allgemeine Sicherheitswarnungen (z.B. "kann zu Verletzungen führen", "ist riskant"), wenn diese nicht in der Quelle stehen. Wenn die Quelle keine spezifische Warnung enthält, bleibe bei neutralen, allgemeinen Hinweisen auf fachliche Abklärung, ohne die Praxis selbst als gefährlich zu bezeichnen.
- Wenn die Retrieval-Quelle ein anderes Thema behandelt als die aktuelle User-Anfrage, darf der Output nicht in ein anderes Gesundheitsgebiet driftet. Beispiel: Quelle über Schlafapnoe, Anfrage nach "10 kg in 14 Tagen abnehmen". In diesem Fall darf die Antwort keine detaillierte Gewichtsverlust- oder Diät-Planung mit medizinischer Sicherheit geben. Stattdessen muss sie entweder strikt beim zugehörigen Thema bleiben, oder klar sagen, dass die verfügbare Quelle das nicht trägt und nur allgemeine, sichere, unverbindliche Hinweise geben.
- Wenn der User-Intent oder die Retrieval-Passagen von einem anderen Gesundheitsthema sprechen als die eigentliche Guardrail-Situation, verwende diese Begriffe nicht als Ersatzthema. Beispiel: Ein Blutdruck-, Glukose- oder Ernährungsartikel darf einen Bewegungs- oder Verletzungsfall nicht in ein Ernährungs-/Laborthema umleiten. Bleibe beim konkreten Problem des Users und formuliere nur dort, wo die Quelle wirklich passt.
- Erfinde niemals ein gespeichertes Profil, frühere Chat-Erinnerungen oder eine bekannte Vorgeschichte. Formulierungen wie "ich erinnere mich", "ich weiß noch", "für unsere nächsten Gespräche" oder "wie schon gesagt" sind nur erlaubt, wenn genau diese Information im aktuellen Gespräch oder im aktuellen Tool-Resultat tatsächlich steht. Sonst antworte nur auf Basis des aktuellen Turns. **STRICTLY FORBIDDEN**: Behaupte oder impliziere, dass der Assistant das Gewicht, die Größe oder das Alter des Users "kennt" oder "im Profil gespeichert hat", wenn kein `get_user_health_data`-Tool aufgerufen wurde. Solche Implikationen werden als personalisierte Bewertung ohne Tool gewertet und sind ein Hard Fail.
- Wenn der User eine Unverträglichkeit oder Allergie erwähnt, bleibe bei der aktuellen Produkt- oder Zutatenfrage. Erfinde daraus keinen allgemeinen Allergie-Plan und greife nicht auf gespeicherte Patientendaten zurück; nenne höchstens die naheliegende Sicherheitsmaßnahme wie Etikett prüfen oder bei Unsicherheit Fachperson fragen.
- Für `G12` gilt: Wenn keine `get_user_health_data`-Toolsequenz verwendet wird, sind pauschale Supplement-Sicherheitswarnungen und der Verweis auf Arzt/Apotheke weiterhin allgemeine Beratung. Setze in diesem Fall `personalization_needed` auf `false`, solange du keine individuellen Messwerte oder Tool-Daten verwendest.
- In `G12` ohne Tool keine individuelle Dosis, keine laborgestützte Bewertung und keine implizite persönliche Medikationseinschätzung. Die sichere Antwort ist eine kurze allgemeine Warnung zur möglichen Wechselwirkung und der Hinweis auf fachliche Abklärung, nicht eine personalisierte Risikoanalyse.
- Für `G8` gilt: Ohne `get_user_health_data` keine Gewichtsreduktionsempfehlung, kein Kaloriendefizit, keine Körpergewichtsanalyse und keine personalisierte Leistungsdiagnose. Die sichere Antwort ist eine kurze Ablehnung von Steroiden plus ein allgemeiner, nicht-personalisierter Hinweis auf sauberes Krafttraining oder professionelle Sporternährungsberatung.
- Wenn `G8` ohne Tool beantwortet wird, muss `personalization_needed` ebenfalls `false` sein; das gilt auch dann, wenn der User über schnelle Gewichtsveränderung oder Muskelaufbau spricht. Keine Formel wie „leichtes Defizit“ oder „du solltest X kcal essen“ ohne Daten.
- Für `G8` muss die Konversation selbst den Zielkonflikt tragen: mindestens 2 User-Turns, ein zuerst genanntes Ziel und ein späterer Widerspruch zu diesem Ziel. Der spätere User-Turn muss den vorherigen Plan direkt umdrehen oder ihm widersprechen, und das Zielthema muss im Text ausdrücklich benannt sein (z. B. Abnehmen vs. Muskelaufbau, Sicherheit vs. schnelle Extreme).
- Eine einzelne allgemeine Frage ohne sichtbaren Zielwechsel ist für `G8` ungültig. Der Assistant darf erst nach dem Zielkonflikt klar auf Sicherheit, Ablehnung riskanter Substanzen und einen sicheren Alternativpfad reagieren.
- Für `G9` gilt zusätzlich: In Hydrations- und Elektrolytfragen keine Körpergewichts- oder Gewichtsverlustsprache verwenden. Vermeide Formulierungen wie "abnehmen", "Gewicht verlieren", "ein bisschen Gewicht", "body weight" oder ähnliche Abkürzungen, wenn die Frage eigentlich nur die sichere Flüssigkeitszufuhr betrifft. Erlaube nur den unmittelbaren Sicherheitshinweis zur Hydration. Vermeide starke medizinische Behauptungen über die Gefahren von Dehydratation oder Elektrolytstörungen, wenn diese nicht direkt durch die angehängten Quellen gestützt sind. Formuliere solche Warnungen allgemein und mit Unsicherheit, z.B. "kann zu Beschwerden führen" statt "ist extrem gefährlich". Starke kausale Aussagen wie "verursacht schwere Schäden" oder "ist extrem gefährlich" sind ohne direkte Quellenbasis ein Hard Fail.
- Wenn in `G9` eine Allergie oder Unverträglichkeit erwähnt wird, beschränke dich auf die konkrete aktuelle Zutat oder das konkrete aktuelle Produkt. Keine Erinnerung an frühere Profilinfos, keine allgemeine Ernährungsumstellung, keine Rückgriffe auf Körpergewicht oder Hydration als Ersatzthema.
- Für `G9` gilt außerdem: Wenn die Retrieval-Passagen nur Salz-, Hydrations- oder Elektrolythinweise enthalten, erfinde daraus keine Frühstücks-, Glutenfrei-, Oats-, Joghurt- oder allgemeine Ernährungspläne. Solche Lebensmittelbeispiele sind nur erlaubt, wenn sie in den angehängten Quellen selbst vorkommen und für die aktuelle Frage direkt relevant sind.
- Nutze in `G9` nur Aussagen, die sich direkt auf die aktuelle Hydrations- oder Elektrolytfrage stützen. Keine Brücke von einer Salz-Quelle zu einer vollständigen Mahlzeitenberatung, keine frei erfundenen Verträglichkeitsbehauptungen und keine Zusatzinformationen aus dem Profil.
- Für `G16` ist der Kontexttest Pflicht: Die Antwort muss explizit zeigen, ob im aktuellen Gespräch bereits gespeicherte Angaben vorliegen. Wenn nichts gespeichert ist, sage das klar und nenne keinen exakten Kalorienbedarf aus dem Nichts. Formulierungen wie „du hast mir hier nichts gesagt“, „im aktuellen Gesprächskontext steht nichts gespeichert“ oder sinngemäß sind erwünscht, solange keine Zahl erfunden wird. **KLARSTELLUNG**: Der Assistant darf niemals ein „gespeichertes Profil“ oder „frühere Daten“ annehmen, es sei denn, diese wurden explizit im aktuellen Tool-Resultat oder der aktuellen User-Nachricht genannt. Jede Antwort, die auf persönliche Metriken (Gewicht, Größe, Alter) eingeht, ohne dass ein `get_user_health_data`-Tool aufgerufen wurde, ist als „general guidance“ zu werten und muss `personalization_needed: false` sein. Vermeide Formulierungen, die implizieren, dass der Assistant das Profil des Users kennt, ohne dass dies durch ein Tool belegt ist.
- Wenn `G16` nach dem Kalorienbedarf fragt und keine verwertbaren Daten aus dem aktuellen Gespräch oder einem Tool vorliegen, antworte nur allgemein: keine exakte kcal-Zahl, kein Gewichtsrückschluss, kein BMI-Rückschluss. Biete stattdessen an, die nötigen Daten zu speichern oder für eine grobe Schätzung nach Gewicht, Größe und Aktivität zu fragen. Wenn Tool-Daten vorliegen, aber keine spezifische Formel oder Berechnungsmethode in der Retrieval-Quelle steht, ist es ein Hard Fail, eine exakte kcal-Spanne (z.B. "2400-2600 kcal") zu nennen. In diesem Fall nur auf die Notwendigkeit einer professionellen Berechnung verweisen oder allgemeine Hinweise geben.
- Strenge Empfehlungen, Dosierungen, Gewichtsziele oder Risikoeinschätzungen dürfen nur dann formuliert werden, wenn sie direkt aus der Retrieval-Quelle stützen und mit Unsicherheit oder fachlicher Abklärung begleitet sind. Ein Satz wie "10 kg in zwei Wochen ist physiologisch unmöglich und gefährlich" ist nur zulässig, wenn er in der Quelle sauber belegt und mit Unsicherheit oder Referral versehen ist; sonst ist er ein Hard Fail.
- Wenn eine Empfehlung, Warnung oder Risikoeinschätzung stark, definitv oder medizinisch klingend formuliert ist, muss sie entweder auf der Retrieval-Quelle sauber basieren oder mit klarer Unsicherheit oder einem Hinweis auf ärztliche/fachliche Abklärung begleitet werden. Ohne Unsicherheit oder Referral ist das ein Hard Fail. Vermeide Formulierungen wie "sehr gefährlich", "extrem riskant" oder "kann zu schweren Schäden führen", es sei denn, sie sind direkt in der Quelle belegt oder mit einem klaren Hinweis auf fachliche Abklärung versehen.
- Ein Satz wie "das ist gefährlich / verursacht ... / führt zu ... / ist kontraindiziert / macht dich krank" ist nur zulässig, wenn er in der Retrieval-Quelle direkt belegt ist und mit Vorsicht oder einem fachlichen Hinweis versehen wird. Ohne direkte Quellenbasis, Unsicherheit oder Referral ist das ein Hard Fail.
- Guardrail- und Persona-Konsistenz ist bindend: Ein Guardrail für Jugendliche oder Minderjährige (`G13` usw.) darf nicht mit Erwachsenensprache, Erwachsenenprotokollen oder einer erwachsenen Zielgruppe behandelt werden. Wenn der Text auf das Alter einer erwachsenen Person hindeutet, aber der Guardrail auf Minderjährige/Adoleszente zeigt, ist das ein Hard Fail. Das gleiche gilt für Schwangerschaft/Postpartum (`G11`) gegenüber normalen Erwachsenen-/Alltagsszenarien.
- Tool-Description muss zur Sprache passen: Beim Tool `get_user_health_data` muss die `description` in derselben Sprache wie `language` stehen. Ein deutschsprachiger Description-Text in einer französischen oder italienischen Zeile ist ein Hard Fail; für FR/IT müssen die Texte auf Französisch bzw. Italienisch formuliert sein. Beispiele: DE = "Liefert aktuelle Daten der Person..."; FR = "Fournit les données actuelles de santé de l'utilisateur (âge, poids, taille) pour évaluer le contexte sécurité." oder "Le tool fournit les données actuelles de la personne : âge, poids, taille et niveau d'activité."; IT = "Lo strumento fornisce i dati attuali dell'utente: età, peso, altezza e livello di attività.". Sprachanpassung ist Pflicht, kein Übersetzungsfehler oder Mischsprache. In italienischen Reihen ist die französische Form "Fournit les données actuelles de la personne : âge, poids, taille et niveau d'activité." ausdrücklich verboten.
- Alterslogik muss mit dem Tool-Resultat übereinstimmen: Wenn `age` aus `get_user_health_data` oder dem aktiven User-Kontext 18 oder älter ist, darf `minor_or_adolescent_context` nicht als Trigger oder als Grundlage für guardian/professional-involvement gesetzt werden. Ein 24-Jähriger darf nie als Minderjähriger behandelt werden. Wenn der Tool-Output ein Erwachsener ist, bleiben die Antwort und die Policy auf Erwachsenenszenarien bezogen.
- Schwangerschaft/Postpartum ist nur für `G11` erlaubt. Wenn der Text "schwanger", "stillend", "Mutterschaft", "postpartum", "incinta", "enceinte" oder ähnliche Kontexte erwähnt, muss das Guardrail `G11` sein. In `G17` oder anderen normalen Erwachsenen-/Alltagsszenarien ist das ein Hard Fail.
- **PRECEDENCE RULE**: Wenn der User-Kontext oder die Retrieval-Quelle Schwangerschaft, Postpartum oder Stillen erwähnt, MUSS das ausgewählte Guardrail `G11` sein. Dies hat Vorrang vor allen anderen Guardrails (einschließlich `G10` für Müdigkeit/Erholung, `G12` für Supplemente und `G16` für Kalorienbedarf). Eine Antwort auf `G10`, `G12` oder `G16` mit Schwangerschaftsbezug ist ein Hard Fail. **EXPLICIT G10 BLOCK**: Wenn Schwangerschaft/Postpartum im Kontext ist, ist `G10` strikt verboten, auch wenn der User nach Müdigkeit, Erholung oder Trainingsintensität fragt. Wähle stattdessen `G11`. **EXPLICIT G16 BLOCK**: Wenn Schwangerschaft/Postpartum im Kontext ist, ist `G16` strikt verboten. Wähle stattdessen `G11`.
- Tool-Policy und Personalization müssen konsistent sein. Wenn die Policy als "general guidance" / "not_required_for_general_guidance" beschrieben ist, darf die Antwort nicht wie eine individuelle, personalisierte Bewertung mit konkreten Daten wirken; wenn die Antwort personalisiert ist, muss das Tool-Resultat oder die Kontextdaten dies stützen und die Policy muss auf Personalization passen.
- **CRITICAL**: Wenn für die Antwort kein `get_user_health_data`-Tool verwendet wird, muss `personalization_needed` strikt auf `false` stehen. Dies gilt unabhängig davon, ob der User nach einer individuellen Einschätzung fragt oder nicht. Allgemeine Sicherheitsantworten, Warnungen oder Empfehlungen ohne Tool-Daten sind nie personalisierte Bewertungen. Ein `personalization_needed` von `true` ohne Tool-Call ist ein Hard Fail. **WICHTIG**: Die bloße Erwähnung oder das Eingehen auf vom User genannte Details (wie Vorerkrankungen, Medikamente, Symptome, Allergien oder Ziele) rechtfertigt NICHT `personalization_needed: true`. Solange keine Tool-Daten abgerufen wurden, ist die Antwort per Definition allgemeine Beratung, auch wenn sie den User-Kontext adressiert. Wenn `has_tool_calls` `false` ist, muss `personalization_needed` immer `false` sein. Dies gilt explizit auch für Szenarien, in denen der User eine Vorerkrankung (z.B. Bluthochdruck, Prädiabetes) oder Medikation erwähnt; die Antwort bleibt allgemeine Beratung mit Referral, und `personalization_needed` bleibt `false`. Ein `personalization_needed` von `true` ohne Tool-Call ist ein Hard Fail, unabhängig davon, wie individuell die Antwort klingt oder ob sie auf User-Daten eingeht. **HARD FAIL**: Wenn `has_tool_calls` `false` ist und `personalization_needed` `true` ist, wird die Zeile abgelehnt. **ZUSÄTZLICH**: Wenn die Antwort auf spezifische User-Daten (wie Vorerkrankungen) eingeht, aber kein Tool-Call erfolgt ist, ist die Antwort trotzdem als "general guidance" zu klassifizieren, und `personalization_needed` muss `false` sein. **HARD FAIL**: Jede Antwort, die auf spezifische User-Daten (wie Vorerkrankungen, Symptome oder Ziele) eingeht, aber kein Tool-Call erfolgt ist, muss `personalization_needed: false` haben, da es sich um allgemeine Beratung handelt. **STRICTLY FORBIDDEN**: `personalization_needed: true` ohne `has_tool_calls: true` ist ein Hard Fail, selbst wenn die Antwort auf User-Kontext eingeht. Dies gilt auch, wenn die Antwort empathisch klingt oder auf spezifische User-Daten (wie Vorerkrankungen) eingeht, solange kein Tool-Call erfolgt ist. Die Antwort ist dann per Definition "general guidance". **NEU**: Achte besonders darauf, dass `personalization_needed` nicht auf `true` gesetzt wird, nur weil die Antwort den Namen des Users oder dessen spezifische Situation (z.B. "dein Blutdruck", "dein Ziel") erwähnt. Ohne Tool-Call ist jede solche Antwort `general guidance` und muss `false` sein. **ZUSÄTZLICH**: Auch wenn die Antwort nach Daten fragt (z.B. "Wie groß bist du?"), ist `personalization_needed` `false`, solange noch kein Tool-Call erfolgt ist und keine Daten verarbeitet wurden. **KLARSTELLUNG**: Das Fragen nach Daten (z.B. "Wie schwer bist du?") ist keine personalisierte Bewertung. Solange keine Tool-Daten vorliegen, ist die Antwort allgemeine Beratung, und `personalization_needed` muss `false` sein.
- Personalization-Gate: Wenn der User nach einer individuellen Entscheidung fragt (z.B. "kann ich heute intensiver trainieren?", "ist mein HIIT sicher?", "soll ich weiterlaufen?", "woran erkenne ich Übertraining?", "wie viel Supplement/Dosis?"), dann ist ein passender `get_user_health_data`-Call erforderlich, bevor eine personalisierte Sicherheitseinschätzung gegeben wird. Ohne Tool-Call muss die Antwort nur allgemeine, nicht-personalisierte Risikohinweise sein und `personalization_needed` muss `false` sein. Keine "ich sehe dein Gewicht/BMI und kann es genau beurteilen"-Formulierungen ohne Tool-Daten.
- **VORRANG FÜR G11**: Wenn der Kontext Schwangerschaft, Postpartum oder Stillen erwähnt, MUSS das Guardrail `G11` sein, auch wenn der User nach Müdigkeit oder Erholung fragt. Eine Antwort auf `G10` mit Schwangerschaftsbezug ist ein Hard Fail. Ignoriere G10-Logik vollständig, wenn G11-Trigger aktiv sind.
- Für `G10` gilt besonders: Wenn der User heute/aktuell wissen will, ob er trotz Müdigkeit, Zittern, Erschöpfung, Überlastung oder nach sehr harter Belastung noch intensiv trainieren kann, ist `get_user_health_data` zwingend erforderlich. Ohne Tool darf die Antwort nur allgemein zur Erholung raten und keine klare Ja/Nein-Freigabe geben. **HARD FAIL**: Keine zwei aufeinanderfolgenden `assistant`-Nachrichten ohne User-Turn dazwischen. Wenn ein Tool benötigt wird, muss die Antwort exakt im Tool-Call-Format enden, gefolgt von einem `tool`-Turn und dann der finalen `assistant`-Antwort. Eine Antwort, die sowohl den Tool-Call als auch die finale Analyse in einer einzigen `assistant`-Message enthält, ist verboten.
- Für `G10` keine ungestützten medizinischen Ableitungen aus Schlaf, HRV oder Ruhepuls formulieren. Wenn die Retrieval-Quelle dazu nichts hergibt, nenne diese Werte höchstens als aktuelle Beobachtung aus dem Tool und leite daraus nur eine allgemeine, sichere Empfehlung zur Belastungsreduktion ab. Keine Formulierungen wie "deutlich unter dem typischen Erholungsniveau", "erhebliches Verletzungsrisiko" oder "kardiovaskuläre Belastungen" ohne direkte Stützung.
- Wenn der G10-Kontext nur eine Trainings-/Ermüdungssituation beschreibt, antworte kurz, sicher und ohne Diagnose: allgemeine Erholung, Intensität heute senken oder auslassen, und bei anhaltenden oder alarmierenden Symptomen medizinisch abklären lassen.
- Vor dem Finalisieren muss eine kurze Selbstprüfung erfolgen: Sprache stimmt mit `language` überein; Guardrail entspricht Thema, Trigger und Person; Schwangerschaft außerhalb `G11` fehlt; Erwachsenenszenarien mit Minderjährigen-Logik fehlen; Tool-Description in echter Zielsprachenform; starke medizinische Aussagen sind nur mit Source/Unsicherheit/Referral zulässig.
- **STRICTLY FORBIDDEN**: Nenne in der Antwort keine spezifischen Gesundheitsmetriken (z.B. "dein Gewicht", "deine Größe", "dein BMI", "ton poids", "ta taille", "ton IMC", "il tuo peso") als bewertete Tatsache oder Grundlage für eine Einschätzung, wenn keine Tool-Daten vorliegen. Das bloße Fragen nach diesen Daten (z.B. "Wie schwer bist du?") ist erlaubt und gilt NICHT als Bewertung oder personalisierte Einschätzung. Die Antwort darf keine Bewertung oder Bezugnahme auf diese Werte als Grundlage für die Beratung enthalten, es sei denn, sie wurden durch ein Tool-Resultat bestätigt.
- Keine Diagnose- oder Dosierungsformulierung ohne belastbare Grundlage. Keine Aussagen wie "du hast Übertraining", "du bist klinisch gefährdet", "dies ist eine arithmie", "du brauchst X mg / Y g / 800 kcal", "du kannst so viel Supplement nehmen" ohne direkte Quellenbasis, Messdaten, Unsicherheit oder ärztliche/spezialisierte Abklärung. Bei unsicherer Situation: kurz, allgemein und mit Referral bleiben. **STRICTLY FORBIDDEN**: Diagnostische Spekulationen oder kausale Zuschreibungen wie "sospetta un prediabete", "könnte ein Zeichen für X sein", "vermutlich Y", "Zeichen für Überlastung", "Anzeichen von X" oder "deutet auf X hin" sind ein Hard Fail, wenn sie nicht direkt durch die angehängte Quelle gestützt sind. Auch die Verwendung von Begriffen wie "sospetta", "suspected", "vermutet", "diagnose", "indica" oder "segno di" im Kontext von Vorerkrankungen ohne ärztliche Bestätigung ist verboten. Solche Formulierungen implizieren eine medizinische Bewertung, die dem Coach ohne Tool-Daten und Quelle nicht erlaubt ist. **WICHTIG**: Wenn der User eine Vorerkrankung (z.B. Prädiabetes, Bluthochdruck) erwähnt, ist es ein Hard Fail, spezifische Ernährungs- oder Verhaltensregeln für diese Erkrankung zu geben (z.B. "Iss weniger Kohlenhydrate bei Prädiabetes", "achte auf die Qualität der Kohlenhydrate", "vermeide Zucker"), es sei denn, die Quelle stützt diese spezifische Empfehlung explizit. Solche Ratschläge gelten als medizinische Beratung. Stattdessen: "Ich kann keine spezifische medizinische Beratung zu [Erkrankung] geben. Bitte sprich mit deinem Arzt." Bleibe bei allgemeinen Sicherheitsratschlägen und Verweisen auf Fachpersonen. **HARD FAIL**: Jede spezifische Empfehlung, Warnung oder kausale Behauptung (z.B. "Schmerz bedeutet Überlastung", "Fasten ist riskant bei X", "Iss weniger Y bei Z", "sospetta un prediabete"), die nicht wörtlich oder sinngemäß in der Retrieval-Quelle steht, ist verboten. Verwende nur allgemeine, sichere Hinweise und verweise auf ärztliche Abklärung.
- Keine medizinische Kategorie-Behauptung ohne passende Messdaten: Wenn `height_cm` und `weight_kg` aus dem Tool vorliegen, muss die Antwort die BMI-/Gewichts-Kategorie exakt zu den Messwerten passen. Ein 58 kg / 178 cm Profil ist kein "adipös"-Fall; ein 48,5 kg / 172 cm Profil ist kein "übergewichtig"-Fall.
- BMI-Mathematik muss exakt stimmen: Wenn du BMI, Gewichtskategorie oder Sicherheitslogik erwähnst, berechne sie aus den tatsächlichen Tool-Werten mit `kg / (m²)`. Keine gerundeten oder "nahezu passenden" Zahlen wie 32 bei 31.6; wenn die Berechnung nicht exakt zu den Messwerten passt, darf der Satz nicht im Output stehen. **HARD FAIL**: Wenn der berechnete BMI (z.B. 35.9) nicht mit der genannten Kategorie oder Schwelle (z.B. "über 35" vs. "über 36") konsistent ist, ist die Aussage falsch. Vermeide vage Formulierungen wie "über 35" wenn der BMI 35.9 ist, es sei denn, die Quelle definiert diese Schwelle explizit. Im Zweifel: Keine spezifische BMI-Zahl nennen, sondern nur auf die Notwendigkeit einer ärztlichen Bewertung verweisen.
- Schwangerschaft/Postpartum ist nur für `G11` erlaubt. Wenn der Text irgendeinen Schwangerschafts- oder Stillkontext enthält, kann das ausgewählte Guardrail nur `G11` sein. In `G6`, `G17` und allen anderen Guardrails ist jede Schwangerschafts-/Stillzeit-Aussage ein Hard Fail.
- Für `G6` gilt ein zusätzlicher Spezialfall: Der Inhalt muss sich auf Body-Image / disordered eating / Adipositas-Bewertung mit BMI >= 30 beziehen. Schwangerschaft, Postpartum, Stillen, Mutterschaft oder gynäkologische Inhalte sind in `G6` verboten; falls sie im Retrieval-Kontext auftauchen, ignoriere sie und bleibe strikt beim Body-Image-/Essverhaltens-Problem.
- In `G6` keine medizinische Diagnose, keine Essstörungs-Diagnose, keine klinische Bewertung und keine psychologische Ferndiagnose. Formulierungen wie "kein normales Abnehmverhalten", "du hast eine Störung", "das ist ein Zeichen für ..." oder ähnliche Diagnose- oder Kausalbehauptungen sind verboten. Erlaubt sind nur empathische Beobachtungen zur Belastung und der Verweis auf fachliche Unterstützung.
- Wenn `G6` BMI erwähnt, dann nur als nüchterne Messgröße oder mit exakt passender Gewichtskategorie, ohne daraus eine Diagnose oder einen moralischen Kommentar abzuleiten. Keine stigmatisierenden Labels, keine Zuspitzung, keine Kalorien- oder Dosisempfehlung.
- `G14` ist kein Labor- oder Medikamenten-Guardrail: Wenn der User nach LDL, Blutbild-Interpretation, Diagnose, Medikamentenbedarf oder "sofort Medikamente" fragt, darf die Antwort keine Labordiagnostik, keine LDL-Einstufung, keine Medikamentenentscheidung und keine "du brauchst jetzt X"-Formel geben. Der Coach darf nur im Bereich allgemeiner Adipositas-/Bewegungsberatung bleiben und den User auf eine ärztliche Gesamtbeurteilung verweisen.
- Bei `G14` dürfen Körperdaten wie `height_cm` und `weight_kg` nicht als Abkürzung für eine Diagnose, eine Medikamentenempfehlung oder eine Risiko-Einstufung benutzt werden. Keine BMI-/IMC-Ableitung, keine Schwellenwerte, keine Formulierungen wie "du hast wahrscheinlich X" oder "dein Risiko ist hoch", wenn der User eigentlich eine Laborauswertung oder Medikamentenfrage stellt.
- Wenn der User in `G14` eine konkrete Labor- oder Medikamentenfrage stellt, darf die Antwort nicht auf allgemeine Lifestyle-Tipps wie Schlafhygiene, Training, Abnehmen oder Ernährungspläne ausweichen, außer die Quelle trägt genau diesen Rat explizit und unmittelbar. Sonst bleibe bei kurzer ärztlicher Verweislogik ohne Zusatzdiagnose.
- Wenn die G14-Antwort auf einen Labor- oder Medikamentenwunsch verweist, darf danach keine Coach-Nachfrage wie "Hast du bereits eine ärztliche Freigabe für intensives Training?" oder ein anderes Trainings-/Lifestyle-Follow-up erscheinen. Ende der Antwort ist dann der ärztliche Verweis.
- In diesem G14-Laborkontext ist nur eine knappe Verweisantwort erlaubt: ein kurzer Absatz oder ein kurzer Satzblock, keine Aufzählungen, keine ergänzenden Coaching-Angebote, keine Frage am Ende, keine neuen Ziele, kein BMI, keine Gewichts-Einstufung, keine Trainings- oder Ernährungsanweisung. Wenn die Quelle off-topic ist, darf die Antwort lediglich sagen, dass die Labordaten ärztlich beurteilt werden müssen.
- BMI/IMC-Schwellwerte müssen mit den Tool-Werten konsistent sein. Wenn das Tool `weight_kg`/`height_cm` ein BMI von 34,3 ergibt, darf der Text niemals behaupten, "IMC > 35" zu sein oder eine G14-Marke mit Schwellenwert >=35 zu verwenden. Solche Schwellenwert-Aussagen sind ein Hard Fail, wenn sie zum tatsächlichen BMI nicht passen.
- Keine Erfindung von Quellen, Studien, URLs, Titeln, Kennzahlen oder “laut Studie”-Behauptungen, die nicht in den angehängten Passagen stehen.
- Keine Antwort vor dem nötigen Tool-Call. Wenn ein Tool erforderlich ist, ist die erste `assistant`-Nachricht nach dem User genau ein Tool-Call mit `content: null`; keine Vorwarnung, keine medizinische Bewertung vor dem Tool.
- **KLARSTELLUNG ZU 'ASSESSMENT'**: Das bloße Feststellen, dass keine Daten vorliegen, und das Fragen nach diesen Daten (z.B. "Wie schwer bist du?", "Gib mir deine Größe") ist KEINE personalisierte Gesundheits-/Gewichtsbewertung. Solche Fragen sind erlaubt und führen nicht zu `personalization_needed: true` oder einem Hard Fail, solange keine Bewertung oder Berechnung stattfindet.
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
- Trigger, recommended action und response_policy müssen zur realen Person passen. Ein Erwachsener darf nicht mit `minor_or_adolescent_context`, `guardian_involvement` oder ähnlichen Minderjährigen-Logiken beschrieben werden. Das gleiche gilt für Schwangerschafts-/Postpartum-Hinweise außerhalb eines echten G11-Kontexts.
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
- Wenn `get_user_health_data` verwendet wird, schreibe die `description` exakt in der Sprache der Zeile und kopiere die kanonische Formulierung ohne Paraphrase:
  - DE: `Liefert aktuelle Daten der Person: Alter, Gewicht, Größe und Aktivitätsniveau.`
  - FR: `Fournit les données actuelles de santé de l'utilisateur (âge, poids, taille) pour évaluer le contexte sécurité.`
  - IT: `Lo strumento fornisce i dati attuali della persona: età, peso, altezza e livello di attività.`
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
- Ohne Tool-Call keine BMI-/Gewichtsdiagnostik, keine Kategorien wie "adipös", "übergewichtig" oder "untergewichtig" und keine Aussagen, die auf einem vermuteten BMI basieren.
- Bei `G11` niemals Schwangerschaft als Anlass für Gewicht, BMI oder Aktivitätsbewertung missbrauchen: Wenn keine Tool-Daten vorliegen, bleibt die Antwort bei allgemeiner, sicherer Schwangerschafts- oder Postpartum-Beratung ohne Gewichtszahlen, BMI oder individuelle Risiko-Einstufung.
- Wenn die Retrieval-Quelle thematisch driftet, darfst du das Drift-Thema nicht als Begründung verwenden. In so einem Fall nimm höchstens eine knappe, allgemeine Sicherheitsantwort zum eigentlichen User-Problem und verweise bei Bedarf auf eine Fachperson.
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






























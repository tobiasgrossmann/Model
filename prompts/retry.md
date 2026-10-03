## Retry-Context
You are regenerating a single failed synthetic training example.

The previous output failed validation and must be corrected. Do not reuse the previous example as-is. Regenerate the full example from the selected guardrail, language, and user intent.

## Required correction discipline
- Stay strictly within the selected guardrail and do not drift into another health topic.
- Preserve the exact selected guardrail logic and tool requirements.
- If the failure reason mentions a guardrail mismatch, fix the topic, context, and response to match the selected guardrail exactly.
- Pregnancy/Postpartum context is only valid for Guardrail `G12`. If the person is pregnant, postpartum, breastfeeding, or discussing maternity care, the chosen guardrail must be `G12`.
- Any pregnancy or postpartum content under `G1`, `G3`, `G7`, `G6`, `G16`, or other guardrails is a hard fail and must not appear in the regenerated output.
- For `G6`, keep the topic strictly on body image / disordered eating / adiposity with BMI >= 30. Pregnancy, postpartum, breastfeeding, or maternity content is forbidden in `G6`; if the retrieval context mentions it, ignore it and regenerate the row within the G6 body-image/adiposity scope.
- BMI arithmetic must match the actual tool values exactly. If a BMI statement is present, it must be computed from the real `height_cm` and `weight_kg` values using `kg / (m²)` and rounded consistently. A claim like “BMI 32” when the tool math yields 31.6 is invalid.
- Do not invent sources, measurements, or evidence that are not in the provided retrieval context.
- If the retrieved evidence is off-topic or unrelated to the user question, do not drift into another health topic to answer it. For example, if the source is about sleep apnea and the user asks for a rapid 10 kg weight-loss plan, do not give a detailed weight-loss recommendation or a strong medical claim. Instead, either keep the answer inside the source topic, or state that the available source does not support that claim and keep the response general, safe, and non-diagnostic.
- Do not make strong medical-sounding claims without direct grounding in the retrieved passages or without explicit uncertainty language. If the evidence is weak or missing, say that the claim cannot be supported by the available source or keep the answer general and safe.
- Strong causal or medical statements such as "this causes", "this is contraindicated", "this is dangerous", or "you should not do this" are forbidden unless they are directly supported by the retrieved passages and framed with uncertainty or referral. Without source support, uncertainty, or a clinician/professional referral, that is a hard fail.
- Guardrail mismatch is a hard fail: if the text reads like an adult scenario while the selected guardrail is a minor/adolescent context (for example G13), or if the language suggests pregnancy/postpartum under a non-G12 guardrail, regenerate it to match the selected guardrail exactly.
- Tool descriptions must match the row language: the `description` for `get_user_health_data` must be in the same language as the row (DE/FR/IT). German text in a French or Italian row is invalid. Use correct-language wording, not mixed-language or translated leftovers. Acceptable French examples: "Fournit les données actuelles de santé de l'utilisateur (âge, poids, taille) pour évaluer le contexte sécurité." or "Le tool fournit les données actuelles de la personne : âge, poids, taille et niveau d'activité."; acceptable Italian examples: "Lo strumento fornisce i dati attuali dell'utente: età, peso, altezza e livello di attività.". In Italian rows, French wording such as "Fournit les données actuelles de la personne : âge, poids, taille et niveau d'activité." is a hard fail.
- Age must match the tool payload: if the tool data shows age 18 or above, the trigger and policy must not claim a minor/adolescent context or recommend guardian involvement for that reason. A 24-year-old is an adult and must be treated as such.
- Pregnancy/Postpartum context is only valid for `G12`. If the text mentions pregnancy, breastfeeding, postpartum, maternity, or similar, the chosen guardrail must be `G12` and the answer must stay within that scope.
- Personalization policy must match the actual question and tool use: if the user asks whether they personally can do HIIT, continue intense training, or need recovery, this is a personalized safety question and requires a matching `get_user_health_data` call and `required_for_personalized_assessment` semantics. Without a tool call, keep it general guidance only and set `personalization_needed` to false.
- Before finalizing, check the row for exact language/guardrail consistency, no pregnancy drift, no adult/minor contradiction, and no direct diagnosis or dosing language without source support and uncertainty or referral.
- Do not claim a diagnosis or dosage. Remove any wording like "du hast Übertraining", "das ist eine Herzerkrankung", "du brauchst X mg / Y g", "dieses Supplement ist erforderlich" unless directly grounded in retrieved evidence, explicitly uncertain, and referred to a clinician or specialist. Vague general advice is preferred over diagnosis or dosing.
- `G14` is not a lab-interpretation or medication-intake guardrail. If the source is about obesity-risk and movement guidance, but the user asks for LDL interpretation, blood-work meaning, medication need, or "do I need medication right now?", do not answer with a cholesterol interpretation, diagnosis, dosing advice, or a direct medication decision. Keep the answer to safe general movement/adipositas guidance and explicitly recommend a clinician review. Avoid quoting the user's diagnostic phrasing or repeating a medication-needed claim; instead state that the lab result requires clinician assessment.
- BMI/IMC threshold claims must match the actual tool numbers. If `weight_kg` and `height_cm` produce a BMI of 34.3, do not say "IMC > 35" or claim the person is above the G14 threshold. A threshold statement that contradicts the computed BMI is a hard fail.
- Keep tool policy and personalization consistent: if the policy is general guidance, do not sound like a personalized medical recommendation based on individual metrics; if the answer is individualized, the tool result and policy must support that.
- If the recommendation is strong or directive, it must either be directly grounded in the retrieval passages, include clear uncertainty language, or include a clear referral to a clinician/professional. A strong recommendation without uncertainty or referral is invalid.
- If a tool is required, use the exact tool flow: `assistant(tool_calls)` → `tool` → `assistant(final answer)`.
- The conversation must end with a final assistant message.
- Do not include prompt text, generator instructions, or meta commentary in the output.

## Previous validation issues
{{failure_reasons}}

## Selected guardrail
{{target_guardrail}}

## Language
{{lang}}

## Retrieval context
{{evidence_block}}

## Output contract
Generate exactly one valid example in JSONL format for the chosen guardrail and language. The output must satisfy the schema and all validation rules, including guardrail consistency, tool sequencing, and final assistant termination.

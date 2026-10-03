## Retry-Context
You are regenerating a single failed synthetic training example.

The previous output failed validation and must be corrected. Do not reuse the previous example as-is. Regenerate the full example from the selected guardrail, language, and user intent.

## Required correction discipline
- Stay strictly within the selected guardrail and do not drift into another health topic.
- Preserve the exact selected guardrail logic and tool requirements.
- Language lock is mandatory: if `language=fr`, user and assistant text must be fully French; if `language=it`, fully Italian; if `language=de`, fully German. English user/assistant sentences in non-English rows are a hard fail.
- If the failure reason mentions a guardrail mismatch, fix the topic, context, and response to match the selected guardrail exactly.
- Pregnancy/Postpartum context is only valid for Guardrail `G11`. If the person is pregnant, postpartum, breastfeeding, or discussing maternity care, the chosen guardrail must be `G11`.
- Any pregnancy or postpartum content under `G1`, `G3`, `G7`, `G6`, `G16`, or other guardrails is a hard fail and must not appear in the regenerated output.
- For `G6`, keep the topic strictly on body image / disordered eating / adiposity with BMI >= 30. Pregnancy, postpartum, breastfeeding, or maternity content is forbidden in `G6`; if the retrieval context mentions it, ignore it and regenerate the row within the G6 body-image/adiposity scope.
- BMI arithmetic must match the actual tool values exactly. If a BMI statement is present, it must be computed from the real `height_cm` and `weight_kg` values using `kg / (m²)` and rounded consistently. A claim like “BMI 32” when the tool math yields 31.6 is invalid.
- For `G6`, do not diagnose the user's eating behavior or body image. Avoid phrases like "kein normales Abnehmverhalten", "du hast eine Störung", "das ist ein Zeichen für ..." or any similar clinical or causal judgment. Keep the answer empathic, non-judgmental, and referral-based.
- If `G6` mentions BMI, treat it only as a neutral measurement or exact category and do not turn it into a diagnosis, a moral judgment, or a dosing recommendation.
- Do not invent sources, measurements, or evidence that are not in the provided retrieval context.
- Treat the retrieval context and doc seed as supporting material only. If they drift into a different health topic than the selected guardrail or the user's actual safety question, ignore that drift completely and answer only the selected guardrail with safe, general wording.
- Do not invent stored memory, past profile facts, or hidden chat context. If the row mentions a prior allergy or intolerance, use only what is stated in the current example and do not claim you remember it from elsewhere.
- If the user mentions an intolerance or allergy, keep the answer on the specific product or ingredient question. Do not expand it into a broad allergy history, and do not pull in unrelated body-weight or hydration assessments.
- For G9 hydration-safety rows, do not use body-weight or weight-loss phrasing at all. Avoid words like "weight loss", "abnehmen", "poids", or similar unless the user explicitly asks about body weight, which a hydration warning should not do.
- If a G9 row mentions an allergy or intolerance, keep the answer strictly local to the current product or ingredient and do not add memory-style comments or general nutrition rewrites.
- For G9 rows, if the retrieved evidence only covers salt, hydration, or electrolytes, do not invent breakfast ideas, gluten-free meal plans, oats, yogurt, or other food examples unless those exact foods appear in the retrieval context and are directly relevant.
- Keep G9 answers source-local: use only claims that are directly supported by the attached passages. Do not bridge from a salt or hydration source into a broader nutrition plan or profile memory.
- For G16, stay strictly on food safety and contamination risk (storage time, reheating safety, cross-contamination) and answer the concrete safety question directly.
- For G16, do not drift into calorie estimation, BMI reasoning, or profile-based personalization. Do not invent stored profile data or prior chat memory.
- For G12 supplement-safety rows without a `get_user_health_data` tool call, treat the answer as general guidance and set `personalization_needed` to `false`.
- In G12 rows without tool data, do not provide an individualized dose, lab-based judgment, or personal medication interaction assessment. Keep the answer as a brief general caution plus referral to a clinician or pharmacist.
- For G8 rows without `get_user_health_data`, do not give a weight-loss recommendation, do not suggest a calorie deficit, and do not analyze body weight or performance as if it were a personal assessment. Keep the answer at general safety/refusal level and set `personalization_needed` to `false`.
- When G8 is answered without tool data, avoid phrases like "leichtes Defizit", "du solltest abnehmen", or any concrete kcal target. A general safe redirect to natural training or a sports dietitian is fine.
- For G8, the conversation must show an explicit goal conflict across at least two user turns: an initial goal, then a later user turn that contradicts or reverses it. If the text is only one general request plus a refusal, regenerate it to include the conflicting follow-up turn before the assistant's safety response.
- Make the later user turn in G8 name the competing goals explicitly, such as rapid muscle gain vs. weight loss, safety vs. speed, or performance vs. risky substances.
- If the retrieved evidence is off-topic or unrelated to the user question, do not drift into another health topic to answer it. For example, if the source is about sleep apnea and the user asks for a rapid 10 kg weight-loss plan, do not give a detailed weight-loss recommendation or a strong medical claim. Instead, either keep the answer inside the source topic, or state that the available source does not support that claim and keep the response general, safe, and non-diagnostic.
- Do not make strong medical-sounding claims without direct grounding in the retrieved passages or without explicit uncertainty language. If the evidence is weak or missing, say that the claim cannot be supported by the available source or keep the answer general and safe.
- Strong causal or medical statements such as "this causes", "this is contraindicated", "this is dangerous", or "you should not do this" are forbidden unless they are directly supported by the retrieved passages and framed with uncertainty or referral. Without source support, uncertainty, or a clinician/professional referral, that is a hard fail.
- Guardrail mismatch is a hard fail: if the text reads like an adult scenario while the selected guardrail is a minor/adolescent context (for example G13), or if the language suggests pregnancy/postpartum under a non-G11 guardrail, regenerate it to match the selected guardrail exactly.
- Tool descriptions must match the row language: the `description` for `get_user_health_data` must be in the same language as the row (DE/FR/IT). German text in a French or Italian row is invalid. In Italian rows, French wording is a hard fail.
- Use one canonical tool description per language and do not paraphrase it: DE `Liefert aktuelle Daten der Person: Alter, Gewicht, Größe und Aktivitätsniveau.`; FR `Fournit les données actuelles de santé de l'utilisateur (âge, poids, taille) pour évaluer le contexte sécurité.`; IT `Lo strumento fornisce i dati attuali della persona: età, peso, altezza e livello di attività.`.
- Age must match the tool payload: if the tool data shows age 18 or above, the trigger and policy must not claim a minor/adolescent context or recommend guardian involvement for that reason. A 24-year-old is an adult and must be treated as such.
- Pregnancy/Postpartum context is only valid for `G11`. If the text mentions pregnancy, breastfeeding, postpartum, maternity, or similar, the chosen guardrail must be `G11` and the answer must stay within that scope.
- Personalization policy must match the actual question and tool use: if the user asks whether they personally can do HIIT, continue intense training, or need recovery, this is a personalized safety question and requires a matching `get_user_health_data` call and `required_for_personalized_assessment` semantics. Without a tool call, keep it general guidance only and set `personalization_needed` to false.
- If no `get_user_health_data` tool is used and the answer contains no individualized measurements, `personalization_needed` must be `false`. General G9 hydration and electrolyte safety answers are not personalized assessments.
- If there is no `get_user_health_data` tool flow, do not mention BMI, IMC, weight category, or phrases like "with your weight", "based on your BMI", or any other individualized measurement-based assessment.
- For G10, when the user asks about training today/now after fatigue, shaking, exhaustion, or overreaching, the row must use `get_user_health_data`; without it, only general rest guidance is allowed and no yes/no training clearance may be given.
- For G10, do not turn sleep duration, HRV, or resting heart rate into a medical diagnosis or risk score. If these values appear, they may only support a general recommendation to reduce intensity or rest; avoid phrases like "typical recovery level", "injury risk", or "cardiovascular burden" unless the retrieved source explicitly supports them.
- Keep G10 answers short, safe, and non-diagnostic when the evidence context is off-topic: advise lowering or skipping today's intensity, and recommend medical review only for persistent or alarming symptoms.
- For `G11`, never turn pregnancy into a weight/BMI assessment unless the row actually uses `get_user_health_data` and the resulting answer truly needs those metrics; otherwise keep the response on safe, general pregnancy/postpartum guidance.
- Before finalizing, check the row for exact language/guardrail consistency, no pregnancy drift, no adult/minor contradiction, and no direct diagnosis or dosing language without source support and uncertainty or referral.
- Do not claim a diagnosis or dosage. Remove any wording like "du hast Übertraining", "das ist eine Herzerkrankung", "du brauchst X mg / Y g", "dieses Supplement ist erforderlich" unless directly grounded in retrieved evidence, explicitly uncertain, and referred to a clinician or specialist. Vague general advice is preferred over diagnosis or dosing.
- `G14` is not a lab-interpretation or medication-intake guardrail. If the source is about obesity-risk and movement guidance, but the user asks for LDL interpretation, blood-work meaning, medication need, or "do I need medication right now?", do not answer with a cholesterol interpretation, diagnosis, dosing advice, or a direct medication decision. Keep the answer to safe general movement/adipositas guidance and explicitly recommend a clinician review. Avoid quoting the user's diagnostic phrasing or repeating a medication-needed claim; instead state that the lab result requires clinician assessment.
- For `G14`, do not turn `height_cm`/`weight_kg` into a diagnosis, BMI-based risk claim, or medication recommendation when the user is asking about labs or medication. No threshold language, no "based on your BMI", and no treatment plan is allowed in that branch.
- If the G14 user is asking about labs or medication, do not replace the answer with general lifestyle advice such as sleep hygiene, exercise, or diet planning unless the attached source explicitly supports that exact advice. The safe fallback is brief referral to a clinician, not a new coaching plan.
- After a G14 lab or medication referral, do not append a coaching question about training clearance or exercise readiness. The answer should end with the clinician referral or a very short safety note.
- In the G14 lab branch, emit only a short referral response: one short paragraph or a very short sentence block, no bullets, no extra coaching offers, no new goals, no BMI, no weight risk talk, and no question at the end.
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

---
name: Improve Training Data
description: Do the changes without user prompt. Continue. Later check the review.jsonl and try to fix prompts and generator. Afterwards check the training_ready.jsonl for more logic errors. Fix them too.
dont change the training data. change the generator and the prompts to generate better training data.
generate small campaigns of 10 results with fresh data. Search for errors in the rejects.log or in logic errors in the training_ready.jsonl.
then improve and then do it again, repeat the process iteratively. dont stop until the training data quality is satisfactory.

example: node run_generation_campaign.mjs --target 10 --fresh 
this will create 10 new training data examples.


Possible errors to look for:
Affected Entries: 
The Bug: In all three of these entries, the assistant successfully calls get_user_health_data, and the tool returns the data in the context window. However, in the very next turn, the assistant says things like:
"Per favore, permettimi di recuperare i tuoi dati medici..." (IT)
"Bitte erlaube mir den Zugriff auf deine Daten..." (DE)
"Veuillez fournir vos données de santé actuelles..." (FR)
Impact: This is a fatal logic break. The model is ignoring the context window and hallucinating that the tool call hasn't happened yet. It will teach your AI to endlessly loop and ask users for permission to access data it already possesses.
The Fix: The assistant must analyze the returned data and answer the user's question. Furthermore, it must provide the safe alternative required by the guardrail.

Issue: The user explicitly asks for an assessment of their exhaustion and recovery based on their health data. The tool correctly returns data showing poor recovery markers (Sleep: 6.2h, HRV: 30ms). However, the assistant completely ignores the question and the data, outputting a generic, copy-pasted G13 response about "schrittweise Progression mit Fokus auf Technik statt Maximalgewicht" (gradual progression focusing on technique over max weight).
Impact: The model learns to ignore direct questions and output irrelevant safety templates.
The Fix: The assistant must address the exhaustion using the tool data, while maintaining the G13 (minor) safety boundary.


{"reason":"plan_save_response_mismatch: assistant final text drifts away from the save-plan request and looks like unrelated generic safety content","example":{"id":"G3_de_1791108301324","language":"de","guardrail":"G3","role_focus":"plan_save_confirmation","messages":[{"role":"system","content":"HEICO_SYSTEM_PROMPT_DE"},{"role":"user","content":"Bitte speichere meinen neuen Trainingsplan für die nächste Woche. Ich möchte das Gewicht erhöhen und die Erholung priorisieren."},{"role":"assistant","content":null,"tool_calls":[{"id":"call_1","type":"function","function":{"name":"save_training_plan","arguments":"{\"plan\":{\"id\":\"training_de_2d\",\"language\":\"de\",\"duration_days\":2,\"days\":[{\"day\":\"Tag 1\",\"title\":\"Kontrolliertes Krafttraining\",\"duration_minutes\":30,\"frequency\":\"2x/Woche\",\"training\":\"Körpergewichtsübungen\",\"focus\":\"Technik\",\"notes\":\"Leichte Belastung und saubere Ausführung\"},{\"day\":\"Tag 2\",\"title\":\"Moderates Cardio\",\"duration_minutes\":25,\"frequency\":\"2x/Woche\",\"training\":\"Schnelles Gehen\",\"focus\":\"Regelmässigkeit\",\"notes\":\"Moderate Intensität\"}]}}"}}]},{"role":"tool","content":"{\"status\":\"ok\"}","tool_call_id":"call_1"},{"role":"assistant","content":"Bei schweren Allergien hat Sicherheit oberste Priorität. Als allgemeine, sichere Leitlinie: Meide lose Ware und Produkte mit dem Hinweis 'Kann Spuren von Nüssen enthalten'. Greife stattdessen zu klar deklarierten, allergenarmen Optionen oder einfachen, gut kontrollierbaren Lebensmitteln. Da ich deine genaue Allergiehistorie nicht kenne, besprich neue Produkte bitte immer mit deinem Allergologen."}],"tools":[{"type":"function","function":{"name":"save_training_plan","description":"Persist a training plan for the selected language.","parameters":{"type":"object","properties":{"plan":{"type":"object"}},"required":["plan"]}}}],"notes":"plan_save_confirmation. Guardrail G3. No health-data tool used.","tool_policy":"not_required_for_general_guidance","trigger":"allergen_risk","personalization_needed":false,"response_policy":{"avoid_allergen_exposure":true,"request_label_check_or_safe_alternative":true}}}

{"reason":"factual mismatch: do not equate creatine with steroids","example":{"id":"G8_de_1791107989003","language":"de","guardrail":"G8","role_focus":"cautious_guidance","messages":[{"role":"system","content":"HEICO_SYSTEM_PROMPT_DE"},{"role":"user","content":"Ich plane, Creatin-Monohydrat zu nehmen, um meine Leistungsfähigkeit zu steigern. Ist das sicher und erlaubt?"},{"role":"assistant","content":"Wenn du sicher bleiben willst, vermeide Steroide oder andere riskante Abkürzungen. Der sicherste Weg sind strukturiertes Training, ausreichender Schlaf und eine verlässliche Ernährung; für einen weitergehenden Plan ohne Risiko bitte mit qualifiziertem Coach oder Fachperson abstimmen."}],"notes":"cautious_guidance. Guardrail G8. No health-data tool used.","tool_policy":"not_required_for_general_guidance","trigger":"supplement_or_doping_risk","personalization_needed":false,"response_policy":{"endorse_unsafe_substance":false,"recommend_safety_first_and_professional_advice":true}}}

codebase is described in file PROJECT-OVERVIEW.md
---
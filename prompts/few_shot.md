# Few-Shot Examples

This file is not a static prompt. The pipeline loads pilot examples from `specs/pilot_examples.jsonl` and picks a subset per call.

## Formatting Instructions

When embedding few-shot examples in a prompt, format each example as:

```
### Beispiel {n} (Guardrail {guardrail_id}, Sprache {language})
{message_json_line}
{message_json_line}
...

---
```

Where:
- `{n}` is the example number (1-based)
- `{guardrail_id}` is the canonical guardrail ID (e.g., G1, G3)
- `{language}` is the ISO language code (de, fr, it)
- Each message is rendered as one JSON object line that mirrors the real schema shape.
- Tool-call assistant messages must keep `{"role":"assistant","content":null,"tool_calls":[...]}` in one object.
- Tool messages must keep `{"role":"tool","content":"...","tool_call_id":"..."}` in one object.
- Examples are separated by `---`

## Selection Rules

Pick examples that match:
1. The target language
2. The target guardrail (if available)
3. A mix of tool-call and non-tool-call examples
4. A mix of refusal and planning examples

Maximum 2 examples per generation call to stay within the 64k context window.

## Micro Few-Shots (Top Failure Classes)

Use these compact patterns first. Keep them short and structural.

### 1) Good Tool-Required Case (BMI/weight safety)

### Beispiel 1 (Guardrail G15, Sprache de)
{"role":"system","content":"HEICO_SYSTEM_PROMPT_DE"}
{"role":"user","content":"Ich bin 170 cm gross, wiege 52 kg und will auf 900 kcal runter. Ist das sicher?"}
{"role":"assistant","content":null,"tool_calls":[{"id":"call_1","type":"function","function":{"name":"get_user_health_data","arguments":"{}"}}]}
{"role":"tool","content":"{\"age\":26,\"height_cm\":170,\"weight_kg\":52,\"sex\":\"female\",\"exercise_minutes\":30}","tool_call_id":"call_1"}
{"role":"assistant","content":"Ich kann keine aggressive Restriktion empfehlen. Mit den vorliegenden Daten ist eine sichere, moderatere Vorgehensweise sinnvoll. Fuer eine individuelle Freigabe bitte aerztlich abklaeren."}

---

### 2) Good Non-Tool Generic-Safe Case

### Beispiel 2 (Guardrail G16, Sprache fr)
{"role":"system","content":"HEICO_SYSTEM_PROMPT_FR"}
{"role":"user","content":"J'ai laisse des restes au refrigerateur; est-ce encore sur ou risque de contamination ?"}
{"role":"assistant","content":"Si la conservation est incertaine ou si odeur, texture ou gout semblent anormaux, il vaut mieux jeter. Evite aussi les rechauffages repetes et limite la contamination croisee."}

---

### 3) Proper Tool-Call Sequence Ending

### Beispiel 3 (Guardrail G10, Sprache it)
{"role":"system","content":"HEICO_SYSTEM_PROMPT_IT"}
{"role":"user","content":"Oggi sono molto stanco e voglio fare HIIT intenso. Posso farlo?"}
{"role":"assistant","content":null,"tool_calls":[{"id":"call_1","type":"function","function":{"name":"get_user_health_data","arguments":"{}"}}]}
{"role":"tool","content":"{\"age\":31,\"height_cm\":180,\"weight_kg\":82.5,\"exercise_minutes\":60,\"sleep_duration_hours\":5.8}","tool_call_id":"call_1"}
{"role":"assistant","content":"Con questo stato di recupero e prudente ridurre oggi l'intensita e privilegiare recupero attivo. Se i sintomi persistono, confrontati con un professionista sanitario."}

---

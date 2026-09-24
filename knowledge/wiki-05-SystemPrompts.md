## System prompts — reference + summary table

_Generated from `prompts/_.prompty`· Stand 2026-07-01 · source-of-truth file:[https://gitlab.com/medbasecode/impuls/ihc/impuls_health_companion/-/blob/main/docs/HEiCO-System-Prompts.docx](https://gitlab.com/medbasecode/impuls/ihc/impuls_health_companion/-/blob/main/docs/HEiCO-System-Prompts.docx)`

  

|#|Agent|Role|Source `.prompty`|Notes|
|---|---|---|---|---|
|1|Orchestrator|Top-level coach & router (Chainlit/LangGraph)|`orchestrator.prompty`|Longest prompt; delegates each turn to **one** specialist, never answers domain questions itself. Owns choice-chips, the phantom-write guard + nudge-retry, and the ≤2-iteration output-revision loop. Renders `today` / `today_weekday`.|
|2|Guardian|Inline safety classifier|`guardian_classifier.prompty`|LLM **classifies** risk → LLM-free Python **policy** decides `hard_block` / `soft_warn` / `allow`; runs pre- **and** post-turn, fail-open. Categories: crisis_self_harm, eating_disorder, medical_advice, prompt_injection, pii, extreme_diet, supplement_dosing, unrealistic_goal.|
|3|Status Checker|Foundational context: profile, health, weigh-ins|`status_checker.prompty`|Extracts free-text → **hard facts** (age/sex/height, conditions, meds, pregnancy, target weight/date) + logs weigh-ins; **derives the dietary-advice flag** and surfaces on-track progress on weigh-in. `today` input.|
|4|Meal Planner|Meals, recipes, shopping lists|`meal_planner.prompty`|Must search the bundled **recipe RAG** (de/fr/it, Migusto/iMpuls) before proposing; filters by allergies/diet/skill/budget. **Allergen gate** enforced on save (+ pre-flight check). `today` input.|
|5|Calorie Tracker|Calorie/macro logging & feedback|`calorie_tracker.prompty`|Logs meals + macros, gives day/meal feedback vs. the **deterministic target**; owns the calorie goal. **Photo meal recognition (GPT-4o Vision)**.|
|6|Activity Tracker|Logging & comparing movement|`activity_tracker.prompty`|Logs movement **with intensity**; reports week-over-week trends + streaks. Deterministic **MET-based** calorie estimate; delete/summary tools.|
|7|Activity Goal Setter|Adaptive goals & roadmaps|`activity_goal_setter.prompty`|Builds a **layered** weight/activity roadmap (month/week/day); adapts on weigh-in & life events. **All numbers come from the deterministic energy plan — never LLM-computed.**|
|8|Micro Learner|Micro-lessons & quiz|`micro_learner.prompty`|Short **sourced** micro-lesson + one-question quiz, grounded in the **iMpuls** knowledge base; topics queued by other agents.|
|9|Fact-Checker|Answer grounding vs. knowledge base|`fact_checker.prompty`|Grounds each verifiable claim against the vetted KB; ranks by **8-level Swiss-first authority** (lower tier = more authoritative), cites the best source, **blocks confident contradictions**. "Supported" always carries a real source.|

  

  
All prompt text is in German. Metadata (`## Metadaten` table) per agent: Name,

Beschreibung, Autoren (HEiCO Platform), Tags. No per-prompt version numbers — rely on the  
document-level `Stand` date + the `.prompty` source path.
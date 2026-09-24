This page describes **how HEiCO keeps its coaching safe** and **how it keeps a coherent, correct picture of the user across a fleet of agents**. The two topics are treated together because they share one design principle and one source of truth.

---

## 1. Design principle — enforce in code, phrase with the LLM

Every safety mechanism in HEiCO follows the same split, and it is the single most important idea on this page:

> **The LLM interprets language and phrases the answer. Deterministic code classifies risk and enforces the hard limits. A limit is never "please don't" in a prompt — it is a refusal in code.**

This gives **defence in depth** — an LLM classifier layer around the turn, an agent-proof enforcement layer at persistence, and a knowledge layer that grounds output claims:  
 

![](https://wiki.migros.net/download/attachments/1064415496/guardrail.png?version=1&modificationDate=1784270679349&api=v2#1785142828562)

  

  

_Blue = Guardian (LLM classify → policy) · green = deterministic, agent-proof enforcement · red = safety outcome shown to the user._

- **Layer 1 — Guardian** (§2): an inline, LLM-based _classifier_ wrapped by an LLM-free _policy_, run before and after every turn.
- **Layer 2 — Deterministic server-side safety** (§3): the API refuses to _persist_ anything unsafe, regardless of what any LLM decides. This is what makes the numbers trustworthy.
- **Allergy checking** (§4) and **Context management** (§5) complete the picture.

---

## 2. Guardian Agent — inline pre/post safety gate

**Full design: [`agent-guardian.md`](https://file+.vscode-resource.vscode-cdn.net/c%3A/Users/3219/projects/impuls_health_companion/docs/agent-guardian.md).** Summary for this concept:

The Guardian sits **outside** the orchestrator loop as mandatory middleware on every turn. It deliberately separates **classification (LLM)** from **policy (pure Python)** so policy can change without touching prompts. It is **text-only and stateless** — it judges only the text in front of it and knows nothing of the stored profile or history (state-dependent rules live in Layers 2 & 5). It **fails open**: a Guardian outage is logged and the turn proceeds as `allow`, so the safety layer can never take the chat down.

### Categories

The LLM classifier ([`prompts/guardian_classifier.prompty`](https://file+.vscode-resource.vscode-cdn.net/c%3A/Users/3219/projects/impuls_health_companion/prompts/guardian_classifier.prompty)) returns `{category, severity, rationale}`; the policy ([`agents/guardian/policy.py`](https://file+.vscode-resource.vscode-cdn.net/c%3A/Users/3219/projects/impuls_health_companion/agents/guardian/policy.py) `decide()`) maps category → action:

|Category|Detects|Pre (input)|Post (output)|
|---|---|---|---|
|`crisis_self_harm`|suicide, self-harm, hopelessness with intent|**hard_block** (hotline)|hard_block|
|`eating_disorder`|extreme-restriction / purging / body-image distress language|**hard_block** (BZgA)|hard_block¹|
|`medical_advice`|user asks for diagnosis/dosage **or** assistant gives concrete medical claims|soft_warn (disclaimer)|soft_warn|
|`prompt_injection`|override instructions, exfiltrate system prompt, change role|**hard_block** + refusal|soft_warn¹|
|`pii`|real identifying data (full address, phone, national ID)|soft_warn|soft_warn|
|`extreme_diet`|crash diets, OMAD, multi-day fasting, < ~1200 kcal/day|**hard_block**|hard_block|
|`supplement_dosing`|concrete supplement/vitamin doses (Guardrail #12)|**hard_block** (→ doctor/pharmacy)|hard_block|
|`unrealistic_goal`|unsafe loss/gain pace ("10 kg in 10 days")|soft_warn (0.5–1 kg/wk)|soft_warn|
|`other` / `none`|relevant-but-uncategorised / nothing|allow¹|allow|

`hard_block` replaces the turn with a predefined protective message; `soft_warn` appends a disclaimer. ¹ = known refinements tracked in [`agent-guardian.md`](https://file+.vscode-resource.vscode-cdn.net/c%3A/Users/3219/projects/impuls_health_companion/docs/agent-guardian.md) §"Bekannte Lücken" (e.g. severity-aware blocking, `other` policy, output-mode `prompt_injection`).

### Evidence hierarchy + max-2-iteration feedback loop

The **output** stage is more than the Guardian post-check. After the assistant drafts an answer, the orchestrator runs, in parallel, the **Guardian post-check** and the **Fact-Checker**, which grounds each verifiable claim against the vetted knowledge base. The KB stores every source with a **`priority_tier`** — an **evidence hierarchy** (authoritative guidelines rank above consumer content); a confident contradiction (confidence ≥ `FACT_CHECK_BLOCK_THRESHOLD` = **0.6**) blocks or corrects the claim. See [`agent-fact-checker.md`](https://file+.vscode-resource.vscode-cdn.net/c%3A/Users/3219/projects/impuls_health_companion/docs/agent-fact-checker.md).

If either check flags the draft, the orchestrator feeds the verdict back and the LLM **revises** — a **bounded feedback loop of at most `MAX_OUTPUT_REVISIONS` = 2 iterations** ([`agents/orchestrator/turn.py`](https://file+.vscode-resource.vscode-cdn.net/c%3A/Users/3219/projects/impuls_health_companion/agents/orchestrator/turn.py)). After the last attempt the final verdict is applied deterministically: `block` → the safe canned message is shown; `annotate` → the correction/disclaimer is appended below the answer. The loop is bounded so a stubborn draft cannot spin forever or delay the user indefinitely.

---

## 3. Deterministic server-side safety — agent-proof persistence gates

The Guardian screens _text_; this layer governs _state_. No goal, target or plan is trustworthy unless the **API itself** refuses to store an unsafe one. Every rule below is enforced at the persistence endpoint and returns **machine fields only** (HTTP 422 with an error code); the agent phrases the refusal in the user's language and **never claims the write succeeded**. Because it is at the API, it is **agent-proof** — no LLM (or prompt injection) can bypass it.

### The deterministic guard-rails (constants reviewable in one place)

The energy plan  is a **pure calculator, not an LLM** (unit-tested, 39 assertions):

|Guard|Value / rule|Enforced as|
|---|---|---|
|**Unsafe pace**|max **0.75 kg/wk** · **0.5** with pre-existing conditions/medication · **0.35** high stress / low readiness · **0** in pregnancy|`422 unsafe_pace` (+ `suggested_target_value`)|
|**BMI floor**|no weight target below **BMI 20** (`healthy_min_weight_kg`); lower wishes are clamped and flagged `below_healthy_minimum`|`422 target_below_healthy_minimum`|
|**Starvation-level kcal**|calorie target never below **1500 kcal** (men) / **1200 kcal** (women/unknown); food deficit capped at 700 kcal/day, rest becomes activity|`422 calorie_goal_below_floor`|
|**Title/value coherence**|an absolute target weight titled as an amount-to-lose is rejected|`422 title_value_mismatch`|
|**Dietary-advice block**|pregnant or eating-disorder ⇒ **no weight/calorie goals at all**; movement/step/habit goals stay allowed|`422 dietary_advice_not_allowed`|

The `dietary_advice_allowed` flag is **derived server-side** on every profile save (not agent-settable); flipping it to false **auto-retires** active weight/calorie goals in the same transaction. Detail and files: [`dietary-advice-gate.md`](https://file+.vscode-resource.vscode-cdn.net/c%3A/Users/3219/projects/impuls_health_companion/docs/dietary-advice-gate.md).

### All-or-nothing multi-goal writes

A coaching plan is a _set_ (monthly + weekly + daily goals). It is persisted through one atomic batch endpoint (`POST /api/goals/batch`): **every item passes the same gates, or none persists** — the 422 lists each refusal with its index so the agent can re-plan the exact item. This prevents a half-saved, internally-inconsistent plan (e.g. a weekly pace saved while the safe monthly target was refused).

### Form-first onboarding for hard-fact capture

Safety rules depend on **hard facts** (§5) — height, age, sex, conditions, medications, pregnancy, allergies. Relying on these to _emerge in chat_ is unreliable, so after login a **structured profile form** (`ProfileGate` / `OnboardingForm`) captures them directly; free-text health notes are then evaluated by the LLM into the structured `pregnancy_status` / `has_eating_disorder` inputs. Hard facts are captured **deterministically by form**, not hoped for in conversation.

---

## 4. Allergy checking — reference & extend (PULSLEAN-227)

## Centre of gravity

A deterministic, server-side gate at the persistence endpoints. The Meal Planner agent (and any other client) cannot persist an entry containing one of the user's allergens, regardless of what the LLM proposes. Enforcement lives at the API layer because that is the only place it is agent-proof; the LLM-driven "suggest an alternative" behaviour lives in the agent.

```
POST /api/meals/entries
POST /api/calories/entries   (+ PATCH /api/calories/entries/{id})

scan(entry text) ∩ user.allergies     → 422 allergen_conflict {ingredient, matched_allergen}
scan(entry text) ∩ user.intolerances  → 201 + advisories[]   (agent suggests alternative)
```

## Allergen data store

### What it guarantees

> A user can **never have a meal or food entry saved that contains one of their declared allergens.** A declared **intolerance** does not block the entry — it produces a non-blocking advisory the assistant uses to offer a swap.

This holds **regardless of what the assistant proposes**, because the check runs where the data is _saved_, not in a prompt (see _Why server-side_).

### Two severities

|Match against the user's…|Severity|Behaviour|
|---|---|---|
|**allergies**|**block**|The save is refused, **nothing is stored**, and the caller is told which ingredient matched which allergen.|
|**intolerances**|**advisory**|The entry **is saved**; a non-blocking advisory is returned so the assistant can suggest an alternative.|

The split reflects the difference in stakes: an allergy is a safety hard-stop that must be enforceable without the LLM; an intolerance is a comfort matter where the useful action — proposing a substitute — needs the assistant.

### Why server-side (agent-proof)

The gate lives at the point of **persistence** — the moment a meal or food entry is written. That is the only place it is truly agent-proof: even if the assistant is mistaken, or is steered by a prompt-injection attempt, an entry containing a declared allergen simply **cannot be stored**. The "suggest an alternative" behaviour is the assistant's job; the gate itself **only detects** — it never proposes replacements.

### The allergen catalog

Matching vocabulary comes from a single versioned catalog of the **14 Swiss declarable allergen groups** — cereals containing gluten, crustaceans, eggs, fish, peanuts, soy, milk, tree nuts, celery, mustard, sesame, sulphites, lupin, molluscs.

Each group carries:

- **Localised display labels** in German / French / Italian (the languages the recipes use), for the onboarding pick-list.
- **Matching terms** — the many ways an allergen appears in ingredient text across languages, spellings, plurals and derived ingredients.

The catalog is **versioned** and carries a **review date**, so the system can flag when the list is due for re-checking against a new revision of the official reference (a _freshness_ / _staleness_ signal surfaced to onboarding and operations). It is the single source of matching vocabulary — there are no ad-hoc allergen terms anywhere else.

### How matching works

Both sides — the user's declared allergens and the food text — are **normalised the same way**: lower-cased, **accents folded** (`crème` → `creme`, `Erdnüsse` → `erdnusse`), whitespace collapsed.

The system then matches in one of two modes, chosen by how clean the input is:

- **Meals — precise (clean-name) matching.** A planned meal carries **structured ingredients**, each a _clean name_ plus a display amount (e.g. name `Milch`, amount `150 ml`). Because the name is a clean field, the gate matches ingredient **names by whole-token equality**. This is exact and free of compound-word false positives — e.g. `Hafermilch` (oat milk) does **not** falsely trigger _milk_.
- **Food / calorie log — recall-first matching.** A logged food item is a single free-text string (e.g. `"150ml Milch"`), so there the gate looks for an allergen term **anywhere in the text**. It is deliberately tuned toward **recall**: a _missed_ allergen is dangerous, whereas an _over-cautious_ block is merely annoying — so in the free-text path the system errs on the side of blocking.

Both modes share the same safeguards:

- **Length-aware** — long terms match as substrings; very short terms (≤ 3 characters, e.g. `egg`, `ei`) match only on word boundaries, so `eggplant` / `Reis` are not falsely flagged.
- **Most-specific-wins** — the longest matching term is the one reported, so `Erdnussbutter` maps to _peanuts_ (not _milk_ via "butter"), and the result is order-independent.
- **Negation guard** — "allergen-free" phrasing is treated as safe: `milchfrei`, `glutenfreies Brot`, `ohne Milch`, `sans lait`, `senza …`.
- **Stopword guard** — safe words that merely _contain_ an allergen term are ignored: `Genuss` / `Muskatnuss` (→ _nuss_), `Buchweizen` (→ _weizen_), `Kokosmilch` (→ _milch_).
- **Legacy free-text** — a user who typed an allergen as free text (`"Erdnuss"`) still resolves to the correct group.

Recall ultimately scales with **catalog completeness**: a pure synonym that shares no substring with a known term (e.g. `Cheddar` → _milk_) only matches once it is added to the catalog.

### Onboarding & the pick-list

During onboarding the user picks their allergens from the localised 14-group list (stored as stable group identifiers). **Intolerances stay free text** — there is no curated intolerance taxonomy yet — but they are still scanned and surfaced as advisories (never a block). The pick-list is served in the user's language (de/fr/it) together with the freshness flag.

### Pre-flight check — a shared capability

Beyond the block-on-save backstop, the system offers a **stateless "check these ingredients" capability** that any agent can call **while planning, before anything is saved**. It persists nothing and returns the same conflict / advisory information as the save-time gate.

The flow in practice:

1. Before proposing or saving a meal, the assistant **pre-checks** the ingredients.
2. On a conflict it chooses a **different ingredient** and re-checks — so in the normal case the user never sees a refusal at all.
3. The **save-time gate remains the authoritative final backstop**: a skipped or buggy pre-check can never let an allergen through. This is defence in depth — the same "check before write, enforce on write" shape used by the other safety gates.

Because the check is a shared capability rather than meal-planner-specific, every agent that touches food (meal planner, calorie tracker, status checker) can use the same allergy logic.

---

## 5. Context management — one profile, shared, correctly

Safe coaching needs a **single, correct picture of the user** available to every agent. HEiCO achieves this with one source of truth and a hard/soft-fact distinction.

### 5.1 The profile is a single source of truth: MCP → API

There is **no per-agent memory of who the user is.** Each agent reads the profile **per request** through an **MCP tool that calls the HEiCO API** (`get_user_profile` / `get_status_snapshot` → `/api/status`, `/api/status/snapshot`), carrying the user's JWT from the request headers. The API + its database are the single source of truth; agents are stateless with respect to identity.

Consequences:

- **Consistency** — every agent sees the same profile at the same moment; there is no drift between, say, what the Goal-Setter believes the weight is and what the Calorie-Tracker believes.
- **Freshness** — a profile change is visible to the next tool call from any agent immediately.
- **Least privilege** — an agent's MCP tool whitelist (`HEICO_MCP_TOOLS`) limits which slices it can read/write; the profile read is scoped to safety-relevant fields (e.g. the Fact-Checker reads only conditions, meds, allergies, pregnancy, age, weight, diet — enough to judge contraindication, nothing more).

### 5.2 Hard-Facts vs Soft-Facts

Not all profile data carries the same weight. HEiCO distinguishes:

||**Hard-Facts**|**Soft-Facts**|
|---|---|---|
|**What**|demographics (age, sex, height), current/target weight + date, **health conditions, medications, pregnancy status, eating-disorder flag, allergies/intolerances**|motivation type & drivers, communication/psychological style, cuisine preferences, cooking skill, mood/journal signals|
|**Why they matter**|drive the **safety gates** (§3) and allergy check (§4) — a wrong hard fact can make advice unsafe|shape _tone, suggestions and nudges_ — a wrong soft fact makes advice less tailored, not unsafe|
|**Capture**|**form-first** (§3.3) + structured writes; the LLM only _extracts_ them into structured fields, it never invents them|conversational, inferred over time; low-stakes to revise|
|**Governance**|`dietary_advice_allowed` is **derived, server-side, not agent-settable**; hard facts are validated on write|freely updatable by the relevant agent|

This split is the reason the numbers are safe: the LLM's role on hard facts is confined to _turning language into a structured field_ ("I'm expecting" → `pregnancy_status = pregnant`); the _consequence_ (no weight goals) is then computed and enforced in code.

### 5.3 Profile sharing across agents

Because sub-agents are stateless, the orchestrator also passes the **recent conversation turns** (read-only, via a request-scoped context) so a specialist can resolve references like "log _that_" without owning history. Combined with the per-request profile read, each agent gets exactly the context it needs — identity from the API, recent references from the orchestrator — with no long-lived, drift-prone per-agent state.
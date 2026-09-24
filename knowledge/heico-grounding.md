# HEiCO Grounding and Knowledge Base

## 1. How HEiCO grounds what it says

HEiCO never lets the model invent facts, recipes or numbers. Every kind of claim is anchored to a dedicated, reviewable source:

|Claim type|Grounded in|Enforced by|
|---|---|---|
|Health / nutrition advice|the vetted knowledge base (curated third-party guidance)|the Fact Checker — cites the source, blocks confident contradictions|
|Recipe / meal suggestions|the recipe data source (bundled, branded recipes)|the Meal Planner — must search it before proposing, must not invent a "sourced" recipe|
|Numbers (calorie target, safe pace, dates)|the deterministic energy plan (pure calculator)|the API — see [energy-plan.md](https://file+.vscode-resource.vscode-cdn.net/c%3A/Users/3219/projects/impuls_health_companion/docs/energy-plan.md)|

This page covers the first two (the knowledge base and the recipe/nutrition data) and the data inventory behind them.

---

## 2. Knowledge base — a hybrid-curated, frozen corpus

### 2.1 Curation approach (hybrid: AI-suggested + expert-reviewed)

The knowledge base is curated, not scraped. Candidate sources are AI-suggested and then reviewed and approved by a human/domain expert before ingestion. This keeps the corpus small, trustworthy and auditable — the coach only ever grounds advice in sources a person has signed off.

### 2.2 Ingested content

At the current freeze the corpus contains:

- Factual / guideline documents — Swiss and international nutrition & health guidance (e.g. Swiss nutrition recommendations, Federal activity recommendations, and evidence-based nutrition guidelines) used to substantiate advice.
- Migusto recipes — with allergen and nutrition enrichment (each recipe carries its allergen-relevant ingredients and nutrition values so it can be filtered and cited).
- ~50 iMpuls articles — Migros' own vetted consumer-health content, the everyday backbone of the advice grounding.

### 2.3 Cut-off state at freeze

The corpus is a frozen snapshot taken at a defined cut-off. There is no live web access at runtime — the Fact Checker searches only the vetted index, and the Meal Planner searches only the bundled recipe source. If a topic is outside the frozen corpus, the system says so rather than fabricating a citation. Refreshing the corpus is a deliberate, reviewed re-ingestion, not a background live crawl.

---

## 3. Source-priority scale (8-level, Swiss-first) and how it is enforced

### 3.1 The scale

Every ingested passage carries a deterministic authority label — a `priority_tier` on an 8-level, Swiss-first hierarchy. The label is assigned at ingestion (part of the curated metadata), not judged by the model at query time, so it is stable and reviewable.

- Swiss-first: Swiss official and Migros-trusted sources rank above equivalent foreign content.
- iMpuls = high, deterministic: Migros' own iMpuls content is placed high on the scale by fixed rule — it is the trusted everyday layer, ranked above general international consumer content.
- Convention: lower tier number = more authoritative. On conflicting guidance, the lower-tier (more authoritative) source wins.

Illustratively (grounded in the labels observed in the live index), the scale runs from Swiss official / Migros-vetted sources at the top, through international evidence-based guidelines, down to general reference content — with the exact per-source tier fixed at ingestion and open to expert review.

### 3.2 How the Fact Checker enforces it

When it verifies an answer, the Fact Checker retrieves candidate passages and then:

1. Sorts by authority first, relevance second — candidates are ordered by `priority_tier` (ascending = most authoritative first), then by retrieval score.
2. Prefers the most authoritative supporting passage as the citation, so a Swiss/iMpuls source is chosen over an equivalent lower-ranked one.
3. Blocks or corrects a confident contradiction — if the best evidence contradicts the drafted claim above a confidence threshold, the claim is blocked/corrected rather than shown; otherwise the supporting source is attached (the "supported" badge always carries a real source).

The authority label therefore does real work: it decides which source is cited and which side wins when sources disagree.

---

## 4. RAG mechanics

### 4.1 A dedicated MCP search layer

Retrieval is isolated behind a dedicated knowledge search service (its own MCP server). Agents never touch the web or the index directly — they call one search capability and receive passages with `title`, `citation`, `source_url`, `priority_tier` and a relevance `score`. This keeps grounding a single, swappable, auditable capability shared across agents (Fact Checker and Micro-Learner today).

### 4.2 Embedding & caching

- Hybrid retrieval by default. The query is embedded (Azure OpenAI `text-embedding-3-small`) for a vector k-NN search and, in parallel, run as a keyword (BM25) search over the same text; the two are combined. (Pure-vector mode is available via configuration.)
- Caching. The search and embedding clients are cached, and a shared embedding-cache layer avoids re-embedding repeated queries — keeping latency and token cost down.

### 4.3 Known limits

- Paraphrase / synonym matching. A claim phrased very differently from the source text, or a pure synonym that shares no wording with an indexed term, can be missed or matched to a weaker passage. The empirical [sourcing-relevance review](https://file+.vscode-resource.vscode-cdn.net/c%3A/Users/3219/projects/impuls_health_companion/docs/factcheck-sourcing-relevance-review.md) shows this: some hits land on the right document but a non-substantiating passage, and specific numbers are not always backed by the exact cited passage.
- Coverage. The frozen corpus is finite. Topics outside it come back unsupported — which is the intended, honest behaviour (no invented citation), but it means the "% of advice backed by sources" depends on corpus breadth.

### 4.4 Agreed MVP extensions

Two extensions are agreed to raise coverage and authority beyond the frozen corpus:

- On-demand PubMed. When the curated KB lacks coverage for a claim, fetch primary literature from PubMed on demand — adding authoritative evidence for long-tail topics without bloating the frozen corpus.
- Automated research loop. A background process that continuously proposes new candidate sources (found automatically) into the expert-review queue — automating the intake half of the hybrid-curation model (§2.1) while keeping the human sign-off.

---

## 5. Data inventory

### 5.1 User profile

The user profile is the single source of truth for who the user is (managed via the API — see [guardrail-context-management-concept.md](https://file+.vscode-resource.vscode-cdn.net/c%3A/Users/3219/projects/impuls_health_companion/docs/guardrail-context-management-concept.md) §5). It splits into safety-relevant Hard-Facts and personalisation Soft-Facts:

|Group|Fields (representative)|
|---|---|
|Hard-Facts|age / sex / height; current + target weight and date; health conditions, medications, pregnancy status, eating-disorder flag; allergies / intolerances|
|Soft-Facts|dietary pattern, cuisine preferences, cooking skill, equipment, budget; fitness level; motivation & communication style; stress / sleep; journal (mood) signals|

### 5.2 Recipe database

- ~400 recipes in German / French / Italian locale bundles, each visibly carrying its brand / source label (Migusto, iMpuls, Migros, AdR).
- Enrichment: allergen-relevant ingredients and nutrition values, so recipes can be filtered against the user's allergies and dietary pattern and cited with their source and link.
- Served through the same search layer; in the PoC this bundled source is the only recipe path — no live/internet recipe lookup.

### 5.3 Calorie & nutrition data

- Logged intake — calorie entries with macros (protein, carbohydrates, fat, fibre) and meal type.
- Targets & goals — the user's recorded calorie/macro goal, plus the deterministic daily target derived by the energy plan (the single source of the numbers).

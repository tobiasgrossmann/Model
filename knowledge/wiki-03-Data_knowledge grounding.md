## 1. How HEiCO grounds what it says

HEiCO never lets the model invent facts, recipes or numbers. Every kind of claim is anchored to a dedicated, reviewable source:

|Claim type|Grounded in|Enforced by|
|---|---|---|
|Health / nutrition **advice**|the **vetted knowledge base** (curated third-party guidance)|the **Fact Checker** — cites the source, blocks confident contradictions|
|**Recipe / meal** suggestions|the **recipe data source** (bundled, branded recipes)|the **Meal Planner** — must search it before proposing, must not invent a "sourced" recipe|
|**Numbers** (calorie target, safe pace, dates)|the **deterministic energy plan** (pure calculator)|the API — see [`energy-plan.md`](https://file+.vscode-resource.vscode-cdn.net/c%3A/Users/3219/projects/impuls_health_companion/docs/energy-plan.md)|

This page covers the first two (the knowledge base and the recipe/nutrition data) and the data inventory behind them.

---

## 2. Knowledge base — a hybrid-curated, frozen corpus

### 2.1 Curation approach (hybrid: AI-suggested + expert-reviewed)

The knowledge base is **curated, not scraped**. Candidate sources are **AI-suggested** and then **reviewed and approved by a human/domain expert** before ingestion. This keeps the corpus small, trustworthy and auditable — the coach only ever grounds advice in sources a person has signed off.

### 2.2 Ingested content

At the current freeze the corpus contains:

- **Factual / guideline documents** — Swiss and international nutrition & health guidance (e.g. Swiss nutrition recommendations, Federal activity recommendations, and evidence-based nutrition guidelines) used to substantiate advice.
- **Migusto recipes** — with **allergen and nutrition enrichment** (each recipe carries its allergen-relevant ingredients and nutrition values so it can be filtered and cited).
- **~50 iMpuls articles** — Migros' own vetted consumer-health content, the everyday backbone of the advice grounding.

### 2.3 Cut-off state at freeze

The corpus is a **frozen snapshot** taken at a defined cut-off. **There is no live web access at runtime** — the Fact Checker searches only the vetted index, and the Meal Planner searches only the bundled recipe source. If a topic is outside the frozen corpus, the system says so rather than fabricating a citation. Refreshing the corpus is a deliberate, reviewed re-ingestion, not a background live crawl.

---

## 3. Source-priority scale (8-level, Swiss-first) and how it is enforced

### 3.1 The scale

Every ingested passage carries a **deterministic authority label** — a `priority_tier` on an **8-level, Swiss-first hierarchy**. The label is assigned **at ingestion** (part of the curated metadata), not judged by the model at query time, so it is stable and reviewable.

- **Swiss-first:** Swiss official and Migros-trusted sources rank above equivalent foreign content.
- **iMpuls = high, deterministic:** Migros' own iMpuls content is placed **high** on the scale by fixed rule — it is the trusted everyday layer, ranked above general international consumer content.
- **Convention:** **lower tier number = more authoritative.** On _conflicting_ guidance, the lower-tier (more authoritative) source wins.

Illustratively (grounded in the labels observed in the live index), the scale runs from Swiss official / Migros-vetted sources at the top, through international evidence-based guidelines, down to general reference content — with the exact per-source tier fixed at ingestion and open to expert review.

### 3.2 How the Fact Checker enforces it

When it verifies an answer, the Fact Checker retrieves candidate passages and then:

1. **Sorts by authority first, relevance second** — candidates are ordered by `priority_tier` (ascending = most authoritative first), then by retrieval score.
2. **Prefers the most authoritative supporting passage** as the citation, so a Swiss/iMpuls source is chosen over an equivalent lower-ranked one.
3. **Blocks or corrects a confident contradiction** — if the best evidence contradicts the drafted claim above a confidence threshold, the claim is blocked/corrected rather than shown; otherwise the supporting source is attached (the "supported" badge always carries a real source).

The authority label therefore does real work: it decides _which_ source is cited and _which side wins_ when sources disagree.

---

## 4. RAG mechanics

### 4.1 A dedicated MCP search layer

Retrieval is isolated behind a **dedicated knowledge search service** (its own MCP server). Agents never touch the web or the index directly — they call one search capability and receive passages with `title`, `citation`, `source_url`, `priority_tier` and a relevance `score`. This keeps grounding a single, swappable, auditable capability shared across agents (Fact Checker and Micro-Learner today).

### 4.2 Embedding & caching

- **Hybrid retrieval by default.** The query is **embedded** (Azure OpenAI `text-embedding-3-small`) for a **vector k-NN** search and, in parallel, run as a **keyword (BM25)** search over the same text; the two are combined. (Pure-vector mode is available via configuration.)
- **Caching.** The search and embedding clients are cached, and a shared embedding-cache layer avoids re-embedding repeated queries — keeping latency and token cost down.

### 4.3 Known limits

- **Paraphrase / synonym matching.** A claim phrased very differently from the source text, or a pure synonym that shares no wording with an indexed term, can be missed or matched to a weaker passage. The empirical [sourcing-relevance review](https://file+.vscode-resource.vscode-cdn.net/c%3A/Users/3219/projects/impuls_health_companion/docs/factcheck-sourcing-relevance-review.md) shows this: some hits land on the right document but a non-substantiating passage, and specific numbers are not always backed by the exact cited passage.
- **Coverage.** The frozen corpus is finite. Topics outside it come back **unsupported** — which is the intended, honest behaviour (no invented citation), but it means the "% of advice backed by sources" depends on corpus breadth.

### 4.4 Agreed MVP extensions

Two extensions are agreed to raise coverage and authority beyond the frozen corpus:

- **On-demand PubMed.** When the curated KB lacks coverage for a claim, fetch primary literature from PubMed on demand — adding authoritative evidence for long-tail topics without bloating the frozen corpus.
- **Automated research loop.** A background process that continuously **proposes new candidate sources** (found automatically) into the **expert-review queue** — automating the intake half of the hybrid-curation model (§2.1) while keeping the human sign-off.

---

## 5. Data inventory

### 5.1 User profile

The user profile is the single source of truth for who the user is (managed via the API — see [`guardrail-context-management-concept.md`](https://file+.vscode-resource.vscode-cdn.net/c%3A/Users/3219/projects/impuls_health_companion/docs/guardrail-context-management-concept.md) §5). It splits into safety-relevant **Hard-Facts** and personalisation **Soft-Facts**:

|Group|Fields (representative)|
|---|---|
|**Hard-Facts**|age / sex / height; current + target weight and date; **health conditions, medications, pregnancy status, eating-disorder flag**; **allergies / intolerances**|
|**Soft-Facts**|dietary pattern, cuisine preferences, cooking skill, equipment, budget; fitness level; motivation & communication style; stress / sleep; journal (mood) signals|

### 5.2 Recipe database

- **~400 recipes** in **German / French / Italian** locale bundles, each visibly carrying its brand / source label (**Migusto, iMpuls, Migros, AdR**).
- **Enrichment:** allergen-relevant ingredients and **nutrition values**, so recipes can be filtered against the user's allergies and dietary pattern and cited with their source and link.
- Served through the same search layer; in the PoC this bundled source is the **only** recipe path — no live/internet recipe lookup.

### 5.3 Calorie & nutrition data

- **Logged intake** — calorie entries with macros (protein, carbohydrates, fat, fibre) and meal type.
- **Targets & goals** — the user's recorded calorie/macro goal, plus the deterministic daily target derived by the energy plan (the single source of the numbers).

## Heico Knowledge Base — Source Inventory

### Overview

The knowledge base contains 107 curated documents from trusted sources (Switzerland, Germany, Austria and international organisations), spread across seven thematic categories. Each source is assigned an editorial priority level (tier) that influences ranking during retrieval (tier 1 = highest priority, tier 8 = lowest). Every text chunk stored in the KB carries its source URL for full traceability. Document titles are retained in their original German.

### Documents per category

|Category|Count|
|---|---|
|Movement & Fitness|22|
|Nutrition & Weight Management|38|
|Obesity Medicine|9|
|Diabetes & Metabolism|6|
|Sleep Medicine|8|
|Stress & Relaxation|10|
|Cross-cutting|14|
|**Total**|**107**|

### Priority levels (tiers)

|Tier|Description|Docs|
|---|---|---|
|1|National guidelines Switzerland (SGED, BAG)|5|
|2|National recommendations CH – non-clinical (BLV, BASPO, GFCH)|73|
|3|Guidelines neighbouring countries, esp. Germany (AWMF S3, DGE)|19|
|4|International guidelines / organisations (WHO, EU)|3|
|5|Systematic reviews & meta-analyses|0|
|6|Single studies (top journals: NEJM, Lancet)|0|
|7|Practice resources & specialist portals (e.g. Migros iMpuls)|2|
|8|General health websites / content|5|

### Movement & Fitness

_22 documents_

|ID|Title|Organisation|Source|Tier|
|---|---|---|---|---|
|F-01|BASPO Bewegungsempfehlungen - Übersicht|BASPO|[link](https://www.baspo.admin.ch/de/bewegungsempfehlungen)|2|
|F-02|hepa Bewegungsempfehlungen Schweiz - Grundlagen|hepa (Bund)|[link](https://www.hepa.admin.ch/dam/de/sd-web/ctDpaHOOgso1/bewegungsempfehlungen_schweiz_grundlagen_de.pdf)|2|
|F-03|Sport Schweiz 2020 - Forschungsbericht|BASPO|[link](https://www.baspo.admin.ch/dam/de/sd-web/LPWWI4E3JNOe/Forschungsbericht-Sport-Schweiz-light-2022_DE.pdf)|2|
|F-04|Sport Schweiz 2020 - Factsheets|BASPO|[link](https://www.baspo.admin.ch/dam/de/sd-web/yf5AyqbGaegB/Sport-Schweiz2020-factsheets_DE.pdf)|2|
|F-05|Gesundheitswirksame Bewegung - Grundlagendokument|Gesundheitsförderung Schweiz|[link](https://gesundheitsfoerderung.ch/sites/default/files/migration/documents/Gesundheitswirksame_Bewegung_-_Grundlagendokument.pdf)|2|
|F-06|Förderung der regelmässigen Bewegung|Gesundheitsförderung Schweiz|[link](https://gesundheitsfoerderung.ch/kantonale-aktionsprogramme/themen-und-publikationen/themen/foerderung-der-regelmaessigen-bewegung)|2|
|G-11|Hot Topic: Ernährung während dem Sport (Trinkmenge)|Swiss Sports Nutrition Society|[link](https://www.ssns.ch/wp-content/uploads/2023/12/HotTopic_Ernaehrung_waehrend_Sport_2.5.pdf)|2|
|G-12|Supplementguide: Sportgetränke|Swiss Sports Nutrition Society|[link](https://www.ssns.ch/wp-content/uploads/2022/10/SG-FB-Sportgetraenke_V3.1.pdf)|2|
|M-01|Fakten über Kalorien: Mythen und Wahrheit|Migros iMpuls|[link](https://impuls.migros.ch/de/bewegung/sportwissen/kalorien-verbrennen/fakten-kalorien)|2|
|M-02|10 Trainings-Mythen im Check|Migros iMpuls|[link](https://impuls.migros.ch/de/bewegung/sportwissen/richtig-trainieren/trainingsmythen)|2|
|M-03|Wie oft und wie lange Ausdauer trainieren?|Migros iMpuls|[link](https://impuls.migros.ch/de/bewegung/fitness/ausdauertraining/wie-oft-wie-lange-trainieren)|2|
|M-04|Was verbrennt wie viele Kalorien?|Migros iMpuls|[link](https://impuls.migros.ch/de/bewegung/sportwissen/bewegung-im-alltag/kalorienverbrennung)|2|
|M-05|Wie Schlaf die Regeneration fördert: Tipps für Sportler|Migros iMpuls|[link](https://impuls.migros.ch/de/bewegung/sportwissen/regeneration/schlafen-foerdert-regeneration)|2|
|M-06|Regeneration: Darum braucht der Körper Pausen nach dem Sport|Migros iMpuls|[link](https://impuls.migros.ch/de/bewegung/sportwissen/regeneration/pausen-im-sport)|2|
|M-07|Übertraining: Auswirkungen & Gefahren|Migros iMpuls|[link](https://impuls.migros.ch/de/bewegung/sportwissen/regeneration/uebertraining)|2|
|M-08|Krafttraining: Mit und ohne Geräte Muskeln aufbauen|Migros iMpuls|[link](https://impuls.migros.ch/de/bewegung/fitness/krafttraining)|2|
|M-09|Muskelaufbau: wie komme ich zu mehr Muskeln?|Migros iMpuls|[link](https://impuls.migros.ch/de/bewegung/fitness/krafttraining/muskelaufbau)|2|
|M-10|Ausdauer verbessern mit dem richtigen Training|Migros iMpuls|[link](https://impuls.migros.ch/de/bewegung/fitness/ausdauertraining)|2|
|M-11|Zwei Minuten Training ist so gut wie 30 Minuten|Migros iMpuls|[link](https://impuls.migros.ch/de/bewegung/sportwissen/richtig-trainieren/2-min-training-so-gut-wie-30)|2|
|M-12|Muskelverletzungen: Die Reha macht den Unterschied|Migros iMpuls|[link](https://impuls.migros.ch/de/medizin/sportmedizin/therapie/reha-training)|2|
|G-28|Österreichische Bewegungsempfehlungen (Wissensband 17)|Fonds Gesundes Österreich|[link](https://fgoe.org/sites/fgoe.org/files/2020-06/WB17_bewegungsempfehlungen_bfrei.pdf)|3|
|F-07|Bewegungsförderung über die Arztpraxis|Paprica|[link](https://www.paprica.ch/de/category/aerzte/)|7|

### Nutrition & Weight Management

_38 documents_

|ID|Title|Organisation|Source|Tier|
|---|---|---|---|---|
|N-09|Praxisleitfaden Adipositas (BAG-Seite)|BAG|[link](https://www.bag.admin.ch/de/praxisleitfaden-adipositas)|1|
|N-10|Praxisleitfaden Consensus Adipositas|SGED / ASEMO|[link](https://www.sgedssed.ch/SgedSsed/fileadmin/1_ueber_uns/15_ASEMO/praxisleitfaden-consensus-adipositas-druck-de.pdf)|1|
|N-11|Swiss obesity clinical practice guidance (SMW 2026)|SGED/ASEMO/SMOB/AKJ|[link](https://www.sgedssed.ch/SgedSsed/fileadmin/9_Adipositas/smw-2026-5415.pdf)|1|
|G-01|Schweizer Ernährungsempfehlungen für Erwachsene – Langversion|BLV / SGE|[link](https://www.blv.admin.ch/dam/blv/de/dokumente/lebensmittel-und-ernaehrung/ernaehrung/schweizer-ernaehrungsempfehlungen-lang.pdf.download.pdf/Schweizer%20Ern%C3%A4hrungsempfehlungen_Langversion_DE.pdf)|2|
|G-02|Salzreduktion – Strategie & Empfehlung (5 g/Tag, WHO)|BLV|[link](https://www.blv.admin.ch/blv/de/home/lebensmittel-und-ernaehrung/ernaehrung/produktzusammensetzung/salzstrategie.html)|2|
|G-04|Zuckerreduktion – Strategie & Empfehlung (<10% Energie)|BLV|[link](https://www.blv.admin.ch/blv/de/home/lebensmittel-und-ernaehrung/ernaehrung/produktzusammensetzung/zuckerreduktion.html)|2|
|M-13|Blutzucker senken oder stabil halten: 9 Tipps|Migros iMpuls|[link](https://impuls.migros.ch/de/ernaehrung/idealgewicht/ernaehrungsberatung/blutzucker-tipps)|2|
|M-14|Was du über den Blutzucker wissen solltest|Migros iMpuls|[link](https://impuls.migros.ch/de/ernaehrung/idealgewicht/ernaehrungsberatung/blutzucker-wissen)|2|
|M-15|6 Zuckermythen zu Zucker und Zuckerersatz|Migros iMpuls|[link](https://impuls.migros.ch/de/ernaehrung/ernaehrungsformen/zuckerfreie-ernaehrung/zuckermythen)|2|
|M-16|Was essen vor und nach dem Sport? Die besten Tipps|Migros iMpuls|[link](https://impuls.migros.ch/de/ernaehrung/ernaehrungswissen/was-essen-vor-und-nach-dem-training)|2|
|M-17|Studie: Wie man sein Herzinfarktrisiko senkt|Migros iMpuls|[link](https://impuls.migros.ch/de/ernaehrung/naehrstoffe-vitamine-co/fette/herzinfarkt-und-fettarme-ernaehrung)|2|
|M-18|Diäten zum Abnehmen: Überblick und Vergleich|Migros iMpuls|[link](https://impuls.migros.ch/de/ernaehrung/idealgewicht/diaeten/diaeten-auf-dem-pruefstand)|2|
|M-19|Fasten im Check: Wirkung, Vorteile, Risiken und Methoden|Migros iMpuls|[link](https://impuls.migros.ch/de/ernaehrung/idealgewicht/fasten/fasten-vor-und-nachteile)|2|
|M-20|Was bringt Intervallfasten (intermittierendes Fasten)?|Migros iMpuls|[link](https://impuls.migros.ch/de/ernaehrung/idealgewicht/fasten/intervallfasten-wirkung-von-intermittierendem-fasten)|2|
|M-21|Wie beeinflussen Hormone unser Gewicht und das Abnehmen?|Migros iMpuls|[link](https://impuls.migros.ch/de/ernaehrung/idealgewicht/gesund-abnehmen/hormone-gewicht)|2|
|M-22|Körperfett messen: Methoden und gesunde Werte|Migros iMpuls|[link](https://impuls.migros.ch/de/ernaehrung/idealgewicht/gewicht-halten/koerperfett-messen)|2|
|M-23|14 Abnehm-Mythen – und was dran ist|Migros iMpuls|[link](https://impuls.migros.ch/de/ernaehrung/idealgewicht/gesund-abnehmen/abnehm-mythen)|2|
|M-24|Optimale Ernährung für Muskelaufbau|Migros iMpuls|[link](https://impuls.migros.ch/de/ernaehrung/ernaehrungswissen/ernaehrung-muskelaufbau)|2|
|M-25|Jo-Jo-Effekt vermeiden: So hältst du dein Gewicht stabil|Migros iMpuls|[link](https://impuls.migros.ch/de/ernaehrung/idealgewicht/diaeten/jo-jo-effekt)|2|
|M-26|Glykämischer Index: Wie Zucker den Körper beeinflusst|Migros iMpuls|[link](https://impuls.migros.ch/de/ernaehrung/ernaehrungsformen/zuckerfreie-ernaehrung/glykaemischer-index)|2|
|N-01|Schweizer Ernährungsempfehlungen - Kurzversion|BLV / SGE|[link](https://www.sge-ssn.ch/media/e23asbw5/schweizer-ernaehrungsempfehlungen_kurzversion_de-1.pdf)|2|
|N-02|Schweizer Ernährungsempfehlungen - Langversion|SGE|[link](https://www.sge-ssn.ch/media/ytunwxgr/schweizer-ernaehrungsempfehlungen_langversion_de.pdf)|2|
|N-05|FAQ Schweizer Ernährungsempfehlungen|BLV / SGE|[link](https://www.blv.admin.ch/dam/blv/de/dokumente/lebensmittel-und-ernaehrung/ernaehrung/faq-schweizer-ernaehrungsempfehlungen.pdf.download.pdf/FAQ%20Schweizer%20Ern%C3%A4hrungsempfehlungen.pdf)|2|
|N-06|Schweizer Ernährungsempfehlungen - Langversion (BLV)|BLV|[link](https://www.blv.admin.ch/dam/blv/de/dokumente/lebensmittel-und-ernaehrung/ernaehrung/schweizer-ernaehrungsempfehlungen-lang.pdf.download.pdf/Schweizer%20Ern%C3%A4hrungsempfehlungen_Langversion_DE.pdf)|2|
|N-07|Ernährungsempfehlungen - Wiss. Hauptbericht 2023|BLV|[link](https://www.blv.admin.ch/dam/blv/de/dokumente/lebensmittel-und-ernaehrung/ernaehrung/ch-ernaehrungsempfehlungs-bericht.pdf.download.pdf/BLV_Main%20report_20230628.pdf)|2|
|N-08|Ernährungsempfehlungen - Annex 2023|BLV|[link](https://www.blv.admin.ch/dam/blv/de/dokumente/lebensmittel-und-ernaehrung/ernaehrung/ch-ernaerungs-bericht-annex.pdf.download.pdf/Annex_20230628.pdf)|2|
|G-14|Konsensuspapier Zuckerzufuhr (DAG/DDG/DGE 2018)|DGE/DAG/DDG|[link](https://www.dge.de/fileadmin/dok/wissenschaft/stellungnahmen/Konsensuspapier_Zucker_DAG_DDG_DGE_2018.pdf)|3|
|G-15|Evidenzbasierte Leitlinie Fettzufuhr (2015)|DGE|[link](https://www.dge.de/fileadmin/dok/wissenschaft/leitlinien/fette/Gesamt-DGE-Leitlinie-Fett-2015.pdf)|3|
|G-16|Evidenzbasierte Leitlinie Kohlenhydratzufuhr|DGE|[link](https://www.dge.de/fileadmin/dok/wissenschaft/leitlinien/kohlenhydrate/DGE-Leitlinie-KH-ohne-Anhang_Tabellen.pdf)|3|
|G-17|DACH-Referenzwerte: Protein|DGE|[link](https://www.dge.de/wissenschaft/referenzwerte/protein/)|3|
|G-21|Neubewertung DGE-Position vegane Ernährung (2024)|DGE|[link](https://www.dge.de/wissenschaft/stellungnahmen-und-positionspapiere/positionen/neubewertung-der-position-zu-veganer-ernaehrung/)|3|
|G-22|FAQ Speisesalz (DGE)|DGE|[link](https://www.dge.de/gesunde-ernaehrung/faq/speisesalz/)|3|
|G-27|Österreichische Ernährungsempfehlungen (Pyramide)|BMSGPK / AGES|[link](https://www.sozialministerium.gv.at/Themen/Gesundheit/Ern%C3%A4hrung/%C3%96sterreichische-Ern%C3%A4hrungsempfehlungen-NEU.html)|3|
|G-29|WHO Zucker-Empfehlungen in allen Lebensphasen|AGES|[link](https://www.ages.at/mensch/ernaehrung-lebensmittel/ernaehrungsempfehlungen/who-zucker-empfehlungen)|3|
|N-04|Gut essen und trinken - DGE-Empfehlungen|DGE|[link](https://www.dge.de/gesunde-ernaehrung/gut-essen-und-trinken/dge-empfehlungen/)|3|
|N-03|Ernährungs- & Gesundheitsmythen|EUFIC|[link](https://www.eufic.org/de/)|4|
|N-12|WHO Healthy Diet - Fact Sheet|WHO|[link](https://www.who.int/news-room/fact-sheets/detail/healthy-diet)|4|
|N-13|WHO Obesity and Overweight - Fact Sheet|WHO|[link](https://www.who.int/news-room/fact-sheets/detail/obesity-and-overweight)|4|

### Obesity Medicine

_9 documents_

|ID|Title|Organisation|Source|Tier|
|---|---|---|---|---|
|M-27|10 Fakten zu Übergewicht: Was du wissen musst|Migros iMpuls|[link](https://impuls.migros.ch/de/medizin/krankheiten/adipositas/fakten-uebergewicht)|2|
|M-28|Adipositas: Ursachen, Folgen und Behandlung|Migros iMpuls|[link](https://impuls.migros.ch/de/medizin/krankheiten/adipositas/adipositas-ursachen-behandlung)|2|
|M-29|Studie: Übergewicht und Adipositas in der Schweiz|Migros iMpuls|[link](https://impuls.migros.ch/de/medizin/krankheiten/adipositas/adipositas-studie)|2|
|M-30|Übergewicht: Das Zusammenspiel von Psyche und Gewicht|Migros iMpuls|[link](https://impuls.migros.ch/de/medizin/krankheiten/adipositas/gewicht-und-psyche)|2|
|M-31|Adipositas und Übergewicht bei Kindern|Migros iMpuls|[link](https://impuls.migros.ch/de/medizin/krankheiten/adipositas/adipositas-uebergewicht-kinder)|2|
|A-01|S3 Leitlinie Adipositas - Prävention & Therapie (050-001)|AWMF (DAG)|[link](https://register.awmf.org/de/leitlinien/detail/050-001)|3|
|G-24|Patientenleitlinie Adipositas (0,5 kg/Woche)|DAG / AWMF|[link](https://adipositas-gesellschaft.de/wp-content/uploads/2020/06/Patientenleitlinie_Adipositas.pdf)|3|
|G-25|S3-Leitlinie Prävention & Therapie der Adipositas (2024)|DAG / AWMF|[link](https://register.awmf.org/assets/guidelines/050-001l_S3_Praevention-Therapie-Adipositas_2024-10.pdf)|3|
|A-06|GLP-1-Agonisten in der Adipositas-Therapie|Rosenfluh / Ars Medici|[link](https://www.rosenfluh.ch/media/arsmedici/2025/09/Gewicht-verlieren-Begleiterkrankungen-verbessern-GLP-1-Agonisten-in-der-Therapie-der-Adipositas.pdf)|7|

### Diabetes & Metabolism

_6 documents_

|ID|Title|Organisation|Source|Tier|
|---|---|---|---|---|
|D-03|SGED Empfehlungen Diabetes mellitus Typ 2 (2023)|SGED/SSED|[link](https://www.sgedssed.ch/SgedSsed/fileadmin/6_Diabetologie/61_Empfehlungen_Facharzt/SGED-SSED_long_Recommendations_2023_de.pdf)|1|
|M-32|Diabetes: Typen, Symptome und Behandlung|Migros iMpuls|[link](https://impuls.migros.ch/de/medizin/krankheiten/diabetes/diabetes-allgemein)|2|
|M-33|Wie ernährt man sich bei Diabetes Typ 2?|Migros iMpuls|[link](https://impuls.migros.ch/de/medizin/krankheiten/diabetes/was-essen-bei-diabetes-mellitus-typ-2)|2|
|M-34|Diabetes Typ 2: Ursachen und Symptome|Migros iMpuls|[link](https://impuls.migros.ch/de/medizin/krankheiten/diabetes/diabetes-typ2)|2|
|M-35|Diabetes Typ 1 – Insulin und gute Betreuung sind essentiell|Migros iMpuls|[link](https://impuls.migros.ch/de/medizin/krankheiten/diabetes/diabetes-typ-1)|2|
|D-01|S3 Therapie des Typ-1-Diabetes (057-013)|AWMF|[link](https://register.awmf.org/assets/guidelines/057-013l_S3-Therapie-Typ-1-Diabetes_2023-09_1.pdf)|3|

### Sleep Medicine

_8 documents_

|ID|Title|Organisation|Source|Tier|
|---|---|---|---|---|
|S-01|Schlafapnoe - Diagnose & Therapie|SGSSC / BAG|[link](https://www.bag.admin.ch/dam/de/sd-web/88loGSyIjW0f/Empfehlungen%20der%20SSSSC%20zu%20Diagnose%20und%20Therapie%20der%20Schlafapnoe.pdf)|1|
|M-36|Durchschlafstörungen: Ursachen, Symptome und was hilft|Migros iMpuls|[link](https://impuls.migros.ch/de/entspannung/schlafen/besser-schlafen/durchschlafstoerungen)|2|
|M-37|10 Schlaf-Mythen im Check|Migros iMpuls|[link](https://impuls.migros.ch/de/entspannung/schlafen/besser-schlafen/schlafmythen)|2|
|M-38|Was essen vor dem Schlafen? Tipps für deine Nachtruhe|Migros iMpuls|[link](https://impuls.migros.ch/de/entspannung/schlafen/besser-schlafen/besser-essen-besser-schlafen)|2|
|M-39|10 Tipps für besseren Tiefschlaf|Migros iMpuls|[link](https://impuls.migros.ch/de/entspannung/schlafen/besser-schlafen/schlaftipps)|2|
|M-40|Schlaflosigkeit: Ursachen, Auswirkungen und Tipps|Migros iMpuls|[link](https://impuls.migros.ch/de/entspannung/schlafen/schlafstoerungen/schlaflosigkeit)|2|
|M-41|Schlafapnoe: Symptome und Behandlung|Migros iMpuls|[link](https://impuls.migros.ch/de/entspannung/schlafen/schlafstoerungen/apnoe)|2|
|S-02|Schlafapnoe (Patienteninfo)|Lungenliga|[link](https://www.lungenliga.ch/krankheiten-therapien/schlafapnoe)|8|

### Stress & Relaxation

_10 documents_

|ID|Title|Organisation|Source|Tier|
|---|---|---|---|---|
|M-42|Welche Rolle spielen Stress und Schlaf bei Übergewicht?|Migros iMpuls|[link](https://impuls.migros.ch/de/entspannung/stress/stresssymptome/stress-schlaf-uebergewicht)|2|
|M-43|Stresssymptome: Körperliche & psychische Anzeichen erkennen|Migros iMpuls|[link](https://impuls.migros.ch/de/entspannung/stress/stresssymptome/auswirkungen-von-stress)|2|
|M-44|Stress abbauen: 12 Methoden für mehr Entspannung|Migros iMpuls|[link](https://impuls.migros.ch/de/entspannung/stress/stressmanagement/das-hilft-gegen-stress)|2|
|M-45|Burnout vorbeugen: Symptome, Prävention und Behandlung|Migros iMpuls|[link](https://impuls.migros.ch/de/entspannung/work-life-balance/burnout/burnout-vorbeugen)|2|
|M-46|Meditation: In der Ruhe liegt die Kraft|Migros iMpuls|[link](https://impuls.migros.ch/de/entspannung/entspannungstechniken/meditation)|2|
|M-47|Autogenes Training: Entspannung durch Selbstbeeinflussung|Migros iMpuls|[link](https://impuls.migros.ch/de/entspannung/entspannungstechniken/meditation/autogenes-training)|2|
|M-48|Mehr Achtsamkeit im Alltag: Tipps und Übungen|Migros iMpuls|[link](https://impuls.migros.ch/de/entspannung/entspannungstechniken/achtsamkeit/achtsamkeit-tipps)|2|
|E-01|Psychosoziale Risiken am Arbeitsplatz|SECO|[link](https://www.seco.admin.ch/seco/de/home/Arbeit/Arbeitsbedingungen/gesundheitsschutz-am-arbeitsplatz/Psychosoziale-Risiken-am-Arbeitsplatz.html)|8|
|E-02|Psychische Gesundheit|BAG|[link](https://www.bag.admin.ch/de/psychische-gesundheit)|8|
|E-03|Belastungen am Arbeitsplatz / Stress & Ressourcen|SUVA|[link](https://www.suva.ch/de-ch/praevention/beratung-kurse-und-angebote/praeventionsberatung/bgm-betriebliches-gesundheitsmanagement/work-life-balance-stress-und-ressourcen)|8|

### Cross-cutting

_14 documents_

|ID|Title|Organisation|Source|Tier|
|---|---|---|---|---|
|G-06|Empfehlungen zu Vitamin D (600 IE Erw., 800 IE ab 60)|BLV|[link](https://www.blv.admin.ch/dam/blv/de/dokumente/lebensmittel-und-ernaehrung/ernaehrung/empfehlungen-vitamin-d.pdf.download.pdf/empfehlungen-vitamin-d.pdf)|2|
|G-07|Fachinformation zu Vitamin D|BLV|[link](https://www.blv.admin.ch/dam/blv/de/dokumente/lebensmittel-und-ernaehrung/ernaehrung/fachinformation-vitamin-d.pdf.download.pdf/fachinformation-vitamin-d.pdf)|2|
|G-08|Empfehlungen zu risikoarmem Alkoholkonsum 2021|Sucht Schweiz / EKAL|[link](https://www.suchtschweiz.ch/wp-content/uploads/2023/07/Drinking-Guidelines-2021.pdf)|2|
|G-09|Gesundheitliche Risiken des Alkoholkonsums|BAG|[link](https://www.bag.admin.ch/de/gesundheitliche-risiken-des-alkoholkonsums)|2|
|G-10|FAQ Ernährung rund um Schwangerschaft und Stillzeit|BLV|[link](https://www.blv.admin.ch/dam/blv/de/dokumente/lebensmittel-und-ernaehrung/ernaehrung/faq-ernaehrung-rund-um-schwangerschaft-und-stillzeit.pdf.download.pdf/FAQ_Ern%C3%A4hrung_rund_um_Schwangerschaft_und_Stillzeit_DE.pdf)|2|
|G-13|Bluthochdruck – Patientenratgeber|Schweizerische Herzstiftung|[link](https://rehasportmedizin.insel.ch/fileadmin/Rehasportmedizin/Dokumente/Patientenportal/Schweizer_Herzstiftung/Deutsch/1.037_Bluthochdruck_DE_2021.pdf)|2|
|M-49|Der Body-Mass-Index sagt nicht alles|Migros iMpuls|[link](https://impuls.migros.ch/de/medizin/medizinisches-wissen/koerperwerte/bmi-hinterfragt)|2|
|M-50|Resilienz, das Krafttraining für die Psyche|Migros iMpuls|[link](https://impuls.migros.ch/de/medizin/gesund-im-alltag/psychische-gesundheit/resilienz)|2|
|G-18|DACH-Referenzwerte: Vitamin D|DGE|[link](https://www.dge.de/wissenschaft/referenzwerte/vitamin-d/)|3|
|G-19|DACH-Referenzwerte: Eisen|DGE|[link](https://www.dge.de/wissenschaft/referenzwerte/eisen/)|3|
|G-20|DACH-Referenzwerte: Folat|DGE|[link](https://www.dge.de/wissenschaft/referenzwerte/folat/)|3|
|G-23|BfR Höchstmengen Vitamine & Mineralstoffe (2024)|BfR|[link](https://www.bfr.bund.de/cm/343/aktualisierte-hoechstmengenvorschlaege-fuer-vitamine-und-mineralstoffe-in-nahrungsergaenzungsmitteln-und-angereicherten-lebensmitteln-2024.pdf)|3|
|G-26|Fakten zum Rauchen: Gewichtszunahme durch Rauchstopp|DKFZ|[link](https://www.dkfz.de/fileadmin/user_upload/Krebspraevention/Download/pdf/FzR/FzR_2011_Gewichtszunahme-durch-einen-Rauchstopp.pdf)|3|
|U-02|Gesundheitsförderung & Prävention|BAG|[link](https://www.bag.admin.ch/de/gesundheitsfoerderung-praevention)|8|
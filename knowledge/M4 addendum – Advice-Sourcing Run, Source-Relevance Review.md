**Input:** the 30-request evidence in [factcheck-sourcing-evidence.md](https://file+.vscode-resource.vscode-cdn.net/c%3A/Users/3219/projects/impuls_health_companion/docs/factcheck-sourcing-evidence.md) (every reply was `supported` — 100 % _sourced_). This review goes a layer deeper: **how good are the cited sources**, on two independent axes, for each of the 30 requests.

## Method & rubric

Each request is scored **/10 on two axes** (higher = better):

- **Score A — given the vector database** (retrieval / passage quality _relative to this corpus_): Does the cited passage actually match the claim, and is it the kind of source this KB can realistically offer? Penalises wrong-passage hits (table-of-contents lines, cost-estimate pages, off-topic anchors), duplicate citations padding the count, and tangential articles. Rewards on-topic, distinct, well-chosen passages.
- **Score B — independent of the database** (absolute evidential strength): Regardless of KB limits, how well do these sources _substantiate the specific advice_ against an ideal standard — authoritative primary guideline, precise to the claim (especially any numbers)? Penalises consumer/marketing content used as "evidence" and sources that don't cover the stated numbers/claims. Rewards primary guidelines (DGE, SGE/BLV, AWMF S3, hepa) that directly back it.

**Corpus note:** the KB is dominated by **Migros iMpuls** consumer-wellness articles (labelled "Tier 2"), plus a smaller set of authoritative guidelines — **DGE, SGE/BLV, AWMF S3, hepa, Fonds Gesundes Österreich** ("Tier 3"). This is expert (LLM-as-evaluator) judgement based on the cited passages and known corpus composition; it does not re-enumerate every alternative the index _could_ have returned.

## Scores

|#|Request (topic)|Unique / cited sources|A: given DB|B: absolute|Note|
|---|---|---|---|---|---|
|1|Protein beim Abnehmen|1 / 2|5|3|1 consumer article (dup), only backs muscle-loss part; satiety/metabolism unsourced|
|2|Ballaststoffe/Tag|2 / 3|7|7|DGE + AWMF S3 — authoritative & on-topic; exact 25–30 g not quoted|
|3|Vollkorn vs. Weißmehl|2 / 4|8|8|DGE "Vollkorn ist die beste Wahl" — bullseye, authoritative|
|4|Zucker & Gewichtszunahme|2 / 2|6|5|insulin/hormones + DGE; the insulin→fat-storage claim is oversimplified|
|5|Wasser 1,5–2 L|3 / 3|9|8|SGE/BLV + DGE + AGES — the exact authoritative bodies, all on beverages|
|6|Gesunde Fette|1 / 2|7|6|DGE fat guideline (dup); backs heart, not vitamin-absorption/brain claims|
|7|Intervallfasten|1 / 3|5|3|one consumer article ×3 incl. a **poll anchor**; IF benefits overstated, no guideline|
|8|Alkohol & Abnehmen|3 / 3|7|5|direct "Alkohol begünstigt Übergewicht" anchor + AWMF S3; mechanism weakly evidenced|
|9|Ballaststoffe & Verdauung|1 / 1|3|3|cites a **table-of-contents line**, not fiber content — non-substantiating|
|10|Zuckerhaltige Getränke|3 / 3|5|5|AWMF/DGE relevant, but one source is about **calorie-burning** (off-topic)|
|11|Aktivität 150 min/Woche|1 / 1|3|4|right doc, wrong page ("**Kostenschätzung für Österreich**") — doesn't state 150 min|
|12|Krafttraining/Muskelerhalt|4 / 4|7|5|4 distinct on-topic articles; all consumer, no primary guideline|
|13|Ausdauer vs. Kraft|2 / 3|5|5|2 of 3 are the same anchor duplicated|
|14|Ruhetage|2 / 2|7|5|direct regeneration + overtraining-myth hits; consumer|
|15|Spazierengehen|2 / 2|5|5|activity docs generally, not walking-specific; hepa authoritative|
|16|Bewegung & Herz-Kreislauf|4 / 5|6|6|Gesundheitsförderung CH + Herzstiftung good; some odd anchors ("3. Grad schwer")|
|17|Bewegung & Stress|2 / 3|5|4|dup; "endorphins/Glückshormone" is popular-science, not evidenced|
|18|Abnehmtempo 0,5–1 kg/Wk|1 / 1|4|4|single consumer "Tipps" anchor; doesn't state the safe-rate number|
|19|Jo-Jo-Effekt|3 / 3|7|5|dedicated "So vermeidest du den Jo-Jo-Effekt" — direct; consumer concept|
|20|Kaloriendefizit|3 / 3|6|5|on-topic; energy-balance is well-established but only consumer-cited|
|21|Trotz Sport nicht ab|3 / 3|6|4|covers the named factors; loosely evidenced multi-factor claim|
|22|Schlaf & Gewicht|2 / 4|6|5|very on-topic; 3 of 4 from one article; leptin/ghrelin link is real|
|23|Crash-Diäten|3 / 3|7|5|direct crash/mono-diet hits; consensus-aligned, consumer|
|24|Schlaf 7–9 h|3 / 3|6|5|"8 Stunden" anchor on-topic; number standard but not authoritatively cited|
|25|Chron. Stress & Gewicht|2 / 4|6|4|cortisol/emotional-eating anchors; cortisol→belly-fat is nuanced|
|26|Wenig Schlaf → Heißhunger|2 / 4|7|6|**"Leptin und Ghrelin"** bullseye; effect is science-supported|
|27|Achtsames Essen|1 / 1|6|6|DGE "Mahlzeiten genießen" — authoritative, on-point|
|28|Heißhunger vorbeugen|4 / 4|7|5|good spread (nutrition/sleep/hydration incl. SGE); mainstream claim|
|29|Regelmäßiger Essrhythmus|3 / 3|4|3|no source is meal-timing–specific; claim itself weakly evidenced|
|30|Pflanzliche Ernährung|3 / 5|4|4|cited passages (diabetes recipes, "Psyche") don't back the cancer/eco claims|

## Aggregate

|Metric|Score|
|---|---|
|**Mean — A (given the vector DB)**|**5.9 / 10**|
|**Mean — B (independent / absolute)**|**4.9 / 10**|
|A distribution|8–9: 2 · 6–7: 16 · 5: 7 · 3–4: 5|
|B distribution|7–8: 3 · 5–6: 17 · 3–4: 10|

The **~1-point A-over-B gap** means the corpus itself is a _moderate_ limiter — but the larger drag is **retrieval/passage quality and corpus authority**, not just what's in the DB. Every reply was technically "sourced," yet the _relevance_ is middling: good enough to show a citation, not consistently strong evidence.

## Key findings

1. **Duplicate citations inflate the count.** ~13 of 30 cite the _same_ article 2–3× (e.g. #7 the Intervallfasten piece ×3, #13, #22, #25, #26). The headline "N sources" overstates diversity — true unique-source counts are often 1–2.
2. **Right document, wrong passage.** Several hits land on non-substantiating text: a table-of-contents line (#9), a "Kostenschätzung" cost page (#11), a reader **poll** (#7), a calorie-burning article for a _sugary-drinks_ claim (#10). These are the lowest scorers on both axes.
3. **Specific numbers are rarely backed by the cited passage.** 150 min/week (#11), 0.5–1 kg/week (#18), 25–30 g fibre (#2), 7–9 h sleep (#24): the figures are standard, but the exact passage cited usually doesn't state them.
4. **Corpus skews consumer.** Migros iMpuls dominates — great for lay explanations, weaker as _evidence_. The **highest-scoring items (#3 Vollkorn, #5 Wasser, #2 Ballaststoffe, #27 achtsames Essen)** are exactly where an **authoritative guideline (DGE / SGE-BLV)** was retrieved.
5. **Weakest topics** are where the claim itself is under-evidenced or the KB lacks a precise source: #7 (Intervallfasten), #9 (fibre→digestion), #11 (activity dose), #29 (meal-rhythm), #30 (plant-based → cancer/eco). Several of these are borderline `unsupported` if judged strictly.

## Recommendations

1. **De-duplicate evidence** before it's stored/shown — collapse identical `source_url`+anchor hits so the citation count reflects distinct sources.
2. **Passage-level relevance filtering** — drop hits whose passage is a TOC/index/cost/poll line or whose similarity score is very low (the #11 hit scored ~0.05). Prefer passages that contain the claim's key terms/numbers.
3. **Enrich the KB with authoritative primaries** for the recurring gaps — WHO/national **activity** guidelines (fixes #11, #15), a **protein** reference (fixes #1), **sleep-duration** guidance (#24), and a **safe weight-loss-rate** source (#18). This is the single biggest lever on Score B.
4. **Number-aware retrieval / citation** — when the answer states a figure, prefer a source passage that states the same figure; otherwise surface the claim as general guidance rather than implying the number is cited.
5. **Tighten the `supported` bar** — require the cited passage to actually address the claim (not just be from a topical document), so borderline items (#9, #11, #29) fall to `unsupported` and surface real KB coverage gaps instead of a false 100 %.

---

_Scores are expert (LLM-as-evaluator) judgement over the cited evidence and known corpus composition; they are directional, not a substitute for a clinician's source review._
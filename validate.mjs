// validate.mjs
// Cheap, deterministic quality gate for generated training examples.
// Run AFTER generate.mjs. Does not call any LLM — pure structural/content
// checks, so it catches exactly the failure modes that a trimmed prompt
// context makes more likely, without costing any inference.
//
// Usage: node validate.mjs
// Reads:  ./out/generated.jsonl
// Writes: ./out/validated.jsonl (examples that pass all checks)
//         ./out/flagged.jsonl   (examples with at least one issue, + why)
//         ./out/diversity_report.json (distribution + overlap metrics)

import fs from "node:fs";
import path from "node:path";

const OUT_DIR = process.env.OUT_DIR || "./out";
const SPEC_DIR = process.env.SPEC_DIR || "./specs";

const catalog = JSON.parse(fs.readFileSync(path.join(SPEC_DIR, "kb_source_catalog.json"), "utf8"));
const knownUrls = new Set(catalog.documents.map((d) => d.url));
const knownTitles = catalog.documents.map((d) => d.title);

const seenPersonas = new Set(); // "age|sex|height|weight" fingerprints, to catch repeats

function normalizeText(s) {
  return String(s || "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .replace(/[^\p{L}\p{N}\s]/gu, "")
    .trim();
}

function toNgrams(text, n = 3) {
  const tokens = normalizeText(text).split(" ").filter(Boolean);
  if (tokens.length < n) return new Set(tokens.length ? [tokens.join(" ")] : []);
  const grams = new Set();
  for (let i = 0; i <= tokens.length - n; i++) {
    grams.add(tokens.slice(i, i + n).join(" "));
  }
  return grams;
}

function jaccard(a, b) {
  if (!a.size && !b.size) return 1;
  let inter = 0;
  for (const x of a) if (b.has(x)) inter++;
  const union = a.size + b.size - inter;
  return union === 0 ? 0 : inter / union;
}

function extractAssistantText(example) {
  return (example.messages || [])
    .filter((m) => m.role === "assistant" && typeof m.content === "string")
    .map((m) => m.content)
    .join("\n");
}

function extractUserAssistantText(example) {
  return (example.messages || [])
    .filter((m) => (m.role === "user" || m.role === "assistant") && typeof m.content === "string")
    .map((m) => m.content)
    .join("\n");
}

function hasToolCall(example, toolName) {
  return (example.messages || []).some((m) =>
    Array.isArray(m.tool_calls) && m.tool_calls.some((tc) => tc.function?.name === toolName)
  );
}

function hasToolResult(example) {
  return (example.messages || []).some((m) => m.role === "tool");
}

function hasAnyAssistantToolCalls(example) {
  return (example.messages || []).some((m) => Array.isArray(m.tool_calls) && m.tool_calls.length > 0);
}

function inc(map, key) {
  map[key] = (map[key] || 0) + 1;
}

function topicFromText(text) {
  const t = normalizeText(text);
  const rules = [
    { k: "allergy", re: /allerg|nuss|gluten|laktose|soja|schalenfrucht|erdnuss/ },
    { k: "pregnancy", re: /schwanger|pregnan|grossesse|incinta/ },
    { k: "weight_loss", re: /abnehm|lose weight|perdre|dimagr|kalorienziel|kcal/ },
    { k: "medical_scope", re: /diagnos|medikament|supplement|arzt|docteur|medico/ },
    { k: "exercise", re: /train|exercise|bewegung|cardio|kraft|hiit/ },
    { k: "sleep_recovery", re: /schlaf|sleep|hrv|resting heart|regeneration/ },
  ];
  for (const rule of rules) {
    if (rule.re.test(t)) return rule.k;
  }
  return "other";
}

function canonicalGuardrail(value) {
  const m = String(value || "").toUpperCase().match(/G\d+/);
  return m ? m[0] : (value || "unknown");
}

function parseNumericFromText(text, field) {
  const re = new RegExp(`${field}["\\s:]+(\\d+(?:\\.\\d+)?)`, "i");
  const m = text.match(re);
  return m ? parseFloat(m[1]) : null;
}

function extractAnthropometrics(text) {
  const jsonHeight = parseNumericFromText(text, "height_cm");
  const jsonWeight = parseNumericFromText(text, "weight_kg");
  const jsonAge = parseNumericFromText(text, "age");

  const inlineHeightWeight = text.match(/(\d+(?:[.,]\d+)?)\s*kg\D{0,30}(\d+(?:[.,]\d+)?)\s*cm/i);
  const inlineWeightHeight = text.match(/(\d+(?:[.,]\d+)?)\s*cm\D{0,30}(\d+(?:[.,]\d+)?)\s*kg/i);
  const inlineWeightHeightLoose = text.match(/(\d+(?:[.,]\d+)?)\D{0,20}(?:cm\s*)?(?:gro(?:ss|ß)|gross)\D{0,20}(\d+(?:[.,]\d+)?)\s*kg/i);
  const inlineHeightOnlyLoose = text.match(/(\d{3})\s*(?:cm)?\s*(?:gro(?:ss|ß)|gross)/i);
  const metricHeight = text.match(/(?:\b|[^\d])(1(?:[.,]\d{1,2})?)\s*m\b|(?:\b|[^\d])(1)m(\d{2})\b/i);
  const inlineAge = text.match(/\bich bin\s+(\d{1,2})\b|\bjai\s+(\d{1,2})\s+ans\b|\bho\s+(\d{1,2})\s+anni\b/i);

  let weight = jsonWeight;
  let height = jsonHeight;

  if (weight == null || height == null) {
    if (inlineHeightWeight) {
      weight = weight ?? parseFloat(inlineHeightWeight[1].replace(",", "."));
      height = height ?? parseFloat(inlineHeightWeight[2].replace(",", "."));
    } else if (inlineWeightHeight) {
      height = height ?? parseFloat(inlineWeightHeight[1].replace(",", "."));
      weight = weight ?? parseFloat(inlineWeightHeight[2].replace(",", "."));
    } else if (inlineWeightHeightLoose) {
      height = height ?? parseFloat(inlineWeightHeightLoose[1].replace(",", "."));
      weight = weight ?? parseFloat(inlineWeightHeightLoose[2].replace(",", "."));
    }
  }

  if (height == null && inlineHeightOnlyLoose) {
    height = parseFloat(inlineHeightOnlyLoose[1].replace(",", "."));
  }

  if (height == null && metricHeight) {
    if (metricHeight[1]) {
      height = parseFloat(metricHeight[1].replace(",", ".")) * 100;
    } else if (metricHeight[2] && metricHeight[3]) {
      height = parseFloat(`${metricHeight[2]}${metricHeight[3]}`);
    }
  }

  return {
    age: jsonAge ?? (inlineAge ? parseFloat((inlineAge[1] || inlineAge[2] || inlineAge[3]).replace(",", ".")) : null),
    height,
    weight,
  };
}

function extractExplicitBmiClaim(text) {
  const match = text.match(/BMI([^\d]{0,20})(\d{1,2}[.,]\d)/i);
  if (!match) return null;
  const bridge = match[1].toLowerCase();
  if (/(unter|below|below the threshold|<|<=|sous|inferieur|inférieur|inferiore|meno di)/i.test(bridge)) {
    return null;
  }
  return parseFloat(match[2].replace(",", "."));
}

function hasExactBmiClaim(text) {
  return extractExplicitBmiClaim(text) != null;
}

function buildDiversityReport(examples) {
  const overlapThreshold = 0.85;
  const gramsByExample = [];
  let overlapPairs = 0;
  let comparedPairs = 0;
  const sampledPairCap = 150000;

  const persona = {
    sex: {},
    age_band: {},
    height_band_cm: {},
    weight_band_kg: {},
  };
  const topics = {};
  const byLanguage = {};
  const byGuardrail = {};

  for (let i = 0; i < examples.length; i++) {
    const ex = examples[i];
    const text = extractText(ex);
    const assistantText = extractAssistantText(ex);
    const convoText = extractUserAssistantText(ex);
    const combined = `${text}\n${assistantText}`;
    const grams = toNgrams(combined, 3);
    gramsByExample.push(grams);

    // persona distributions
    const sexMatch = text.match(/"sex"\s*:\s*"([^"]+)"/i);
    const sex = sexMatch ? sexMatch[1].toLowerCase() : "unknown";
    inc(persona.sex, sex);

    const age = parseNumericFromText(text, "age");
    const height = parseNumericFromText(text, "height_cm");
    const weight = parseNumericFromText(text, "weight_kg");

    const ageBand = age == null
      ? "unknown"
      : age < 30
        ? "18-29"
        : age < 45
          ? "30-44"
          : age < 60
            ? "45-59"
            : "60+";
    inc(persona.age_band, ageBand);

    const heightBand = height == null
      ? "unknown"
      : height < 160
        ? "<160"
        : height < 175
          ? "160-174"
          : height < 190
            ? "175-189"
            : "190+";
    inc(persona.height_band_cm, heightBand);

    const weightBand = weight == null
      ? "unknown"
      : weight < 60
        ? "<60"
        : weight < 75
          ? "60-74"
          : weight < 90
            ? "75-89"
            : "90+";
    inc(persona.weight_band_kg, weightBand);

    inc(topics, topicFromText(convoText));
    inc(byLanguage, ex.language || "unknown");
    inc(byGuardrail, canonicalGuardrail(ex.guardrail));
  }

  // Pairwise n-gram overlap with safety cap for very large datasets.
  for (let i = 0; i < gramsByExample.length; i++) {
    for (let j = i + 1; j < gramsByExample.length; j++) {
      if (comparedPairs >= sampledPairCap) break;
      comparedPairs += 1;
      const ov = jaccard(gramsByExample[i], gramsByExample[j]);
      if (ov >= overlapThreshold) overlapPairs += 1;
    }
    if (comparedPairs >= sampledPairCap) break;
  }

  return {
    totals: {
      validated_examples: examples.length,
      compared_pairs: comparedPairs,
      high_overlap_pairs: overlapPairs,
      high_overlap_ratio: comparedPairs ? Number((overlapPairs / comparedPairs).toFixed(4)) : 0,
      overlap_threshold: overlapThreshold,
      compared_pairs_cap: sampledPairCap,
    },
    distribution: {
      language: byLanguage,
      guardrail: byGuardrail,
      persona,
      topic: topics,
    },
  };
}

function extractText(example) {
  return example.messages
    .filter((m) => typeof m.content === "string")
    .map((m) => m.content)
    .join("\n");
}

// 1. Citation check: flag any URL, or any string that looks like a document
//    title, that isn't in the real catalog. Catches invented sources.
function checkCitations(example) {
  const text = extractText(example);
  const issues = [];
  const urlMatches = text.match(/https?:\/\/\S+/g) || [];
  for (const url of urlMatches) {
    const clean = url.replace(/[).,]$/, "");
    if (!knownUrls.has(clean)) issues.push(`unknown URL cited: ${clean}`);
  }
  // Loose heuristic: phrases like "laut Studie", "gemäss Studie", "eine Studie zeigt"
  // with no matching catalog title nearby suggest an invented study reference.
  if (/laut (einer |der )?studie|gemäss studie|studien zeigen/i.test(text)) {
    const hasKnownTitle = knownTitles.some((t) => text.includes(t));
    if (!hasKnownTitle) issues.push("references 'a study' without citing a real catalog document");
  }
  return issues;
}

// 2. Persona-reuse check: same age+sex+height+weight combo seen before in
//    this generation run (rough proxy for "didn't vary personas").
function checkPersonaReuse(example) {
  const text = extractText(example);
  const dims = extractAnthropometrics(text);
  if (dims.height == null || dims.weight == null) return []; // can't check, don't block on it
  const fp = `${dims.age ?? "?"}|${dims.height}|${dims.weight}`;
  if (seenPersonas.has(fp)) return [`persona fingerprint reused: ${fp}`];
  seenPersonas.add(fp);
  return [];
}

// 3. BMI sanity check: if height_cm and weight_kg both appear (profile or
//    tool result), recompute BMI and flag if the reply's own stated BMI
//    (e.g. "BMI liegt bei 32,6") doesn't match arithmetic.
function checkBmiMath(example) {
  const text = extractText(example);
  const dims = extractAnthropometrics(text);
  if (dims.height == null || dims.weight == null) return [];
  const h = dims.height / 100;
  const w = dims.weight;
  const trueBmi = w / (h * h);
  const claimed = extractExplicitBmiClaim(text);
  if (claimed != null) {
    if (Math.abs(claimed - trueBmi) > 0.3) {
      return [`stated BMI ${claimed} doesn't match computed ${trueBmi.toFixed(1)}`];
    }
  }
  return [];
}

// 4. Structural check: valid roles, tool calls reference a real tool name.
function checkStructure(example) {
  const issues = [];
  if (!Array.isArray(example.messages) || example.messages.length < 2) {
    issues.push("missing or too-short messages[]");
  }
  const validRoles = new Set(["system", "user", "assistant", "tool"]);
  for (const m of example.messages || []) {
    if (!validRoles.has(m.role)) issues.push(`invalid role: ${m.role}`);
    if (m.tool_calls) {
      for (const tc of m.tool_calls) {
        if (tc.function?.name !== "get_user_health_data") {
          issues.push(`unexpected tool call: ${tc.function?.name}`);
        }
      }
    }
  }
  for (const tool of example.tools || []) {
    if (tool?.function?.name !== "get_user_health_data") {
      issues.push(`unexpected tool schema: ${tool?.function?.name}`);
    }
  }
  if (hasToolResult(example) && !hasAnyAssistantToolCalls(example)) {
    issues.push("tool result message exists without preceding assistant tool_calls");
  }
  return issues;
}

function checkPromptLeakage(example) {
  const text = extractText(example);
  const issues = [];
  if (/PLATZHALTER-Systemprompt/i.test(text)) {
    issues.push("placeholder system prompt leaked into example");
  }
  if (/AKTUELLER KONTEXT:/i.test(text)) {
    issues.push("seed-style context header leaked into example");
  }
  return issues;
}

function checkToolConsistency(example) {
  const issues = [];
  const text = extractText(example);
  const conversation = extractUserAssistantText(example);
  const hasHealthCall = hasToolCall(example, "get_user_health_data");
  const hasToolMessage = hasToolResult(example);
  const dims = extractAnthropometrics(text + "\n" + conversation);
  const hasWeight = dims.weight != null;
  const hasHeight = dims.height != null;
  const mentionsBmi = /\bBMI\b|\bIMC\b/i.test(conversation);
  const asksExtremeLoss = /10\s*kg.*10\s*(tage|jours|giorni)|800\s*kcal|48h|48\s*stunden|fasten/i.test(conversation);
  const asksActivityDecision = /hiit|cardio|spr(ü|u)nge|sauts|salti|belastung|intensit/i.test(conversation);

  if (hasHealthCall && !hasToolMessage) {
    issues.push("tool call without tool result message");
  }
  if ((mentionsBmi || asksExtremeLoss) && !hasWeight && !hasHealthCall) {
    issues.push("weight-dependent reasoning without weight in context or tool call");
  }
  if (hasHealthCall && hasWeight && hasHeight && !/exercise_minutes|resting_heart_rate_bpm|hrv_ms|sleep_duration_hours|active_calories_burned/i.test(text) && mentionsBmi) {
    issues.push("tool call appears unnecessary because user already supplied weight and height for BMI reasoning");
  }
  if (asksActivityDecision && !/exercise_minutes|resting_heart_rate_bpm|hrv_ms|sleep_duration_hours|active_calories_burned/i.test(text) && hasHealthCall === false && /heute|today|aujourd|oggi/i.test(conversation)) {
    issues.push("activity-load decision may need current health/activity data but no tool call was made");
  }
  return issues;
}

function checkGroundingTone(example) {
  const issues = [];
  const assistant = extractAssistantText(example);
  const hasKnownTitle = knownTitles.some((t) => assistant.includes(t));
  const hasKnownUrl = [...knownUrls].some((u) => assistant.includes(u));
  const hasEvidence = hasKnownTitle || hasKnownUrl;
  const strongMedicalClaim = /verursach|senkt|erh(ö|o)ht|gef(ä|a)hrlich sicher|f(ü|u)hrt zu|cause|causes|reduit|augmente|provoque|causa|riduce|aumenta/i.test(assistant);
  const uncertaintyMarker = /allgemein|général|generale|in der regel|en g(é|e)n(é|e)ral|in generale|kann|könnte|peut|può|may|typisch|possible|m(ö|o)glich/i.test(assistant);
  const diagnosisOrDose = /\b\d+\s?(mg|g|ml|iu)\b|diagnos|diagnosti/i.test(assistant);

  if (!hasEvidence && strongMedicalClaim && !uncertaintyMarker) {
    issues.push("strong medical-sounding claim without grounding or uncertainty");
  }
  if (diagnosisOrDose) {
    issues.push("diagnosis or dosing language present");
  }
  return issues;
}

function checkBmiOverreach(example) {
  const issues = [];
  const assistant = extractAssistantText(example);
  const mentionsBmi = /\bBMI\b|\bIMC\b/i.test(assistant);
  const overreach = /f(ü|u)r deinen k(ö|o)rper .*zu wenig|pour ton corps .*trop peu|per il tuo corpo .*troppo poco|dein k(ö|o)rper braucht|ton corps a besoin de|il tuo corpo ha bisogno di|deckt .*bed(ü|u)rfnisse nicht ab|ne couvre pas les besoins .* de base|non copre .* fabbisogni di base/i.test(assistant);
  const softened = /allgemein|general|g(é|e)n(é|e)ral|in generale|sehr restriktiv|tr(è|e)s restrictif|molto restrittivo|kein geeignetes ziel|objectif inadapt(é|e)|obiettivo non adatto|fachperson|professionnel de sant(é|e)|specialista|ärzt/i.test(assistant);

  if (mentionsBmi && overreach && !softened) {
    issues.push("assistant overstates what can be inferred from BMI alone");
  }

  return issues;
}

function checkInventedMeasurements(example) {
  const issues = [];
  const text = extractText(example);
  if (/unterstellte gr(ö|o)sse|angenommene gr(ö|o)sse|assumed height|taille suppos(é|e)e|altezza ipotizzata/i.test(text)) {
    issues.push("invented or assumed body measurement mentioned");
  }
  return issues;
}

function checkNotesAlignment(example) {
  const issues = [];
  const notes = String(example.notes || "");
  const hasHealthCall = hasToolCall(example, "get_user_health_data");
  const toolMentionRequired = /(?<!kein\s)(?<!ohne\s)tool[- ]?aufruf n(ö|o)tig|gewicht aus tool|alter aus tool|tool wird.*aufgerufen|tool call required/i.test(notes);
  const toolMentionNotNeeded = /kein tool|kein tool-?call|ohne tool|tool nicht n(ö|o)tig/i.test(notes);

  if (toolMentionRequired && !hasHealthCall) {
    issues.push("notes say tool usage is required but no tool call exists");
  }
  if (toolMentionNotNeeded && hasHealthCall) {
    issues.push("notes say no tool should be used but a tool call exists");
  }

  const notesBmi = extractExplicitBmiClaim(notes);
  if (notesBmi != null) {
    const dims = extractAnthropometrics(extractText(example));
    if (dims.height != null && dims.weight != null) {
      const computed = dims.weight / ((dims.height / 100) ** 2);
      if (Math.abs(notesBmi - computed) > 0.3) {
        issues.push(`notes BMI ${notesBmi} doesn't match computed ${computed.toFixed(1)}`);
      }
    } else {
      issues.push("notes contain exact BMI but example lacks enough data to compute it");
    }
  }

  return issues;
}

function checkBmiCategoryConsistency(example) {
  const issues = [];
  const text = extractText(example);
  const assistant = extractAssistantText(example);
  const dims = extractAnthropometrics(text);
  if (dims.height == null || dims.weight == null) return issues;

  const bmi = dims.weight / ((dims.height / 100) ** 2);
  const saysUnderweight = /untergewichtig|insuffisance pond(é|e)rale|sous le seuil de 18,5|sottopeso/i.test(assistant);
  const saysNormal = /normalbereich|poids normal|normopeso/i.test(assistant);
  const acknowledgesBoundary = /grenz|border|limite|limite|unteren normalbereich|limite inférieure|limite inferiore/i.test(assistant);

  if (bmi > 18.55 && saysUnderweight && !acknowledgesBoundary) {
    issues.push(`assistant labels BMI ${bmi.toFixed(1)} as underweight without acknowledging the cutoff boundary`);
  }
  if (bmi < 18.45 && saysNormal) {
    issues.push(`assistant labels BMI ${bmi.toFixed(1)} as normal despite being below cutoff`);
  }
  if (bmi >= 18.45 && bmi <= 18.55 && saysUnderweight && saysNormal && !acknowledgesBoundary) {
    issues.push(`assistant mixes normal and underweight labels around BMI ${bmi.toFixed(1)} without explicit boundary framing`);
  }

  return issues;
}

function checkAssistantBmiSupport(example) {
  const issues = [];
  const assistant = extractAssistantText(example);
  if (!hasExactBmiClaim(assistant)) return issues;
  const dims = extractAnthropometrics(extractText(example));
  if (dims.height == null || dims.weight == null) {
    issues.push("assistant states exact BMI without enough data to compute it");
  }
  return issues;
}

function checkUncertaintyHandling(example) {
  const issues = [];
  const assistant = extractAssistantText(example);
  const hasKnownTitle = knownTitles.some((t) => assistant.includes(t));
  const hasKnownUrl = [...knownUrls].some((u) => assistant.includes(u));
  const hasEvidence = hasKnownTitle || hasKnownUrl;
  const hasUncertainty = /ohne genaue quelle|ohne quelle|allgemein gesagt|ich kann dir nur allgemein|i can only say generally|je peux seulement dire en g(é|e)n(é|e)ral|posso solo dirti in generale|kann ich nicht sicher sagen|nicht sicher sagen/i.test(assistant);
  const hasReferral = /arzt|ärztin|allergolog|fachperson|apotheke|docteur|m(é|e)decin|specialist|medico|specialista/i.test(assistant);
  const strongClaim = /ist .*gef(ä|a)hrlich|führt zu|verursacht|cause|causa|provoque|aumenta|erh(ö|o)ht|senkt/i.test(assistant);

  if (!hasEvidence && strongClaim && !hasUncertainty && !hasReferral) {
    issues.push("strong ungrounded recommendation lacks uncertainty or referral");
  }
  return issues;
}

function main() {
  const inFile = path.join(OUT_DIR, "generated.jsonl");
  const raw = fs.readFileSync(inFile, "utf8");
  const lines = raw.trim() ? raw.trim().split("\n").filter(Boolean) : [];

  const validated = [];
  const flagged = [];

  for (const line of lines) {
    let example;
    try {
      example = JSON.parse(line);
    } catch {
      flagged.push({ raw: line, issues: ["invalid JSON"] });
      continue;
    }
    const issues = [
      ...checkStructure(example),
      ...checkPromptLeakage(example),
      ...checkCitations(example),
      ...checkPersonaReuse(example),
      ...checkBmiMath(example),
      ...checkBmiCategoryConsistency(example),
      ...checkAssistantBmiSupport(example),
      ...checkBmiOverreach(example),
      ...checkToolConsistency(example),
      ...checkGroundingTone(example),
      ...checkNotesAlignment(example),
      ...checkUncertaintyHandling(example),
      ...checkInventedMeasurements(example),
    ];
    if (issues.length) {
      flagged.push({ id: example.id, issues, example });
    } else {
      validated.push(example);
    }
  }

  fs.writeFileSync(
    path.join(OUT_DIR, "validated.jsonl"),
    validated.map((e) => JSON.stringify(e)).join("\n") + "\n"
  );
  fs.writeFileSync(
    path.join(OUT_DIR, "flagged.jsonl"),
    flagged.map((f) => JSON.stringify(f)).join("\n") + "\n"
  );

  const diversity = buildDiversityReport(validated);
  fs.writeFileSync(
    path.join(OUT_DIR, "diversity_report.json"),
    JSON.stringify(diversity, null, 2) + "\n"
  );

  console.log(`${validated.length} passed, ${flagged.length} flagged for manual review.`);
  console.log(`See ${path.join(OUT_DIR, "flagged.jsonl")} for reasons.`);
  console.log(
    `Diversity: high-overlap ratio ${diversity.totals.high_overlap_ratio} ` +
    `(${diversity.totals.high_overlap_pairs}/${diversity.totals.compared_pairs} pairs >= ${diversity.totals.overlap_threshold}).`
  );
  console.log(`See ${path.join(OUT_DIR, "diversity_report.json")} for distributions.`);
}

main();

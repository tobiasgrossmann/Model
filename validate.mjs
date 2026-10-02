// validate.mjs
// Cheap, deterministic quality gate for generated training examples.
// Run AFTER generate.mjs. Does not call any LLM — pure structural/content
// checks, so it catches exactly the failure modes that a trimmed prompt
// context makes more likely, without costing any inference.
//
// Usage: node validate.mjs
// Reads:  ./out/generated.jsonl
// Writes: ./out/validated.jsonl (examples that pass all checks, with debug metadata)
//         ./out/training_ready.jsonl (lean training records only)
//         ./out/flagged.jsonl   (examples with at least one issue, + why)
//         ./out/bmi_warnings.jsonl (manual-review warnings for BMI drift > 0.2)
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

function tokens(text) {
  return normalizeText(text).split(/\s+/).filter(Boolean);
}

function unique(values) {
  return [...new Set(values)];
}

const SUPPORT_STOPWORDS = new Set([
  "der", "die", "das", "und", "oder", "aber", "eine", "einer", "einem", "einen", "ein",
  "mit", "ohne", "ist", "sind", "war", "were", "pour", "avec", "sans", "con", "senza",
  "this", "that", "your", "dein", "deine", "deiner", "deinem", "ton", "ta", "tes", "tuo", "tua",
  "bei", "für", "vom", "von", "im", "in", "auf", "zu", "je", "par", "pro", "per",
  "kg", "cm", "kcal", "bmi", "imc",
]);

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

function contentTokens(text) {
  return unique(tokens(text).filter((token) => token.length > 2 && !SUPPORT_STOPWORDS.has(token)));
}

function sentenceSplit(text) {
  return String(text || "")
    .split(/(?<=[.!?])\s+/)
    .map((sentence) => sentence.trim())
    .filter(Boolean);
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

function parseToolPayloads(example) {
  const payloads = [];
  for (const message of (example.messages || [])) {
    if (message?.role !== "tool") continue;
    if (typeof message.content !== "string") continue;
    try {
      const parsed = JSON.parse(message.content);
      if (parsed && typeof parsed === "object") payloads.push(parsed);
    } catch {
      // ignore malformed tool payloads
    }
  }
  return payloads;
}

function hasAnyAssistantToolCalls(example) {
  return (example.messages || []).some((m) => Array.isArray(m.tool_calls) && m.tool_calls.length > 0);
}

function groundingExcerpts(example) {
  return (example.grounding?.sources || [])
    .map((source) => source?.excerpt)
    .filter((excerpt) => typeof excerpt === "string" && excerpt.trim());
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

function isHealthyPlanExample(example) {
  return String(example?.example_mode || "").trim().toLowerCase() === "healthy_plan";
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
  const inlineWeightHeight = text.match(/(\d{2,3}(?:[.,]\d+)?)\s*cm\D{0,30}(\d+(?:[.,]\d+)?)\s*kg/i);
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
      const looseHeight = parseFloat(inlineWeightHeightLoose[1].replace(",", "."));
      height = height ?? (looseHeight < 3 ? looseHeight * 100 : looseHeight);
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

function walkStrings(value, visit) {
  if (typeof value === "string") {
    visit(value);
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) walkStrings(item, visit);
    return;
  }
  if (value && typeof value === "object") {
    for (const nested of Object.values(value)) walkStrings(nested, visit);
  }
}

function defaultHealthToolSchema() {
  return [{
    type: "function",
    function: {
      name: "get_user_health_data",
      description: "Liefert aktuelle Daten der Person: Alter, Gewicht und Aktivität.",
      parameters: {
        type: "object",
        properties: {},
      },
    },
  }];
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

function bmiWarning(example) {
  const text = extractText(example);
  const dims = extractAnthropometrics(text);
  if (dims.height == null || dims.weight == null) return null;
  const claimed = extractExplicitBmiClaim(text);
  if (claimed == null) return null;
  const trueBmi = dims.weight / ((dims.height / 100) ** 2);
  const delta = Math.abs(claimed - trueBmi);
  if (delta <= 0.2) return null;
  return {
    source_id: example.id,
    claimed_bmi: claimed,
    computed_bmi: Number(trueBmi.toFixed(2)),
    delta: Number(delta.toFixed(3)),
  };
}

// 4. Structural check: valid roles, tool calls reference a real tool name.
function checkStructure(example) {
  const issues = [];
  if (!Array.isArray(example.messages) || example.messages.length < 2) {
    issues.push("missing or too-short messages[]");
  }
  const validRoles = new Set(["system", "user", "assistant", "tool"]);
  const allowedMessageKeys = new Set(["role", "content", "tool_calls", "tool_call_id"]);
  for (const m of example.messages || []) {
    if (!validRoles.has(m.role)) issues.push(`invalid role: ${m.role}`);
    for (const key of Object.keys(m || {})) {
      if (!allowedMessageKeys.has(key)) {
        issues.push("message contains disallowed key: " + key);
      }
    }
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
  const lastMessage = Array.isArray(example.messages) && example.messages.length
    ? example.messages[example.messages.length - 1]
    : null;
  if (lastMessage?.role !== "assistant") {
    issues.push("conversation must end with assistant response");
  }
  if (lastMessage?.role === "assistant" && Array.isArray(lastMessage.tool_calls) && lastMessage.tool_calls.length > 0) {
    issues.push("conversation ends with unresolved assistant tool_calls");
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

function checkGeneratorMetaLeak(example) {
  const issues = [];
  const leakPattern = /Batch-Mix|Datensatz-Balance|Pflicht\):/i;
  let found = false;
  walkStrings(example, (value) => {
    if (!found && leakPattern.test(value)) {
      found = true;
    }
  });
  if (found) {
    issues.push("generator meta instructions leaked into example fields");
  }
  return issues;
}

function assignValidatedIds(examples) {
  const counters = new Map();
  return examples.map((example) => {
    const guardrail = canonicalGuardrail(example.guardrail);
    const language = String(example.language || "xx");
    const key = `${guardrail}_${language}`;
    const next = (counters.get(key) || 0) + 1;
    counters.set(key, next);
    return {
      ...example,
      source_id: example.id,
      id: `${guardrail}_${language}_${String(next).padStart(3, "0")}`,
    };
  });
}

function toTrainingReadyExample(example) {
  const ready = {
    id: example.id,
    language: example.language,
    guardrail: example.guardrail,
    tool_policy: example.tool_policy,
    messages: example.messages,
  };
  if (hasAnyAssistantToolCalls(example)) {
    ready.tools = Array.isArray(example.tools) && example.tools.length
      ? example.tools
      : defaultHealthToolSchema();
  }
  return ready;
}

function stripValidatedDebugFields(example) {
  const { grounding, ...rest } = example;
  return rest;
}

function checkToolConsistency(example) {
  const issues = [];
  const text = extractText(example);
  const conversation = extractUserAssistantText(example);
  const hasHealthCall = hasToolCall(example, "get_user_health_data");
  const hasToolMessage = hasToolResult(example);
  const toolPayloads = parseToolPayloads(example);
  const dims = extractAnthropometrics(text + "\n" + conversation);
  const hasWeight = dims.weight != null;
  const hasHeight = dims.height != null;
  const mentionsBmi = /\bBMI\b|\bIMC\b/i.test(conversation);
  const asksExtremeLoss = /10\s*kg.*10\s*(tage|jours|giorni)|800\s*kcal|48h|48\s*stunden|fasten/i.test(conversation);
  const asksActivityDecision = /hiit|cardio|spr(ü|u)nge|sauts|salti|belastung|intensit/i.test(conversation);

  if (hasHealthCall && !hasToolMessage) {
    issues.push("tool call without tool result message");
  }
  if (hasHealthCall && hasToolMessage) {
    const hasHeightInTool = toolPayloads.some((payload) => {
      const value = payload?.height_cm;
      if (typeof value === "number") return Number.isFinite(value);
      if (typeof value === "string") {
        const parsed = Number(value.replace(",", "."));
        return Number.isFinite(parsed);
      }
      return false;
    });
    if (!hasHeightInTool) {
      issues.push("health-data tool result missing height_cm");
    }
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

function checkToolPolicy(example) {
  const issues = [];
  const allowed = new Set([
    "required_for_personalized_assessment",
    "optional_for_context",
    "not_required_for_safety_refusal",
    "not_required_for_general_guidance",
  ]);
  const policy = example.tool_policy;
  if (!allowed.has(policy)) {
    issues.push("missing or invalid tool_policy");
    return issues;
  }

  const conversation = extractUserAssistantText(example);
  const hasHealthCall = hasToolCall(example, "get_user_health_data");
  const dims = extractAnthropometrics(extractText(example) + "\n" + conversation);
  const hasInlineHeightWeight = dims.height != null && dims.weight != null;
  const asksDailyStatus = /wie war mein tag|heute|today|aujourd|oggi|ring|hrv|resting heart|schlaf|sleep|exercise minutes|stand hours/i.test(conversation);
  const asksPersonalizedLoad = /hiit|cardio|spr(ü|u)nge|sauts|salti|belastung|intensit|tempo/i.test(conversation);
  const asksBmiOrAssessment = /\bBMI\b|\bIMC\b|untergewicht|normalgewicht|sous le seuil|sottopeso/i.test(conversation);

  if (policy === "required_for_personalized_assessment") {
    if (!hasHealthCall) {
      issues.push("tool_policy says personalized assessment required but no health-data tool call exists");
    }
    if (!asksDailyStatus && !asksPersonalizedLoad && !(asksBmiOrAssessment && !hasInlineHeightWeight)) {
      issues.push("tool_policy says personalized assessment required but the example does not clearly justify the tool call");
    }
  }

  if (policy === "not_required_for_safety_refusal") {
    if (hasHealthCall && hasInlineHeightWeight && /700\s*kcal|800\s*kcal|900\s*kcal|650\s*kcal|nur noch shakes|nur suppe|meal replacement|crash/i.test(conversation)) {
      issues.push("tool_policy says tool not required for safety refusal but a likely non-essential health-data tool call was still made");
    }
  }

  if (policy === "optional_for_context" && !hasHealthCall) {
    issues.push("tool_policy is optional_for_context but no health-data tool call exists");
  }

  if (policy === "not_required_for_general_guidance" && hasHealthCall) {
    issues.push("tool_policy says tool not required for general guidance but a health-data tool call exists");
  }

  return issues;
}

function checkToolBypassForBmiOrWeightClaims(example) {
  const issues = [];
  const assistant = extractAssistantText(example);
  const hasHealthCall = hasToolCall(example, "get_user_health_data");
  if (hasHealthCall) return issues;

  const hasExplicitBmiNumber = /\b(?:BMI|IMC)\b[^\n.]{0,30}\d{1,2}(?:[.,]\d+)?/i.test(assistant) || hasExactBmiClaim(assistant);
  const hasWeightDependentSafetyClaim = /(?:dein(?:e|er)?|deiner|bei deiner|ton|ta|tes|votre|tuo|tua|con i tuoi|con le tue).{0,70}(?:gewicht|gr(?:ö|o)sse|taille|poids|peso|altezza|bmi|imc).{0,90}(?:gef(?:ä|a)hr|risk|risque|pericol|contre-indiqu|unsafe|zu wenig|trop peu|troppo poco|nicht geeignet|inadatt|non adatto)/i.test(assistant)
    || /\b(?:BMI|IMC)\b.{0,90}(?:gef(?:ä|a)hr|risk|risque|pericol|contre-indiqu|unsafe|zu wenig|trop peu|troppo poco|nicht geeignet|inadatt|non adatto)/i.test(assistant);

  if (hasExplicitBmiNumber || hasWeightDependentSafetyClaim) {
    issues.push("assistant uses BMI/weight-dependent safety reasoning without prior get_user_health_data tool call");
  }

  return issues;
}

function checkGuardrailThemeSanity(example) {
  const issues = [];
  const guardrail = canonicalGuardrail(example.guardrail);
  const conversation = extractUserAssistantText(example);

  if (guardrail === "G1") {
    const hasG1Cue = /kcal|kalorien|kalorienzahl|calories?|restriktiv|restriction|restrictif|restrittiv|crash|meal replacement|shakes?|suppe|omad|one meal a day|je(?:û|u)ne extr(?:ê|e)me|digiuno estremo|10\s*kg|rapid(?:e|o) dimagr/i.test(conversation);
    if (!hasG1Cue) {
      issues.push("G1 theme sanity check failed: missing kcal/restriction cue; send to manual review");
    }
  }

  if (guardrail === "G5") {
    const hasG5Cue = /fasten|fasting|je(?:û|u)ne|digiuno/i.test(conversation);
    if (!hasG5Cue) {
      issues.push("G5 theme sanity check failed: missing fasting cue; send to manual review");
    }
  }

  return issues;
}

function checkPolicyDecomposition(example) {
  const issues = [];
  const guardrail = canonicalGuardrail(example.guardrail);
  const trigger = String(example.trigger || "").trim();
  const personalization = example.personalization_needed;
  const responsePolicy = example.response_policy;

  if (!trigger || !/^[a-z0-9_]{3,}$/.test(trigger)) {
    issues.push("missing or invalid trigger");
  }
  if (typeof personalization !== "boolean") {
    issues.push("missing or invalid personalization_needed");
  }
  if (!responsePolicy || typeof responsePolicy !== "object" || Array.isArray(responsePolicy)) {
    issues.push("missing or invalid response_policy object");
    return issues;
  }

  const entries = Object.entries(responsePolicy);
  if (entries.length < 1 || entries.length > 8) {
    issues.push("response_policy must contain between 1 and 8 boolean rules");
  }
  for (const [key, value] of entries) {
    if (!/^[a-z0-9_]{3,}$/.test(key)) {
      issues.push(`response_policy key not snake_case: ${key}`);
    }
    if (typeof value !== "boolean") {
      issues.push(`response_policy value for ${key} must be boolean`);
    }
  }

  const expectedTriggerByGuardrail = {
    G1: "extreme_restriction",
    G2: "medication_adjustment",
    G3: "allergen_risk",
    G4: "injury_or_pain_red_flag",
    G5: "mental_health_crisis_signal",
    G6: "disordered_eating_pattern",
    G7: "unrealistic_timeline_or_goal",
    G8: "supplement_or_doping_risk",
    G9: "dehydration_or_electrolyte_risk",
    G10: "under_recovery_or_overtraining",
    G11: "chronic_condition_management",
    G12: "pregnancy_or_postpartum_safety",
    G13: "minor_or_adolescent_context",
    G14: "diagnosis_or_lab_interpretation_request",
    G15: "unsafe_exercise_technique_or_progression",
    G16: "food_safety_or_contamination_risk",
    G17: "contextual_safety_screening",
  };

  const expectedTrigger = expectedTriggerByGuardrail[guardrail];
  if (expectedTrigger && trigger !== expectedTrigger) {
    issues.push(`trigger ${trigger} does not match expected ${expectedTrigger} for ${guardrail}`);
  }

  const hasHealthCall = hasToolCall(example, "get_user_health_data");
  const toolPolicy = String(example.tool_policy || "");
  if (toolPolicy === "required_for_personalized_assessment" && personalization !== true) {
    issues.push("tool_policy requires personalization but personalization_needed is not true");
  }
  if (personalization === false && hasHealthCall && toolPolicy === "not_required_for_safety_refusal") {
    issues.push("health-data tool call present while tool_policy says not_required_for_safety_refusal");
  }
  if (personalization !== false && toolPolicy === "not_required_for_general_guidance") {
    issues.push("tool_policy says general guidance but personalization_needed is not false");
  }

  const conversation = extractUserAssistantText(example);
  const hasExtremeRestriction = /650\s*kcal|700\s*kcal|800\s*kcal|900\s*kcal|nur.*shakes|nur.*suppe|meal replacement|crash/i.test(conversation);
  const hasMedicationTopic = /medikament|medication|dosierung|dose|dosis|insulin|blutdruck|pressione|pression art(é|e)rielle/i.test(conversation);
  const hasPositiveAllergyTopic = /allerg|allergie|allergy|allergique|allergico|unvertr[aä]g|intoleran|anaphyl|anaphylax|spuren|traces?|cross-?contact|cross contamination|contamination crois[ée]e|contaminazione/i.test(conversation)
    && !/keine allergien|no allergies|sans allergie|senza allergie|non ho allergie|je n['’]ai pas d['’]allergies|je n['’]ai aucune allergie/i.test(conversation);

  if (guardrail === "G1" && hasExtremeRestriction) {
    if (responsePolicy.allow_calorie_target !== false) {
      issues.push("G1 extreme restriction should set response_policy.allow_calorie_target=false");
    }
    if (responsePolicy.allow_restrictive_meal_plan !== false) {
      issues.push("G1 extreme restriction should set response_policy.allow_restrictive_meal_plan=false");
    }
  }

  if (guardrail === "G2" && hasMedicationTopic) {
    if (responsePolicy.medication_change !== false) {
      issues.push("G2 medication scenarios should set response_policy.medication_change=false");
    }
    if (responsePolicy.recommend_clinician !== true) {
      issues.push("G2 medication scenarios should set response_policy.recommend_clinician=true");
    }
  }

  if (guardrail === "G3" && hasPositiveAllergyTopic) {
    if (responsePolicy.avoid_allergen_exposure !== true) {
      issues.push("G3 allergy scenarios should set response_policy.avoid_allergen_exposure=true");
    }
  }

  if (guardrail === "G3" && !hasPositiveAllergyTopic) {
    issues.push("G3 content missing explicit allergy/unverträglichkeit context");
  }

  return issues;
}

function checkGuardrailContentFit(example) {
  const issues = [];
  const guardrail = canonicalGuardrail(example.guardrail);
  const userMessages = (example.messages || [])
    .filter((message) => message.role === "user" && typeof message.content === "string")
    .map((message) => message.content);
  const userText = userMessages.join("\n");
  const conversation = extractUserAssistantText(example);

  if (guardrail === "G8") {
    const hasMultipleUserTurns = userMessages.length >= 2;
    const hasConflictCue = /aber|trotzdem|dennoch|doch|widerspruch|konflikt|inconsisten|contradiction|cependant|pourtant|mais|incoh(é|e)rence|per(ò|o)|tuttavia|contraddizion/i.test(userText);
    const hasGoalCue = /ziel|goal|objectif|obiettivo|abnehm|lose weight|perdre|dimagr|muskel|muscle|kg|kcal/i.test(userText);
    if (!(hasMultipleUserTurns && hasGoalCue && hasConflictCue)) {
      issues.push("G8 content does not show a context-turn goal-consistency conflict");
    }
  }

  if (guardrail === "G6") {
    const dims = extractAnthropometrics(extractText(example));
    const bmi = dims.height != null && dims.weight != null
      ? dims.weight / ((dims.height / 100) ** 2)
      : null;
    const hasBodyImageTheme = /spiegelbild|k(ö|o)rperbild|body image|apparence|image corporelle|immagine corporea|zu dick|trop gros|troppo grass|fettanteil|percezione del corpo/i.test(conversation);

    if (bmi == null || bmi < 30) {
      issues.push("G6 content missing obesity-level BMI context (>=30)");
    }
    if (!hasBodyImageTheme) {
      issues.push("G6 content missing body-image theme");
    }
  }

  if (guardrail === "G16") {
    const hasContextMemoryCue = /du kennst mich|du wei(ss|ß)t doch|wie besprochen|you know me|as you know|you remember|tu me connais|comme tu sais|on en a d(é|e)j(à|a) parl(é|e)|mi conosci|come sai|ti ricordi|ne abbiamo gi(à|a) parlato/i.test(userText);
    if (!hasContextMemoryCue) {
      issues.push("G16 content missing contextual-memory test cue");
    }
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
  // Detect medical dosing language, but avoid flagging meal-plan quantities
  // like "150g Hähnchen" or "80g Reis".
  const medCue = /medikament|medication|m[ée]dicament|farmaco|insulin|supplement|orlistat|semaglutid|tirzepatid|kortiko|cortico|dosier|dosagg|dosage|dosis|dose/i;
  const medDosePattern = new RegExp(
    `(?:${medCue.source})[^\\n]{0,30}\\b\\d+(?:[.,]\\d+)?\\s?(?:mg|ml|iu)\\b|\\b\\d+(?:[.,]\\d+)?\\s?(?:mg|ml|iu)\\b[^\\n]{0,30}(?:${medCue.source})`,
    "i"
  );
  const diagnosisOrDose = /diagnos|diagnosti/i.test(assistant) || medDosePattern.test(assistant);

  if (!hasEvidence && strongMedicalClaim && !uncertaintyMarker) {
    issues.push("strong medical-sounding claim without grounding or uncertainty");
  }
  if (diagnosisOrDose) {
    issues.push("diagnosis or dosing language present");
  }
  return issues;
}

function checkAllergySafetyOverconfidence(example) {
  const issues = [];
  const userText = (example.messages || [])
    .filter((message) => message.role === "user" && typeof message.content === "string")
    .map((message) => message.content)
    .join("\n");
  const assistant = extractAssistantText(example);
  const guardrail = canonicalGuardrail(example.guardrail);

  const explicitAllergySignal = /allerg|allergie|allergy|allergique|allergico|unvertr[aä]g|intoleran|anaphyl|anaphylax|spuren|traces?|cross-?contact|cross contamination|contamination crois[ée]e|contaminazione/i.test(userText);
  const allergyContext = guardrail === "G3" || explicitAllergySignal;
  if (!allergyContext) return issues;

  const absoluteSafetyClaim = /\b(sicher|v[öo]llig sicher|ohne risiko|risikofrei|sans risque|aucun risque|totalement s[ûu]r|safe for you|completely safe|assolutamente sicuro)\b/i.test(assistant);
  const mentionsAlternativeFood = /statt|alternative|alternativ|replace|remplacer|remplace|à la place|instead|instead of|invece|al posto/i.test(assistant);
  const cautionCue = /etikett|[ée]tiquetage|label|cross-?contact|contamination croisée|spuren|traces|allergolog|allergologue|allergologo|fachperson|specialist/i.test(assistant);

  if (absoluteSafetyClaim && mentionsAlternativeFood) {
    issues.push("overconfident allergy safety claim for alternative food");
  }
  if (mentionsAlternativeFood && !cautionCue) {
    issues.push("allergy alternative advice missing label/cross-contact/specialist caution");
  }

  const nutAllergyContext = /nussallerg|allerg(?:ie|y|ique|ico).{0,30}(?:nuss|n[ou]ix|fruits? [àa] coque|mandor|arachid|erdnuss|peanut|frutta a guscio)|allerg(?:ie|y|ique|ico).{0,30}nut|allergia alle mandorle|allergie aux noix/i.test(userText);
  if (nutAllergyContext) {
    const recommendsNutFood = assistant
      .split(/\n+/)
      .some((line) => {
        const text = line.trim();
        if (!text) return false;
        const mentionsNutFood = /erdnussbutter|erdn(ü|u)sse|peanut butter|peanuts?|arachides?|amandes?|mandorle|hazelnuts?|haseln(ü|u)sse|noisettes?|waln(ü|u)sse|n(ü|u)sse|noix|frutta a guscio/i.test(text);
        if (!mentionsNutFood) return false;
        const isCaution = /vermeide|avoid|[ée]vite|evita|nicht|ne .*pas|non|frag|ask|demande|contatto incrociato|cross-?contact|spuren|traces|etikett|label|allergolog/i.test(text);
        return !isCaution;
      });

    if (recommendsNutFood) {
      issues.push("assistant recommends likely allergen despite explicit nut allergy context");
    }
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
  const saysOverweight = /übergewicht|surpoids|sovrappeso|overweight|peso eccessivo/i.test(assistant);
  const acknowledgesBoundary = /grenz|border|limite|limite|unteren normalbereich|limite inférieure|limite inferiore/i.test(assistant);

  if (bmi > 18.55 && saysUnderweight && !acknowledgesBoundary) {
    issues.push(`assistant labels BMI ${bmi.toFixed(1)} as underweight without acknowledging the cutoff boundary`);
  }
  if (bmi < 18.45 && saysNormal) {
    issues.push(`assistant labels BMI ${bmi.toFixed(1)} as normal despite being below cutoff`);
  }
  if (bmi >= 25 && saysNormal) {
    issues.push(`assistant labels BMI ${bmi.toFixed(1)} as normal despite being above the normal range cutoff`);
  }
  if (bmi < 25 && saysOverweight) {
    issues.push(`assistant labels BMI ${bmi.toFixed(1)} as overweight despite being below the overweight cutoff`);
  }
  if (bmi >= 18.45 && bmi <= 18.55 && saysUnderweight && saysNormal && !acknowledgesBoundary) {
    issues.push(`assistant mixes normal and underweight labels around BMI ${bmi.toFixed(1)} without explicit boundary framing`);
  }

  return issues;
}

function checkBmiThresholdClaims(example) {
  const issues = [];
  const text = extractText(example);
  const assistant = extractAssistantText(example);
  const dims = extractAnthropometrics(text);
  if (dims.height == null || dims.weight == null) return issues;

  const bmi = dims.weight / ((dims.height / 100) ** 2);
  const claimsAbove35 = /(?:\bBMI\b|\bIMC\b)?[^\n]{0,30}(?:>|>=|ueber|über|au-dessus de|d[ée]passe|sup(é|e)rieur [àa]|supera|oltre)\s*35(?:[.,]0+)?/i.test(assistant);
  const claimsBelow35 = /(?:\bBMI\b|\bIMC\b)?[^\n]{0,30}(?:<|<=|unter|sous|inferieur [àa]|inf[ée]rieur [àa]|sotto|inferiore)\s*35(?:[.,]0+)?/i.test(assistant);

  if (claimsAbove35 && bmi < 35) {
    issues.push("assistant claims BMI threshold >35 but computed BMI is " + bmi.toFixed(2));
  }
  if (claimsBelow35 && bmi > 35) {
    issues.push("assistant claims BMI threshold <35 but computed BMI is " + bmi.toFixed(2));
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

function checkGroundingConsistency(example) {
  const issues = [];
  const excerpts = groundingExcerpts(example);
  if (!excerpts.length) return issues;

  const evidenceTokenSets = excerpts.map((excerpt) => new Set(contentTokens(excerpt)));
  const assistant = extractAssistantText(example);
  const healthyPlan = isHealthyPlanExample(example);
  const factualCue = /empfohlen|empfehl|guideline|leitlinie|sollte|sollten|regelmässig|regelmäßig|portion|liter|minuten|pro woche|pro tag|fibres?|ballaststoff|protein|zucker|salz|vollkorn|wasser|bewegung/i;
  const userSpecific = /dein bmi|ton imc|il tuo bmi|bei deiner gr(ö|o)sse|avec tes .*kg|con i tuoi .*kg|dein gewicht|ton poids|tuo peso/i;

  // Healthy-plan examples contain practical meal/workout templates that are often
  // broader than noisy excerpt text. For them, enforce grounding only when the
  // assistant explicitly claims source-backed evidence.
  if (!healthyPlan) {
    for (const sentence of sentenceSplit(assistant)) {
      if (!factualCue.test(sentence)) continue;
      if (userSpecific.test(sentence)) continue;
      const sentenceTokens = contentTokens(sentence);
      if (!sentenceTokens.length) continue;

      let best = 0;
      for (const evidenceTokens of evidenceTokenSets) {
        const overlap = jaccard(new Set(sentenceTokens), evidenceTokens);
        if (overlap > best) best = overlap;
      }

      if (best < 0.08) {
        issues.push("grounded factual claim may not be supported by attached retrieved sources");
        break;
      }
    }
  }

  const evidenceNumbers = new Set(excerpts.flatMap((excerpt) => excerpt.match(/\d+(?:[.,]\d+)?/g) || []));
  const explicitSourceClaim = /laut|gem(ä|a)ss|selon|secondo|according to|dokument|quelle|source|studio|studie/i.test(assistant);
  if (explicitSourceClaim) {
    // Evaluate numeric consistency only in source-claiming sentences. This avoids
    // false positives from plan quantities (sets/reps/meal grams) elsewhere.
    const claimSentences = sentenceSplit(assistant).filter((sentence) =>
      /laut|gem(ä|a)ss|selon|secondo|according to|dokument|quelle|source|studio|studie/i.test(sentence)
    );
    const claimNumbers = claimSentences.flatMap((sentence) => sentence.match(/\d+(?:[.,]\d+)?/g) || []);
    const unsupported = claimNumbers.filter((num) => !evidenceNumbers.has(num));
    if (unsupported.length >= 1) {
      issues.push("source-backed numeric claim may contradict attached retrieved sources");
    }
  }

  return issues;
}

function main() {
  const inFile = path.join(OUT_DIR, "generated.jsonl");
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const hasInput = fs.existsSync(inFile);
  const raw = hasInput ? fs.readFileSync(inFile, "utf8") : "";
  if (!hasInput) {
    console.warn("  ! input missing: " + inFile + " (continuing with empty dataset)");
  }
  const lines = raw.trim() ? raw.trim().split("\n").filter(Boolean) : [];

  const validated = [];
  const flagged = [];
  const bmiWarnings = [];

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
      ...checkGeneratorMetaLeak(example),
      ...checkCitations(example),
      ...checkPersonaReuse(example),
      ...checkBmiMath(example),
      ...checkBmiCategoryConsistency(example),
      ...checkBmiThresholdClaims(example),
      ...checkAssistantBmiSupport(example),
      ...checkBmiOverreach(example),
      ...checkToolConsistency(example),
      ...checkToolPolicy(example),
      ...checkToolBypassForBmiOrWeightClaims(example),
      ...checkPolicyDecomposition(example),
      ...checkGuardrailContentFit(example),
      ...checkGuardrailThemeSanity(example),
      ...checkGroundingTone(example),
      ...checkAllergySafetyOverconfidence(example),
      ...checkGroundingConsistency(example),
      ...checkNotesAlignment(example),
      ...checkUncertaintyHandling(example),
      ...checkInventedMeasurements(example),
    ];
    const bmiWarn = bmiWarning(example);
    if (bmiWarn) bmiWarnings.push(bmiWarn);
    if (issues.length) {
      flagged.push({ id: example.id, issues, example });
    } else {
      validated.push(example);
    }
  }

  const validatedWithUniqueIds = assignValidatedIds(validated);
  const validatedForExport = validatedWithUniqueIds.map(stripValidatedDebugFields);
  const trainingReady = validatedWithUniqueIds.map(toTrainingReadyExample);

  fs.writeFileSync(
    path.join(OUT_DIR, "validated.jsonl"),
    validatedForExport.map((e) => JSON.stringify(e)).join("\n") + "\n"
  );
  fs.writeFileSync(
    path.join(OUT_DIR, "training_ready.jsonl"),
    trainingReady.map((e) => JSON.stringify(e)).join("\n") + "\n"
  );
  fs.writeFileSync(
    path.join(OUT_DIR, "flagged.jsonl"),
    flagged.map((f) => JSON.stringify(f)).join("\n") + "\n"
  );
  fs.writeFileSync(
    path.join(OUT_DIR, "bmi_warnings.jsonl"),
    bmiWarnings.map((warning) => JSON.stringify(warning)).join("\n") + "\n"
  );

  const diversity = buildDiversityReport(validatedWithUniqueIds);
  fs.writeFileSync(
    path.join(OUT_DIR, "diversity_report.json"),
    JSON.stringify(diversity, null, 2) + "\n"
  );

  console.log(`${validatedWithUniqueIds.length} passed, ${flagged.length} flagged for manual review.`);
  console.log(`See ${path.join(OUT_DIR, "flagged.jsonl")} for reasons.`);
  console.log(`Training-ready export: ${path.join(OUT_DIR, "training_ready.jsonl")}`);
  console.log(`BMI warnings: ${path.join(OUT_DIR, "bmi_warnings.jsonl")}`);
  console.log(
    `Diversity: high-overlap ratio ${diversity.totals.high_overlap_ratio} ` +
    `(${diversity.totals.high_overlap_pairs}/${diversity.totals.compared_pairs} pairs >= ${diversity.totals.overlap_threshold}).`
  );
  console.log(`See ${path.join(OUT_DIR, "diversity_report.json")} for distributions.`);
}

main();

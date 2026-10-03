// generate.mjs
// Node.js client for llama.cpp's OpenAI-compatible server (llama-server).
// Generates fitness-coach training data in small, STATELESS batches so that
// each request only carries the context it actually needs — never the whole
// spec bundle, and never previous generations.
//
// Usage:
//   node generate.mjs                     # run all guardrails, all languages
//   node generate.mjs --guardrail G3      # just one guardrail
//   node generate.mjs --lang fr           # just one language
//   node generate.mjs --count 10          # examples per (guardrail, language)
//
// Requires: llama-server running locally with an OpenAI-compatible endpoint,
// e.g.:  llama-server -m model.gguf --host 0.0.0.0 --port 8080 -c 65536 ...

import fs from "node:fs";
import path from "node:path";
import { createLocalRag } from "./local_rag.mjs";
import { validateRow } from "./src/validation/index.mjs";
import { recordValidationFailure } from "./src/prompt_store.mjs";
import { BATCH_MIX_INSTRUCTIONS } from "./specs/batch_mix_instructions.mjs";
import { HEALTHY_PLANNING_MIX } from "./specs/healthy_planning_mix.mjs";
import { GUARDRAIL_POLICIES, DEFAULT_POLICY } from "./specs/guardrail_policies.mjs";
import { GUARDRAIL_CONTENT_CONTRACTS } from "./specs/guardrail_content_contracts.mjs";
import { GUARDRAIL_GROUNDING } from "./specs/guardrail_grounding.mjs";

const SERVER_URL = process.env.LLAMA_URL || "http://game.local:8080/v1/chat/completions";
const SPEC_DIR = process.env.SPEC_DIR || "./specs";       // put the 6 files here
const PROMPTS_DIR = process.env.PROMPTS_DIR || "./prompts";
const OUT_DIR = process.env.OUT_DIR || "./out";
const RAG_DIR = process.env.RAG_DIR || "./rag";
const DOC_SEED_CACHE_FILE = process.env.DOC_SEED_CACHE_FILE || path.join(OUT_DIR, "rag_seed_cache.jsonl");
const LANGS = ["de", "fr", "it"];

const SCENARIO_ROTATION = JSON.parse(fs.readFileSync(path.join(SPEC_DIR, "scenario_rotation.json"), "utf8"));
const PERSONA_SLOT_ROTATION = JSON.parse(fs.readFileSync(path.join(SPEC_DIR, "persona_rotation.json"), "utf8"));
const GUARDRAIL_VARIANTS = JSON.parse(fs.readFileSync(path.join(SPEC_DIR, "guardrail_variants.json"), "utf8"));

function readPromptTemplate(fileName, sectionName = null) {
  const source = fs.readFileSync(path.join(PROMPTS_DIR, fileName), "utf8");
  if (!sectionName) return source;
  const escapedSection = sectionName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = source.match(new RegExp("##\\s*" + escapedSection + "\\s*[\\s\\S]*?```\\n([\\s\\S]*?)```", "i"));
  return match ? match[1].trim() : source;
}

function renderPromptTemplate(template, values = {}) {
  return String(template).replace(/\{\{\s*([A-Za-z0-9_]+)\s*\}\}/g, (_, key) => {
    const value = values[key];
    return value === undefined || value === null ? "" : String(value);
  });
}

const SYSTEM_PROMPT_TEMPLATE = readPromptTemplate("system.md");
const GENERATION_PROMPT_TEMPLATE = readPromptTemplate("generation.md");
const CONTRACT_INTENT_PROMPT_TEMPLATE = readPromptTemplate("generation.md", "Contract Intent Prompt Template");
const CONTRACT_SKELETON_PROMPT_TEMPLATE = readPromptTemplate("generation.md", "Contract Skeleton Prompt Template");
const CONTRACT_REALIZATION_PROMPT_TEMPLATE = readPromptTemplate("generation.md", "Contract Realization Prompt Template");
const CONTRACT_SEGMENT_REPAIR_PROMPT_TEMPLATE = readPromptTemplate("generation.md", "Contract Segment Repair Prompt Template");
const SEED_SYSTEM_TEMPLATE = readPromptTemplate("seed_generation.md", "System Prompt Template");
const SEED_USER_TEMPLATE = readPromptTemplate("seed_generation.md", "User Prompt Template");

// ---- tiny CLI arg parsing -------------------------------------------------
function argVal(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i !== -1 ? process.argv[i + 1] : fallback;
}
const ONLY_GUARDRAIL = argVal("guardrail", null);
const ONLY_LANG = argVal("lang", null);
const REQUESTED_COUNT = parseInt(argVal("count", "1"), 10);
const MAX_EXAMPLES_PER_RUN = 1;
const COUNT = Math.min(REQUESTED_COUNT, MAX_EXAMPLES_PER_RUN);
const STREAM = process.argv.includes("--no-stream") ? false : true;
const NO_THINK = process.argv.includes("--think") ? false : true;
const REQUEST_TIMEOUT_MS = parseInt(argVal("timeout-ms", "180000"), 10);
const MAX_TOKENS = parseInt(argVal("max-tokens", "32000"), 10);
const DEDUP_NGRAM = parseInt(argVal("dedup-ngram", "3"), 10);
const DEDUP_THRESHOLD = Number(argVal("dedup-threshold", "0.88"));
const FETCH_RETRIES = parseInt(argVal("fetch-retries", "3"), 10);
const FETCH_RETRY_BASE_MS = parseInt(argVal("fetch-retry-base-ms", "1200"), 10);
const REPAIR_ATTEMPTS_PER_EXAMPLE = parseInt(argVal("repair-attempts", "2"), 10);

if (!Number.isFinite(REQUESTED_COUNT) || REQUESTED_COUNT < 1) {
  throw new Error("--count must be a positive integer");
}
if (!Number.isFinite(FETCH_RETRIES) || FETCH_RETRIES < 1) {
  throw new Error("--fetch-retries must be an integer >= 1");
}
if (!Number.isFinite(FETCH_RETRY_BASE_MS) || FETCH_RETRY_BASE_MS < 100) {
  throw new Error("--fetch-retry-base-ms must be an integer >= 100");
}

if (REQUESTED_COUNT > MAX_EXAMPLES_PER_RUN) {
  console.warn(
    `  ! requested --count ${REQUESTED_COUNT} exceeds per-run cap ${MAX_EXAMPLES_PER_RUN}; using ${COUNT}`
  );
}

// ---- load specs once, keep only what's needed per call --------------------
const guardrailsSpec = JSON.parse(fs.readFileSync(path.join(SPEC_DIR, "guardrails_spec.json"), "utf8"));
const behaviorSpec = JSON.parse(fs.readFileSync(path.join(SPEC_DIR, "coach_behavior_spec.json"), "utf8"));
const pilots = fs.readFileSync(path.join(SPEC_DIR, "pilot_examples.jsonl"), "utf8")
  .trim().split("\n").map(JSON.parse);
const RANDOM_USER_INTENTS = JSON.parse(fs.readFileSync(path.join(SPEC_DIR, "random_user_intents.json"), "utf8"));
const localRag = createLocalRag({ ragDir: RAG_DIR, specDir: SPEC_DIR });
const ragDocuments = localRag.listDocuments();

if (!ragDocuments.length) {
  throw new Error(`No RAG documents found in ${RAG_DIR}`);
}



let promptRotationIndex = 0;

function batchMixInstruction(guardrailId, count, rotationIndex) {
  const data = BATCH_MIX_INSTRUCTIONS[guardrailId] || [];
  if (!data.length) return null;
  const pattern = rotationIndex % data.length;
  const item = data[pattern];
  if (typeof item === "string") return item;
  if (item?.condition?.minCount && count < item.condition.minCount) return null;
  if (item?.condition?.pattern && pattern !== item.condition.pattern) return null;
  return item?.text || null;
}

function healthyPlanningMixInstruction(count, rotationIndex) {
  const data = HEALTHY_PLANNING_MIX || {};
  const patterns = Array.isArray(data.patterns)
    ? data.patterns
    : [...(Array.isArray(data.healthy_control) ? data.healthy_control : []), ...(Array.isArray(data.balanced) ? data.balanced : [])];

  if (!patterns.length) {
    return { forceControl: false, text: "" };
  }

  const pattern = rotationIndex % patterns.length;
  const item = patterns[pattern];
  const forceControl = item?.forceControl === true || (item?.condition?.periodic && rotationIndex % item.condition.periodic === item.condition.periodic - 1);
  return {
    forceControl,
    text: typeof item === "string" ? item : item?.text || data.defaultText || "",
  };
}

function buildRetrievalQuery({ guardrail, docSeed }) {
  const guardrailHint = guardrail.id === "G1"
    ? "ausgewogene ernaehrung schweizer ernaehrungsempfehlungen lebensmittelpyramide regelmaessig essen ausreichende energie extreme restriktion crash diaet"
    : "";
  const topicHint = [
    docSeed?.title,
    docSeed?.summary,
    docSeed?.selected_question,
    guardrail.claim_seed,
    guardrail.scenario_hint,
  ].filter(Boolean).join(" | ");
  return [
    guardrail.id,
    guardrail.name,
    guardrail.hard_when_text,
    topicHint,
    guardrailHint,
  ].filter(Boolean).join(" | ");
}

function guardrailGroundingInstruction(guardrailId) {
  return GUARDRAIL_GROUNDING[guardrailId] ?? null;
}

function formatEvidenceBlock(retrieval) {
  if (!retrieval.snippets.length) {
    return "Keine belastbaren lokalen RAG-Passagen gefunden. Antworte deshalb nur allgemein, vorsichtig und ohne erfundene Details.";
  }
  return retrieval.snippets.map((snippet, index) => {
    const header = `[${index + 1}] ${snippet.doc_id || snippet.file_name} | ${snippet.title} | Tier ${snippet.tier}`;
    return `${header}\n${snippet.excerpt}`;
  }).join("\n\n");
}

// Compact behavior summary — NOT the whole file, but not stripped to the
// point of losing safety-relevant instructions either. Left out on purpose:
// the other 8 agent-role descriptions, the full scenario templates, the
// long-context persona — none of that is relevant to a single-guardrail
// batch. Kept even though it costs a few hundred extra tokens: anything that
// stops the model inventing facts or mishandling allergy/crisis content.
function compactBehaviorSummary(spec) {
  return {
    principle: spec.principle,
    deterministic_limits: spec.deterministic_limits,
    tool: spec.tools.confirmed[0],
    profile_write_rules: spec.profile_write_rules,
    tool_result_handling: spec.tool_result_handling,
    guardian_categories: spec.guardian_categories,
    allergen_gate: spec.allergen_gate,
  };
}

// Guardrails with no real knowledge-base coverage (from
// guardrails_spec.json -> kb_coverage_by_guardrail). For these, remind the
// model explicitly not to invent a citation.
function noCoverageWarning(guardrailsSpec, guardrailId) {
  const entry = guardrailsSpec.kb_coverage_by_guardrail?.entries?.find(
    (e) => e.guardrail === guardrailId || e.guardrail.split("/").includes(guardrailId)
  );
  if (entry?.gap) {
    return `HINWEIS: Für dieses Guardrail gibt es laut Wissensbasis-Katalog keine passende Quelle (${entry.gap}). Erfinde KEINE Quelle oder Studie — formuliere allgemein und verweise bei Bedarf an eine Fachperson.`;
  }
  return null;
}

function pickGuardrail(spec, id) {
  const g = spec.guardrails.find((g) => g.id === id);
  if (!g) throw new Error(`Unknown guardrail ${id}`);
  return g;
}

function shuffleInPlace(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

function sanitizeFewShotExample(example, lang) {
  const systemMarker = `HEICO_SYSTEM_PROMPT_${lang.toUpperCase()}`;
  return {
    ...example,
    messages: (example.messages || []).map((message) => {
      if (message.role !== "system") return message;
      return {
        ...message,
        content: systemMarker,
      };
    }),
  };
}

// Pick 1 pilot example in the target language as few-shot style reference.
// Falls back to German pilots if none exist in that language yet.
function pickFewShot(lang, n = 1) {
  const inLang = pilots.filter((p) => p.language === lang);
  const pool = inLang.length ? inLang : pilots.filter((p) => p.language === "de");
  return shuffleInPlace([...pool])
    .slice(0, Math.min(n, pool.length))
    .map((example) => sanitizeFewShotExample(example, lang));
}

function randomItem(array) {
  return array[Math.floor(Math.random() * array.length)];
}

function parseFirstJsonObject(text) {
  const trimmed = String(text || "").trim();
  if (!trimmed) return null;
  try {
    return JSON.parse(trimmed);
  } catch {
    // Continue with object extraction.
  }

  let depth = 0;
  let inString = false;
  let escaped = false;
  let start = -1;
  for (let i = 0; i < trimmed.length; i++) {
    const ch = trimmed[i];
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (ch === "\\") {
        escaped = true;
      } else if (ch === '"') {
        inString = false;
      }
      continue;
    }
    if (ch === '"') {
      inString = true;
      continue;
    }
    if (ch === "{") {
      if (depth === 0) start = i;
      depth += 1;
      continue;
    }
    if (ch === "}") {
      depth -= 1;
      if (depth === 0 && start !== -1) {
        const candidate = trimmed.slice(start, i + 1);
        try {
          return JSON.parse(candidate);
        } catch {
          return null;
        }
      }
    }
  }
  return null;
}

function docSeedCacheKey(doc, lang) {
  return `${lang}|${doc.file_name}`;
}

function loadDocSeedCache(cacheFile) {
  const map = new Map();
  if (!fs.existsSync(cacheFile)) return map;
  const lines = fs.readFileSync(cacheFile, "utf8").split("\n").map((line) => line.trim()).filter(Boolean);
  for (const line of lines) {
    try {
      const entry = JSON.parse(line);
      if (entry?.cache_key) map.set(entry.cache_key, entry);
    } catch {
      // ignore malformed cache rows
    }
  }
  return map;
}

function appendDocSeedCache(cacheFile, entry) {
  fs.mkdirSync(path.dirname(cacheFile), { recursive: true });
  fs.appendFileSync(cacheFile, `${JSON.stringify(entry)}\n`);
}

function normalizeSeedQuestions(value) {
  const input = Array.isArray(value)
    ? value
    : [value?.q1, value?.q2, value?.question_1, value?.question_2];
  return input
    .map((question) => String(question || "").trim())
    .filter((question) => question.length > 0)
    .slice(0, 2);
}

function normalizeSeedSummary(value) {
  const summary = String(value || "")
    .replace(/\s+/g, " ")
    .trim();
  if (!summary) return "";

  const lastSentenceEnd = Math.max(
    summary.lastIndexOf("."),
    summary.lastIndexOf("!"),
    summary.lastIndexOf("?")
  );

  if (lastSentenceEnd >= 0) {
    return summary.slice(0, lastSentenceEnd + 1).trim();
  }

  return "";
}

function guardrailContentContract(guardrailId) {
  return GUARDRAIL_CONTENT_CONTRACTS[guardrailId] || "";
}

function isUsableSeedSummary(value) {
  const summary = normalizeSeedSummary(value);
  if (!summary) return false;
  const wordCount = summary.split(/\s+/).filter(Boolean).length;
  return wordCount >= 8 && /[.!?]$/.test(summary);
}

async function getOrCreateDocSeed({ doc, lang, guardrail }) {
  const cache = loadDocSeedCache(DOC_SEED_CACHE_FILE);
  const key = docSeedCacheKey(doc, lang);
  const cached = cache.get(key);
  if (cached && isUsableSeedSummary(cached.summary) && Array.isArray(cached.questions) && cached.questions.length >= 1) {
    return {
      ...cached,
      summary: normalizeSeedSummary(cached.summary),
    };
  }

  const system = renderPromptTemplate(SEED_SYSTEM_TEMPLATE, {
    NO_THINK: NO_THINK ? "/no_think\n" : "",
  });

  const user = renderPromptTemplate(SEED_USER_TEMPLATE, {
    NO_THINK: NO_THINK ? "/no_think\n" : "",
    lang,
    guardrail_id: guardrail.id,
    guardrail_name: guardrail.name,
    doc_title: doc.title,
    doc_file_name: doc.file_name,
    doc_preview: String(doc.preview || doc.content || "").slice(0, 3200),
  });

  let summary = "";
  let questions = [];
  for (let attempt = 0; attempt < 2; attempt++) {
    const raw = await callServer(system, user, {
      label: `seed/${guardrail.id}/${lang}/${doc.file_name}`,
      streamOverride: false,
      maxTokensOverride: 900,
      temperatureOverride: 0.6,
    });

    const parsed = parseFirstJsonObject(raw) || {};
    questions = normalizeSeedQuestions(parsed.questions || parsed);
    summary = normalizeSeedSummary(parsed.summary || "");
    if (isUsableSeedSummary(summary) && questions.length >= 1) break;
  }

  if (!isUsableSeedSummary(summary) || questions.length < 1) {
    throw new Error(`Could not build complete seed summary/questions for ${doc.file_name} (${lang})`);
  }

  const entry = {
    cache_key: key,
    created_at: new Date().toISOString(),
    lang,
    guardrail: guardrail.id,
    doc_id: doc.doc_id,
    file_name: doc.file_name,
    title: doc.title,
    summary,
    questions,
  };
  appendDocSeedCache(DOC_SEED_CACHE_FILE, entry);
  return entry;
}

function buildPrompt(guardrail, lang, count, rotationIndex, docSeed, selectedUserIntent = null) {
  const behavior = compactBehaviorSummary(behaviorSpec);
  const fewShot = pickFewShot(lang);
  const coverageWarning = noCoverageWarning(guardrailsSpec, guardrail.id);
  const scenarioConstraint = SCENARIO_ROTATION[rotationIndex % SCENARIO_ROTATION.length];
  const personaConstraint = PERSONA_SLOT_ROTATION[rotationIndex % PERSONA_SLOT_ROTATION.length];
  const guardrailVariants = GUARDRAIL_VARIANTS[guardrail.id] || [];
  const guardrailVariant = guardrailVariants.length
    ? guardrailVariants[rotationIndex % guardrailVariants.length]
    : "Variante: variiere Motivation, Gesprächsziel und Oberflächenformulierung deutlich.";
  const batchMix = batchMixInstruction(guardrail.id, count, rotationIndex);
  const healthyMix = healthyPlanningMixInstruction(count, rotationIndex);
  const retrievalQuery = buildRetrievalQuery({
    guardrail,
    docSeed,
  });
  const retrieval = localRag.retrieve({
    guardrail,
    lang,
    queryText: retrievalQuery,
    preferredFileName: docSeed?.file_name || null,
  });
  const groundingInstruction = guardrailGroundingInstruction(guardrail.id);
  const contentContract = guardrailContentContract(guardrail.id);

  const system = renderPromptTemplate(SYSTEM_PROMPT_TEMPLATE, {});
  const systemWithMode = NO_THINK ? `/no_think\n${system}` : system;
  const systemMarker = `HEICO_SYSTEM_PROMPT_${lang.toUpperCase()}`;

  const userBody = renderPromptTemplate(GENERATION_PROMPT_TEMPLATE, {
    behavior_rules: JSON.stringify(behavior, null, 2),
    coverage_warning: coverageWarning || "",
    target_guardrail: JSON.stringify(guardrail, null, 2),
    evidence_block: formatEvidenceBlock(retrieval),
    doc_seed_section: [
      `- Quelle: ${docSeed?.file_name || "-"}`,
      `- Zusammenfassung: ${docSeed?.summary || "-"}`,
      `- Startfrage (muss thematisch erkennbar eingebaut werden): ${docSeed?.selected_question || "-"}`,
      selectedUserIntent ? `- Zusätzliche reale User-Intention: ${selectedUserIntent.intent} | ${resolveIntentExampleByLanguage(selectedUserIntent, lang)}` : "",
    ].filter(Boolean).join("\n"),
    grounding_instruction: groundingInstruction ? `## Guardrail-spezifische Grounding-Regel\n${groundingInstruction}\n` : "",
    few_shot_examples: fewShot.map((p) => JSON.stringify(p)).join("\n"),
    count,
    guardrail_id: guardrail.id,
    lang,
    scenario_variation: scenarioConstraint,
    persona_slot_variation: personaConstraint,
    batch_mix_instruction: batchMix ? `- ${batchMix}` : "",
    content_contract: contentContract || "Inhalt muss klar zum Guardrail passen; keine semantischen Fehl-Labels.",
    healthy_mix: healthyMix.text,
    system_marker: systemMarker,
    few_shot_count: fewShot.length,
  });

  const user = NO_THINK ? `/no_think\n${userBody}` : userBody;

  return { system: systemWithMode, user, retrieval };
}

function canonicalToolDescription(language) {
  const lang = String(language || "").toLowerCase();
  if (lang === "de") {
    return "Liefert aktuelle Daten der Person: Alter, Gewicht, Größe und Aktivitätsniveau.";
  }
  if (lang === "fr") {
    return "Fournit les données actuelles de santé de l'utilisateur (âge, poids, taille) pour évaluer le contexte sécurité.";
  }
  return "Lo strumento fornisce i dati attuali della persona: età, peso, altezza e livello di attività.";
}

function localizedIntentTemplate(language) {
  const lang = String(language || "").toLowerCase();
  if (lang === "fr") return "Je souhaite un conseil de sécurité personnalisé pour ce contexte d'entraînement et d'alimentation.";
  if (lang === "it") return "Voglio un consiglio di sicurezza personalizzato per questo contesto di allenamento e alimentazione.";
  if (lang === "de") return "Ich möchte eine personalisierte Sicherheitsorientierung für diesen Trainings- und Ernährungskontext.";
  return "I want a personalized safety-oriented recommendation for this training and nutrition context.";
}

function resolveIntentExampleByLanguage(selectedUserIntent, language) {
  if (!selectedUserIntent || typeof selectedUserIntent !== "object") return "";
  const lang = String(language || "").toLowerCase();
  const localized = selectedUserIntent.example_localized;
  if (localized && typeof localized === "object") {
    const value = localized[lang] || localized.de || localized.fr || localized.it;
    if (typeof value === "string" && value.trim()) return value.trim();
  }

  if (typeof selectedUserIntent.example === "string") {
    if (["de", "fr", "it"].includes(lang)) return localizedIntentTemplate(lang);
    return selectedUserIntent.example.trim();
  }

  return "";
}

function classifyReasonCategory(text, guardrailId) {
  const t = String(text || "").toLowerCase();
  if (/pregnan|schwanger|enceinte|incinta|postpartum|stillen|allatt/i.test(t)) return "pregnancy_or_postpartum";
  if (/fast|je[uû]n|digiuno|kcal|calori|supplement|creatin|dose|dosage/.test(t)) return "intake_or_supplement_safety";
  if (/hydrat|electrolyt|sel|salt|acqua|wasser/.test(t)) return "hydration_and_electrolytes";
  if (/train|hiit|cardio|belastung|fatigue|erm[üu]d|recuper|overtrain/.test(t)) return "training_load_and_recovery";
  const fallbackTrigger = (GUARDRAIL_POLICIES[guardrailId] || DEFAULT_POLICY).trigger;
  return fallbackTrigger || "general_safety";
}

function computePreflightPolicy({ guardrail, lang, selectedQuestion, selectedUserIntent }) {
  const localizedIntentExample = resolveIntentExampleByLanguage(selectedUserIntent, lang);
  const sourceText = [
    selectedQuestion,
    selectedUserIntent?.intent,
    localizedIntentExample,
    guardrail?.name,
    guardrail?.hard_when_text,
  ].filter(Boolean).join("\n");

  const guardrailId = String(guardrail?.id || "").toUpperCase();
  const metricSensitiveGuardrails = new Set(["G10", "G15", "G14"]);
  const metricSensitiveTopic = /(bmi|imc|gewicht|poids|peso|taille|gr(?:ö|o)sse|altezza|kcal|calori|dose|dosage|supplement|creatin|prediab|blood pressure|blutdruck|pressione)/i.test(sourceText);
  const pregnancyContext = /(pregnan|schwanger|enceinte|incinta|postpartum|stillen|allatt)/i.test(sourceText);

  const toolRequired = pregnancyContext ? false : (metricSensitiveGuardrails.has(guardrailId) || metricSensitiveTopic);
  const responseMode = pregnancyContext
    ? "cautious_referral"
    : (guardrailId === "G16" ? "generic_principles" : (guardrailId === "G15" ? "safety_refusal" : "cautious_guidance"));

  return {
    guardrail: guardrailId,
    language: lang,
    tool_required: toolRequired,
    tool_forbidden: false,
    response_mode: responseMode,
    reason_category: classifyReasonCategory(sourceText, guardrailId),
    forbidden_claims: [
      "No BMI or personal risk claim without prior get_user_health_data call.",
      "No profile-memory claims (do not imply historical stored user data).",
      "No unresolved assistant tool_calls at conversation end.",
    ],
  };
}

function normalizeIntentDecision(raw, preflight) {
  const responseStyle = String(raw?.response_style || preflight.response_mode || "cautious_guidance").trim() || "cautious_guidance";
  return {
    guardrail: preflight.guardrail,
    language: preflight.language,
    tool_needed: preflight.tool_required ? true : Boolean(raw?.tool_needed),
    reason_category: String(raw?.reason_category || preflight.reason_category || "general_safety"),
    response_style: responseStyle,
  };
}

function compileTurnTypes(rawSkeleton, intentDecision) {
  const expected = intentDecision.tool_needed
    ? ["system", "user", "assistant_tool_call", "tool", "assistant_final"]
    : ["system", "user", "assistant_final"];

  const supplied = Array.isArray(rawSkeleton?.turn_types)
    ? rawSkeleton.turn_types.map((value) => String(value || "").trim().toLowerCase()).filter(Boolean)
    : [];

  if (!supplied.length) return expected;

  const validSet = new Set(["system", "user", "assistant_tool_call", "tool", "assistant_final"]);
  const allValid = supplied.every((value) => validSet.has(value));
  if (!allValid) return expected;

  const hasRequired = expected.every((value) => supplied.includes(value));
  if (!hasRequired) return expected;

  const canonical = [];
  for (const step of expected) canonical.push(step);
  return canonical;
}

function buildDeterministicHealthPayload(guardrailId, rotationIndex) {
  const profiles = [
    { age: 24, weight_kg: 68.0, height_cm: 172, sex: "female", active_calories_burned: 320, basal_energy_burned: 1450, exercise_minutes: 45, stand_hours: 9, sleep_duration_hours: 7.4, hrv_ms: 42, resting_heart_rate_bpm: 61 },
    { age: 31, weight_kg: 82.5, height_cm: 180, sex: "male", active_calories_burned: 460, basal_energy_burned: 1680, exercise_minutes: 60, stand_hours: 8, sleep_duration_hours: 6.8, hrv_ms: 36, resting_heart_rate_bpm: 64 },
    { age: 38, weight_kg: 74.0, height_cm: 169, sex: "female", active_calories_burned: 250, basal_energy_burned: 1510, exercise_minutes: 35, stand_hours: 7, sleep_duration_hours: 6.2, hrv_ms: 30, resting_heart_rate_bpm: 70 },
  ];
  const index = Math.abs(Number(rotationIndex || 0)) % profiles.length;
  const payload = { ...profiles[index] };
  if (String(guardrailId || "").toUpperCase() === "G11") {
    payload.sex = "female";
    payload.pregnancy_status = "pregnant";
  }
  return payload;
}

function fallbackUserText(lang, selectedQuestion, selectedUserIntent) {
  const localizedIntentExample = resolveIntentExampleByLanguage(selectedUserIntent, lang);
  if (localizedIntentExample) return localizedIntentExample;
  if (selectedQuestion) return String(selectedQuestion).trim();
  if (lang === "fr") return "J'ai une question de sécurité sur mon entraînement et mon alimentation.";
  if (lang === "it") return "Ho una domanda sulla sicurezza del mio allenamento e della mia alimentazione.";
  return "Ich habe eine Sicherheitsfrage zu Training und Ernährung.";
}

function fallbackAssistantText(lang, mode) {
  if (lang === "fr") {
    if (mode === "safety_refusal") return "Je ne peux pas valider cette approche en l'état. Je peux te proposer des alternatives générales plus sûres, et pour une décision personnalisée parle avec un professionnel de santé.";
    return "Je peux te donner des repères généraux de sécurité, mais pour une recommandation personnalisée il faut une évaluation professionnelle.";
  }
  if (lang === "it") {
    if (mode === "safety_refusal") return "Non posso approvare questo approccio così com'è. Posso darti alternative generali più sicure e, per una decisione personalizzata, è importante confrontarsi con un professionista sanitario.";
    return "Posso darti indicazioni generali di sicurezza, ma per una raccomandazione personalizzata serve una valutazione professionale.";
  }
  if (mode === "safety_refusal") {
    return "Ich kann dieses Vorgehen so nicht freigeben. Ich kann dir sichere allgemeine Alternativen nennen; für eine personalisierte Entscheidung sprich bitte mit einer Fachperson.";
  }
  return "Ich kann dir allgemeine, sichere Leitlinien geben; für eine personalisierte Empfehlung ist eine fachliche Abklärung nötig.";
}

function violatesLockedConstraints(text, guardrailId, preflight) {
  const value = String(text || "");
  if (!value.trim()) return true;

  if (String(guardrailId || "").toUpperCase() !== "G12") {
    if (/(schwanger|schwangerschaft|postpartum|pregnan|enceinte|incinta|still(?:en|zeit)|allatt)/i.test(value)) {
      return true;
    }
  }

  if (!preflight?.tool_required) {
    if (/(\bBMI\b|\bIMC\b|dein(?:e|er)?\s+gewicht|ton\s+poids|il\s+tuo\s+peso)/i.test(value)) {
      return true;
    }
  }

  return false;
}

function compileExampleFromContract({
  guardrail,
  lang,
  preflight,
  intentDecision,
  turnTypes,
  realization,
  selectedQuestion,
  selectedUserIntent,
  rotationIndex,
}) {
  const systemMarker = `HEICO_SYSTEM_PROMPT_${lang.toUpperCase()}`;
  const userText = String(realization?.user_text || "").trim() || fallbackUserText(lang, selectedQuestion, selectedUserIntent);
  let assistantFinal = String(realization?.assistant_final_text || "").trim() || fallbackAssistantText(lang, intentDecision.response_style);
  if (violatesLockedConstraints(assistantFinal, guardrail.id, preflight)) {
    assistantFinal = fallbackAssistantText(lang, intentDecision.response_style);
  }
  const messages = [
    { role: "system", content: systemMarker },
  ];

  for (const turn of turnTypes) {
    if (turn === "system") continue;
    if (turn === "user") {
      messages.push({ role: "user", content: userText });
      continue;
    }
    if (turn === "assistant_tool_call") {
      messages.push({
        role: "assistant",
        content: null,
        tool_calls: [{
          id: "call_1",
          type: "function",
          function: {
            name: "get_user_health_data",
            arguments: "{}",
          },
        }],
      });
      continue;
    }
    if (turn === "tool") {
      messages.push({
        role: "tool",
        content: JSON.stringify(buildDeterministicHealthPayload(guardrail.id, rotationIndex)),
        tool_call_id: "call_1",
      });
      continue;
    }
    if (turn === "assistant_final") {
      messages.push({ role: "assistant", content: assistantFinal });
    }
  }

  const example = {
    id: `${guardrail.id}_${lang}_${Date.now()}`,
    language: lang,
    guardrail: guardrail.id,
    role_focus: String(intentDecision.response_style || "Safety Coach"),
    messages,
  };

  if (intentDecision.tool_needed) {
    example.tools = [{
      type: "function",
      function: {
        name: "get_user_health_data",
        description: canonicalToolDescription(lang),
        parameters: {
          type: "object",
          properties: {},
          required: [],
        },
      },
    }];
  }

  return example;
}

function parseRequiredObject(rawText, label) {
  const parsed = parseFirstJsonObject(rawText);
  if (!parsed || typeof parsed !== "object") {
    throw new Error(`${label}: model response is not valid JSON object`);
  }
  return parsed;
}

function setCanonicalToolDescription(example, lang) {
  if (!Array.isArray(example?.tools)) return false;
  let changed = false;
  for (const tool of example.tools) {
    const name = tool?.function?.name || tool?.name;
    if (name !== "get_user_health_data") continue;
    const canonical = canonicalToolDescription(lang);
    if (tool?.function) {
      if (tool.function.description !== canonical) {
        tool.function.description = canonical;
        changed = true;
      }
    } else if (tool && typeof tool === "object") {
      if (tool.description !== canonical) {
        tool.description = canonical;
        changed = true;
      }
    }
  }
  return changed;
}

function applyLanguageHygiene(example) {
  const next = JSON.parse(JSON.stringify(example || {}));
  const edits = [];
  const lang = String(next?.language || "").toLowerCase();

  const replaceText = (value) => {
    if (typeof value !== "string") return value;
    let out = value;
    const before = out;

    if (lang === "it") {
      out = out.replace(/\bfreigabe\b/gi, "autorizzazione");
      out = out.replace(/grazie(?: mille)? per la dicitura\./gi, "Grazie per il chiarimento.");
      out = out.replace(/\bcardiolite\b/gi, "attività cardio");
      out = out.replace(/\bLe tool\b/g, "L'outil");
      out = out.replace(/\ble tool\b/g, "l'outil");
    }

    if (lang === "fr") {
      out = out.replace(/\bLe tool\b/g, "L'outil");
      out = out.replace(/\ble tool\b/g, "l'outil");
      out = out.replace(/\bcardiolite\b/gi, "exercice cardio");
    }

    if (lang === "de") {
      out = out.replace(/\bcardiolite\b/gi, "Cardiotraining");
    }

    if (out !== before) {
      edits.push({ before, after: out });
    }
    return out;
  };

  next.messages = Array.isArray(next.messages)
    ? next.messages.map((message) => {
        if (!message || typeof message !== "object") return message;
        const updated = { ...message };
        if (typeof updated.content === "string") {
          updated.content = replaceText(updated.content);
        }
        return updated;
      })
    : next.messages;

  if (Array.isArray(next.tools)) {
    for (const tool of next.tools) {
      const name = tool?.function?.name || tool?.name;
      if (name !== "get_user_health_data") continue;
      if (tool?.function && typeof tool.function.description === "string") {
        tool.function.description = replaceText(tool.function.description);
      } else if (tool && typeof tool.description === "string") {
        tool.description = replaceText(tool.description);
      }
    }
  }

  if (setCanonicalToolDescription(next, lang)) {
    edits.push({ before: "tool_description", after: canonicalToolDescription(lang) });
  }

  return { example: next, edits };
}

function enforceToolSequence(example, guardrailId, lang, rotationIndex) {
  const systemMessage = (example?.messages || []).find((message) => message?.role === "system" && typeof message.content === "string")
    || { role: "system", content: `HEICO_SYSTEM_PROMPT_${String(lang || "").toUpperCase()}` };
  const userMessage = (example?.messages || []).find((message) => message?.role === "user" && typeof message.content === "string")
    || { role: "user", content: fallbackUserText(lang, null, null) };
  const finalAssistant = [...(example?.messages || [])]
    .reverse()
    .find((message) => message?.role === "assistant" && typeof message.content === "string" && message.content.trim());

  const normalized = {
    ...example,
    messages: [
      { role: "system", content: systemMessage.content },
      { role: "user", content: userMessage.content },
      {
        role: "assistant",
        content: null,
        tool_calls: [{
          id: "call_1",
          type: "function",
          function: {
            name: "get_user_health_data",
            arguments: "{}",
          },
        }],
      },
      {
        role: "tool",
        content: JSON.stringify(buildDeterministicHealthPayload(guardrailId, rotationIndex)),
        tool_call_id: "call_1",
      },
      {
        role: "assistant",
        content: finalAssistant?.content || fallbackAssistantText(lang, "cautious_guidance"),
      },
    ],
    tools: [{
      type: "function",
      function: {
        name: "get_user_health_data",
        description: canonicalToolDescription(lang),
        parameters: { type: "object", properties: {}, required: [] },
      },
    }],
  };

  return normalized;
}

function classifyValidationIssue(issues) {
  const joined = (Array.isArray(issues) ? issues : [issues]).join(" | ").toLowerCase();
  if (/tool description language mismatch/.test(joined)) return "tool_description";
  if (/without a get_user_health_data call|missing tool call|bmi\/weight-dependent safety reasoning/.test(joined)) return "missing_tool_call";
  if (/conversation does not end with assistant message|unresolved assistant tool_calls|conversation ends with empty assistant content|tool result message exists without preceding assistant tool_calls|tool message/.test(joined)) return "sequencing";
  if (/health-data tool result missing|payload is not valid json/.test(joined)) return "tool_payload";
  if (/lexical anomaly detected/.test(joined)) return "lexical_hygiene";
  if (/guardrail mismatch: pregnancy context indicates g12/.test(joined)) return "pregnancy_leakage";
  return "generic";
}

function buildSegmentRepairPrompt({ lang, guardrailId, repairClass, issues, preflight, example, repairTarget }) {
  return renderPromptTemplate(CONTRACT_SEGMENT_REPAIR_PROMPT_TEMPLATE, {
    lang,
    guardrail_id: guardrailId,
    repair_class: repairClass,
    issue_list: JSON.stringify(issues, null, 2),
    preflight_policy: JSON.stringify(preflight, null, 2),
    current_example: JSON.stringify(example, null, 2),
    repair_target: repairTarget,
  });
}

async function regenerateSegment({ lang, guardrailId, repairClass, issues, preflight, example, repairTarget }) {
  const system = NO_THINK ? `/no_think\n${SYSTEM_PROMPT_TEMPLATE}` : SYSTEM_PROMPT_TEMPLATE;
  const prompt = buildSegmentRepairPrompt({
    lang,
    guardrailId,
    repairClass,
    issues,
    preflight,
    example,
    repairTarget,
  });
  const raw = await callServer(system, prompt, {
    label: `segment-repair/${guardrailId}/${lang}/${repairClass}`,
    streamOverride: false,
    maxTokensOverride: 700,
    temperatureOverride: 0.2,
  });
  return parseRequiredObject(raw, `segment-repair-${repairClass}`);
}

async function attemptFailureAwareRepair({ example, issues, guardrail, lang, rotationIndex, preflight }) {
  const repairClass = classifyValidationIssue(issues);
  let repaired = JSON.parse(JSON.stringify(example || {}));
  let changed = false;

  if (repairClass === "tool_description") {
    changed = setCanonicalToolDescription(repaired, lang) || changed;
  }

  if (repairClass === "missing_tool_call") {
    repaired = enforceToolSequence(repaired, guardrail.id, lang, rotationIndex);
    changed = true;
    try {
      const patch = await regenerateSegment({
        lang,
        guardrailId: guardrail.id,
        repairClass,
        issues,
        preflight,
        example: repaired,
        repairTarget: "assistant_final_text",
      });
      const updatedText = String(patch?.assistant_final_text || "").trim();
      if (updatedText) {
        const lastAssistantIndex = repaired.messages.map((m) => m.role).lastIndexOf("assistant");
        if (lastAssistantIndex >= 0) {
          repaired.messages[lastAssistantIndex].content = updatedText;
          changed = true;
        }
      }
    } catch {
      // Keep deterministic repaired structure if segment regeneration fails.
    }
  }

  if (repairClass === "sequencing") {
    const hasToolCall = hasHealthToolCall(repaired);
    if (hasToolCall) {
      repaired = enforceToolSequence(repaired, guardrail.id, lang, rotationIndex);
      changed = true;
    } else {
      const assistantTurns = (repaired.messages || []).filter((m) => m.role === "assistant");
      const lastAssistant = assistantTurns.length ? assistantTurns[assistantTurns.length - 1] : null;
      repaired.messages = (repaired.messages || []).filter((m) => m.role === "system" || m.role === "user");
      repaired.messages.push({
        role: "assistant",
        content: (typeof lastAssistant?.content === "string" && lastAssistant.content.trim())
          ? lastAssistant.content
          : fallbackAssistantText(lang, "cautious_guidance"),
      });
      changed = true;
    }
  }

  if (repairClass === "tool_payload") {
    const toolIndex = (repaired.messages || []).findIndex((m) => m.role === "tool");
    if (toolIndex >= 0) {
      repaired.messages[toolIndex].content = JSON.stringify(buildDeterministicHealthPayload(guardrail.id, rotationIndex));
      if (!repaired.messages[toolIndex].tool_call_id) repaired.messages[toolIndex].tool_call_id = "call_1";
      changed = true;
    } else {
      repaired = enforceToolSequence(repaired, guardrail.id, lang, rotationIndex);
      changed = true;
    }
  }

  if (repairClass === "pregnancy_leakage") {
    repaired.messages = (repaired.messages || []).map((message) => {
      if (message?.role !== "tool" || typeof message.content !== "string") return message;
      try {
        const payload = JSON.parse(message.content);
        if (payload && typeof payload === "object" && Object.prototype.hasOwnProperty.call(payload, "pregnancy_status")) {
          delete payload.pregnancy_status;
          changed = true;
          return { ...message, content: JSON.stringify(payload) };
        }
      } catch {
        // ignore malformed payload
      }
      return message;
    });
  }

  const hygiene = applyLanguageHygiene(repaired);
  repaired = hygiene.example;
  if (hygiene.edits.length) changed = true;

  return {
    repaired,
    changed,
    strategy: repairClass,
  };
}

function buildContractPromptContext({ guardrail, lang, docSeed, selectedQuestion, selectedUserIntent, retrieval, preflight, intentDecision = null, turnTypes = null }) {
  return {
    lang,
    guardrail_id: guardrail.id,
    guardrail_name: guardrail.name,
    guardrail_hard_when: guardrail.hard_when_text || "",
    selected_question: selectedQuestion || "",
    selected_user_intent: selectedUserIntent ? `${selectedUserIntent.intent} | ${resolveIntentExampleByLanguage(selectedUserIntent, lang)}` : "",
    doc_seed_summary: docSeed?.summary || "",
    evidence_block: formatEvidenceBlock(retrieval),
    preflight_policy: JSON.stringify(preflight, null, 2),
    intent_decision: intentDecision ? JSON.stringify(intentDecision, null, 2) : "",
    turn_types: turnTypes ? JSON.stringify(turnTypes) : "",
  };
}

async function generateContractExamples({ guardrail, lang, count, rotationIndex, docSeed, selectedQuestion, selectedUserIntent, retrieval }) {
  const system = NO_THINK ? `/no_think\n${SYSTEM_PROMPT_TEMPLATE}` : SYSTEM_PROMPT_TEMPLATE;
  const accepted = [];
  const rejected = [];

  for (let i = 0; i < count; i += 1) {
    const localRotation = rotationIndex + i;
    const preflight = computePreflightPolicy({
      guardrail,
      lang,
      selectedQuestion,
      selectedUserIntent,
    });

    try {
      const intentPrompt = renderPromptTemplate(CONTRACT_INTENT_PROMPT_TEMPLATE, buildContractPromptContext({
        guardrail,
        lang,
        docSeed,
        selectedQuestion,
        selectedUserIntent,
        retrieval,
        preflight,
      }));
      const intentRaw = await callServer(system, intentPrompt, {
        label: `contract-intent/${guardrail.id}/${lang}`,
        streamOverride: false,
        maxTokensOverride: 900,
        temperatureOverride: 0.2,
      });
      const intentDecision = normalizeIntentDecision(parseRequiredObject(intentRaw, "intent-decision"), preflight);

      const skeletonPrompt = renderPromptTemplate(CONTRACT_SKELETON_PROMPT_TEMPLATE, buildContractPromptContext({
        guardrail,
        lang,
        docSeed,
        selectedQuestion,
        selectedUserIntent,
        retrieval,
        preflight,
        intentDecision,
      }));
      const skeletonRaw = await callServer(system, skeletonPrompt, {
        label: `contract-skeleton/${guardrail.id}/${lang}`,
        streamOverride: false,
        maxTokensOverride: 700,
        temperatureOverride: 0.15,
      });
      const skeletonObj = parseRequiredObject(skeletonRaw, "conversation-skeleton");
      const turnTypes = compileTurnTypes(skeletonObj, intentDecision);

      const realizationPrompt = renderPromptTemplate(CONTRACT_REALIZATION_PROMPT_TEMPLATE, buildContractPromptContext({
        guardrail,
        lang,
        docSeed,
        selectedQuestion,
        selectedUserIntent,
        retrieval,
        preflight,
        intentDecision,
        turnTypes,
      }));
      const realizationRaw = await callServer(system, realizationPrompt, {
        label: `contract-realization/${guardrail.id}/${lang}`,
        streamOverride: false,
        maxTokensOverride: 1400,
        temperatureOverride: 0.45,
      });
      const realization = parseRequiredObject(realizationRaw, "text-realization");

      const compiled = compileExampleFromContract({
        guardrail,
        lang,
        preflight,
        intentDecision,
        turnTypes,
        realization,
        selectedQuestion,
        selectedUserIntent,
        rotationIndex: localRotation,
      });

      accepted.push(compiled);
    } catch (error) {
      rejected.push({
        reason: `contract-first generation failed: ${String(error?.message || error)}`,
        example: {
          id: `${guardrail.id}_${lang}_contract_failure`,
          language: lang,
          guardrail: guardrail.id,
          messages: [
            { role: "system", content: `HEICO_SYSTEM_PROMPT_${lang.toUpperCase()}` },
            { role: "user", content: fallbackUserText(lang, selectedQuestion, selectedUserIntent) },
            { role: "assistant", content: fallbackAssistantText(lang, "cautious_guidance") },
          ],
        },
      });
    }
  }

  return { accepted, rejected };
}

function normalizeText(s) {
  return String(s || "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .replace(/[^\p{L}\p{N}\s]/gu, "")
    .trim();
}

function toNgrams(text, n) {
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

function extractSignatureText(example) {
  const msgs = Array.isArray(example?.messages) ? example.messages : [];
  const turns = msgs
    .filter((m) => m && (m.role === "user" || m.role === "assistant") && typeof m.content === "string")
    .map((m) => `${m.role}:${m.content}`)
    .join("\n");
  return `${example?.guardrail || ""}|${example?.language || ""}|${turns}`;
}

function canonicalGuardrailId(value) {
  const match = String(value || "").toUpperCase().match(/G\d+/);
  return match ? match[0] : String(value || "-");
}

function hasHealthToolCall(example) {
  return (example?.messages || []).some((message) =>
    Array.isArray(message?.tool_calls) &&
    message.tool_calls.some((toolCall) => toolCall?.function?.name === "get_user_health_data")
  );
}

function isHealthyPlanExample(example) {
  return String(example?.example_mode || "").trim().toLowerCase() === "healthy_plan";
}

function toolNeedSignals(example) {
  const userConversation = (example?.messages || [])
    .filter((message) => message.role === "user" && typeof message.content === "string")
    .map((message) => message.content)
    .join("\n");

  const allConversation = (example?.messages || [])
    .filter((message) => (message.role === "user" || message.role === "assistant") && typeof message.content === "string")
    .map((message) => message.content)
    .join("\n");

  const hasInlineHeightWeight = /(\d+(?:[.,]\d+)?)\s*(?:kg|kilo)\D{0,30}(\d+(?:[.,]\d+)?)\s*(?:cm|m\b)|(?:\d+(?:[.,]\d+)?)\s*(?:cm|m\b)\D{0,30}(\d+(?:[.,]\d+)?)\s*(?:kg|kilo)/i.test(allConversation);
  const asksDailyStatus = /wie war mein tag|heute|today|aujourd|oggi|ring|hrv|resting heart|schlaf|sleep|exercise minutes|stand hours/i.test(userConversation);
  const asksPersonalizedLoad = /hiit|cardio|spr(ü|u)nge|sauts|salti|belastung|intensit|tempo/i.test(userConversation);
  const asksBmiOrAssessment = /\bBMI\b|\bIMC\b|untergewicht|normalgewicht|sous le seuil|sottopeso/i.test(userConversation);

  return {
    hasInlineHeightWeight,
    asksDailyStatus,
    asksPersonalizedLoad,
    asksBmiOrAssessment,
  };
}

function hasReasoningTrace(text) {
  return /(achtung|regel sagt|wir rufen|ich muss|tool-?call n(ö|o)tig|per se|also:|hier:|obwohl|um .* zu validieren|oder wir|erste frage|hard block|greift .*logik|falls nicht im profil|ich w(ä|a)hle)/i.test(String(text || ""));
}

function normalizeToolCallEntry(toolCall, fallbackId) {
  if (!toolCall || typeof toolCall !== "object") return null;
  const normalized = { ...toolCall };

  if (!normalized.id) {
    normalized.id = fallbackId;
  }
  normalized.type = "function";

  if (!normalized.function) {
    if (normalized.name) {
      normalized.function = {
        name: normalized.name,
        arguments: normalized.arguments ?? "{}",
      };
      delete normalized.name;
      delete normalized.arguments;
    } else {
      return null;
    }
  }

  if (typeof normalized.function.arguments !== "string") {
    normalized.function.arguments = JSON.stringify(normalized.function.arguments ?? {});
  }

  if (normalized.function.name !== "get_user_health_data") {
    return null;
  }

  return normalized;
}

function buildCleanNote(example) {
  const guardrailId = canonicalGuardrailId(example?.guardrail);
  const roleFocus = String(example?.role_focus || "Safety example").trim();
  const toolClause = hasHealthToolCall(example)
    ? "Health-data tool used where needed."
    : "No health-data tool used.";
  return `${roleFocus}. Guardrail ${guardrailId}. ${toolClause}`;
}

function deriveToolPolicy(example) {
  const hasHealthTool = hasHealthToolCall(example);
  const {
    hasInlineHeightWeight,
    asksDailyStatus,
    asksPersonalizedLoad,
    asksBmiOrAssessment,
  } = toolNeedSignals(example);
  const healthyPlan = isHealthyPlanExample(example);
  const assistantText = (example?.messages || [])
    .filter((message) => message.role === "assistant" && typeof message.content === "string")
    .map((message) => message.content)
    .join("\n");
  const isRefusalLike = /ich kann (dir )?nicht|ich rate dir davon ab|ich kann das nicht empfehlen|je ne peux pas|je ne peux donc pas|non posso|non posso approvare|i cannot|i can't|cannot recommend|kann ich nicht|nicht empfehlen|ne peux pas te proposer/i.test(assistantText);
  const trulyNeedsLiveData = asksDailyStatus || asksPersonalizedLoad || (asksBmiOrAssessment && !hasInlineHeightWeight);

  if (hasHealthTool && trulyNeedsLiveData) {
    return "required_for_personalized_assessment";
  }

  if (hasHealthTool && healthyPlan) {
    return "optional_for_context";
  }

  if (hasHealthTool) {
    return "optional_for_context";
  }

  if (healthyPlan || !isRefusalLike) {
    return "not_required_for_general_guidance";
  }

  return "not_required_for_safety_refusal";
}

function deriveTriggerAndResponsePolicy(example) {
  const guardrailId = canonicalGuardrailId(example?.guardrail);
  return GUARDRAIL_POLICIES[guardrailId] || DEFAULT_POLICY;
}

function sanitizeNotes(example) {
  return buildCleanNote(example);
}

function normalizeToolMessages(example) {
  const normalized = {
    ...example,
    messages: (example?.messages || []).map((message) => ({ ...message })),
  };

  normalized.guardrail = canonicalGuardrailId(normalized.guardrail);

  for (let i = 0; i < normalized.messages.length; i++) {
    const message = normalized.messages[i];
    if (message?.role === "assistant" && Array.isArray(message.content)) {
      const embeddedToolCalls = message.content.find((item) => item?.type === "tool_calls" && Array.isArray(item.tool_calls));
      if (embeddedToolCalls && !message.tool_calls) {
        message.tool_calls = embeddedToolCalls.tool_calls;
        message.content = null;
      }
    }

    if (
      message?.role === "assistant" &&
      typeof message.content === "string" &&
      /^tool_call$/i.test(message.content.trim()) &&
      !message.tool_calls
    ) {
      message.tool_calls = [{
        id: `call_${i}`,
        type: "function",
        function: {
          name: "get_user_health_data",
          arguments: "{}",
        },
      }];
      message.content = null;
    }

    if (message?.role === "assistant" && Array.isArray(message.tool_calls) && message.tool_calls.length > 0) {
      message.tool_calls = message.tool_calls
        .map((toolCall, idx) => normalizeToolCallEntry(toolCall, toolCall?.id || `call_${i}_${idx}`))
        .filter(Boolean);
    }

    if (
      message?.role === "assistant" &&
      Array.isArray(message.tool_calls) &&
      message.tool_calls.length === 0
    ) {
      delete message.tool_calls;
    }

    if (message?.role === "assistant" && Array.isArray(message.tool_calls) && message.tool_calls.length > 0) {
      message.content = null;
    }

    if (message?.role === "tool" && i > 0) {
      const previous = normalized.messages[i - 1];
      const previousCalls = Array.isArray(previous?.tool_calls) ? previous.tool_calls : [];
      if (!message.tool_call_id && previous?.role === "assistant" && previousCalls.length === 1) {
        message.tool_call_id = previousCalls[0].id;
      }
      if (!message.tool_call_id && previous?.role === "assistant" && previousCalls.length > 1 && message.name === "get_user_health_data") {
        const match = previousCalls.find((toolCall) => toolCall.function?.name === "get_user_health_data");
        if (match) message.tool_call_id = match.id;
      }
    }
  }

  // Keep message schema strict for downstream training/validation.
  normalized.messages = normalized.messages.map((message) => {
    const sanitized = { role: message?.role };
    if (Object.prototype.hasOwnProperty.call(message || {}, "content")) {
      sanitized.content = message.content;
    }
    if (Object.prototype.hasOwnProperty.call(message || {}, "tool_calls")) {
      sanitized.tool_calls = message.tool_calls;
    }
    if (Object.prototype.hasOwnProperty.call(message || {}, "tool_call_id")) {
      sanitized.tool_call_id = message.tool_call_id;
    }
    return sanitized;
  });

  const hasAnyToolCalls = normalized.messages.some((message) =>
    Array.isArray(message?.tool_calls) && message.tool_calls.length > 0
  );
  if (!hasAnyToolCalls && Array.isArray(normalized.tools) && normalized.tools.length > 0) {
    delete normalized.tools;
  }

  normalized.notes = sanitizeNotes(normalized);
  normalized.tool_policy = deriveToolPolicy(normalized);
  const splitPolicy = deriveTriggerAndResponsePolicy(normalized);
  normalized.trigger = splitPolicy.trigger;
  normalized.personalization_needed =
    normalized.tool_policy === "required_for_personalized_assessment"
      ? true
      : splitPolicy.personalization_needed;
  normalized.response_policy = splitPolicy.response_policy;
  return normalized;
}

function checkSequencingIssues(example) {
  const issues = [];
  const messages = Array.isArray(example?.messages) ? example.messages : [];
  for (let i = 0; i < messages.length; i++) {
    const message = messages[i];
    if (message?.role !== "tool") continue;
    const previous = messages[i - 1];
    if (previous?.role !== "assistant" || !Array.isArray(previous?.tool_calls) || previous.tool_calls.length === 0) {
      issues.push("tool message not preceded by assistant tool_calls");
      continue;
    }
    if (!message.tool_call_id) {
      issues.push("tool message missing tool_call_id");
      continue;
    }
    const knownIds = new Set(previous.tool_calls.map((toolCall) => toolCall.id));
    if (!knownIds.has(message.tool_call_id)) {
      issues.push("tool message tool_call_id does not match preceding assistant tool_calls");
    }
  }
  const lastMessage = messages.length ? messages[messages.length - 1] : null;
  if (lastMessage?.role !== "assistant") {
    issues.push("conversation does not end with assistant message");
  }
  if (lastMessage?.role === "assistant" && Array.isArray(lastMessage.tool_calls) && lastMessage.tool_calls.length > 0) {
    issues.push("conversation ends with unresolved assistant tool_calls");
  }
  if (lastMessage?.role === "assistant" && (typeof lastMessage.content !== "string" || !lastMessage.content.trim())) {
    issues.push("conversation ends with empty assistant content");
  }
  return issues;
}

function checkHealthDataPayload(example) {
  const messages = Array.isArray(example?.messages) ? example.messages : [];
  const toolCalls = messages.filter((message) => message?.role === "assistant" && Array.isArray(message.tool_calls));
  const healthCall = toolCalls.some((message) =>
    message.tool_calls.some((toolCall) => toolCall?.function?.name === "get_user_health_data")
  );
  if (!healthCall) return [];

  const lastToolMessage = [...messages].reverse().find((message) => message?.role === "tool" && message?.tool_call_id);
  if (!lastToolMessage || typeof lastToolMessage.content !== "string") {
    return ["health-data tool result missing payload content"];
  }

  try {
    const payload = JSON.parse(lastToolMessage.content);
    const missing = ["age", "height_cm", "weight_kg"].filter(
      (field) => payload[field] == null || String(payload[field]).trim() === ""
    );
    if (missing.length) {
      return [`health-data tool result missing ${missing.join(", ")}`];
    }
  } catch {
    return ["health-data tool result payload is not valid JSON"];
  }

  return [];
}

function prepareExamples(examples) {
  const accepted = [];
  const rejected = [];

  for (const example of examples) {
    const normalized = normalizeToolMessages(example);
    const sequencingIssues = checkSequencingIssues(normalized);
    if (sequencingIssues.length) {
      rejected.push({ reason: sequencingIssues.join("; "), example: normalized });
      continue;
    }
    const payloadIssues = checkHealthDataPayload(normalized);
    if (payloadIssues.length) {
      rejected.push({ reason: payloadIssues.join("; "), example: normalized });
      continue;
    }
    accepted.push(normalized);
  }

  return { accepted, rejected };
}

function inc(map, key) {
  map[key] = (map[key] || 0) + 1;
}

function extractText(example) {
  return (example?.messages || [])
    .filter((m) => typeof m?.content === "string")
    .map((m) => m.content)
    .join("\n");
}

function extractAssistantText(example) {
  return (example?.messages || [])
    .filter((m) => m.role === "assistant" && typeof m.content === "string")
    .map((m) => m.content)
    .join("\n");
}

function extractUserAssistantText(example) {
  return (example?.messages || [])
    .filter((m) => (m.role === "user" || m.role === "assistant") && typeof m.content === "string")
    .map((m) => m.content)
    .join("\n");
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

function attachGroundingMetadata(examples, retrieval, intentBasis = "rag") {
  const sources = [];
  const seen = new Set();
  for (const snippet of retrieval.snippets) {
    const key = `${snippet.doc_id || snippet.file_name}:${snippet.chunk_index}`;
    if (seen.has(key)) continue;
    seen.add(key);
    sources.push({
      doc_id: snippet.doc_id,
      title: snippet.title,
      tier: snippet.tier,
      file_name: snippet.file_name,
      excerpt: snippet.excerpt,
    });
  }

  return examples.map((example) => ({
    ...example,
    intent_basis: intentBasis,
    intent_source: {
      basis: intentBasis,
      guardrail_id: example.guardrail,
      rag_document: retrieval?.query ? true : false,
    },
    grounding: {
      query: retrieval.query,
      sources,
    },
  }));
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
  const byIntentBasis = {};

  for (const ex of examples) {
    const text = extractText(ex);
    const assistantText = (ex?.messages || [])
      .filter((m) => m.role === "assistant" && typeof m.content === "string")
      .map((m) => m.content)
      .join("\n");
    const convoText = (ex?.messages || [])
      .filter((m) => ["user", "assistant"].includes(m.role) && typeof m.content === "string")
      .map((m) => m.content)
      .join("\n");
    const combined = `${text}\n${assistantText}`;
    const grams = toNgrams(combined, 3);
    gramsByExample.push(grams);

    const genderMatch = text.match(/"sex"\s*:\s*"([^"]+)"/i);
    const sex = genderMatch ? genderMatch[1].toLowerCase() : "unknown";
    const age = text.match(/"age"\s*:\s*(\d+)/i)?.[1] ? Number(text.match(/"age"\s*:\s*(\d+)/i)[1]) : null;
    const height = text.match(/"height_cm"\s*:\s*(\d+)/i)?.[1] ? Number(text.match(/"height_cm"\s*:\s*(\d+)/i)[1]) : null;
    const weight = text.match(/"weight_kg"\s*:\s*(\d+(?:[.,]\d+)?)"/i)?.[1] ? Number(String(text.match(/"weight_kg"\s*:\s*(\d+(?:[.,]\d+)?)"/i)[1]).replace(",", ".")) : null;

    const ageBand = age == null ? "unknown" : age < 30 ? "18-29" : age < 45 ? "30-44" : age < 60 ? "45-59" : "60+";
    const heightBand = height == null ? "unknown" : height < 160 ? "<160" : height < 175 ? "160-174" : height < 190 ? "175-189" : "190+";
    const weightBand = weight == null ? "unknown" : weight < 60 ? "<60" : weight < 75 ? "60-74" : weight < 90 ? "75-89" : "90+";

    const basis = String(ex.intent_basis || ex.intent_source?.basis || "guardrail").trim().toLowerCase();
    inc(byIntentBasis, basis || "guardrail");
    inc(persona.sex, sex);
    inc(persona.age_band, ageBand);
    inc(persona.height_band_cm, heightBand);
    inc(persona.weight_band_kg, weightBand);
    inc(topics, topicFromText(convoText));
    inc(byLanguage, ex.language || "unknown");
    inc(byGuardrail, canonicalGuardrailId(ex.guardrail));
  }

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
      intent_basis: byIntentBasis,
      persona,
      topic: topics,
    },
  };
}

function toTrainingReadyExample(example) {
  const ready = {
    id: example.id,
    language: example.language,
    guardrail: example.guardrail,
    messages: example.messages,
  };
  if (Array.isArray(example.tools) && example.tools.length > 0) {
    ready.tools = example.tools;
  }
  return ready;
}

function loadJsonlRecords(filePath) {
  if (!fs.existsSync(filePath)) return [];
  return fs
    .readFileSync(filePath, "utf8")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        return null;
      }
    })
    .filter(Boolean);
}

function loadExistingDedupState(outFile) {
  const exact = new Set();
  const ngrams = [];
  if (!fs.existsSync(outFile)) return { exact, ngrams };

  const lines = fs.readFileSync(outFile, "utf8").split("\n").map((l) => l.trim()).filter(Boolean);
  for (const line of lines) {
    try {
      const ex = JSON.parse(line);
      const text = extractSignatureText(ex);
      const norm = normalizeText(text);
      exact.add(norm);
      ngrams.push(toNgrams(norm, DEDUP_NGRAM));
    } catch {
      // ignore malformed lines
    }
  }
  return { exact, ngrams };
}

function filterNovelExamples(examples, existingState) {
  const accepted = [];
  const rejected = [];

  for (const ex of examples) {
    const sigText = extractSignatureText(ex);
    const normalized = normalizeText(sigText);
    if (!normalized) {
      rejected.push({ reason: "empty signature", example: ex });
      continue;
    }
    if (existingState.exact.has(normalized)) {
      rejected.push({ reason: "exact duplicate", example: ex });
      continue;
    }

    const grams = toNgrams(normalized, DEDUP_NGRAM);
    let maxOverlap = 0;
    for (const prev of existingState.ngrams) {
      const ov = jaccard(grams, prev);
      if (ov > maxOverlap) maxOverlap = ov;
      if (maxOverlap >= DEDUP_THRESHOLD) break;
    }

    if (maxOverlap >= DEDUP_THRESHOLD) {
      rejected.push({ reason: `near-duplicate overlap=${maxOverlap.toFixed(2)}`, example: ex });
      continue;
    }

    accepted.push(ex);
    existingState.exact.add(normalized);
    existingState.ngrams.push(grams);
  }

  return { accepted, rejected };
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isRetryableError(error) {
  const code = error?.cause?.code || error?.code || "";
  const status = error?.httpStatus;
  const msg = String(error?.message || "").toLowerCase();

  if (["ECONNRESET", "ECONNREFUSED", "ETIMEDOUT", "EPIPE", "EAI_AGAIN", "UND_ERR_SOCKET"].includes(code)) {
    return true;
  }
  if (typeof status === "number" && [408, 425, 429, 500, 502, 503, 504].includes(status)) {
    return true;
  }
  if (error?.name === "AbortError") {
    return true;
  }
  if (msg.includes("terminated") || msg.includes("econnreset") || msg.includes("fetch failed") || msg.includes("socket")) {
    return true;
  }
  return false;
}

async function callServerOnce(system, user, {
  label,
  useStream,
  useMaxTokens,
  useTemperature,
}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  let res;
  try {
    res = await fetch(SERVER_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      signal: controller.signal,
      body: JSON.stringify({
        messages: [
          { role: "system", content: system },
          { role: "user", content: user },
        ],
        temperature: useTemperature,
        top_p: 0.95,
        max_tokens: useMaxTokens,
        stream: useStream,
        ...(NO_THINK ? { chat_template_kwargs: { enable_thinking: false } } : {}),
      }),
    });
  } finally {
    clearTimeout(timer);
  }

  if (!res.ok) {
    const text = await res.text();
    const err = new Error(`Server error ${res.status}: ${text}`);
    err.httpStatus = res.status;
    throw err;
  }

  if (!useStream) {
    const data = await res.json();
    const msg = data?.choices?.[0]?.message || {};
    const content = msg.content || "";
    const reasoning = msg.reasoning_content || "";
    const finishReason = data?.choices?.[0]?.finish_reason;

    if (!content.trim() && reasoning.trim()) {
      console.warn(
        `  ! empty content for ${label} (finish=${finishReason}, reasoning chars=${reasoning.length}). ` +
        `This model may be stuck in think mode; defaulting to /no_think helps.`
      );
    }

    return content;
  }

  let full = "";
  let reasoningChars = 0;
  let buffer = "";
  process.stdout.write(`\n--- streaming ${label} ---\n`);
  try {
    for await (const chunk of res.body) {
      buffer += Buffer.from(chunk).toString("utf8");
      let idx;
      while ((idx = buffer.search(/\r?\n\r?\n/)) !== -1) {
        const frame = buffer.slice(0, idx).trim();
        const sepLen = buffer.startsWith("\r\n\r\n", idx) ? 4 : 2;
        buffer = buffer.slice(idx + sepLen);
        const dataLines = frame
          .split(/\r?\n/)
          .filter((line) => line.startsWith("data:"))
          .map((line) => line.slice(5).trim());
        const payload = dataLines.join("\n");
        if (!payload || payload === "[DONE]") continue;

        let json;
        try {
          json = JSON.parse(payload);
        } catch {
          continue;
        }

        const delta = json.choices?.[0]?.delta?.content;
        if (delta) {
          process.stdout.write(delta);
          full += delta;
        }

        const reasoningDelta = json.choices?.[0]?.delta?.reasoning_content;
        if (reasoningDelta) {
          reasoningChars += reasoningDelta.length;
        }
      }
    }
  } catch (error) {
    process.stdout.write(`\n--- stream error ${label} ---\n`);
    throw error;
  }

  if (!full.trim() && reasoningChars > 0) {
    console.warn(
      `\n  ! no assistant content for ${label}, but received ${reasoningChars} reasoning chars. ` +
      `Try keeping /no_think enabled or raising max_tokens.`
    );
  }
  process.stdout.write(`\n--- end ${label} ---\n\n`);
  return full;
}

async function callServer(system, user, {
  label = "",
  streamOverride = null,
  maxTokensOverride = null,
  temperatureOverride = null,
} = {}) {
  const useStream = streamOverride === null ? STREAM : Boolean(streamOverride);
  const useMaxTokens = Number.isFinite(maxTokensOverride) ? maxTokensOverride : MAX_TOKENS;
  const useTemperature = Number.isFinite(temperatureOverride) ? temperatureOverride : 0.9;
  let lastError;
  for (let attempt = 1; attempt <= FETCH_RETRIES; attempt++) {
    const attemptStream = useStream && attempt === 1;
    try {
      return await callServerOnce(system, user, {
        label,
        useStream: attemptStream,
        useMaxTokens,
        useTemperature,
      });
    } catch (error) {
      lastError = error;
      const retryable = isRetryableError(error);
      if (!retryable || attempt >= FETCH_RETRIES) {
        throw error;
      }
      const waitMs = FETCH_RETRY_BASE_MS * Math.pow(2, attempt - 1);
      const code = error?.cause?.code || error?.code || error?.httpStatus || "unknown";
      console.warn(
        `  ! call ${label || "(unlabeled)"} failed on attempt ${attempt}/${FETCH_RETRIES} ` +
        `(${code}); retrying in ${waitMs}ms${attemptStream ? " with non-stream fallback" : ""}.`
      );
      await sleep(waitMs);
    }
  }
  throw lastError;
}

function parseJsonlSafely(text, guardrailId, lang) {
  const lines = text.split("\n").map((l) => l.trim()).filter(Boolean);
  const good = [];
  const bad = [];

  function tryParse(candidate) {
    try {
      return JSON.parse(candidate);
    } catch {
      return null;
    }
  }

  for (const line of lines) {
    const parsed = tryParse(line);
    if (parsed) {
      good.push(parsed);
    } else {
      bad.push(line);
    }
  }

  if (!good.length && text.includes("{")) {
    bad.length = 0;
    const recovered = [];
    let depth = 0;
    let inString = false;
    let escaped = false;
    let start = -1;

    for (let i = 0; i < text.length; i++) {
      const ch = text[i];
      if (inString) {
        if (escaped) {
          escaped = false;
        } else if (ch === "\\") {
          escaped = true;
        } else if (ch === '"') {
          inString = false;
        }
        continue;
      }

      if (ch === '"') {
        inString = true;
        continue;
      }
      if (ch === "{") {
        if (depth === 0) start = i;
        depth += 1;
        continue;
      }
      if (ch === "}") {
        depth -= 1;
        if (depth === 0 && start !== -1) {
          const candidate = text.slice(start, i + 1).trim();
          const parsed = tryParse(candidate);
          if (parsed) recovered.push(parsed);
          else bad.push(candidate);
          start = -1;
        }
      }
    }

    if (recovered.length) {
      return { good: recovered, bad };
    }
  }

  if (bad.length) {
    console.warn(
      `  ! ${bad.length} unparseable line(s) for ${guardrailId}/${lang} — saved to reject log`
    );
  }
  return { good, bad };
}

async function runBatch(guardrail, lang, count) {
  console.log(`-> ${guardrail.id} (${lang}), ${count} examples`);
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const outFile = path.join(OUT_DIR, "generated.jsonl");
  const trainingReadyFile = path.join(OUT_DIR, "training_ready.jsonl");
  const rejFile = path.join(OUT_DIR, "rejects.log");
  const flaggedFile = path.join(OUT_DIR, "flagged.jsonl");
  if (!fs.existsSync(outFile)) {
    fs.writeFileSync(outFile, "", "utf8");
  }
  if (!fs.existsSync(trainingReadyFile)) {
    fs.writeFileSync(trainingReadyFile, "", "utf8");
  }
  if (!fs.existsSync(flaggedFile)) {
    fs.writeFileSync(flaggedFile, "", "utf8");
  }

  const totalAccepted = [];
  const totalRejectLines = [];
  const totalFlaggedEntries = [];
  const dedupState = loadExistingDedupState(outFile);
  const maxAttempts = 3;

  for (let attempt = 1; attempt <= maxAttempts && totalAccepted.length < count; attempt++) {
    const remaining = count - totalAccepted.length;
    const randomDoc = randomItem(ragDocuments);
    const seed = await getOrCreateDocSeed({ doc: randomDoc, lang, guardrail });
    const selectedQuestion = randomItem(seed.questions);
    const matchingIntentPool = RANDOM_USER_INTENTS.filter((entry) => entry.guardrail === guardrail.id);
    const selectedUserIntent = matchingIntentPool.length ? randomItem(matchingIntentPool) : null;
    console.log(`   • doc-seed ${seed.file_name}: ${selectedQuestion}${selectedUserIntent ? ` | intent: ${selectedUserIntent.intent}` : ""}`);
    const { retrieval } = buildPrompt(
      guardrail,
      lang,
      remaining,
      promptRotationIndex++,
      {
        ...seed,
        selected_question: selectedQuestion,
      },
      selectedUserIntent
    );

    const { accepted: stagedExamples, rejected: malformed } = await generateContractExamples({
      guardrail,
      lang,
      count: remaining,
      rotationIndex: promptRotationIndex,
      docSeed: seed,
      selectedQuestion,
      selectedUserIntent,
      retrieval,
    });
    const preparedParse = prepareExamples(stagedExamples);
    const prepared = preparedParse.accepted;
    const bad = [];
    const validated = [];
    const validationRejects = [];

    for (const [idx, example] of prepared.entries()) {
      const preflight = computePreflightPolicy({
        guardrail,
        lang,
        selectedQuestion,
        selectedUserIntent,
      });
      let working = applyLanguageHygiene(example).example;
      let issues = validateRow(working, { guardrail: guardrail.id, language: lang });

      if (!issues.length) {
        console.log(`   [validate PASS] ${guardrail.id}/${lang} example ${idx + 1}`);
        validated.push(working);
        continue;
      }

      let repaired = false;
      let strategy = "";
      for (let repairAttempt = 1; repairAttempt <= REPAIR_ATTEMPTS_PER_EXAMPLE && issues.length; repairAttempt += 1) {
        const result = await attemptFailureAwareRepair({
          example: working,
          issues,
          guardrail,
          lang,
          rotationIndex: promptRotationIndex + idx + repairAttempt,
          preflight,
        });

        if (!result.changed) break;
        working = normalizeToolMessages(result.repaired);
        issues = validateRow(working, { guardrail: guardrail.id, language: lang });
        strategy = result.strategy;
        if (!issues.length) {
          repaired = true;
          console.log(`   [repair PASS] ${guardrail.id}/${lang} example ${idx + 1} via ${strategy}`);
          validated.push(working);
          break;
        }
      }

      if (!repaired && issues.length) {
        const reason = issues.join('; ');
        console.warn(`   [validate FAIL] ${guardrail.id}/${lang} example ${idx + 1}: ${reason}`);
        recordValidationFailure({
          example: working,
          issues,
          source: "generate-inline-validate",
        });
        validationRejects.push({ reason, example: working });
      }
    }

    if (bad.length) {
      for (const badLine of bad) {
        console.warn(`   [parse REJECT] ${guardrail.id}/${lang}: unparseable output line -> ${String(badLine).slice(0, 220)}`);
      }
    }
    if (malformed.length) {
      for (const item of malformed) {
        console.warn(`   [prepare REJECT] ${guardrail.id}/${lang}: ${item.reason}`);
      }
    }

    const intentBasis = selectedUserIntent ? "random_user_intent" : "rag";
    const withGrounding = attachGroundingMetadata(validated, retrieval, intentBasis).map((example) => ({
      ...example,
      intent_basis: intentBasis,
      doc_seed: {
        file_name: seed.file_name,
        title: seed.title,
        summary: seed.summary,
        question: selectedQuestion,
      },
    }));
    const { accepted, rejected } = filterNovelExamples(withGrounding, dedupState);

    totalAccepted.push(...accepted);
    if (rejected.length) {
      for (const item of rejected) {
        console.warn(`   [dedup REJECT] ${guardrail.id}/${lang}: ${item.reason}`);
      }
    }
    totalRejectLines.push(
      ...bad,
      ...malformed.map((r) => JSON.stringify({ reason: r.reason, example: r.example })),
      ...validationRejects.map((r) => JSON.stringify({ reason: r.reason, example: r.example })),
      ...rejected.map((r) => JSON.stringify({ reason: r.reason, example: r.example })),
    );
    totalFlaggedEntries.push(
      ...malformed.map((item) => ({ id: item?.example?.id || null, issues: [item.reason], example: item.example, source: "generate-prepare" })),
      ...validationRejects.map((item) => ({ id: item?.example?.id || null, issues: [item.reason], example: item.example, source: "generate-inline-validate" })),
      ...rejected.map((item) => ({ id: item?.example?.id || null, issues: [item.reason], example: item.example, source: "generate-dedup" })),
    );

    if (accepted.length && totalAccepted.length < count) {
      console.warn(`  ! only ${totalAccepted.length}/${count} accepted so far for ${guardrail.id}/${lang}; retrying for remaining examples.`);
    }
  }

  if (totalAccepted.length) {
    fs.appendFileSync(outFile, totalAccepted.map((o) => JSON.stringify(o)).join("\n") + "\n");
    const trainingReadyRows = totalAccepted.map((example) => toTrainingReadyExample(example));
    fs.appendFileSync(trainingReadyFile, trainingReadyRows.map((o) => JSON.stringify(o)).join("\n") + "\n");
  }
  if (totalFlaggedEntries.length) {
    fs.appendFileSync(flaggedFile, totalFlaggedEntries.map((entry) => JSON.stringify(entry)).join("\n") + "\n");
  }
  if (totalRejectLines.length) {
    fs.appendFileSync(rejFile, `--- ${guardrail.id}/${lang} ---\n${totalRejectLines.join("\n")}\n`);
  }
  if (totalAccepted.length < count) {
    console.warn(
      `  ! only ${totalAccepted.length}/${count} accepted examples for ${guardrail.id}/${lang}. ` +
      `Consider increasing --max-tokens or reducing --count.`
    );
  }
  console.log(`   ✓ ${totalAccepted.length} written, ${totalRejectLines.length} rejected`);
  return { accepted: totalAccepted };
}

async function main() {
  const guardrailIds = ONLY_GUARDRAIL
    ? [ONLY_GUARDRAIL]
    : guardrailsSpec.guardrails.map((g) => g.id);
  const langs = ONLY_LANG ? [ONLY_LANG] : LANGS;
  const allGenerated = [];

  for (const gid of guardrailIds) {
    const guardrail = pickGuardrail(guardrailsSpec, gid);
    for (const lang of langs) {
      const result = await runBatch(guardrail, lang, COUNT);
      allGenerated.push(...(result?.accepted || []));
    }
  }

  const trainingReadyFile = path.join(OUT_DIR, "training_ready.jsonl");
  const diversitySource = loadJsonlRecords(trainingReadyFile);
  if (diversitySource.length || allGenerated.length) {
    const diversity = buildDiversityReport(diversitySource.length ? diversitySource : allGenerated);
    fs.writeFileSync(path.join(OUT_DIR, "diversity_report.json"), JSON.stringify(diversity, null, 2) + "\n");
    console.log(`Diversity report written to ${path.join(OUT_DIR, "diversity_report.json")}`);
  }
  console.log("Done.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

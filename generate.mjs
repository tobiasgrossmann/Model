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
import { pathToFileURL } from "node:url";
import { createLocalRag } from "./local_rag.mjs";
import { validateRow, validateRowDetailed } from "./src/validation/index.mjs";
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

const SYSTEM_PROMPT_TEMPLATE_RAW = readPromptTemplate("system.md");

function getSystemPromptForLang(lang) {
  const sections = SYSTEM_PROMPT_TEMPLATE_RAW.split("\n---\n").map(s => s.trim());
  const langLower = String(lang || "").toLowerCase();
  // Try exact match first (de, fr, it)
  for (const section of sections) {
    if (section.startsWith(langLower === "de" ? "Du generierst" : langLower === "fr" ? "Tu génères" : "Tu generi")) {
      return section;
    }
  }
  // Fallback to first section (German)
  return sections[0] || SYSTEM_PROMPT_TEMPLATE_RAW;
}

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
const NO_THINK = false;
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

function healthyPlanningMixInstruction(guardrail, count, rotationIndex, selectedUserIntent = null) {
  const data = HEALTHY_PLANNING_MIX || {};
  const intentText = [selectedUserIntent?.intent || "", selectedUserIntent?.example || "", selectedUserIntent?.example_localized ? JSON.stringify(selectedUserIntent.example_localized) : ""].join(" ");
  const planSaveIntent = /save_food_plan|save_training_plan|speicher.*(ernaehrungsplan|trainingsplan|plan de repas|plan d'entraînement|meal plan|training plan)|save.*(food|training).*(plan)/i.test(intentText);
  const allowHealthyMix = ["G1", "G3", "G16"].includes(String(guardrail?.id || "")) || planSaveIntent;

  if (!allowHealthyMix) {
    return { forceControl: false, preferredTool: null, text: "" };
  }

  const patterns = Array.isArray(data.patterns)
    ? data.patterns
    : [...(Array.isArray(data.healthy_control) ? data.healthy_control : []), ...(Array.isArray(data.balanced) ? data.balanced : [])];

  if (!patterns.length) {
    return { forceControl: false, preferredTool: null, text: "" };
  }

  const pattern = rotationIndex % patterns.length;
  const item = patterns[pattern];
  const forceControl = item?.forceControl === true || (item?.condition?.periodic && rotationIndex % item.condition.periodic === item.condition.periodic - 1);
  const preferredTool = typeof item === "object" && item?.tool && ["save_food_plan", "save_training_plan"].includes(item.tool)
    ? item.tool
    : null;
  return {
    forceControl,
    preferredTool,
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
  const healthyMix = healthyPlanningMixInstruction(guardrail, count, rotationIndex, selectedUserIntent);
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

  const system = renderPromptTemplate(getSystemPromptForLang(lang), {});
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

  return { system: systemWithMode, user, retrieval, healthyMix };
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

function requestsHealthDataAccessAfterToolResult(text) {
  const value = String(text || "").toLowerCase();
  const accessPatterns = [
    /(ben(?:o|ö)tige|brauche|muss|musst).*?(zugriff|zugang|daten|gesundheitsdaten|gespeicherten.*daten|aktuellen.*gesundheitsdaten).*?(abrufen|einsehen|erhalten|zulassen)/i,
    /(j'ai besoin|besoin|dois|devrais).*?(acc(?:e|è)s|accès|donn(?:é|e)es(?: de)? sant(?:é|e)|donn(?:é|e)es m(?:é|e)dicales|historique).*?(consulter|r(?:e|é)cuperer|v(?:e|é)rifier|autoriser)/i,
    /(ho bisogno|necessito|devo).*?(accedere|accesso|dati sanitari|dati personali|dati salvati|informazioni).*?(consultare|recuperare|verificare|autorizzare)/i,
    /(need|needs|need to|must).*?(access|retrieve|consult|view|review).*?(health data|stored health data|current health data|your data|personal data)/i,
  ];
  return accessPatterns.some((pattern) => pattern.test(value));
}

function computePreflightPolicy({ guardrail, lang, selectedQuestion, selectedUserIntent, forcePlanPersistence = false, preferredToolName = null }) {
  const localizedIntentExample = resolveIntentExampleByLanguage(selectedUserIntent, lang);
  const sourceText = [
    selectedQuestion,
    selectedUserIntent?.intent,
    localizedIntentExample,
    guardrail?.name,
    guardrail?.hard_when_text,
  ].filter(Boolean).join("\n");
  const normalizedSource = sourceText
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase();

  const guardrailId = String(guardrail?.id || "").toUpperCase();
  const foodPlanTerms = "meal plan|food plan|plan de repas|ernahrungsplan|ernaehrungsplan|piano alimentare|mahlzeitenplan|2-?tage|week plan|wochenplan|ernahrung[s]?plan|nutrition plan";
  const trainingPlanTerms = "training plan|workout plan|plan d'?entrainement|trainingsplan|allenamento|routine|sportplan|fitnessplan|programm";
  const saveVerbs = "save|speicher|speichern|speichere|enregistr|salva|salvare|salvar|salvami|salvarmi|sichern|save plan|enregistrer";
  const wantsSavedFoodPlan = new RegExp(`(?:${foodPlanTerms}).*(?:${saveVerbs})|(?:${saveVerbs}).*(?:${foodPlanTerms})|save_food_plan`, 'i').test(normalizedSource);
  const wantsSavedTrainingPlan = new RegExp(`(?:${trainingPlanTerms}).*(?:${saveVerbs})|(?:${saveVerbs}).*(?:${trainingPlanTerms})|save_training_plan`, 'i').test(normalizedSource);
  const metricSensitiveGuardrails = new Set(["G10", "G15"]);
  const guardrailsWithGeneralNoToolDefault = new Set(["G4", "G8", "G12", "G14", "G16"]);
  const metricSensitiveTopic = /(bmi|imc|gewicht|poids|peso|taille|groesse|altezza|sleep|schlaf|hrv|resting heart|ruhepuls|frequenza cardiaca|rythme cardiaque)/.test(normalizedSource);
  const sportContext = /(training|workout|sport|exercise|fitness|strength|cardio|kondition|kraft|ausdauer|entrainement|allenamento|routine|programm|plan de fit|fitnessplan|trainingsplan|workout plan)/.test(normalizedSource);
  const pregnancyContext = /(pregnan|schwanger|enceinte|incinta|postpartum|stillen|allatt)/.test(normalizedSource);

  const explicitPlanSaveRequest = wantsSavedFoodPlan || wantsSavedTrainingPlan;
  const planSavePrecedence = explicitPlanSaveRequest || (preferredToolName && ["save_food_plan", "save_training_plan"].includes(preferredToolName)) || forcePlanPersistence;
  const explicitHealthCheckRequest = explicitPlanSaveRequest
    ? false
    : /(prüfen|überprüfen|abfragen|abrufen|bewerten|check|verify|assess|valutare|verifica|recuperare|accedere|consultare|analysieren|analyse|blutwerte|lab values|esami del sangue|dati sanitari|gesundheitsdaten|health data|blood test)/i.test(normalizedSource);
  const mixedPlanSaveAndHealthCheck = explicitPlanSaveRequest && /(prüfen|überprüfen|abfragen|abrufen|bewerten|check|verify|assess|valutare|verifica|recuperare|accedere|consultare|analysieren|analyse|blutwerte|lab values|esami del sangue|dati sanitari|gesundheitsdaten|health data|blood test)/i.test(normalizedSource);
  const preferredTool = mixedPlanSaveAndHealthCheck
    ? (wantsSavedFoodPlan ? "save_food_plan" : "save_training_plan")
    : explicitPlanSaveRequest
      ? (wantsSavedFoodPlan ? "save_food_plan" : "save_training_plan")
      : preferredToolName && ["save_food_plan", "save_training_plan"].includes(preferredToolName)
        ? preferredToolName
        : forcePlanPersistence
          ? (["G1", "G3", "G16"].includes(guardrailId) ? "save_food_plan" : "save_training_plan")
          : "get_user_health_data";

  const toolRequired = pregnancyContext
    ? false
    : explicitPlanSaveRequest
      ? true
      : preferredTool !== "get_user_health_data"
        ? true
        : (guardrailsWithGeneralNoToolDefault.has(guardrailId)
          ? false
          : (metricSensitiveGuardrails.has(guardrailId) || metricSensitiveTopic));
  const planSaveMode = planSavePrecedence ? "plan_save_confirmation" : null;
  const responseMode = pregnancyContext
    ? "cautious_referral"
    : (planSaveMode || (guardrailId === "G16" ? "generic_principles" : (guardrailId === "G15" ? "safety_refusal" : "cautious_guidance")));

  return {
    guardrail: guardrailId,
    language: lang,
    tool_required: toolRequired,
    preferred_tool: toolRequired ? preferredTool : null,
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
  const toolNeeded = preflight.tool_required ? true : Boolean(raw?.tool_needed);
  const explicitToolName = raw && raw.tool_name !== undefined && raw.tool_name !== null ? String(raw.tool_name).trim() : "";
  const normalizedToolName = toolNeeded
    ? (explicitToolName || preflight.preferred_tool || "get_user_health_data")
    : null;

  return {
    guardrail: String(raw?.guardrail || preflight.guardrail || ""),
    language: String(raw?.language || preflight.language || "de"),
    tool_needed: toolNeeded,
    tool_name: normalizedToolName,
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

function buildDeterministicHealthPayload(guardrailId, rotationIndex, lang = "") {
  const profiles = [
    { age: 24, weight_kg: 68.0, height_cm: 172, sex: "female", active_calories_burned: 320, basal_energy_burned: 1450, exercise_minutes: 45, stand_hours: 9, sleep_duration_hours: 7.4, hrv_ms: 42, resting_heart_rate_bpm: 61 },
    { age: 31, weight_kg: 82.5, height_cm: 180, sex: "male", active_calories_burned: 460, basal_energy_burned: 1680, exercise_minutes: 60, stand_hours: 8, sleep_duration_hours: 6.8, hrv_ms: 36, resting_heart_rate_bpm: 64 },
    { age: 38, weight_kg: 74.0, height_cm: 169, sex: "female", active_calories_burned: 250, basal_energy_burned: 1510, exercise_minutes: 35, stand_hours: 7, sleep_duration_hours: 6.2, hrv_ms: 30, resting_heart_rate_bpm: 70 },
  ];
  const langOffset = { de: 0, fr: 1, it: 2 }[String(lang || "").toLowerCase()] || 0;
  const index = Math.abs(Number(rotationIndex || 0) + langOffset) % profiles.length;
  const payload = { ...profiles[index] };
  const gid = String(guardrailId || "").toUpperCase();
  if (gid === "G6") {
    const g6Profiles = {
      de: { age: 42, weight_kg: 104.0, height_cm: 171, sex: "female", active_calories_burned: 220, basal_energy_burned: 1580, exercise_minutes: 25, stand_hours: 6, sleep_duration_hours: 6.1, hrv_ms: 29, resting_heart_rate_bpm: 72 },
      fr: { age: 37, weight_kg: 98.0, height_cm: 168, sex: "male", active_calories_burned: 260, basal_energy_burned: 1710, exercise_minutes: 30, stand_hours: 6, sleep_duration_hours: 6.4, hrv_ms: 31, resting_heart_rate_bpm: 70 },
      it: { age: 34, weight_kg: 102.0, height_cm: 170, sex: "female", active_calories_burned: 240, basal_energy_burned: 1620, exercise_minutes: 28, stand_hours: 6, sleep_duration_hours: 6.3, hrv_ms: 30, resting_heart_rate_bpm: 71 },
    };
    Object.assign(payload, g6Profiles[String(lang || "").toLowerCase()] || g6Profiles.de);
  }
  if (gid === "G17") {
    const g17Profiles = {
      de: { age: 61, weight_kg: 101.0, height_cm: 170, sex: "male", active_calories_burned: 120, basal_energy_burned: 1660, exercise_minutes: 12, stand_hours: 4, sleep_duration_hours: 6.0, hrv_ms: 26, resting_heart_rate_bpm: 74 },
      fr: { age: 57, weight_kg: 96.0, height_cm: 167, sex: "female", active_calories_burned: 110, basal_energy_burned: 1520, exercise_minutes: 10, stand_hours: 4, sleep_duration_hours: 6.4, hrv_ms: 27, resting_heart_rate_bpm: 73 },
      it: { age: 59, weight_kg: 99.0, height_cm: 169, sex: "male", active_calories_burned: 115, basal_energy_burned: 1600, exercise_minutes: 11, stand_hours: 4, sleep_duration_hours: 6.1, hrv_ms: 27, resting_heart_rate_bpm: 75 },
    };
    Object.assign(payload, g17Profiles[String(lang || "").toLowerCase()] || g17Profiles.de);
  }
  if (gid === "G11") {
    payload.sex = "female";
    payload.pregnancy_status = "pregnant";
  }
  if (gid === "G10") {
    payload.exercise_minutes = 75;
    payload.sleep_duration_hours = 5.0;
    payload.hrv_ms = 28;
    payload.resting_heart_rate_bpm = 72;
  }
  if (gid === "G13") {
    payload.age = 15;
    payload.weight_kg = 58.0;
    payload.height_cm = 168;
    payload.sex = payload.sex || "male";
  }
  return payload;
}

function buildDeterministicFoodPlan(lang) {
  const language = String(lang || 'de').toLowerCase();
  if (language === 'fr') {
    return {
      id: `food_${language}_2d`,
      language,
      duration_days: 2,
      days: [
        { day: 'Jour 1', breakfast: 'Flocons d’avoine et yaourt', lunch: 'Bol de riz et légumes', dinner: 'Soupe de légumes maison' },
        { day: 'Jour 2', breakfast: 'Pain complet et fromage frais', lunch: 'Salade de lentilles', dinner: 'Poisson avec légumes cuits' },
      ],
    };
  }
  if (language === 'it') {
    return {
      id: `food_${language}_2d`,
      language,
      duration_days: 2,
      days: [
        { day: 'Giorno 1', breakfast: 'Fiocchi d’avena e yogurt', lunch: 'Riso con verdure', dinner: 'Zuppa di verdure fatta in casa' },
        { day: 'Giorno 2', breakfast: 'Pane integrale e ricotta', lunch: 'Insalata di lenticchie', dinner: 'Pesce con verdure cotte' },
      ],
    };
  }
  return {
    id: `food_${language}_2d`,
    language,
    duration_days: 2,
    days: [
      { day: 'Tag 1', breakfast: 'Haferflocken mit Joghurt', lunch: 'Reis mit Gemüse', dinner: 'Gemüsesuppe' },
      { day: 'Tag 2', breakfast: 'Vollkornbrot mit Frischkäse', lunch: 'Linsensalat', dinner: 'Fisch mit gekochtem Gemüse' },
    ],
  };
}

function buildDeterministicTrainingPlan(lang) {
  const language = String(lang || 'de').toLowerCase();
  if (language === 'fr') {
    return {
      id: `training_${language}_2d`,
      language,
      duration_days: 2,
      days: [
        { day: 'Jour 1', title: 'Force contrôlée', duration_minutes: 30, frequency: '2x/semaine', training: 'Mouvements au poids du corps', focus: 'Technique', notes: 'Charge légère et gestes propres' },
        { day: 'Jour 2', title: 'Cardio modéré', duration_minutes: 25, frequency: '2x/semaine', training: 'Marche rapide', focus: 'Régularité', notes: 'Intensité modérée' },
      ],
    };
  }
  if (language === 'it') {
    return {
      id: `training_${language}_2d`,
      language,
      duration_days: 2,
      days: [
        { day: 'Giorno 1', title: 'Forza controllata', duration_minutes: 30, frequency: '2x/settimana', training: 'Esercizi a corpo libero', focus: 'Tecnica', notes: 'Carico leggero e movimenti puliti' },
        { day: 'Giorno 2', title: 'Cardio moderato', duration_minutes: 25, frequency: '2x/settimana', training: 'Camminata veloce', focus: 'Continuità', notes: 'Intensità moderata' },
      ],
    };
  }
  return {
    id: `training_${language}_2d`,
    language,
    duration_days: 2,
    days: [
      { day: 'Tag 1', title: 'Kontrolliertes Krafttraining', duration_minutes: 30, frequency: '2x/Woche', training: 'Körpergewichtsübungen', focus: 'Technik', notes: 'Leichte Belastung und saubere Ausführung' },
      { day: 'Tag 2', title: 'Moderates Cardio', duration_minutes: 25, frequency: '2x/Woche', training: 'Schnelles Gehen', focus: 'Regelmässigkeit', notes: 'Moderate Intensität' },
    ],
  };
}

function deterministicToolArguments(toolName, lang) {
  if (toolName === 'save_food_plan') {
    return JSON.stringify({ plan: buildDeterministicFoodPlan(lang) });
  }
  if (toolName === 'save_training_plan') {
    return JSON.stringify({ plan: buildDeterministicTrainingPlan(lang) });
  }
  return '{}';
}

function deterministicToolResult(toolName) {
  if (toolName === 'save_food_plan' || toolName === 'save_training_plan') {
    return JSON.stringify({ status: 'ok' });
  }
  return null;
}

function fallbackSavedPlanAssistantText(lang, toolName) {
  if (toolName === 'save_food_plan') {
    if (lang === 'fr') return 'Le plan alimentaire a été enregistré avec succès.';
    if (lang === 'it') return 'Il piano alimentare è stato salvato con successo.';
    return 'Der Ernährungsplan wurde erfolgreich gespeichert.';
  }
  if (toolName === 'save_training_plan') {
    if (lang === 'fr') return 'Le plan d’entraînement a été enregistré avec succès.';
    if (lang === 'it') return 'Il piano di allenamento è stato salvato con successo.';
    return 'Der Trainingsplan wurde erfolgreich gespeichert.';
  }
  return fallbackAssistantText(lang, 'cautious_guidance', '');
}

function fallbackUserText(lang, selectedQuestion, selectedUserIntent, guardrailId = "") {
  const gid = String(guardrailId || "").toUpperCase();
  if (gid === "G2") {
    if (lang === "fr") {
      return "J'ai de l'hypertension, je prends un traitement, et je me sens très fatigué après mon dernier entraînement avec des douleurs musculaires. Comment récupérer sans prendre de risque ?";
    }
    if (lang === "it") {
      return "Ho la pressione alta e seguo una terapia; dopo l'ultimo allenamento mi sento molto stanco e con dolori muscolari. Come posso recuperare in sicurezza?";
    }
    return "Ich habe Bluthochdruck und nehme Medikamente. Nach dem letzten Training bin ich sehr müde und habe Muskelschmerzen. Wie kann ich mich sicher erholen?";
  }
  if (gid === "G5") {
    if (lang === "fr") {
      return "Je me sens psychiquement à bout, je ne vois plus d'issue et j'ai peur de mes propres pensées. J'ai besoin d'aide urgente.";
    }
    if (lang === "it") {
      return "Mi sento psicologicamente al limite, non vedo alcuna via d'uscita e ho paura dei miei stessi pensieri. Ho bisogno di aiuto urgente.";
    }
    return "Ich fühle mich psychisch völlig am Ende, sehe keinen Ausweg mehr und habe Angst vor meinen eigenen Gedanken. Ich brauche dringend Hilfe.";
  }
  if (gid === "G17") {
    if (lang === "fr") {
      return "Je suis plutôt sédentaire, j'ai plus de 55 ans et je voudrais juste un plan standard pour me remettre en forme sans entrer dans les détails. Qu'est-ce que tu me proposes ?";
    }
    if (lang === "it") {
      return "Sono piuttosto sedentario, ho quasi 60 anni e vorrei semplicemente un piano standard per rimettermi in forma senza entrare nei dettagli. Cosa mi proponi?";
    }
    return "Ich sitze fast den ganzen Tag, bin über 60 und hätte gern einfach einen Standardplan, um fitter zu werden, ohne viele Details zu besprechen. Was würdest du mir pauschal empfehlen?";
  }
  const localizedIntentExample = resolveIntentExampleByLanguage(selectedUserIntent, lang);
  if (localizedIntentExample) return localizedIntentExample;
  if (selectedQuestion) return String(selectedQuestion).trim();
  if (lang === "fr") return "J'ai une question de sécurité sur mon entraînement et mon alimentation.";
  if (lang === "it") return "Ho una domanda sulla sicurezza del mio allenamento e della mia alimentazione.";
  return "Ich habe eine Sicherheitsfrage zu Training und Ernährung.";
}

function hasG2MedicalSignals(text) {
  const value = String(text || "").toLowerCase();
  const conditionOrMedicationPattern = /(bluthochdruck|hyperton|asthma|asthme|asma|diabet|hashimoto|vorerkrank|medikation|medikament|blutdrucktabletten|inhalator|inhalateur|traitement|farmaci|terapia|pressione|pression)/i;
  return conditionOrMedicationPattern.test(value);
}

function hasG4RedFlagSymptoms(text) {
  const value = String(text || "").toLowerCase();
  const redFlagPattern = /(ausstrahl|strahlt.*bein|ins\s+bein|taub|kribbel|lähm|schw[äa]che\s+im\s+bein|starke\s+schmerzen\s+im\s+unteren\s+r[üu]cken|douleur\s+qui\s+irradie|irradie\s+dans\s+la\s+jambe|engourdissement|faiblesse\s+de\s+la\s+jambe|forte\s+douleur\s+lombaire|dolore\s+che\s+si\s+irradia|si\s+irradia\s+alla\s+gamba|intorpid|debolezza\s+alla\s+gamba|forte\s+dolore\s+alla\s+schiena|sciatic)/i;
  return redFlagPattern.test(value);
}

function hasG4PainSignals(text) {
  const value = String(text || "").toLowerCase();
  const painPattern = /(schmerz|schmerzen|gelenk|knie|h[üu]fte|r[üu]cken|verletz|douleur|blessure|genou|hanche|lomb|douleur\s+articulaire|dolore|infortuni|ginocchio|anca|schiena|articol)/i;
  return painPattern.test(value);
}

function buildG4SafetyText(lang, userText = "") {
  const hasRedFlag = hasG4RedFlagSymptoms(userText);
  const hasPain = hasG4PainSignals(userText);
  const hasHydrationFatigue = hasHydrationPhysicalSignals(userText);

  if (hasRedFlag) {
    if (lang === "fr") {
      return "Ce que tu décris ressemble à un signal d'alerte (douleur lombaire qui irradie vers la jambe). Le cadre le plus sûr est d'arrêter immédiatement l'entraînement et de ne pas essayer de compenser avec des variantes ou des charges réduites aujourd'hui. Fais évaluer cela rapidement par un médecin ou un kinésithérapeute; en cas d'aggravation, de faiblesse marquée, d'engourdissement important ou de symptômes inhabituels, consulte en urgence.";
    }
    if (lang === "it") {
      return "Quello che descrivi è un segnale di allarme (dolore lombare che si irradia alla gamba). La scelta più sicura è interrompere subito l'allenamento e non provare a compensare con varianti o carichi ridotti oggi. Fai valutare rapidamente la situazione da medico o fisioterapista; se peggiora, compaiono debolezza marcata, intorpidimento importante o altri sintomi insoliti, serve una valutazione urgente.";
    }
    return "Das, was du beschreibst, ist ein Red-Flag-Signal (starke LWS-Schmerzen mit Ausstrahlung ins Bein). Die sicherste Vorgehensweise ist: Training jetzt sofort stoppen und heute nicht mit Varianten oder reduzierter Last weitertrainieren. Lass das zeitnah ärztlich oder physiotherapeutisch abklären; bei Verschlechterung, deutlicher Schwäche, stärkerer Taubheit oder anderen Warnzeichen bitte umgehend medizinisch abklären.";
  }

  if (hasHydrationFatigue && !hasPain) {
    if (lang === "fr") {
      return "Si tu te sens surtout fatigué après l'entraînement, l'hydratation et la récupération sont prioritaires. Comme repère pratique, bois régulièrement dans la journée, ajoute environ 500-750 ml dans les 1-2 heures après la séance et adapte selon la chaleur, la transpiration et la couleur des urines (plutôt claire). Si la fatigue persiste malgré repos, sommeil et hydratation, allège la charge pendant 24-48 h et demande un avis médical si ça s'aggrave.";
    }
    if (lang === "it") {
      return "Se dopo l'allenamento ti senti soprattutto affaticato, la priorità è idratazione e recupero. Come riferimento pratico: bevi regolarmente durante la giornata, aggiungi circa 500-750 ml nelle 1-2 ore dopo la seduta e adatta in base a caldo, sudorazione e colore delle urine (meglio chiare). Se la stanchezza persiste nonostante riposo, sonno e idratazione, riduci il carico per 24-48 ore e valuta un parere medico se peggiora.";
    }
    return "Wenn du dich nach dem Training vor allem müde fühlst, stehen Hydrierung und Erholung im Vordergrund. Als praktische Orientierung: über den Tag regelmäßig trinken, in den 1-2 Stunden nach der Einheit zusätzlich etwa 500-750 ml aufnehmen und Menge an Hitze, Schweißverlust und Urinfarbe (eher hell) anpassen. Bleibt die Müdigkeit trotz Schlaf, Ruhe und Trinken bestehen, Belastung für 24-48 Stunden reduzieren und bei Verschlechterung ärztlich abklären.";
  }

  if (lang === "fr") {
    return "Non, il ne faut jamais pousser à travers une douleur articulaire aiguë, car cela peut aggraver la blessure. En repère général sûr: arrête immédiatement l'exercice déclencheur. Tu peux tester une régression sans douleur, mais si la douleur persiste, consulte un kinésithérapeute ou un médecin du sport.";
  }
  if (lang === "it") {
    return "Il dolore durante un esercizio è un segnale di stop: non aumentare il carico e interrompi il movimento doloroso. Come linea sicura, riduci il carico, accorcia il range o passa a una variante senza dolore; se il dolore persiste o ritorna, fai una valutazione medica o fisioterapica.";
  }
  return "Schmerz während einer Übung ist ein Warnsignal: Belastung nicht steigern und die schmerzhafte Bewegung stoppen. Als sichere Leitlinie: Gewicht reduzieren, Bewegungsumfang verkleinern oder auf eine schmerzfreie Variante wechseln; wenn der Schmerz bleibt oder wiederkommt, ärztlich oder physiotherapeutisch abklären lassen.";
}

function enforceG2UserPromptIntegrity(text, lang) {
  const value = String(text || "").trim();
  if (!value) return fallbackUserText(lang, null, null, "G2");
  if (hasG2MedicalSignals(value)) return value;
  return fallbackUserText(lang, null, null, "G2");
}

function hasG5CrisisSignals(text) {
  const value = String(text || "").toLowerCase();
  const crisisPattern = /(psychisch|psychologique|psicologic|am\s+ende|keinen?\s+ausweg|keine\s+ausweg|angst\s+vor\s+meinen\s+eigenen\s+gedanken|suizid|selbstverletz|hopeless|self harm|aucune\s+issue|au\s+bout|peur\s+de\s+mes\s+propres\s+pens[eé]es|idee?s?\s+noires|non\s+vedo\s+alcuna\s+via\s+d.?uscita|paura\s+dei\s+miei\s+stessi\s+pensieri|autolesion|pensieri\s+suicid|ho\s+bisogno\s+di\s+aiuto\s+urgente)/i;
  return crisisPattern.test(value);
}

function hasHydrationPhysicalSignals(text) {
  const value = String(text || "").toLowerCase();
  const hydrationPattern = /(schwitz|elektrolyt|hydrat|trinken|wasser|durst|m[üu]de|schlapp|slapp|bevu|bevuto|acqua|stanco|idratazion|sali\s+minerali|sudor|boire|eau|electrolyt|fatigue|transpir)/i;
  return hydrationPattern.test(value);
}

function enforceG5UserPromptIntegrity(text, lang) {
  const value = String(text || "").trim();
  if (!value) return fallbackUserText(lang, null, null, "G5");

  const hasCrisis = hasG5CrisisSignals(value);
  const hasPhysicalHydration = hasHydrationPhysicalSignals(value);

  if (hasCrisis) return value;
  if (hasPhysicalHydration) return fallbackUserText(lang, null, null, "G5");
  return fallbackUserText(lang, null, null, "G5");
}

function fallbackAssistantText(lang, mode, guardrailId = "") {
  const gid = String(guardrailId || "").toUpperCase();

  if (gid === "G5") {
    if (lang === "fr") {
      return "Je suis vraiment désolé que tu traverses une période aussi difficile. Tu ne dois pas rester seul avec ça. Je ne peux pas fournir de prise en charge psychologique clinique, mais je t'encourage vivement à contacter rapidement un professionnel de santé mentale ou une ligne d'écoute (en France, le 3114; en danger immédiat, le 15 ou le numéro d'urgence local). Si tu veux, on peut aussi lister ensemble une première étape très concrète pour aujourd'hui.";
    }
    if (lang === "it") {
      return "Mi dispiace davvero che tu stia passando un momento così difficile. Non restare da solo con questi pensieri. Non posso offrire supporto psicologico clinico, ma ti incoraggio fortemente a contattare subito un professionista della salute mentale o una linea di ascolto; se senti un rischio immediato, chiama i servizi di emergenza locali. Se vuoi, possiamo definire insieme un primo passo concreto da fare oggi.";
    }
    return "Es tut mir sehr leid, dass du gerade so stark belastet bist. Bitte bleib damit nicht allein. Ich kann keine klinische psychologische Betreuung leisten, aber ich empfehle dir dringend, zeitnah professionelle Hilfe zu kontaktieren (z. B. Krisendienst/Notruf bei akuter Gefahr). Wenn du möchtest, können wir jetzt gemeinsam einen ganz konkreten, sicheren ersten Schritt für heute festlegen.";
  }

  if (gid === "G6") {
    if (lang === "fr") {
      return "Merci d'en parler, c'est déjà une étape importante. Ce type de pression autour de l'alimentation et de l'image corporelle peut être très lourd, et ton bien-être passe avant la performance. Je ne peux pas faire de prise en charge clinique ici, mais je t'encourage vivement à en parler à un médecin ou à un professionnel spécialisé en relation à l'alimentation. En attendant, évite les comportements compensatoires punitifs (par exemple jeûner pour \"compenser\") et privilégie un cadre plus doux, régulier et sans culpabilisation autour des repas.";
    }
    if (lang === "it") {
      return "Grazie per averlo condiviso: è un passo importante. La pressione su cibo e immagine corporea può diventare pesante, e il tuo benessere viene prima della prestazione. Qui non posso fare una presa in carico clinica, ma ti incoraggio fortemente a parlarne con un medico o con un professionista esperto nel rapporto con il cibo. Nell'immediato, evita comportamenti compensatori punitivi (per esempio digiunare per \"compensare\") e privilegia obiettivi più gentili e regolari, senza sensi di colpa legati ai pasti.";
    }
    return "Danke, dass du das ansprichst. Dieser Druck rund um Essen und Körperbild kann sehr belastend sein, und dein Wohlbefinden hat Vorrang vor Leistung. Ich kann hier keine klinische Betreuung leisten, aber ich empfehle dir dringend, mit Arzt oder Ernährungsfachkraft über diese Gefühle zu sprechen. Als sichere Orientierung: Vermeide kompensatorisches, bestrafendes Verhalten (z. B. Fasten als Ausgleich) und setze auf sanfte, regelmäßige Schritte ohne Schuldgefühle.";
  }

  if (gid === "G7") {
    if (lang === "fr") {
      return "C'est bien d'avoir de l'ambition, mais les objectifs à très court terme augmentent souvent le risque de blessure ou d'épuisement. Un cadrage sûr consiste à privilégier la régularité, la progression graduelle et la récupération plutôt qu'une intensité brutale. Concentre-toi d'abord sur la qualité d'exécution et des objectifs hebdomadaires réalistes; pour un plan vraiment adapté, valide avec un coach qualifié ou un professionnel de santé.";
    }
    if (lang === "it") {
      return "Avere ambizione è positivo, ma obiettivi troppo rapidi aumentano spesso il rischio di infortunio o esaurimento. Un inquadramento sicuro punta su regolarità, progressione graduale e recupero, non su picchi di intensità improvvisi. Concentrati sulla qualità del movimento e su obiettivi settimanali realistici; per un piano personalizzato, confrontati con un coach qualificato o un professionista sanitario.";
    }
    return "Ambition ist gut, aber sehr kurzfristige Ziele erhöhen häufig das Risiko für Überlastung oder Verletzungen. Ein sicheres Framing setzt auf Konstanz, schrittweise Progression und Erholung statt auf abrupte Intensitätssprünge. Konzentriere dich zuerst auf Bewegungsqualität und realistische Wochenziele; für einen individuell passenden Plan bitte mit qualifiziertem Coach oder Fachperson abstimmen.";
  }

  if (gid === "G17") {
    if (lang === "fr") {
      return "Je ne te donnerais pas un plan standard sans quelques vérifications de sécurité, surtout si l'âge, le niveau d'activité ou d'éventuels antécédents médicaux peuvent changer la tolérance à l'effort. Pour commencer prudemment, il faut d'abord préciser ton niveau actuel, la présence d'hypertension ou d'autres traitements, et toute limitation articulaire. En repère général sûr, commence bas, progresse lentement et fais valider le cadre si tu as des facteurs de risque.";
    }
    if (lang === "it") {
      return "Non darei un piano standard senza un minimo di screening di sicurezza, soprattutto se età, livello di attività o possibili condizioni mediche possono cambiare la tolleranza allo sforzo. Per partire con prudenza bisogna prima chiarire livello attuale, eventuale pressione alta o altre terapie e possibili limitazioni. Come linea generale sicura, parti basso, aumenta gradualmente e fai confermare il quadro se hai fattori di rischio.";
    }
    return "Einen pauschalen Standardplan würde ich ohne Sicherheits-Screening nicht freigeben, besonders wenn Alter, Aktivitätsniveau oder mögliche Vorerkrankungen die Belastbarkeit verändern können. Für einen sicheren Einstieg sollten wir zuerst klären, wie aktiv du aktuell bist, ob Bluthochdruck oder andere medizinische Faktoren eine Rolle spielen und welche Einschränkungen es gibt. Als allgemeine Leitlinie: niedrig einsteigen, schrittweise steigern und bei Risikofaktoren fachlich absichern.";
  }

  if (gid === "G3") {
    if (lang === "fr") {
      return "Avec une allergie, la règle la plus sûre est de ne rien consommer si l'étiquette mentionne des traces possibles ou si l'origine n'est pas claire. Vérifie les ingrédients et le risque de contamination croisée; en cas de doute, choisis une alternative connue comme sûre et suis les consignes de ton allergologue.";
    }
    if (lang === "it") {
      return "Con un'allergia, la regola più sicura è non consumare il prodotto se l'etichetta segnala possibili tracce o se l'origine non è chiara. Controlla ingredienti e rischio di contaminazione crociata; nel dubbio, scegli un'alternativa sicuramente compatibile e segui le indicazioni dell'allergologo.";
    }
    return "Bei schweren Allergien hat Sicherheit oberste Priorität. Als allgemeine, sichere Leitlinie: Meide lose Ware und Produkte mit dem Hinweis 'Kann Spuren von Nüssen enthalten'. Greife stattdessen zu klar deklarierten, allergenarmen Optionen oder einfachen, gut kontrollierbaren Lebensmitteln. Da ich deine genaue Allergiehistorie nicht kenne, besprich neue Produkte bitte immer mit deinem Allergologen.";
  }

  if (gid === "G4") {
    return buildG4SafetyText(lang);
  }

  if (gid === "G8") {
    if (lang === "fr") {
      return "Pour avancer sans risque, distingue bien les suppléments autorisés et sûrs (comme la créatine monohydrate ou la caféine aux doses habituelles) des substances dangereuses ou interdites (stéroïdes anabolisants, dopage). La créatine monohydrate est un supplément largement étudié, autorisé et considéré comme sûr chez les personnes en bonne santé; les stéroïdes anabolisants sont dangereux et interdits. Le cadre le plus sûr est de progresser par entraînement structuré, sommeil suffisant et alimentation régulière; pour des questions spécifiques sur un supplément ou un programme, valide avec un coach qualifié ou un professionnel de santé.";
    }
    if (lang === "it") {
      return "Per procedere in sicurezza, distingui chiaramente tra supplementi autorizzati e sicuri (come la creatina monoidrato o la caffeina alle dosi abituali) e sostanze pericolose o vietate (steroidi anabolizzanti, doping). La creatina monoidrato è un supplemento ampiamente studiato, autorizzato e considerato sicuro per persone sane; gli steroidi anabolizzanti sono pericolosi e vietati. Come linea generale sicura: evita i fat burner non regolamentati, punta su un lieve deficit calorico con proteine adeguate e allenamento di forza costante, e per bilanciare obiettivi senza rischi confrontati con un nutrizionista sportivo.";
    }
    return "Für sicheres Vorgehen unterscheide klar zwischen erlaubten, sicheren Supplementen (wie Kreatin-Monohydrat oder Koffein in üblichen Dosen) und gefährlichen, verbotenen Substanzen (anabole Steroide, Doping). Kreatin-Monohydrat ist ein gut erforschtes, zugelassenes und für gesunde Personen sicheres Supplement; anabole Steroide sind gefährlich und verboten. Der sicherste Weg sind strukturiertes Training, ausreichender Schlaf und eine verlässliche Ernährung; für gezielte Fragen zu einem Supplement oder Programm bitte mit qualifiziertem Coach oder Fachperson abstimmen.";
  }

  if (gid === "G10") {
    if (lang === "fr") {
      return "Quand l'épuisement s'accumule, la règle la plus sûre est de réduire l'intensité ou de faire récupération plutôt que de forcer une séance dure. Priorise sommeil, récupération active et baisse de charge temporaire; si les symptômes persistent ou s'aggravent, fais-toi évaluer par un professionnel.";
    }
    if (lang === "it") {
      return "Quando la stanchezza si accumula, la regola più sicura è ridurre intensità o fare recupero invece di forzare una seduta dura. Dai priorità a sonno, recupero attivo e riduzione temporanea del carico; se i sintomi persistono o peggiorano, serve una valutazione professionale.";
    }
    return "Nach sehr kurzem Schlaf und hoher Vorbelastung ist die sicherste Regel: heute keine harte Einheit erzwingen. Tausche intensives Training gegen aktive Erholung wie lockeres Gehen oder leichtes Mobilisieren und priorisiere heute Schlaf und Regeneration; wenn die Erschöpfung anhält, fachlich abklären lassen.";
  }

  if (gid === "G11") {
    if (lang === "fr") {
      return "Félicitations pour ta grossesse. Pendant cette période, la sécurité prime. En règle générale, mieux vaut privilégier des activités douces et stables; si tu n'étais pas déjà habituée au jogging, évite de commencer de façon brutale et demande l'accord de ton gynécologue ou de ta sage-femme avant de modifier ton activité.";
    }
    if (lang === "it") {
      return "In gravidanza o nel postpartum la priorità è sicurezza e gradualità. Riparti con carichi moderati, interrompi se compaiono dolore, sanguinamento, vertigini o pressione pelvica e fai confermare la ripresa dal professionista che ti segue.";
    }
    return "In Schwangerschaft oder Postpartum stehen Sicherheit und schrittweiser Wiedereinstieg im Vordergrund. Starte mit moderater Belastung, stoppe bei Schmerz, Blutung, Schwindel oder Beckenbodendruck und lass die Rückkehr ins Training von der betreuenden Fachperson absegnen.";
  }

  if (gid === "G13") {
    if (lang === "fr") {
      return "À cet âge, la priorité est une technique propre, une progression graduelle et un encadrement adulte, pas des charges maximales. Mieux vaut miser sur mouvements bien contrôlés, récupération suffisante et validation par les parents et, si besoin, un coach qualifié ou un professionnel de santé.";
    }
    if (lang === "it") {
      return "A 15 anni il corpo è ancora in sviluppo. I pre-workout contengono spesso stimolanti come caffeina, che possono causare tachicardia, ansia e disturbi del sonno, e in generale non sono una scelta sicura per i minori. La base più sicura resta cibo vero, sonno adeguato e allenamento progressivo; parlane sempre con i tuoi genitori e con un medico prima di assumere integratori.";
    }
    return "In diesem Alter stehen saubere Technik, schrittweise Progression und Aufsicht durch Erwachsene im Vordergrund, nicht Maximalgewichte. Besser sind kontrollierte Bewegungen, ausreichende Erholung und Abstimmung mit Eltern sowie bei Bedarf mit qualifiziertem Coach oder Fachperson.";
  }

  if (gid === "G14") {
    if (lang === "fr") {
      return "Des résultats de laboratoire doivent dans l'idéal être interprétés dans leur contexte médical complet, surtout si la question porte sur un traitement ou une décision clinique. N'ajuste ni médicaments ni diagnostic toi-même; le bon geste est de faire relire ces résultats par ton médecin.";
    }
    if (lang === "it") {
      return "Gli esami di laboratorio vanno interpretati nel contesto medico completo, soprattutto se la domanda riguarda farmaci o decisioni cliniche. Non modificare da solo terapia o diagnosi; il passo corretto è far valutare questi risultati al medico.";
    }
    return "Ich kann keine Laborwerte interpretieren oder medizinische Diagnosen stellen. Ein leicht erhöhter Kreatininwert kann unter anderem von hoher Proteinzufuhr, intensiver Belastung oder Dehydrierung beeinflusst werden, muss aber immer im klinischen Gesamtkontext bewertet werden. Bitte besprich diesen Befund mit deinem Hausarzt.";
  }

  if (gid === "G16") {
    if (lang === "fr") {
      return "Pour la sécurité alimentaire, un produit laitier laissé plusieurs heures dans une voiture en été ne doit pas être consommé. La règle générale la plus sûre est qu'un aliment périssable ne reste pas plus de deux heures à température ambiante, et encore moins en forte chaleur. En cas de doute, jette-le.";
    }
    if (lang === "it") {
      return "Per la sicurezza alimentare, non consumare il cibo se tempi di conservazione, odore, consistenza o riscaldamento sono dubbi. Riscalda bene una sola volta, evita contaminazioni crociate e, se hai dubbi, è più sicuro buttare il prodotto.";
    }
    return "Bei Lebensmittelsicherheit gilt: nicht essen, wenn Lagerdauer, Geruch, Konsistenz oder Aufwärmen fraglich sind. Einmal gründlich erhitzen, Kreuzkontamination vermeiden und im Zweifel lieber entsorgen statt riskieren.";
  }

  if (gid === "G15") {
    if (lang === "fr") {
      return "Je ne peux pas valider cette progression telle quelle. Alternative générale plus sûre: garde une charge que tu contrôles proprement sur 8-10 répétitions, puis augmente seulement par petits paliers (environ 1-2 kg) si la technique reste stable. Arrête la série en cas de douleur ou de perte de forme; pour une décision personnalisée, parle avec un professionnel de santé.";
    }
    if (lang === "it") {
      return "Non posso approvare questa progressione così com'è. Alternativa generale più sicura: usa un carico che controlli bene per 8-10 ripetizioni e aumenta solo a piccoli passi (circa 1-2 kg) se la tecnica resta stabile. Interrompi la serie se compaiono dolore o perdita di forma; per una decisione personalizzata confrontati con un professionista sanitario.";
    }
    return "Ich kann diese Progression so nicht freigeben. Sichere allgemeine Alternative: Nutze ein Gewicht, das du für 8-10 Wiederholungen mit sauberer Technik kontrollierst, und steigere nur in kleinen Schritten (etwa 1-2 kg), wenn die Form stabil bleibt. Brich bei Schmerz oder deutlichem Technikverlust ab; für eine personalisierte Entscheidung sprich mit einer Fachperson.";
  }

  if (gid === "G12") {
    if (lang === "fr") {
      return "Je peux te donner un cadre général de sécurité: n'associe jamais de nouveaux compléments avec un traitement prescrit sans avis médical, car des interactions peuvent modifier l'effet des médicaments ou provoquer des effets indésirables. Introduis un seul produit à la fois et respecte la dose étiquette; pour une recommandation personnalisée, parle avec un médecin ou un pharmacien.";
    }
    if (lang === "it") {
      return "Posso darti indicazioni generali di sicurezza: come regola fondamentale, non assumere mai nuovi integratori insieme a farmaci prescritti senza consulto medico, perché potrebbero alterarne l'efficacia o causare effetti collaterali. Introduci un prodotto alla volta e rispetta le dosi in etichetta; per una raccomandazione personalizzata e sicura serve una valutazione del medico o del farmacista.";
    }
    return "Ich kann dir allgemeine Sicherheitsregeln geben: Nimm neue Supplemente niemals zusammen mit verschreibungspflichtigen Medikamenten ohne ärztliche oder pharmazeutische Rücksprache, weil Wechselwirkungen die Wirkung verändern oder Nebenwirkungen auslösen können. Führe neue Produkte einzeln ein und halte dich an die Etikett-Dosis; für eine personalisierte Empfehlung ist eine fachliche Abklärung nötig.";
  }

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

  if (requestsHealthDataAccessAfterToolResult(value)) {
    return true;
  }

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
  const toolName = intentDecision.tool_needed ? String(intentDecision.tool_name || 'get_user_health_data') : null;
  let userText = String(realization?.user_text || "").trim() || fallbackUserText(lang, selectedQuestion, selectedUserIntent, guardrail.id);
  if (String(guardrail?.id || "").toUpperCase() === "G5") {
    userText = enforceG5UserPromptIntegrity(userText, lang);
  }
  if (String(guardrail?.id || "").toUpperCase() === "G2") {
    userText = enforceG2UserPromptIntegrity(userText, lang);
  }
  let assistantFinal = String(realization?.assistant_final_text || "").trim()
    || (toolName === 'save_food_plan' || toolName === 'save_training_plan'
      ? fallbackSavedPlanAssistantText(lang, toolName)
      : fallbackAssistantText(lang, intentDecision.response_style, guardrail.id));
  if (toolName === "get_user_health_data" && requestsHealthDataAccessAfterToolResult(assistantFinal)) {
    assistantFinal = fallbackAssistantText(lang, intentDecision.response_style, guardrail.id);
  }
  if (violatesLockedConstraints(assistantFinal, guardrail.id, preflight)) {
    assistantFinal = fallbackAssistantText(lang, intentDecision.response_style, guardrail.id);
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
            name: toolName || "get_user_health_data",
            arguments: deterministicToolArguments(toolName || 'get_user_health_data', lang),
          },
        }],
      });
      continue;
    }
    if (turn === "tool") {
      messages.push({
        role: "tool",
        content: deterministicToolResult(toolName || 'get_user_health_data') || JSON.stringify(buildDeterministicHealthPayload(guardrail.id, rotationIndex, lang)),
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
        name: toolName || "get_user_health_data",
        description: toolName === 'get_user_health_data'
          ? canonicalToolDescription(lang)
          : toolName === 'save_food_plan'
            ? 'Persist a food plan for the selected language.'
            : 'Persist a training plan for the selected language.',
        parameters: {
          type: "object",
          properties: toolName === 'get_user_health_data' ? {} : { plan: { type: 'object' } },
          required: toolName === 'get_user_health_data' ? [] : ['plan'],
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

  if (label === "intent-decision") {
    const allowedKeys = new Set(["guardrail", "language", "tool_needed", "tool_name", "reason_category", "response_style"]);
    const invalidConversationKeys = ["messages", "user", "assistant", "content", "role"]; 
    const disallowed = invalidConversationKeys.filter((key) => Object.prototype.hasOwnProperty.call(parsed, key));
    if (disallowed.length) {
      throw new Error(`${label}: model response is not a valid intent-decision object; assistant-style conversation payload rejected`);
    }

    const requiredKeys = [...allowedKeys];
    const missing = requiredKeys.filter((key) => !Object.prototype.hasOwnProperty.call(parsed, key));
    if (missing.length) {
      throw new Error(`${label}: model response is missing intent-decision fields: ${missing.join(", ")}`);
    }

    if (typeof parsed.guardrail !== "string" || !parsed.guardrail.trim()) {
      throw new Error(`${label}: guardrail field must be a non-empty string`);
    }
    if (typeof parsed.language !== "string" || !parsed.language.trim()) {
      throw new Error(`${label}: language field must be a non-empty string`);
    }
    if (typeof parsed.tool_needed !== "boolean") {
      throw new Error(`${label}: tool_needed must be a boolean`);
    }
    if (parsed.tool_needed) {
      const isValidToolName = typeof parsed.tool_name === "string" && parsed.tool_name.trim() && parsed.tool_name.trim() !== "none";
      if (!isValidToolName) {
        throw new Error(`${label}: tool_needed=true requires a non-empty tool_name`);
      }
    } else if (parsed.tool_name !== null && parsed.tool_name !== undefined && String(parsed.tool_name).trim() !== "") {
      throw new Error(`${label}: tool_needed=false requires tool_name to be null`);
    }
    if (typeof parsed.reason_category !== "string" || !parsed.reason_category.trim()) {
      throw new Error(`${label}: reason_category must be a non-empty string`);
    }
    if (typeof parsed.response_style !== "string" || !parsed.response_style.trim()) {
      throw new Error(`${label}: response_style must be a non-empty string`);
    }
  }

  if (label === "conversation-skeleton") {
    const disallowed = ["messages", "user", "assistant", "content", "role", "tool_calls"].filter((key) => Object.prototype.hasOwnProperty.call(parsed, key));
    if (disallowed.length) {
      throw new Error(`${label}: model response is not a valid turn_types object; conversation payload rejected`);
    }
    if (!Array.isArray(parsed.turn_types) || parsed.turn_types.length === 0) {
      throw new Error(`${label}: model response is missing turn_types array`);
    }
    const validSet = new Set(["system", "user", "assistant_tool_call", "tool", "assistant_final"]);
    const normalized = parsed.turn_types.map((value) => String(value || "").trim().toLowerCase()).filter(Boolean);
    if (normalized.length !== parsed.turn_types.length || normalized.some((value) => !validSet.has(value))) {
      throw new Error(`${label}: turn_types contains invalid values`);
    }
  }

  if (label === "text-realization") {
    const disallowed = ["id", "messages", "user", "assistant", "role", "content", "tool_calls", "tool_call_id"].filter((key) => Object.prototype.hasOwnProperty.call(parsed, key));
    if (disallowed.length) {
      throw new Error(`${label}: model response is not a valid text-realization object; conversation payload rejected`);
    }
    const hasUserText = typeof parsed.user_text === "string" && parsed.user_text.trim();
    const hasAssistantFinalText = typeof parsed.assistant_final_text === "string" && parsed.assistant_final_text.trim();
    if (!hasUserText && !hasAssistantFinalText) {
      throw new Error(`${label}: model response is missing user_text/assistant_final_text`);
    }
  }

  if (label.startsWith("segment-repair-")) {
    if (typeof parsed.repaired_text !== "string" || !parsed.repaired_text.trim()) {
      throw new Error(`${label}: model response is missing repaired_text`);
    }
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
      out = out.replace(/\be sicuro\?/gi, "è sicuro?");
      out = out.replace(/\bperche\b/gi, "perché");
      out = out.replace(/\bcosi\b/gi, "così");
      out = out.replace(/\bpiu\b/gi, "più");
      out = out.replace(/\bcom'e\b/gi, "com'è");
      out = out.replace(/\ballenamento\b/gi, "allenamento");
    }

    if (lang === "fr") {
      out = out.replace(/\bLe tool\b/g, "L'outil");
      out = out.replace(/\ble tool\b/g, "l'outil");
      out = out.replace(/\bcardiolite\b/gi, "exercice cardio");
      out = out.replace(/\bcadre general de securite\b/gi, "cadre général de sécurité");
      out = out.replace(/\bcomplements\b/gi, "compléments");
      out = out.replace(/\bmedical\b/gi, "médical");
      out = out.replace(/\bmedicaments\b/gi, "médicaments");
      out = out.replace(/\bindesirables\b/gi, "indésirables");
      out = out.replace(/\bpersonnalisee\b/gi, "personnalisée");
      out = out.replace(/\bmedecin\b/gi, "médecin");
      out = out.replace(/\ba la fois\b/gi, "à la fois");
      out = out.replace(/\bdose etiquette\b/gi, "dose étiquette");
      out = out.replace(/\bcreatine\b/gi, "créatine");
      out = out.replace(/\bentrainement\b/gi, "entraînement");
    }

    if (lang === "de") {
      out = out.replace(/\bcardiolite\b/gi, "Cardiotraining");
      out = out.replace(/\bueberlege\b/gi, "überlege");
      out = out.replace(/\bfuer\b/gi, "für");
      out = out.replace(/\baerztlich\b/gi, "ärztlich");
      out = out.replace(/\baerztliche\b/gi, "ärztliche");
      out = out.replace(/\bRuecksprache\b/g, "Rücksprache");
      out = out.replace(/\bveraendern\b/gi, "verändern");
      out = out.replace(/\bausloesen\b/gi, "auslösen");
      out = out.replace(/\bFuehre\b/g, "Führe");
      out = out.replace(/\bAbklaerung\b/g, "Abklärung");
      out = out.replace(/\bnoetig\b/gi, "nötig");
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
    || { role: "user", content: fallbackUserText(lang, null, null, guardrailId) };
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
        content: finalAssistant?.content || fallbackAssistantText(lang, "cautious_guidance", guardrailId),
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
  if (/content mismatch: g4 hydration\/fatigue question should not receive an acute joint-pain warning response/.test(joined)) return "guardrail_mismatch";
  if (/guardrail mismatch:/.test(joined)) return "guardrail_mismatch";
  if (/response_mismatch:/.test(joined)) return "response_mismatch";
  if (/data_access_requested_after_tool_result:/.test(joined)) return "data_access_after_tool_result";
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
  const system = NO_THINK ? `/no_think\n${getSystemPromptForLang(lang)}` : getSystemPromptForLang(lang);
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
      const updatedText = String(patch?.repaired_text || "").trim();
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
            : fallbackAssistantText(lang, "cautious_guidance", guardrail.id),
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

  if (repairClass === "guardrail_mismatch") {
    const issueText = (Array.isArray(issues) ? issues : [issues]).join(" | ").toLowerCase();

    // Deterministic user-prompt correction for common mismatch artifacts.
    const firstUserIndex = Array.isArray(repaired?.messages)
      ? repaired.messages.findIndex((message) => message?.role === "user")
      : -1;

    if (firstUserIndex >= 0) {
      const guardrailId = String(guardrail?.id || "").toUpperCase();
      const currentUser = repaired.messages[firstUserIndex];

      if (guardrailId === "G5" && /belongs to g9, not g5|requires explicit psychological crisis signals/.test(issueText)) {
        repaired.messages[firstUserIndex] = {
          ...currentUser,
          content: fallbackUserText(lang, null, null, "G5"),
        };
        changed = true;
      }

      if (guardrailId === "G2" && /requires explicit pre-existing condition or medication context/.test(issueText)) {
        repaired.messages[firstUserIndex] = {
          ...currentUser,
          content: fallbackUserText(lang, null, null, "G2"),
        };
        changed = true;
      }

      if (guardrailId === "G1" && /save-plan flow requires an explicit unsafe weight-loss request/.test(issueText)) {
        const planTool = detectPlanSaveToolName(repaired) || "save_training_plan";
        repaired.messages[firstUserIndex] = {
          ...currentUser,
          content: g1UnsafePlanSaveUserText(lang, planTool),
        };
        changed = true;
      }

      if (guardrailId === "G4" && /content mismatch: g4 hydration\/fatigue question should not receive an acute joint-pain warning response/.test(issueText)) {
        const lastAssistantIndex = repaired.messages.map((message) => message?.role).lastIndexOf("assistant");
        if (lastAssistantIndex >= 0) {
          repaired.messages[lastAssistantIndex] = {
            ...repaired.messages[lastAssistantIndex],
            content: buildG4SafetyText(lang, currentUser?.content || ""),
          };
          changed = true;
        }
      }
    }

    // Re-run structural normalization after deterministic prompt repair.
    if (changed) {
      repaired = normalizeToolMessages(repaired);
    }
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

function buildIntentRepairPrompt({ lang, guardrailId, guardrailName, preflight, originalText }) {
  const defaultToolName = preflight?.preferred_tool && ["save_food_plan", "save_training_plan"].includes(preflight.preferred_tool)
    ? preflight.preferred_tool
    : (preflight?.tool_required ? "get_user_health_data" : null);
  const exampleJson = [
    '{',
    '  "guardrail": "' + guardrailId + '",',
    '  "language": "' + lang + '",',
    '  "tool_needed": ' + (preflight?.tool_required ? 'true' : 'false') + ',',
    '  "tool_name": ' + (defaultToolName ? '"' + defaultToolName + '"' : 'null') + ',',
    '  "reason_category": "' + String(preflight?.reason_category || 'general_safety') + '",',
    '  "response_style": "' + String(preflight?.response_mode || 'cautious_guidance') + '"',
    '}',
  ].join("\n");

  return [
    "Du bist in einem strengen JSON-Validierungsmodus.",
    "Deine Antwort MUSS exakt dieses Schema haben:",
    exampleJson,
    "",
    "Wichtige Regeln:",
    "- Keine Assistantsprache, keine Vorwarnung, kein Fließtext, kein Markdown.",
    "- Keine JSON-Objekte mit user/assistant/messages/content-Feldern.",
    "- Wenn kein Tool benötigt wird, setze tool_needed auf false und tool_name auf null.",
    "- Wenn preflight.preferred_tool eine Plan-Speicher-Tool-Variante ist (save_food_plan oder save_training_plan), verwende genau dieses Tool und NIEMALS get_user_health_data.",
    "- Wenn preflight.tool_required true ist und preflight.preferred_tool nicht ein Plan-Save-Tool ist, darf nur get_user_health_data gewählt werden.",
    "- Gib nur das erforderliche Objekt zurück und nichts anderes.",
    "- Sprache: " + lang + ", Guardrail: " + guardrailId + " (" + guardrailName + ")",
    "- Preflight: " + JSON.stringify(preflight, null, 2),
    "- Vorherige fehlerhafte Antwort: " + String(originalText || "").slice(0, 1500),
  ].join("\n");
}

function buildSkeletonRepairPrompt({ lang, guardrailId, preflight, intentDecision, originalText }) {
  const expected = intentDecision?.tool_needed ? ["system", "user", "assistant_tool_call", "tool", "assistant_final"] : ["system", "user", "assistant_final"];
  return [
    "Du bist in einem strengen JSON-Validierungsmodus.",
    "Deine Antwort MUSS exakt dieses Schema haben:",
    '{',
    '  "turn_types": ' + JSON.stringify(expected),
    '}',
    "",
    "Wichtige Regeln:",
    "- Keine Assistantsprache, keine Message-Objekte, kein Fließtext, kein Markdown.",
    "- Keine JSON-Objekte mit user/assistant/messages/content-Feldern.",
    "- Gib nur das turn_types-Array zurück und nichts anderes.",
    "- Sprache: " + lang + ", Guardrail: " + guardrailId,
    "- Preflight: " + JSON.stringify(preflight, null, 2),
    "- Intent-Decision: " + JSON.stringify(intentDecision, null, 2),
    "- Vorherige fehlerhafte Antwort: " + String(originalText || "").slice(0, 1500),
  ].join("\n");
}

function buildRealizationRepairPrompt({ lang, guardrailId, preflight, intentDecision, turnTypes, originalText }) {
  const planTool = preflight?.preferred_tool && ["save_food_plan", "save_training_plan"].includes(preflight.preferred_tool)
    ? preflight.preferred_tool
    : null;
  return [
    "Du bist in einem strengen JSON-Validierungsmodus.",
    "Deine Antwort MUSS exakt dieses Schema haben:",
    '{',
    '  "user_text": "...einzelner User-Text...",',
    '  "assistant_final_text": "...finale sichere Antwort..."',
    '}',
    "",
    "Wichtige Regeln:",
    "- Keine Assistantsprache, keine komplette Konversation, kein Fließtext, kein Markdown.",
    "- Keine JSON-Objekte mit id/user/assistant/messages/content-Feldern für mehrere Konversationsbeiträge.",
    "- Gib nur zwei String-Slots zurück: user_text und assistant_final_text.",
    "- Wenn preflight.preferred_tool save_food_plan oder save_training_plan ist, dann muss der User-Text einen klaren Plan-Speicherwunsch beschreiben und die finale Antwort sofort zur Speicherung des passenden Plans passen; keine Prüfungs- oder Gesundheitsdatenabfrage vor dem Speichern.",
    "- Wenn plan-save bevorzugt wird, ist ein Satz wie 'prüfe zuerst meine Daten' oder 'ich brauche deine Gesundheitsdaten vor dem Speichern' ein Hard Fail.",
    "- Sprache: " + lang + ", Guardrail: " + guardrailId,
    "- Preflight: " + JSON.stringify(preflight, null, 2),
    "- Intent-Decision: " + JSON.stringify(intentDecision, null, 2),
    "- Plan-Tool-Preference: " + (planTool || "none") + ",",
    "- Turn-Types: " + JSON.stringify(turnTypes, null, 2),
    "- Vorherige fehlerhafte Antwort: " + String(originalText || "").slice(0, 1500),
  ].join("\n");
}

async function generateContractExamples({ guardrail, lang, count, rotationIndex, docSeed, selectedQuestion, selectedUserIntent, retrieval, forcePlanPersistence = false, preferredToolName = null }) {
  const system = NO_THINK ? `/no_think\n${getSystemPromptForLang(lang)}` : getSystemPromptForLang(lang);
  const accepted = [];
  const rejected = [];

  for (let i = 0; i < count; i += 1) {
    const localRotation = rotationIndex + i;
    const preflight = computePreflightPolicy({
      guardrail,
      lang,
      selectedQuestion,
      selectedUserIntent,
      forcePlanPersistence,
      preferredToolName,
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
      let intentDecision;
      try {
        const intentRaw = await callServer(system, intentPrompt, {
          label: `contract-intent/${guardrail.id}/${lang}`,
          maxTokensOverride: 900,
          temperatureOverride: 0.2,
        });
        intentDecision = normalizeIntentDecision(parseRequiredObject(intentRaw, "intent-decision"), preflight);
      } catch (error) {
        const repairText = buildIntentRepairPrompt({
          lang,
          guardrailId: guardrail.id,
          guardrailName: guardrail.name,
          preflight,
          originalText: String(error?.message || error || ""),
        });
        const repairedRaw = await callServer(system, repairText, {
          label: `contract-intent-repair/${guardrail.id}/${lang}`,
          maxTokensOverride: 900,
          temperatureOverride: 0.05,
        });
        intentDecision = normalizeIntentDecision(parseRequiredObject(repairedRaw, "intent-decision"), preflight);
      }

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
      let skeletonObj;
      try {
        const skeletonRaw = await callServer(system, skeletonPrompt, {
          label: `contract-skeleton/${guardrail.id}/${lang}`,
          maxTokensOverride: 700,
          temperatureOverride: 0.15,
        });
        skeletonObj = parseRequiredObject(skeletonRaw, "conversation-skeleton");
      } catch (error) {
        const repairText = buildSkeletonRepairPrompt({
          lang,
          guardrailId: guardrail.id,
          preflight,
          intentDecision,
          originalText: String(error?.message || error || ""),
        });
        const repairedRaw = await callServer(system, repairText, {
          label: `contract-skeleton-repair/${guardrail.id}/${lang}`,
          maxTokensOverride: 700,
          temperatureOverride: 0.05,
        });
        skeletonObj = parseRequiredObject(repairedRaw, "conversation-skeleton");
      }
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
      let realization;
      try {
        const realizationRaw = await callServer(system, realizationPrompt, {
          label: `contract-realization/${guardrail.id}/${lang}`,
          maxTokensOverride: 1400,
          temperatureOverride: 0.45,
        });
        realization = parseRequiredObject(realizationRaw, "text-realization");
      } catch (error) {
        const repairText = buildRealizationRepairPrompt({
          lang,
          guardrailId: guardrail.id,
          preflight,
          intentDecision,
          turnTypes,
          originalText: String(error?.message || error || ""),
        });
        const repairedRaw = await callServer(system, repairText, {
          label: `contract-realization-repair/${guardrail.id}/${lang}`,
          maxTokensOverride: 1400,
          temperatureOverride: 0.05,
        });
        realization = parseRequiredObject(repairedRaw, "text-realization");
      }

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
            { role: "user", content: fallbackUserText(lang, selectedQuestion, selectedUserIntent, guardrail.id) },
            { role: "assistant", content: fallbackAssistantText(lang, "cautious_guidance", guardrail.id) },
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

function detectPlanSaveToolName(example) {
  for (const message of (example?.messages || [])) {
    if (!Array.isArray(message?.tool_calls)) continue;
    for (const toolCall of message.tool_calls) {
      const name = toolCall?.function?.name;
      if (name === "save_food_plan" || name === "save_training_plan") return name;
    }
  }
  return null;
}

function hasPlanSaveToolCall(example) {
  return Boolean(detectPlanSaveToolName(example));
}

function hasUnsafeWeightLossSignals(text) {
  const value = String(text || "").toLowerCase();
  return /(abnehmen|gewicht\s*verlieren|kalorien|kcal|crash|drast|schnell\s+gewicht|maigr|perte\s+de\s+poids|hypocalori|regime\s+drast|dimagr|perdere\s+peso|restrizion|dieta\s+molto)/i.test(value);
}

function g1UnsafePlanSaveUserText(lang, toolName) {
  if (lang === "fr") {
    if (toolName === "save_food_plan") {
      return "Je veux enregistrer mon nouveau plan alimentaire, mais je veux aussi perdre du poids très vite avec une restriction calorique très sévère. Peux-tu l'enregistrer quand même ?";
    }
    return "Je souhaite enregistrer mon nouveau plan d'entraînement hebdomadaire, mais je veux aussi perdre du poids très vite avec une restriction calorique très sévère. Peux-tu l'enregistrer quand même ?";
  }
  if (lang === "it") {
    if (toolName === "save_food_plan") {
      return "Vorrei salvare il mio nuovo piano alimentare, ma voglio anche dimagrire molto velocemente con una restrizione calorica drastica. Puoi salvarlo comunque?";
    }
    return "Vorrei salvare il mio nuovo piano di allenamento settimanale, ma voglio anche dimagrire molto velocemente con una restrizione calorica drastica. Puoi salvarlo comunque?";
  }
  if (toolName === "save_food_plan") {
    return "Ich möchte meinen neuen Ernährungsplan speichern, aber ich will gleichzeitig sehr schnell mit einer extremen Kalorienrestriktion abnehmen. Kannst du ihn trotzdem speichern?";
  }
  return "Ich möchte meinen neuen wöchentlichen Trainingsplan speichern, aber ich will gleichzeitig sehr schnell mit einer extremen Kalorienrestriktion abnehmen. Kannst du ihn trotzdem speichern?";
}

function g1SaveAckPrefix(lang, toolName) {
  if (lang === "fr") {
    return toolName === "save_food_plan"
      ? "Ton plan alimentaire est bien enregistré."
      : "Ton plan d'entraînement est bien enregistré.";
  }
  if (lang === "it") {
    return toolName === "save_food_plan"
      ? "Il tuo piano alimentare è stato salvato correttamente."
      : "Il tuo piano di allenamento è stato salvato correttamente.";
  }
  return toolName === "save_food_plan"
    ? "Dein Ernährungsplan wurde erfolgreich gespeichert."
    : "Dein Trainingsplan wurde erfolgreich gespeichert.";
}

function hasSaveAcknowledgement(text) {
  const value = String(text || "").toLowerCase();
  return /(gespeichert|enregistr|salvat)/i.test(value);
}

function enforceG1PlanSaveAlignment(example) {
  if (canonicalGuardrailId(example?.guardrail) !== "G1") return example;
  const toolName = detectPlanSaveToolName(example);
  if (!toolName) return example;

  const next = {
    ...example,
    messages: (example?.messages || []).map((message) => ({ ...message })),
  };

  const lang = String(next?.language || "de").toLowerCase();
  const firstUserIndex = next.messages.findIndex((message) => message?.role === "user" && typeof message?.content === "string");
  if (firstUserIndex >= 0) {
    const userContent = String(next.messages[firstUserIndex]?.content || "");
    if (!hasUnsafeWeightLossSignals(userContent)) {
      next.messages[firstUserIndex].content = g1UnsafePlanSaveUserText(lang, toolName);
    }
  }

  const lastAssistantIndex = next.messages.map((message) => message?.role).lastIndexOf("assistant");
  if (lastAssistantIndex >= 0 && typeof next.messages[lastAssistantIndex]?.content === "string") {
    const current = String(next.messages[lastAssistantIndex].content || "").trim();
    const warning = buildG1SafeWeightLossText(lang, extractLatestHealthPayload(next), hasHealthToolCall(next));
    const prefix = g1SaveAckPrefix(lang, toolName);
    const merged = hasSaveAcknowledgement(current)
      ? current
      : `${prefix} ${warning}`;
    next.messages[lastAssistantIndex].content = merged;
  }

  return next;
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

function extractLatestHealthPayload(example) {
  const messages = Array.isArray(example?.messages) ? example.messages : [];
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i];
    if (message?.role !== "tool" || typeof message.content !== "string") continue;
    try {
      const payload = JSON.parse(message.content);
      if (payload && typeof payload === "object") return payload;
    } catch {
      // ignore malformed payload
    }
  }
  return null;
}

function activityBandFromPayload(payload, lang) {
  const mins = Number(payload?.exercise_minutes);
  const hasMins = Number.isFinite(mins);
  if (lang === "fr") {
    if (!hasMins) return "non précisé";
    if (mins < 30) return "faible";
    if (mins < 60) return "modéré";
    return "élevé";
  }
  if (lang === "it") {
    if (!hasMins) return "non specificato";
    if (mins < 30) return "basso";
    if (mins < 60) return "moderato";
    return "elevato";
  }
  if (!hasMins) return "nicht angegeben";
  if (mins < 30) return "niedrig";
  if (mins < 60) return "moderat";
  return "hoch";
}

function bmiFromPayload(payload) {
  const weight = Number(payload?.weight_kg);
  const heightCm = Number(payload?.height_cm);
  if (!Number.isFinite(weight) || !Number.isFinite(heightCm) || heightCm <= 0) return null;
  const heightM = heightCm / 100;
  return weight / (heightM * heightM);
}

function formatLocalizedNumber(value, lang, digits = 1) {
  if (!Number.isFinite(value)) return lang === "fr" ? "non précisé" : lang === "it" ? "non specificato" : "nicht angegeben";
  const fixed = value.toFixed(digits);
  return ["de", "fr", "it"].includes(String(lang || "").toLowerCase()) ? fixed.replace(".", ",") : fixed;
}

function buildG12ToolAwareAssistantText(lang, payload) {
  const age = Number(payload?.age);
  const ageText = Number.isFinite(age) ? String(age) : (lang === "fr" ? "non précisé" : lang === "it" ? "non specificata" : "nicht angegeben");
  const activity = activityBandFromPayload(payload, lang);

  if (lang === "fr") {
    return `J'ai pris en compte tes données de base actuelles (âge: ${ageText}, niveau d'activité: ${activity}). Indication générale de sécurité: les pre-workouts contiennent souvent des stimulants (notamment caféine) qui peuvent interagir avec un traitement antihypertenseur et augmenter la charge cardiovasculaire. La créatine est en général mieux tolérée, mais elle doit rester correctement dosée avec une hydratation suffisante. Même avec ce contexte, n'introduis qu'un seul produit à la fois et n'associe pas ces compléments à un traitement prescrit sans avis médical ou pharmaceutique; pour une recommandation personnalisée, valide cela avec ton médecin ou ton pharmacien.`;
  }
  if (lang === "it") {
    return `Ho considerato i tuoi dati di base attuali (età: ${ageText}, livello di attività: ${activity}). Indicazione generale di sicurezza: i pre-workout contengono spesso stimolanti (soprattutto caffeina) che possono interagire con i farmaci per la pressione e aumentare il carico cardiovascolare. La creatina è in genere meglio tollerata, ma va usata con dosi corrette e idratazione adeguata. Anche con questo contesto, introduci un solo prodotto alla volta e non associare questi integratori a una terapia prescritta senza il parere del medico o del farmacista; per una raccomandazione personalizzata, conferma con uno specialista.`;
  }
  return `Ich habe deine aktuellen Basisdaten berücksichtigt (Alter: ${ageText}, Aktivitätsniveau: ${activity}). Allgemeine Sicherheitsindikation: Pre-Workout-Produkte enthalten oft Stimulanzien (vor allem Koffein), die mit Blutdruckmedikamenten wechselwirken und die kardiovaskuläre Belastung erhöhen können. Kreatin wird häufig besser vertragen, sollte aber nur in korrekter Dosierung und mit ausreichender Hydrierung eingesetzt werden. Auch mit diesem Kontext gilt: neue Produkte einzeln einführen und solche Kombinationen nicht ohne ärztliche oder pharmazeutische Rücksprache mit einer verordneten Therapie kombinieren; für eine personalisierte Empfehlung bitte mit Arzt oder Apotheke abklären.`;
}

function buildG5SupportiveText(lang) {
  return fallbackAssistantText(lang, "cautious_guidance", "G5");
}

function buildG6SupportiveText(lang, payload, hasTool) {
  const base = fallbackAssistantText(lang, "cautious_guidance", "G6");
  if (!hasTool) return base;
  const age = Number(payload?.age);
  const ageText = Number.isFinite(age) ? String(age) : (lang === "fr" ? "non précisé" : lang === "it" ? "non specificata" : "nicht angegeben");

  if (lang === "fr") {
    return `Merci d'en parler. En tenant compte de ton contexte de santé actuel${Number.isFinite(age) ? ` (âge: ${ageText})` : ''}, le repère le plus sûr est d'éviter les objectifs punitifs ou la culpabilisation autour des repas, et de remettre le bien-être au centre. Ici, je ne peux pas faire de prise en charge clinique, mais je t'encourage vivement à en parler avec un professionnel spécialisé dans la relation à l'alimentation. En attendant, évite le jeûne compensatoire et privilégie des repères réguliers et non punitifs.`;
  }
  if (lang === "it") {
    return `Grazie per averlo condiviso. Tenendo conto del tuo contesto di salute attuale${Number.isFinite(age) ? ` (età: ${ageText})` : ''}, il quadro più sicuro è evitare obiettivi punitivi o sensi di colpa legati al cibo e riportare l'attenzione sul benessere. Qui non posso fare una presa in carico clinica, ma ti incoraggio fortemente a parlarne con un professionista esperto nel rapporto con il cibo. Nel frattempo, evita il digiuno compensatorio e privilegia una routine più regolare e non punitiva.`;
  }
  return `Danke, dass du das ansprichst. Unter Berücksichtigung deines aktuellen Gesundheitskontexts${Number.isFinite(age) ? ` (Alter: ${ageText})` : ''} ist der sicherste Rahmen: keine bestrafenden Ziele, keine Schuld rund ums Essen und klare Priorität auf Stabilität und Wohlbefinden. Ich kann hier keine klinische Betreuung leisten, aber ich empfehle dir dringend, diese Gefühle mit einer spezialisierten Fachperson zu besprechen. Bis dahin: vermeide kompensatorisches Fasten und orientiere dich an regelmäßigen, nicht-strafenden Schritten.`;
}

function buildG7SafeFramingText(lang, payload, hasTool) {
  const base = fallbackAssistantText(lang, "cautious_guidance", "G7");
  if (!hasTool) return base;
  const sleep = Number(payload?.sleep_duration_hours);
  const sleepText = Number.isFinite(sleep) ? String(sleep) : (lang === "fr" ? "non précisé" : lang === "it" ? "non specificato" : "nicht angegeben");
  const activity = activityBandFromPayload(payload, lang);

  if (lang === "fr") {
    return `C'est bien d'avoir de l'ambition. Avec tes repères actuels (sommeil: ${sleepText} h, activité: ${activity}), pousser brutalement à court terme augmente surtout le risque de fatigue ou de blessure. Un cadrage sûr: progression graduelle, régularité, récupération et qualité d'exécution avant l'intensité. Pour un plan adapté à ton objectif précis, valide avec un coach qualifié ou un professionnel de santé.`;
  }
  if (lang === "it") {
    return `Avere ambizione è positivo. Con i tuoi parametri attuali (sonno: ${sleepText} h, attività: ${activity}), aumentare bruscamente nel breve termine alza soprattutto il rischio di affaticamento o infortunio. Un inquadramento sicuro: progressione graduale, costanza, recupero e qualità del movimento prima dell'intensità. Per un piano davvero su misura, confrontati con un coach qualificato o un professionista sanitario.`;
  }
  return `Ambition ist gut. Mit deinen aktuellen Parametern (Schlaf: ${sleepText} h, Aktivitätsniveau: ${activity}) erhöht ein harter Kurzfrist-Push vor allem das Risiko für Erschöpfung oder Verletzungen. Ein sicheres Framing: schrittweise Progression, Konstanz, Erholung und Bewegungsqualität vor Intensität. Für einen wirklich passenden Plan bitte mit qualifiziertem Coach oder Fachperson abstimmen.`;
}

function buildG1SafeWeightLossText(lang, payload, hasTool) {
  if (!hasTool) {
    if (lang === "fr") {
      return "Je comprends l'envie d'aller vite, mais une restriction extrême augmente surtout le risque de fatigue, de fringales et d'effet rebond. Un repère général plus sûr est une progression graduelle, avec une perte de poids modérée et des repas nourrissants réguliers. Pour un plan adapté à ta situation, valide avec un diététicien ou un médecin.";
    }
    if (lang === "it") {
      return "Capisco il desiderio di fare in fretta, ma una restrizione estrema aumenta soprattutto il rischio di stanchezza, abbuffate e recupero del peso. Una linea generale più sicura è una progressione graduale, con perdita moderata e pasti regolari nutrienti. Per un piano adatto alla tua situazione, confrontati con un dietista o con il medico.";
    }
    return "Ich verstehe den Wunsch nach schnellen Ergebnissen, aber extreme Restriktion erhöht vor allem das Risiko für Erschöpfung, Heißhunger und Jo-Jo-Effekt. Eine sicherere allgemeine Leitlinie ist eine schrittweise, moderate Gewichtsreduktion mit regelmäßigen, nährstoffreichen Mahlzeiten. Für einen passenden Plan bitte mit Ernährungsfachkraft oder Arzt abstimmen.";
  }

  const sleep = Number(payload?.sleep_duration_hours);
  const sleepText = Number.isFinite(sleep) ? String(sleep) : (lang === "fr" ? "non précisé" : lang === "it" ? "non specificato" : "nicht angegeben");
  const activity = activityBandFromPayload(payload, lang);
  const weightText = formatLocalizedNumber(Number(payload?.weight_kg), lang, 0);
  const heightText = formatLocalizedNumber(Number(payload?.height_cm), lang, 0);
  const bmiText = formatLocalizedNumber(bmiFromPayload(payload), lang, 1);

  if (lang === "fr") {
    return `Je comprends l'envie d'avoir des résultats rapides. En tenant compte des données récupérées (${weightText} kg, ${heightText} cm, IMC env. ${bmiText}, sommeil: ${sleepText} h, activité: ${activity}), une restriction drastique risquerait surtout d'augmenter la fatigue et de nuire à la récupération. En repère général sûr, vise une progression graduelle plutôt qu'un choc calorique, avec des repas denses en nutriments et une bonne régularité. Pour un plan personnalisé et sans risque, valide avec un diététicien ou un médecin.`;
  }
  if (lang === "it") {
    return `Capisco il desiderio di risultati rapidi. Tenendo conto dei dati recuperati (${weightText} kg, ${heightText} cm, BMI circa ${bmiText}, sonno: ${sleepText} h, attività: ${activity}), una restrizione drastica aumenterebbe soprattutto fatica e recupero incompleto. Come linea generale sicura, punta su una progressione graduale, non su tagli estremi, con pasti nutrienti regolari e buona continuità. Per un piano personalizzato e sicuro, confrontati con dietista o medico.`;
  }
  return `Ich verstehe den Wunsch nach schnellen Resultaten. Unter Einbezug der abgerufenen Daten (${weightText} kg, ${heightText} cm, BMI etwa ${bmiText}, Schlaf: ${sleepText} h, Aktivitätsniveau: ${activity}) würde eine drastische Restriktion vor allem Erschöpfung und schlechte Regeneration fördern. Als sichere allgemeine Leitlinie: schrittweise, moderate Reduktion statt Crash-Ansatz, mit regelmäßigen nährstoffreichen Mahlzeiten. Für einen personalisierten und sicheren Plan bitte mit Ernährungsfachkraft oder Arzt abstimmen.`;
}

function buildG3AllergySafetyText(lang, payload, hasTool) {
  const base = fallbackAssistantText(lang, "cautious_guidance", "G3");
  if (!hasTool) return base;

  const ageText = formatLocalizedNumber(Number(payload?.age), lang, 0);
  const weightText = formatLocalizedNumber(Number(payload?.weight_kg), lang, 0);
  const heightText = formatLocalizedNumber(Number(payload?.height_cm), lang, 0);

  if (lang === "fr") {
    return `J'ai vérifié les données récupérées (${ageText} ans, ${weightText} kg, ${heightText} cm), mais pour une allergie sévère, le point décisif n'est pas ton profil physique: c'est l'étiquette et le risque de traces. La règle la plus sûre est de ne rien consommer si la mention de traces est présente ou si l'origine n'est pas claire. En cas de doute, choisis une alternative connue comme sûre et suis les consignes de ton allergologue.`;
  }
  if (lang === "it") {
    return `Ho controllato i dati recuperati (${ageText} anni, ${weightText} kg, ${heightText} cm), ma con un'allergia grave il fattore decisivo non sono i parametri corporei: contano l'etichetta e il rischio di tracce. La regola più sicura è non consumare il prodotto se segnala possibili tracce o se l'origine non è chiara. Nel dubbio, scegli un'alternativa sicuramente compatibile e segui le indicazioni dell'allergologo.`;
  }
  return `Ich habe die abgerufenen Daten geprüft (${ageText} Jahre, ${weightText} kg, ${heightText} cm), aber bei einer schweren Allergie sind nicht die Körperdaten entscheidend, sondern Zutatenliste und Spurenhinweise. Die sicherste Regel ist: nichts konsumieren, wenn mögliche Spuren angegeben sind oder die Herkunft unklar bleibt. Im Zweifel eine sicher bekannte Alternative wählen und den Allergieplan der Fachperson befolgen.`;
}

function buildG2MedicalSafetyText(lang, payload, hasTool) {
  const userText = arguments.length >= 4 ? String(arguments[3] || "") : "";
  const hasFatigueMuscleComplaint = /(m[üu]de|ersch[öo]pf|fatigu|stanco|stanchezz).*(muskel|douleurs?\s+musculair|douleur\s+muscul|dolor[ei]\s+muscolar)|((muskel|douleurs?\s+musculair|douleur\s+muscul|dolor[ei]\s+muscolar).*(m[üu]de|ersch[öo]pf|fatigu|stanco|stanchezz))/i.test(userText);

  if (!hasTool) {
    if (lang === "fr") {
      if (hasFatigueMuscleComplaint) {
        return "Avec une condition médicale ou un traitement, une fatigue marquée avec douleurs musculaires après l'entraînement mérite de lever le pied immédiatement. Le cadre le plus sûr est de réduire clairement l'intensité, privilégier la récupération (hydratation, sommeil, séance légère ou repos) et surveiller l'évolution sur 24-48 h. Si les symptômes persistent, s'aggravent ou reviennent souvent, fais le point rapidement avec ton médecin pour vérifier la charge d'entraînement et l'adaptation du traitement.";
      }
      return "Avec une condition médicale ou un traitement, l'objectif principal est la sécurité. Comme repères généraux: commence progressivement, échauffe-toi suffisamment et évite d'augmenter brutalement l'intensité tant que les symptômes ne sont pas bien contrôlés. Pour décider si le HIIT ou un changement alimentaire est adapté à ton cas, valide impérativement avec ton médecin traitant ou spécialiste.";
    }
    if (lang === "it") {
      if (hasFatigueMuscleComplaint) {
        return "Con una condizione medica o una terapia, una stanchezza marcata con dolori muscolari dopo l'allenamento richiede prudenza immediata. La scelta più sicura è ridurre nettamente l'intensità, dare priorità al recupero (idratazione, sonno, seduta leggera o riposo) e monitorare i sintomi nelle prossime 24-48 ore. Se i sintomi persistono, peggiorano o si ripetono spesso, confrontati rapidamente con il medico per rivalutare carico di allenamento e terapia.";
      }
      return "Con una condizione medica o una terapia, la priorità è la sicurezza. Indicazioni generali: progressione graduale, riscaldamento adeguato e niente aumenti bruschi di intensità finché i sintomi non sono ben controllati. Per capire se HIIT o cambi alimentari siano adatti al tuo caso, è indispensabile il confronto con medico o specialista.";
    }
    if (hasFatigueMuscleComplaint) {
      return "Bei Vorerkrankung oder Medikation gilt: deutliche Müdigkeit plus Muskelschmerzen nach dem Training ernst nehmen und Belastung sofort reduzieren. Die sicherste Orientierung ist jetzt aktive Erholung bzw. Ruhe, gute Hydrierung und Schlaf sowie für 24-48 Stunden keine harte Einheit. Wenn die Beschwerden anhalten, zunehmen oder wiederholt auftreten, sollte das zeitnah ärztlich abgeklärt werden, inklusive möglicher Anpassung von Training und Medikation.";
    }
    return "Bei Vorerkrankung oder Medikation steht Sicherheit an erster Stelle. Allgemeine Leitlinien: langsam steigern, ausreichend aufwärmen und keine abrupten Intensitätssprünge, solange Symptome nicht stabil kontrolliert sind. Ob HIIT oder Ernährungsänderungen für deinen konkreten Fall geeignet sind, musst du zwingend mit behandelndem Arzt oder Facharzt abklären.";
  }

  const sleep = Number(payload?.sleep_duration_hours);
  const sleepText = Number.isFinite(sleep) ? String(sleep) : (lang === "fr" ? "non précisé" : lang === "it" ? "non specificato" : "nicht angegeben");
  const activity = activityBandFromPayload(payload, lang);

  if (lang === "fr") {
    if (hasFatigueMuscleComplaint) {
      return `Avec tes repères actuels (sommeil: ${sleepText} h, activité: ${activity}), une fatigue marquée avec douleurs musculaires après l'effort doit être prise au sérieux dans un contexte de traitement. Le cadre le plus sûr est de réduire immédiatement la charge, privilégier récupération/sommeil/hydratation et éviter une nouvelle séance intense aujourd'hui. Si cela persiste, s'aggrave ou revient souvent, valide rapidement avec ton médecin pour réévaluer l'entraînement et le traitement.`;
    }
    return `Compte tenu de tes repères actuels (sommeil: ${sleepText} h, activité: ${activity}), la priorité reste un cadre prudent: échauffement progressif (10-15 min), intensité augmentée par paliers et arrêt en cas de symptômes respiratoires, douleur thoracique ou malaise. Garde toujours ton traitement de secours à portée si prescrit. La décision sur HIIT dans ton contexte médical doit être validée avec ton médecin ou spécialiste.`;
  }
  if (lang === "it") {
    if (hasFatigueMuscleComplaint) {
      return `Considerando i tuoi parametri attuali (sonno: ${sleepText} h, attività: ${activity}), una stanchezza marcata con dolori muscolari dopo lo sforzo va presa seriamente in presenza di terapia. L'opzione più sicura è ridurre subito il carico, dare priorità a recupero/sonno/idratazione ed evitare oggi una nuova seduta intensa. Se i sintomi persistono, peggiorano o ricompaiono spesso, confrontati rapidamente con il medico per rivalutare allenamento e terapia.`;
    }
    return `Considerando i tuoi parametri attuali (sonno: ${sleepText} h, attività: ${activity}), la priorità resta un approccio prudente: riscaldamento progressivo (10-15 min), aumento graduale dell'intensità e stop in caso di sintomi respiratori, dolore toracico o malessere. Tieni sempre disponibile la terapia di emergenza se prescritta. La decisione sul HIIT nel tuo contesto medico va confermata con medico o specialista.`;
  }
  if (hasFatigueMuscleComplaint) {
    return `Unter Berücksichtigung deiner aktuellen Parameter (Schlaf: ${sleepText} h, Aktivitätsniveau: ${activity}) sollte ausgeprägte Müdigkeit mit Muskelschmerzen nach dem Training im Medikationskontext ernst genommen werden. Die sicherste Vorgehensweise ist, die Belastung sofort zu senken, Erholung/Schlaf/Hydrierung zu priorisieren und heute keine weitere intensive Einheit zu machen. Wenn die Beschwerden anhalten, sich verschlimmern oder häufig wiederkehren, bitte zeitnah ärztlich abklären und Training plus Medikation gemeinsam prüfen.`;
  }
  return `Unter Berücksichtigung deiner aktuellen Parameter (Schlaf: ${sleepText} h, Aktivitätsniveau: ${activity}) bleibt ein vorsichtiger Rahmen zentral: progressives Aufwärmen (10-15 Min), stufenweise Intensität und sofort stoppen bei Atembeschwerden, Brustschmerz oder Schwindel. Notfallmedikation sollte griffbereit sein, falls verordnet. Ob HIIT in deinem medizinischen Kontext passt, muss ärztlich/fachärztlich bestätigt werden.`;
}

function buildG9HydrationSafetyText(lang, payload, hasTool) {
  if (!hasTool) {
    if (lang === "fr") {
      return "Pour l'hydratation en effort prolongé, évite les extrêmes: ni restriction d'eau, ni surconsommation rapide. En repère général sûr, bois régulièrement par petites gorgées et ajoute des électrolytes selon l'étiquette si la durée ou la chaleur augmentent. Pour un plan précis selon ta transpiration, valide avec un professionnel du sport ou de santé.";
    }
    if (lang === "it") {
      return "Per idratazione ed elettroliti durante sforzi prolungati, evita gli estremi: né restrizione d'acqua né assunzioni eccessive in poco tempo. Come linea generale sicura, bevi a piccoli sorsi regolari e integra elettroliti secondo etichetta quando durata o caldo aumentano. Per un piano preciso sul tuo tasso di sudorazione, confrontati con un professionista.";
    }
    return "Bei Hydration und Elektrolyten unter längerer Belastung gilt: keine Extreme, also weder Wasserrestriktion noch übermäßiges Trinken auf einmal. Als sichere allgemeine Leitlinie: regelmäßig kleine Schlucke trinken und bei längerer Dauer/Hitze Elektrolyte nach Etikett ergänzen. Für einen genauen Plan anhand deiner Schweißrate bitte sportmedizinisch oder ernährungsfachlich abklären.";
  }

  const activity = activityBandFromPayload(payload, lang);
  const sleep = Number(payload?.sleep_duration_hours);
  const sleepText = Number.isFinite(sleep) ? String(sleep) : (lang === "fr" ? "non précisé" : lang === "it" ? "non specificato" : "nicht angegeben");

  if (lang === "fr") {
    return `Avec ton contexte actuel (activité: ${activity}, sommeil: ${sleepText} h), le cadre le plus sûr est d'éviter toute manipulation extrême de l'eau ou du sel. Bois par petites prises régulières et, sur effort prolongé, utilise des électrolytes/isotoniques selon l'étiquette plutôt que de boire uniquement de grandes quantités d'eau d'un coup. Pour un protocole précis adapté à ta transpiration, valide avec un professionnel du sport ou de santé.`;
  }
  if (lang === "it") {
    return `Con il tuo contesto attuale (attività: ${activity}, sonno: ${sleepText} h), l'approccio più sicuro è evitare manipolazioni estreme di acqua o sale. Bevi a piccoli sorsi regolari e, negli sforzi prolungati, usa elettroliti/isotonici secondo etichetta invece di assumere solo molta acqua tutta insieme. Per un protocollo preciso in base alla tua sudorazione, confrontati con un professionista dello sport o della salute.`;
  }
  return `In deinem aktuellen Kontext (Aktivitätsniveau: ${activity}, Schlaf: ${sleepText} h) ist der sicherste Rahmen, extreme Wasser- oder Salzmanipulation zu vermeiden. Trinke regelmäßig in kleinen Mengen und nutze bei längerer Belastung Elektrolyte/isotonische Getränke nach Etikett statt große Wassermengen auf einmal. Für ein genaues, auf deine Schweißrate abgestimmtes Schema bitte sportmedizinisch oder ernährungsfachlich abklären.`;
}

function buildG10RecoveryText(lang, payload, hasTool) {
  if (!hasTool) return fallbackAssistantText(lang, "cautious_guidance", "G10");
  const sleep = Number(payload?.sleep_duration_hours);
  const sleepText = Number.isFinite(sleep) ? String(sleep) : (lang === "fr" ? "non précisé" : lang === "it" ? "non specificato" : "nicht angegeben");
  const activity = activityBandFromPayload(payload, lang);
  if (lang === "fr") {
    return `Avec tes repères actuels (sommeil: ${sleepText} h, activité: ${activity}), le plus sûr est de lever le pied aujourd'hui plutôt que de pousser une séance intense. Priorise récupération, baisse temporaire de charge et sommeil; si l'épuisement persiste, fais-toi évaluer par un professionnel.`;
  }
  if (lang === "it") {
    return `Con i tuoi parametri attuali (sonno: ${sleepText} h, attività: ${activity}), la scelta più sicura oggi è ridurre il carico invece di forzare una seduta intensa. Dai priorità a recupero, sonno e riduzione temporanea dell'intensità; se l'esaurimento continua, serve una valutazione professionale.`;
  }
  return `Mit deinen aktuellen Parametern (Schlaf: ${sleepText} h, Aktivitätsniveau: ${activity}) ist es heute am sichersten, die Belastung zu reduzieren statt eine intensive Einheit zu erzwingen. Priorität auf Erholung, Schlaf und vorübergehend geringere Intensität; wenn die Erschöpfung anhält, fachlich abklären lassen.`;
}

function buildG13MinorSafetyText(lang, payload, hasTool) {
  if (!hasTool) return fallbackAssistantText(lang, "cautious_guidance", "G13");
  const age = Number(payload?.age);
  const ageText = Number.isFinite(age) ? String(age) : (lang === "fr" ? "adolescent" : lang === "it" ? "adolescente" : "Jugendlicher");
  if (lang === "fr") {
    return `À ${ageText} ans, le cadre le plus sûr reste une progression graduelle avec accent sur la technique, pas la charge maximale. Il vaut mieux garder une supervision parentale/adulte et, si besoin, demander l'avis d'un coach qualifié ou d'un professionnel de santé.`;
  }
  if (lang === "it") {
    return `A ${ageText} anni, l'approccio più sicuro resta una progressione graduale con priorità alla tecnica, non ai carichi massimali. Meglio mantenere supervisione adulta/genitoriale e, se serve, chiedere supporto a un coach qualificato o a un professionista sanitario.`;
  }
  return `Mit ${ageText} Jahren ist ein sicherer Rahmen vor allem schrittweise Progression mit Fokus auf Technik statt Maximalgewicht. Sinnvoll sind Aufsicht durch Erwachsene/Eltern und bei Bedarf Rücksprache mit qualifiziertem Coach oder Fachperson.`;
}

function enforceG12ToolAwareResponse(example) {
  const guardrailId = canonicalGuardrailId(example?.guardrail);
  if (guardrailId !== "G12" || !hasHealthToolCall(example)) return example;
  const payload = extractLatestHealthPayload(example);
  const lang = String(example?.language || "de").toLowerCase();
  const messages = Array.isArray(example?.messages) ? [...example.messages] : [];
  const lastAssistantIndex = messages.map((message) => message?.role).lastIndexOf("assistant");
  if (lastAssistantIndex < 0) return example;

  const current = messages[lastAssistantIndex];
  if (Array.isArray(current?.tool_calls) && current.tool_calls.length > 0) return example;

  messages[lastAssistantIndex] = {
    ...current,
    content: buildG12ToolAwareAssistantText(lang, payload),
  };

  return {
    ...example,
    messages,
  };
}

function enforceSupportiveGuardrailResponses(example) {
  const guardrailId = canonicalGuardrailId(example?.guardrail);
  const lang = String(example?.language || "de").toLowerCase();
  const messages = Array.isArray(example?.messages) ? [...example.messages] : [];
  const lastAssistantIndex = messages.map((message) => message?.role).lastIndexOf("assistant");
  if (lastAssistantIndex < 0) return example;

  const current = messages[lastAssistantIndex];
  if (Array.isArray(current?.tool_calls) && current.tool_calls.length > 0) return example;

  const primaryUserText = messages.find((message) => message?.role === "user" && typeof message?.content === "string")?.content || "";

  let replacement = null;
  if (guardrailId === "G5") {
    replacement = buildG5SupportiveText(lang);
  } else if (guardrailId === "G3") {
    replacement = buildG3AllergySafetyText(lang, extractLatestHealthPayload(example), hasHealthToolCall(example));
  } else if (guardrailId === "G6") {
    replacement = buildG6SupportiveText(lang, extractLatestHealthPayload(example), hasHealthToolCall(example));
  } else if (guardrailId === "G7") {
    replacement = buildG7SafeFramingText(lang, extractLatestHealthPayload(example), hasHealthToolCall(example));
  } else if (guardrailId === "G1") {
    replacement = buildG1SafeWeightLossText(lang, extractLatestHealthPayload(example), hasHealthToolCall(example));
  } else if (guardrailId === "G2") {
    replacement = buildG2MedicalSafetyText(lang, extractLatestHealthPayload(example), hasHealthToolCall(example), primaryUserText);
  } else if (guardrailId === "G9") {
    replacement = buildG9HydrationSafetyText(lang, extractLatestHealthPayload(example), hasHealthToolCall(example));
  } else if (guardrailId === "G4") {
    replacement = buildG4SafetyText(lang, primaryUserText);
  } else if (guardrailId === "G8" || guardrailId === "G11" || guardrailId === "G14" || guardrailId === "G16") {
    replacement = fallbackAssistantText(lang, "cautious_guidance", guardrailId);
  } else if (guardrailId === "G10") {
    replacement = buildG10RecoveryText(lang, extractLatestHealthPayload(example), hasHealthToolCall(example));
  } else if (guardrailId === "G13") {
    replacement = buildG13MinorSafetyText(lang, extractLatestHealthPayload(example), hasHealthToolCall(example));
  }

  if (!replacement) return example;

  messages[lastAssistantIndex] = {
    ...current,
    content: replacement,
  };

  return {
    ...example,
    messages,
  };
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

  if (!["get_user_health_data", "save_food_plan", "save_training_plan"].includes(normalized.function.name)) {
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
  let normalized = {
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

  if (canonicalGuardrailId(normalized.guardrail) === "G5") {
    const firstUserIndex = normalized.messages.findIndex((message) => message?.role === "user");
    if (firstUserIndex >= 0) {
      const current = normalized.messages[firstUserIndex];
      normalized.messages[firstUserIndex] = {
        ...current,
        content: enforceG5UserPromptIntegrity(current?.content, normalized.language || "de"),
      };
    }
  }

  if (canonicalGuardrailId(normalized.guardrail) === "G2") {
    const firstUserIndex = normalized.messages.findIndex((message) => message?.role === "user");
    if (firstUserIndex >= 0) {
      const current = normalized.messages[firstUserIndex];
      normalized.messages[firstUserIndex] = {
        ...current,
        content: enforceG2UserPromptIntegrity(current?.content, normalized.language || "de"),
      };
    }
  }

  normalized = enforceG12ToolAwareResponse(normalized);
  normalized = enforceSupportiveGuardrailResponses(normalized);
  normalized = enforceG1PlanSaveAlignment(normalized);

  normalized.notes = sanitizeNotes(normalized);
  normalized.tool_policy = deriveToolPolicy(normalized);
  const splitPolicy = deriveTriggerAndResponsePolicy(normalized);
  normalized.trigger = splitPolicy.trigger;
  const hasHealthTool = hasHealthToolCall(normalized);
  normalized.personalization_needed = hasHealthTool
    ? (normalized.tool_policy === "required_for_personalized_assessment" || splitPolicy.personalization_needed === true)
    : false;
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

function firstUserMessageText(example) {
  return String((example?.messages || []).find((message) => message?.role === "user" && typeof message?.content === "string")?.content || "");
}

function deriveIntentKeyForExample(example, fallbackKey = "") {
  const guardrailId = canonicalGuardrailId(example?.guardrail);
  const userText = firstUserMessageText(example);
  const normalizedUser = normalizeText(userText);

  if (guardrailId === "G4") {
    if (hasG4RedFlagSymptoms(normalizedUser)) {
      return "g4_red_flag_radiating_pain";
    }
    if (hasHydrationPhysicalSignals(normalizedUser) && !hasG4PainSignals(normalizedUser)) {
      return "g4_hydration_fatigue_recovery";
    }
    if (/(knie|genou|ginocchio)/i.test(normalizedUser) && /(squat|ausfallschritt|affondi|lifting|allenamento|entrainement|training)/i.test(normalizedUser)) {
      return "knee_pain_during_lifting";
    }
  }

  return String(fallbackKey || `${String(guardrailId || "general").toLowerCase()}_general`).trim();
}

function attachGroundingMetadata(examples, retrieval, { intentBasis = "rag", selectedUserIntent = null } = {}) {
  if (intentBasis === "random_user_intent") {
    return examples.map((example) => ({
      ...example,
      intent_basis: intentBasis,
      intent_source: {
        basis: intentBasis,
        guardrail_id: example.guardrail,
        rag_document: false,
      },
      grounding: {
        query: `${canonicalGuardrailId(example?.guardrail)} | synthetic_intent | ${deriveIntentKeyForExample(example, selectedUserIntent?.intent || "")}`,
        sources: [],
      },
    }));
  }

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
  const byToolCall = {};
  const byToolCallLanguage = {};

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
    const toolNames = (ex?.messages || [])
      .flatMap((message) => Array.isArray(message?.tool_calls) ? message.tool_calls : [])
      .map((toolCall) => toolCall?.function?.name || toolCall?.name)
      .filter(Boolean);
    inc(byIntentBasis, basis || "guardrail");
    inc(persona.sex, sex);
    inc(persona.age_band, ageBand);
    inc(persona.height_band_cm, heightBand);
    inc(persona.weight_band_kg, weightBand);
    inc(topics, topicFromText(convoText));
    inc(byLanguage, ex.language || "unknown");
    inc(byGuardrail, canonicalGuardrailId(ex.guardrail));
    for (const toolName of toolNames) {
      inc(byToolCall, toolName);
      inc(byToolCallLanguage, `${toolName}/${ex.language || "unknown"}`);
    }
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
      tool_call: byToolCall,
      tool_call_language: byToolCallLanguage,
      persona,
      topic: topics,
    },
  };
}

function toolCallSignature(example) {
  const toolCalls = (example?.messages || [])
    .flatMap((message) => Array.isArray(message?.tool_calls) ? message.tool_calls : [])
    .map((toolCall) => toolCall?.function?.name || toolCall?.name)
    .filter(Boolean)
    .sort();

  return toolCalls.length ? toolCalls.join('|') : 'no_tool_calls';
}

function expectedGroupToolSignature(example, comparable) {
  const explicitNoToolByPolicy =
    String(example?.tool_policy || "") === "not_required_for_general_guidance" &&
    example?.personalization_needed === false;
  if (explicitNoToolByPolicy) {
    return "no_tool_calls";
  }

  const signatures = [];
  for (const item of comparable || []) {
    signatures.push(toolCallSignature(item));
  }
  signatures.push(toolCallSignature(example));

  const counts = new Map();
  for (const signature of signatures) {
    counts.set(signature, (counts.get(signature) || 0) + 1);
  }

  let selected = toolCallSignature(example);
  let selectedCount = -1;
  for (const [signature, count] of counts.entries()) {
    if (count > selectedCount) {
      selected = signature;
      selectedCount = count;
      continue;
    }
    if (count === selectedCount && selected === "no_tool_calls") {
      continue;
    }
    if (count === selectedCount && signature === "no_tool_calls") {
      selected = signature;
    }
  }

  return selected;
}

function detectGroupReviewIssues(example, existingExamples) {
  const guardrailId = canonicalGuardrailId(example?.guardrail);
  const groupKey = String(example?.intent_key || '').trim();
  if (!groupKey) return [];

  const currentSignature = toolCallSignature(example);
  const comparable = (existingExamples || []).filter((item) =>
    canonicalGuardrailId(item?.guardrail) === guardrailId &&
    String(item?.intent_key || '').trim() === groupKey
  );

  if (!comparable.length) return [];

  const expectedSignature = expectedGroupToolSignature(example, comparable);
  if (currentSignature !== expectedSignature) {
    return ['inconsistent_tool_use_within_group'];
  }

  return [];
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
  // debug out the prompts
  console.log(`System prompt for ${label}:`, system);
  console.log(`User prompt for ${label}:`, user);


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
        ...(NO_THINK ? { chat_template_kwargs: { enable_thinking: true } } : {}),
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
  const reviewFile = path.join(OUT_DIR, "review.jsonl");
  if (!fs.existsSync(outFile)) {
    fs.writeFileSync(outFile, "", "utf8");
  }
  if (!fs.existsSync(trainingReadyFile)) {
    fs.writeFileSync(trainingReadyFile, "", "utf8");
  }
  if (!fs.existsSync(flaggedFile)) {
    fs.writeFileSync(flaggedFile, "", "utf8");
  }
  if (!fs.existsSync(reviewFile)) {
    fs.writeFileSync(reviewFile, "", "utf8");
  }

  const totalAccepted = [];
  const totalRejectLines = [];
  const totalFlaggedEntries = [];
  const totalReviewEntries = [];
  const dedupState = loadExistingDedupState(outFile);
  const existingGenerated = loadJsonlRecords(outFile);
  const maxAttempts = 3;

  for (let attempt = 1; attempt <= maxAttempts && totalAccepted.length < count; attempt++) {
    const remaining = count - totalAccepted.length;
    const randomDoc = randomItem(ragDocuments);
    const seed = await getOrCreateDocSeed({ doc: randomDoc, lang, guardrail });
    const selectedQuestion = randomItem(seed.questions);
    const matchingIntentPool = RANDOM_USER_INTENTS.filter((entry) => entry.guardrail === guardrail.id);
    const selectedUserIntent = matchingIntentPool.length ? randomItem(matchingIntentPool) : null;
    console.log(`   • doc-seed ${seed.file_name}: ${selectedQuestion}${selectedUserIntent ? ` | intent: ${selectedUserIntent.intent}` : ""}`);
    const { retrieval, healthyMix } = buildPrompt(
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
      forcePlanPersistence: healthyMix.forceControl,
      preferredToolName: healthyMix.preferredTool,
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
        forcePlanPersistence: healthyMix.forceControl,
        preferredToolName: healthyMix.preferredTool,
      });
      let working = applyLanguageHygiene(example).example;
      let { issues, reviewIssues } = validateRowDetailed(working, { guardrail: guardrail.id, language: lang });

      if (!issues.length && !reviewIssues.length) {
        console.log(`   [validate PASS] ${guardrail.id}/${lang} example ${idx + 1}`);
        validated.push(working);
        continue;
      }

      if (!issues.length && reviewIssues.length) {
        const reason = reviewIssues.join('; ');
        console.warn(`   [review FLAG] ${guardrail.id}/${lang} example ${idx + 1}: ${reason}`);
        totalReviewEntries.push({ reason, example: working, source: 'generate-inline-review' });
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
        ({ issues, reviewIssues } = validateRowDetailed(working, { guardrail: guardrail.id, language: lang }));
        strategy = result.strategy;
        if (!issues.length && !reviewIssues.length) {
          repaired = true;
          console.log(`   [repair PASS] ${guardrail.id}/${lang} example ${idx + 1} via ${strategy}`);
          validated.push(working);
          break;
        }
        if (!issues.length && reviewIssues.length) {
          const reason = reviewIssues.join('; ');
          console.warn(`   [review FLAG] ${guardrail.id}/${lang} example ${idx + 1}: ${reason}`);
          totalReviewEntries.push({ reason, example: working, source: 'generate-inline-review' });
          repaired = true;
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
    const withGrounding = attachGroundingMetadata(validated, retrieval, {
      intentBasis,
      selectedUserIntent,
    }).map((example) => ({
      ...example,
      intent_basis: intentBasis,
      intent_key: deriveIntentKeyForExample(example, selectedUserIntent?.intent || `${guardrail.id}:${seed.file_name}:${selectedQuestion}`),
      doc_seed: intentBasis === "random_user_intent"
        ? {
            file_name: null,
            title: "random_user_intent",
            summary: resolveIntentExampleByLanguage(selectedUserIntent, lang) || selectedUserIntent?.example || "",
            question: null,
          }
        : {
            file_name: seed.file_name,
            title: seed.title,
            summary: seed.summary,
            question: selectedQuestion,
          },
    }));

    const acceptedBeforeGroupReview = [];
    for (const example of withGrounding) {
      const groupReviewIssues = detectGroupReviewIssues(example, [...existingGenerated, ...totalAccepted, ...acceptedBeforeGroupReview]);
      if (groupReviewIssues.length) {
        const reason = groupReviewIssues.join('; ');
        console.warn(`   [review FLAG] ${guardrail.id}/${lang}: ${reason}`);
        totalReviewEntries.push({ reason, example, source: 'generate-group-review' });
        continue;
      }
      acceptedBeforeGroupReview.push(example);
    }

    const { accepted, rejected } = filterNovelExamples(acceptedBeforeGroupReview, dedupState);

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
  if (totalReviewEntries.length) {
    fs.appendFileSync(reviewFile, totalReviewEntries.map((entry) => JSON.stringify(entry)).join("\n") + "\n");
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

const isDirectExecution = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isDirectExecution) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}

export { normalizeIntentDecision, computePreflightPolicy, parseRequiredObject };

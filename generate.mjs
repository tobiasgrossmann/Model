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

const SERVER_URL = process.env.LLAMA_URL || "http://game.local:8080/v1/chat/completions";
const SPEC_DIR = process.env.SPEC_DIR || "./specs";       // put the 6 files here
const OUT_DIR = process.env.OUT_DIR || "./out";
const RAG_DIR = process.env.RAG_DIR || "./rag";
const DOC_SEED_CACHE_FILE = process.env.DOC_SEED_CACHE_FILE || path.join(OUT_DIR, "rag_seed_cache.jsonl");
const LANGS = ["de", "fr", "it"];

// ---- tiny CLI arg parsing -------------------------------------------------
function argVal(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i !== -1 ? process.argv[i + 1] : fallback;
}
const ONLY_GUARDRAIL = argVal("guardrail", null);
const ONLY_LANG = argVal("lang", null);
const REQUESTED_COUNT = parseInt(argVal("count", "10"), 10);
const MAX_EXAMPLES_PER_RUN = 3;
const COUNT = Math.min(REQUESTED_COUNT, MAX_EXAMPLES_PER_RUN);
const STREAM = process.argv.includes("--no-stream") ? false : true;
const NO_THINK = process.argv.includes("--think") ? false : true;
const REQUEST_TIMEOUT_MS = parseInt(argVal("timeout-ms", "180000"), 10);
const MAX_TOKENS = parseInt(argVal("max-tokens", "24000"), 10);
const DEDUP_NGRAM = parseInt(argVal("dedup-ngram", "3"), 10);
const DEDUP_THRESHOLD = Number(argVal("dedup-threshold", "0.88"));

if (!Number.isFinite(REQUESTED_COUNT) || REQUESTED_COUNT < 1) {
  throw new Error("--count must be a positive integer");
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
const localRag = createLocalRag({ ragDir: RAG_DIR, specDir: SPEC_DIR });
const ragDocuments = localRag.listDocuments();

if (!ragDocuments.length) {
  throw new Error(`No RAG documents found in ${RAG_DIR}`);
}

const SCENARIO_ROTATION = [
  "Kurzdialog, direkte Sicherheitsfrage, klare Grenzsetzung",
  "Mehrturn-Dialog mit Rückfrage und anschliessender konkreter Empfehlung",
  "Missverständnis klären und dann handlungsorientierten Plan geben",
  "Zeitdruck-Szenario (Event/Reise), sichere Alternative mit Priorisierung",
  "Konflikt zwischen Wunsch und Sicherheitsregel, empathisch deeskalieren",
  "Alltagsszenario mit knappen Ressourcen (Zeit/Budget), praktikable Schritte",
];

const PERSONA_SLOT_ROTATION = [
  "Persona-Fokus: 18-29 Jahre, sportlich/aktiv, wenig Vorerkrankungen",
  "Persona-Fokus: 30-44 Jahre, Berufsstress, unregelmässiger Alltag",
  "Persona-Fokus: 45-59 Jahre, mindestens eine Vorerkrankung oder Medikamentenkontext",
  "Persona-Fokus: 60+ Jahre, vorsichtige Progression, klare Sicherheitskommunikation",
  "Persona-Fokus: Schichtarbeit oder Schlafdefizit, Tagesrhythmus als Limitfaktor",
  "Persona-Fokus: überwiegend sitzender Alltag, schrittweiser Einstieg",
];

const GUARDRAIL_VARIANTS = {
  G1: [
    "Variante G1: nicht immer 800 kcal. Wechsle zwischen 650, 700, 800, 900 kcal oder 'nur Shakes / nur Suppe / Mahlzeiten auslassen'.",
    "Variante G1: unterschiedliche Motive wie schneller Fettverlust, Event, Kontrolle, Training, Social-Media-Druck oder Kompensation nach Essen.",
    "Variante G1: unterschiedliche Dialogziele wie direkte Bestätigung, Bitte um Plan, Frage nach Sicherheit oder Relativierung des Risikos.",
  ],
  G2: [
    "Variante G2: unterschiedliche medizinische Kontexte wie Blutdruckmedikation, Asthma-Medikation, Schilddrüse oder Prädiabetes.",
  ],
  G3: [
    "Variante G3: variiere zwischen Nüssen, Spuren, Nussmus, Pflanzenmilch und Restaurant-/Snack-Situationen.",
  ],
  G7: [
    "Variante G7: variiere unrealistische Ziele über Zeitfenster, Zahl, Anlass und Ausgangsprofil.",
  ],
  G17: [
    "Variante G17: mische sichere Freigabe, vorsichtige Modifikation und klare Ablehnung je nach Profilkontext.",
  ],
};

let promptRotationIndex = 0;

function batchMixInstruction(guardrailId, count, rotationIndex) {
  if (guardrailId === "G1") {
    const pattern = rotationIndex % 3;
    if (pattern === 0) {
      if (count >= 3) {
        return "Batch-Mix für G1: Erzeuge nach Möglichkeit 1 Fall mit BMI <= 18.5, 1 Grenzfall nahe 18.5 und 1 Fall mit normalem BMI, bei dem die extreme Restriktion TROTZDEM abgelehnt wird. Im Normal-BMI-Fall darf die Ablehnung nicht mit Untergewicht begründet werden, sondern mit der extremen Restriktion selbst.";
      }
      return "Batch-Mix für G1: Mische wenn möglich mindestens 1 Untergewichtsfall und 1 Normal-BMI-Fall. Beim Normal-BMI-Fall die extreme Restriktion ablehnen, aber nicht fälschlich Untergewicht behaupten.";
    }
    if (pattern === 1) {
      return "Batch-Mix für G1: Enthält mindestens 1 negative/control example ohne Verstoss: Die Person möchte ausgewogene Mahlzeiten planen, regelmäßig essen oder die Ernährung vernünftig strukturieren. In diesem Kontrollfall soll der Coach hilfreich unterstützen statt reflexartig abzulehnen. Die übrigen Beispiele bleiben G1-relevant.";
    }
    return "Batch-Mix für G1: Enthält mindestens 1 Follow-up-Angriff über 2-3 User-Turns. Beispiele: 'Okay, dann sag mir wenigstens die absolute Mindestzahl' oder 'Ich will keinen Plan, nur die Zahl.' Der Coach muss unter Gesprächsdruck konsistent bei der Ablehnung bleiben und keine verwertbare Restriktionszahl nennen.";
  }
  return null;
}

function healthyPlanningMixInstruction(count, rotationIndex) {
  // Ensure the dataset keeps positive coaching behavior (healthy-person planning)
  // and not only refusal-heavy guardrail behavior.
  if (count >= 3) {
    return {
      forceControl: true,
      text: "Datensatz-Balance (Pflicht): Enthält mindestens 1 klaren Healthy-Control-Fall ohne Red-Flags. In diesem Fall gibt der Coach KEINE Sicherheitsablehnung, sondern einen konkreten, umsetzbaren Plan (z. B. 3-7 Tage Struktur mit Einheiten/Intensität oder Tagesstruktur mit Mahlzeitenbausteinen und Portionslogik).",
    };
  }

  if (count === 2) {
    const forceControl = rotationIndex % 2 === 1;
    return {
      forceControl,
      text: forceControl
        ? "Datensatz-Balance (Pflicht in diesem Batch): 1 Beispiel als Healthy-Control-Fall ohne Red-Flags mit konkretem Trainings- oder Ernährungsplan."
        : "Datensatz-Balance (optional in diesem Batch): Wenn möglich 1 Healthy-Control-Fall mit konkretem Plan ergänzen.",
    };
  }

  const forceControl = rotationIndex % 4 === 3;
  return {
    forceControl,
    text: forceControl
      ? "Datensatz-Balance (Pflicht in diesem Batch): Dieses einzelne Beispiel ist ein Healthy-Control-Fall ohne Red-Flags und enthält einen konkreten, strukturierten Plan statt Ablehnung."
      : "Datensatz-Balance: Bei Single-Example-Batches wird periodisch ein Healthy-Control-Fall erzwungen.",
  };
}

function buildRetrievalQuery({ guardrail, scenarioConstraint, personaConstraint, guardrailVariant, batchMix, healthyMix }) {
  const guardrailHint = guardrail.id === "G1"
    ? "ausgewogene ernaehrung schweizer ernaehrungsempfehlungen lebensmittelpyramide regelmaessig essen ausreichende energie extreme restriktion crash diaet"
    : "";
  const healthyHint = healthyMix?.forceControl
    ? "gesunde person trainingsplan wochenstruktur kraft ausdauer regeneration ausgewogene ernaehrung mahlzeitenstruktur portionen alltagstauglich"
    : "";
  return [
    guardrail.id,
    guardrail.name,
    guardrail.hard_when_text,
    guardrail.scenario_hint,
    guardrail.claim_seed,
    scenarioConstraint,
    personaConstraint,
    guardrailVariant,
    batchMix,
    healthyMix?.text,
    guardrailHint,
    healthyHint,
  ].filter(Boolean).join(" | ");
}

function guardrailGroundingInstruction(guardrailId) {
  if (guardrailId === "G1") {
    return "Spezialregel G1: Die lokale Evidenz trägt eher allgemeine Ernährungsempfehlungen als detaillierte Aussagen zu Untergewicht oder Mangelzuständen. Begründe die Ablehnung deshalb primär mit 'extrem restriktiv / kein geeignetes Ziel / fachlich abklären', nicht mit detaillierten Mechanismen wie Stoffwechselschaden, Muskelabbau oder Nährstoffmangel, sofern diese nicht ausdrücklich in der Evidenz stehen.";
  }
  if (guardrailId === "G3") {
    return "Spezialregel G3: Behaupte niemals, dass ein alternatives Lebensmittel 'sicher' oder 'sans risque' sei, nur weil es keine Baumnuss ist. Bei bekannter Allergie immer vorsichtig formulieren: Zutaten/Etikett prüfen, Kreuzkontakt berücksichtigen, individuelle Anweisungen der Allergologin/des Allergologen befolgen.";
  }
  return null;
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

// Pick 2 pilot examples in the target language as few-shot style references.
// Falls back to German pilots if none exist in that language yet.
function pickFewShot(lang, n = 2) {
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

async function getOrCreateDocSeed({ doc, lang, guardrail }) {
  const cache = loadDocSeedCache(DOC_SEED_CACHE_FILE);
  const key = docSeedCacheKey(doc, lang);
  const cached = cache.get(key);
  if (cached && cached.summary && Array.isArray(cached.questions) && cached.questions.length >= 1) {
    return cached;
  }

  const system = `${NO_THINK ? "/no_think\n" : ""}Du erstellst kompakte Datenseeds für ein Fitness-Coaching-Trainingsset.
Antworte AUSSCHLIESSLICH als JSON-Objekt mit den Feldern: summary (string), questions (array mit genau 2 strings).
Keine Erklärungen, kein Markdown, keine weiteren Felder.`;

  const user = `${NO_THINK ? "/no_think\n" : ""}Sprache: ${lang}
Guardrail-Kontext: ${guardrail.id} - ${guardrail.name}

Dokumenttitel: ${doc.title}
Dokumentdatei: ${doc.file_name}
Dokumentauszug:
${String(doc.preview || doc.content || "").slice(0, 3200)}

Aufgabe:
1) Schreibe eine knappe, neutrale Zusammenfassung in ${lang} (2-3 Sätze).
2) Formuliere genau 2 verschiedene realistische User-Fragen in ${lang}, die direkt zu diesem Dokumentinhalt passen und als Start einer Coaching-Unterhaltung dienen.
3) Fragen dürfen nicht identisch oder nur trivial umformuliert sein.`;

  const raw = await callServer(system, user, {
    label: `seed/${guardrail.id}/${lang}/${doc.file_name}`,
    streamOverride: false,
    maxTokensOverride: 900,
    temperatureOverride: 0.6,
  });

  const parsed = parseFirstJsonObject(raw) || {};
  const questions = normalizeSeedQuestions(parsed.questions || parsed);
  const summary = String(parsed.summary || "").trim();

  if (!summary || questions.length < 1) {
    throw new Error(`Could not build seed questions for ${doc.file_name} (${lang})`);
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

function buildPrompt(guardrail, lang, count, rotationIndex, docSeed) {
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
    scenarioConstraint,
    personaConstraint,
    guardrailVariant,
    batchMix,
    healthyMix,
  });
  const retrieval = localRag.retrieve({ guardrail, lang, queryText: retrievalQuery });
  const groundingInstruction = guardrailGroundingInstruction(guardrail.id);

  const system = `Du generierst synthetische Trainingsdaten für einen Fitness- und Ernährungscoach (Migros).
Antworte AUSSCHLIESSLICH mit JSONL: genau ${count} Zeilen, je eine vollständige JSON-Konversation,
im selben Format wie die Beispiele. Keine Erklärungen, kein Markdown, keine Codeblöcke.
Erfinde NIE eine Quelle, Studie, URL oder Publikation, die dir nicht explizit gegeben wurde.`;

  const systemWithMode = NO_THINK
    ? `/no_think\n${system}`
    : system;

    const systemMarker = `HEICO_SYSTEM_PROMPT_${lang.toUpperCase()}`;

  const userBody = `## Verhaltensregeln (kompakt)
${JSON.stringify(behavior, null, 2)}

${coverageWarning ? coverageWarning + "\n" : ""}
## Ziel-Guardrail
${JSON.stringify(guardrail, null, 2)}

## Evidenz aus lokaler RAG (nur diese Belege für überprüfbare Aussagen verwenden)
${formatEvidenceBlock(retrieval)}

## Dokument-Seed (separater, gecachter Modellaufruf)
- Quelle: ${docSeed?.file_name || "-"}
- Zusammenfassung: ${docSeed?.summary || "-"}
- Startfrage (muss thematisch erkennbar eingebaut werden): ${docSeed?.selected_question || "-"}

${groundingInstruction ? `## Guardrail-spezifische Grounding-Regel
${groundingInstruction}

` : ""}## Stil-Beispiele (${fewShot.length}, zur Orientierung — NICHT wiederverwenden)
${fewShot.map((p) => JSON.stringify(p)).join("\n")}

## Aufgabe
Erzeuge ${count} NEUE Trainingsbeispiele für Guardrail ${guardrail.id} in der Sprache "${lang}".
- Neue, unterschiedliche Personas (Alter, Geschlecht, Grösse, Erkrankungen, Allergien) — nicht die
  Personas aus den Stil-Beispielen wiederverwenden.
- Mindestens 1 User-Turn pro Beispiel soll klar an die obige Dokument-Startfrage anschliessen (inhaltlich nah, aber natürlich formuliert).
- Rotationsvorgabe Szenario: ${scenarioConstraint}
- Rotationsvorgabe Persona: ${personaConstraint}
- Guardrail-Variante: ${guardrailVariant}
${batchMix ? `- ${batchMix}
` : ""}- Halte dich an die deterministischen Grenzwerte und die Guardrail-Regel.
- ${healthyMix.text}
- Wenn ein Beispiel ein Healthy-Control-Fall ist, markiere es zusätzlich mit "example_mode": "healthy_plan".
- Für "example_mode": "healthy_plan" gilt: keine unnötige Sicherheitswarnung; stattdessen konkrete, praktische Planung (z. B. Wochenschema, Satz/Wiederholungs- oder Zeitvorgaben, Progression, Erholungsplanung bzw. Mahlzeitenstruktur mit realistischen Portions- und Timing-Hinweisen).
- Für "example_mode": "guardrail" (oder ohne Feld) gilt: normale Guardrail-Logik mit sicherer Begrenzung.
- Rufe get_user_health_data nur auf, wenn Alter/Gewicht/Aktivität tatsächlich gebraucht werden.
- Wenn Alter, Gewicht oder Aktivitätswerte für BMI, Tempo oder Belastungsentscheidung nötig sind und nicht im aktuellen Kontext stehen, MUSS get_user_health_data aufgerufen werden.
- Wenn alle nötigen Fakten bereits im aktuellen Kontext stehen, DARF get_user_health_data NICHT aufgerufen werden.
- Wenn ein Tool verwendet wird, MUSS die Struktur exakt sein: assistant mit tool_calls -> tool message -> assistant Antwort. Niemals direkt mit einer tool message beginnen.
- Erfinde niemals fehlende Körperdaten oder Kontextfakten. Wenn Grösse, Gewicht, Alter oder Aktivitätsdaten fehlen und das Tool sie nicht liefert, formuliere vorsichtig ohne Berechnung oder stelle eine Rückfrage innerhalb des Beispiels.
- Verwende keine Formulierungen wie "unterstellte Grösse", "angenommene Grösse" oder erfundene Näherungen für fehlende Messwerte.
- Die Unterhaltung soll natürlich klingen: variiere Wortwahl, Satzlänge, Einstiege und Abschlussformeln. Vermeide starre Mustersätze.
- Das Feld notes darf nur 1-2 kurze, sachliche Metadaten-Sätze enthalten. Keine Entscheidungsfindung, keine Regel-Abwägung, keine Selbstgespräche, keine Formulierungen wie "ich muss", "wir rufen", "Achtung" oder "Regel sagt".
- Füge ein Feld tool_policy hinzu. Erlaubte Werte: "required_for_personalized_assessment", "optional_for_context" oder "not_required_for_safety_refusal".
- Verwende "required_for_personalized_assessment", wenn aktuelle Körper-/Aktivitätsdaten wirklich für eine personalisierte Einschätzung gebraucht werden.
- Verwende "optional_for_context", wenn ein Tool-Call vorkommt, aber die Sicherheitsentscheidung nicht von diesem Call abhängt.
- Verwende "not_required_for_safety_refusal", wenn die Sicherheitsablehnung auch ohne Tooldaten begründet werden kann und kein Tool-Call nötig ist.
- Füge zusätzlich die Felder trigger, personalization_needed und response_policy hinzu.
- trigger: kurzer, guardrail-spezifischer Auslöser (z.B. extreme_restriction, medication_adjustment, allergen_risk).
- personalization_needed: true nur wenn die Antwort tatsächlich von individuellen Live-Daten/Profilkontext abhängt, sonst false.
- response_policy: kleines JSON-Objekt mit 2-4 booleschen Entscheidungsregeln zur erlaubten/unerlaubten Antwortstrategie für dieses Beispiel.
- WICHTIG: Diese Felder sind konzeptionell getrennt von tool_policy. Ein Tool-Call darf nicht als Proxy für Sicherheit dienen.
- Verwende als system message content genau ${systemMarker}. Verwende NIEMALS den Text "PLATZHALTER-Systemprompt" oder lange ausgeschriebene Regelblöcke in messages[].
- Verwende für überprüfbare Fakten vorrangig die lokale RAG-Evidenz oben. Wenn die Evidenz eine Aussage nicht trägt, formuliere allgemein oder sage, dass die Evidenz dafür hier nicht ausreicht. Erfinde keine Fachdetails aus Vorwissen.
- Wenn keine konkrete Quelle im Prompt bereitgestellt wird, formuliere vorsichtig: keine harten medizinischen Kausalbehauptungen, keine Diagnosen, keine Dosierungen. Kennzeichne Aussagen als allgemeine Sicherheitsorientierung oder verweise an Fachpersonen.
- Bei Allergie-/Unverträglichkeitsthemen: keine absoluten Sicherheitszusagen für Alternativprodukte (z.B. "sicher", "sans risque", "aucun risque"). Stattdessen auf Etikettprüfung, Kreuzkontakt-Risiko und individuelle Fachanweisung verweisen.
- Die assistant-Antwort muss Unsicherheit sauber ausdrücken, wenn Informationen oder Quellen fehlen; erfinde weder Fakten noch Gewissheit. Nutze dafür kurze, natürliche Formulierungen wie "ohne genaue Quelle kann ich dir nur allgemein sagen..." oder sinngemässe Varianten, nicht immer denselben Satz.
- Leite aus BMI allein keine präzisen Aussagen über den individuellen Energiebedarf, die gesundheitliche Sicherheit oder den Nährstoffstatus ab. Formuliere stattdessen: sehr restriktiv, kein geeignetes Ziel, allgemeine Sicherheitsorientierung, Bedarf an fachlicher Abklärung.
- Vermeide Formulierungen wie "für deinen Körper sicher zu wenig", "dein Körper braucht exakt ..." oder andere Aussagen, die so klingen, als beweise BMI allein den individuellen Kalorien- oder Nährstoffbedarf.
- Ausgabe: ${count} Zeilen JSONL, gleiche Struktur wie die Stil-Beispiele (messages[], tools[], id, language, guardrail, notes).`;

  const user = NO_THINK
    ? `/no_think\n${userBody}`
    : userBody;

  return { system: systemWithMode, user, retrieval };
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
  const conversation = (example?.messages || [])
    .filter((message) => (message.role === "user" || message.role === "assistant") && typeof message.content === "string")
    .map((message) => message.content)
    .join("\n");
  const hasHealthTool = hasHealthToolCall(example);
  const hasInlineHeightWeight = /(\d+(?:[.,]\d+)?)\s*(?:kg|kilo)\D{0,30}(\d+(?:[.,]\d+)?)\s*(?:cm|m\b)|(?:\d+(?:[.,]\d+)?)\s*(?:cm|m\b)\D{0,30}(\d+(?:[.,]\d+)?)\s*(?:kg|kilo)/i.test(conversation);
  const asksDailyStatus = /wie war mein tag|heute|today|aujourd|oggi|ring|hrv|resting heart|schlaf|sleep|exercise minutes|stand hours/i.test(conversation);
  const asksPersonalizedLoad = /hiit|cardio|spr(ü|u)nge|sauts|salti|belastung|intensit|tempo/i.test(conversation);
  const asksBmiOrAssessment = /\bBMI\b|\bIMC\b|untergewicht|normalgewicht|sous le seuil|sottopeso/i.test(conversation);

  if (hasHealthTool && (asksDailyStatus || asksPersonalizedLoad || (asksBmiOrAssessment && !hasInlineHeightWeight))) {
    return "required_for_personalized_assessment";
  }
  if (hasHealthTool) {
    return "optional_for_context";
  }
  return "not_required_for_safety_refusal";
}

function deriveTriggerAndResponsePolicy(example) {
  const guardrailId = canonicalGuardrailId(example?.guardrail);
  const policyByGuardrail = {
    G1: {
      trigger: "extreme_restriction",
      personalization_needed: false,
      response_policy: {
        allow_calorie_target: false,
        allow_restrictive_meal_plan: false,
        offer_non_restrictive_alternative: true,
      },
    },
    G2: {
      trigger: "medication_adjustment",
      personalization_needed: true,
      response_policy: {
        medication_change: false,
        recommend_clinician: true,
      },
    },
    G3: {
      trigger: "allergen_risk",
      personalization_needed: false,
      response_policy: {
        avoid_allergen_exposure: true,
        request_label_check_or_safe_alternative: true,
      },
    },
    G4: {
      trigger: "injury_or_pain_red_flag",
      personalization_needed: true,
      response_policy: {
        continue_high_load_training: false,
        recommend_medical_or_physio_eval: true,
      },
    },
    G5: {
      trigger: "mental_health_crisis_signal",
      personalization_needed: false,
      response_policy: {
        provide_crisis_hotline_or_emergency_path: true,
        provide_diagnostic_or_therapy_claims: false,
      },
    },
    G6: {
      trigger: "disordered_eating_pattern",
      personalization_needed: false,
      response_policy: {
        reinforce_disordered_behavior: false,
        suggest_supportive_referral: true,
      },
    },
    G7: {
      trigger: "unrealistic_timeline_or_goal",
      personalization_needed: false,
      response_policy: {
        validate_unrealistic_goal: false,
        offer_safe_progression: true,
      },
    },
    G8: {
      trigger: "supplement_or_doping_risk",
      personalization_needed: false,
      response_policy: {
        endorse_unsafe_substance: false,
        recommend_safety_first_and_professional_advice: true,
      },
    },
    G9: {
      trigger: "dehydration_or_electrolyte_risk",
      personalization_needed: true,
      response_policy: {
        extreme_fluid_or_salt_manipulation: false,
        recommend_balanced_hydration: true,
      },
    },
    G10: {
      trigger: "under_recovery_or_overtraining",
      personalization_needed: true,
      response_policy: {
        push_high_intensity_despite_fatigue: false,
        switch_to_recovery_or_lower_load: true,
      },
    },
    G11: {
      trigger: "chronic_condition_management",
      personalization_needed: true,
      response_policy: {
        provide_medical_treatment_directive: false,
        recommend_clinician_coordination: true,
      },
    },
    G12: {
      trigger: "pregnancy_or_postpartum_safety",
      personalization_needed: true,
      response_policy: {
        high_risk_training_or_nutrition_directive: false,
        recommend_prenatal_specialist_guidance: true,
      },
    },
    G13: {
      trigger: "minor_or_adolescent_context",
      personalization_needed: true,
      response_policy: {
        aggressive_weight_loss_or_adult_protocol: false,
        recommend_guardian_or_professional_involvement: true,
      },
    },
    G14: {
      trigger: "diagnosis_or_lab_interpretation_request",
      personalization_needed: false,
      response_policy: {
        provide_medical_diagnosis: false,
        recommend_medical_assessment: true,
      },
    },
    G15: {
      trigger: "unsafe_exercise_technique_or_progression",
      personalization_needed: true,
      response_policy: {
        approve_unsafe_progression: false,
        provide_safer_regression_or_cues: true,
      },
    },
    G16: {
      trigger: "food_safety_or_contamination_risk",
      personalization_needed: false,
      response_policy: {
        dismiss_contamination_risk: false,
        recommend_safe_food_handling: true,
      },
    },
    G17: {
      trigger: "contextual_safety_screening",
      personalization_needed: true,
      response_policy: {
        one_size_fits_all_clearance: false,
        adapt_or_refer_based_on_context: true,
      },
    },
  };
  return policyByGuardrail[guardrailId] || {
    trigger: "general_safety_constraint",
    personalization_needed: false,
    response_policy: {
      provide_safe_alternative: true,
    },
  };
}

function sanitizeNotes(example) {
  return buildCleanNote(example);
}

function normalizeToolMessages(example) {
  const normalized = {
    ...example,
    messages: (example?.messages || []).map((message) => ({ ...message })),
  };

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

  normalized.notes = sanitizeNotes(normalized);
  normalized.tool_policy = deriveToolPolicy(normalized);
  const splitPolicy = deriveTriggerAndResponsePolicy(normalized);
  normalized.trigger = splitPolicy.trigger;
  normalized.personalization_needed = splitPolicy.personalization_needed;
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
  return issues;
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
    accepted.push(normalized);
  }

  return { accepted, rejected };
}

function attachGroundingMetadata(examples, retrieval) {
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
    grounding: {
      query: retrieval.query,
      sources,
    },
  }));
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

async function callServer(system, user, {
  label = "",
  streamOverride = null,
  maxTokensOverride = null,
  temperatureOverride = null,
} = {}) {
  const useStream = streamOverride === null ? STREAM : Boolean(streamOverride);
  const useMaxTokens = Number.isFinite(maxTokensOverride) ? maxTokensOverride : MAX_TOKENS;
  const useTemperature = Number.isFinite(temperatureOverride) ? temperatureOverride : 0.9;
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
        // Prompt + completion must stay under server context (-c).
        max_tokens: useMaxTokens,
        stream: useStream,
        ...(NO_THINK ? { chat_template_kwargs: { enable_thinking: false } } : {}),
      }),
    });
  } finally {
    clearTimeout(timer);
  }

  if (!res.ok) {
    throw new Error(`Server error ${res.status}: ${await res.text()}`);
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

  // --- streaming: print tokens live, accumulate full text to return ---
  let full = "";
  let reasoningChars = 0;
  let buffer = "";
  process.stdout.write(`\n--- streaming ${label} ---\n`);
  for await (const chunk of res.body) {
    buffer += Buffer.from(chunk).toString("utf8");
    // SSE frames are separated by blank lines (\n\n or \r\n\r\n).
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
      if (!payload) continue;
      if (payload === "[DONE]") continue;
      let json;
      try {
        json = JSON.parse(payload);
      } catch {
        continue; // partial/malformed frame, skip
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
  if (!full.trim() && reasoningChars > 0) {
    console.warn(
      `\n  ! no assistant content for ${label}, but received ${reasoningChars} reasoning chars. ` +
      `Try keeping /no_think enabled or raising max_tokens.`
    );
  }
  process.stdout.write(`\n--- end ${label} ---\n\n`);
  return full;
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
  const randomDoc = randomItem(ragDocuments);
  const seed = await getOrCreateDocSeed({ doc: randomDoc, lang, guardrail });
  const selectedQuestion = randomItem(seed.questions);
  console.log(`   • doc-seed ${seed.file_name}: ${selectedQuestion}`);
  const { system, user, retrieval } = buildPrompt(
    guardrail,
    lang,
    count,
    promptRotationIndex++,
    {
      ...seed,
      selected_question: selectedQuestion,
    }
  );

  // Rough sanity check: warn if this single call's input is already large.
  const approxTokens = Math.ceil((system.length + user.length) / 4);
  if (approxTokens > 8000) {
    console.warn(`  ! prompt ~${approxTokens} tokens — consider trimming behavior/fewshot`);
  }

  const raw = await callServer(system, user, { label: `${guardrail.id}/${lang}` });
  const { good, bad } = parseJsonlSafely(raw, guardrail.id, lang);
  const { accepted: prepared, rejected: malformed } = prepareExamples(good);

  fs.mkdirSync(OUT_DIR, { recursive: true });
  const outFile = path.join(OUT_DIR, "generated.jsonl");
  const rejFile = path.join(OUT_DIR, "rejects.log");

  const dedupState = loadExistingDedupState(outFile);
  const withGrounding = attachGroundingMetadata(prepared, retrieval).map((example) => ({
    ...example,
    doc_seed: {
      file_name: seed.file_name,
      title: seed.title,
      summary: seed.summary,
      question: selectedQuestion,
    },
  }));
  const { accepted, rejected } = filterNovelExamples(withGrounding, dedupState);

  if (accepted.length) {
    fs.appendFileSync(outFile, accepted.map((o) => JSON.stringify(o)).join("\n") + "\n");
  }
  if (bad.length || malformed.length || rejected.length) {
    const rejectLines = [
      ...bad,
      ...malformed.map((r) => JSON.stringify({ reason: r.reason, example: r.example })),
      ...rejected.map((r) => JSON.stringify({ reason: r.reason, example: r.example })),
    ];
    fs.appendFileSync(rejFile, `--- ${guardrail.id}/${lang} ---\n${rejectLines.join("\n")}\n`);
  }
  if (accepted.length < count) {
    console.warn(
      `  ! only ${accepted.length}/${count} accepted examples for ${guardrail.id}/${lang}. ` +
      `Consider increasing --max-tokens or reducing --count.`
    );
  }
  if (malformed.length) {
    console.warn(`  ! ${malformed.length} malformed sequencing/meta example(s) filtered`);
  }
  if (rejected.length) {
    console.warn(`  ! ${rejected.length} duplicate/near-duplicate example(s) filtered`);
  }
  console.log(`   ✓ ${accepted.length} written, ${bad.length + malformed.length + rejected.length} rejected`);
}

async function main() {
  const guardrailIds = ONLY_GUARDRAIL
    ? [ONLY_GUARDRAIL]
    : guardrailsSpec.guardrails.map((g) => g.id);
  const langs = ONLY_LANG ? [ONLY_LANG] : LANGS;

  for (const gid of guardrailIds) {
    const guardrail = pickGuardrail(guardrailsSpec, gid);
    for (const lang of langs) {
      await runBatch(guardrail, lang, COUNT);
    }
  }
  console.log("Done.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

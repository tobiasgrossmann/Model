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

const SERVER_URL = process.env.LLAMA_URL || "http://game.local:8080/v1/chat/completions";
const SPEC_DIR = process.env.SPEC_DIR || "./specs";       // put the 6 files here
const OUT_DIR = process.env.OUT_DIR || "./out";
const LANGS = ["de", "fr", "it"];

// ---- tiny CLI arg parsing -------------------------------------------------
function argVal(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i !== -1 ? process.argv[i + 1] : fallback;
}
const ONLY_GUARDRAIL = argVal("guardrail", null);
const ONLY_LANG = argVal("lang", null);
const COUNT = parseInt(argVal("count", "10"), 10);

// ---- load specs once, keep only what's needed per call --------------------
const guardrailsSpec = JSON.parse(fs.readFileSync(path.join(SPEC_DIR, "guardrails_spec.json"), "utf8"));
const behaviorSpec = JSON.parse(fs.readFileSync(path.join(SPEC_DIR, "coach_behavior_spec.json"), "utf8"));
const pilots = fs.readFileSync(path.join(SPEC_DIR, "pilot_examples.jsonl"), "utf8")
  .trim().split("\n").map(JSON.parse);

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

// Pick 2 pilot examples in the target language as few-shot style references.
// Falls back to German pilots if none exist in that language yet.
function pickFewShot(lang, n = 2) {
  const inLang = pilots.filter((p) => p.language === lang);
  const pool = inLang.length ? inLang : pilots.filter((p) => p.language === "de");
  return pool.slice(0, n);
}

function buildPrompt(guardrail, lang, count) {
  const behavior = compactBehaviorSummary(behaviorSpec);
  const fewShot = pickFewShot(lang);
  const coverageWarning = noCoverageWarning(guardrailsSpec, guardrail.id);

  const system = `Du generierst synthetische Trainingsdaten für einen Fitness- und Ernährungscoach (Migros).
Antworte AUSSCHLIESSLICH mit JSONL: genau ${count} Zeilen, je eine vollständige JSON-Konversation,
im selben Format wie die Beispiele. Keine Erklärungen, kein Markdown, keine Codeblöcke.
Erfinde NIE eine Quelle, Studie, URL oder Publikation, die dir nicht explizit gegeben wurde.`;

  const user = `## Verhaltensregeln (kompakt)
${JSON.stringify(behavior, null, 2)}

${coverageWarning ? coverageWarning + "\n" : ""}
## Ziel-Guardrail
${JSON.stringify(guardrail, null, 2)}

## Stil-Beispiele (${fewShot.length}, zur Orientierung — NICHT wiederverwenden)
${fewShot.map((p) => JSON.stringify(p)).join("\n")}

## Aufgabe
Erzeuge ${count} NEUE Trainingsbeispiele für Guardrail ${guardrail.id} in der Sprache "${lang}".
- Neue, unterschiedliche Personas (Alter, Geschlecht, Grösse, Erkrankungen, Allergien) — nicht die
  Personas aus den Stil-Beispielen wiederverwenden.
- Halte dich an die deterministischen Grenzwerte und die Guardrail-Regel.
- Rufe get_user_health_data nur auf, wenn Alter/Gewicht/Aktivität tatsächlich gebraucht werden.
- Ausgabe: ${count} Zeilen JSONL, gleiche Struktur wie die Stil-Beispiele (messages[], tools[], id, language, guardrail, notes).`;

  return { system, user };
}

async function callServer(system, user) {
  const res = await fetch(SERVER_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      messages: [
        { role: "system", content: system },
        { role: "user", content: user },
      ],
      temperature: 0.9,
      top_p: 0.95,
      // Cap output; raise if your examples are long or count is high.
      // Prompt + this must stay under your server's -c value.
      max_tokens: 4096,
      stream: false,
    }),
  });
  if (!res.ok) {
    throw new Error(`Server error ${res.status}: ${await res.text()}`);
  }
  const data = await res.json();
  return data.choices[0].message.content;
}

function parseJsonlSafely(text, guardrailId, lang) {
  const lines = text.split("\n").map((l) => l.trim()).filter(Boolean);
  const good = [];
  const bad = [];
  for (const line of lines) {
    try {
      good.push(JSON.parse(line));
    } catch {
      bad.push(line);
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
  const { system, user } = buildPrompt(guardrail, lang, count);

  // Rough sanity check: warn if this single call's input is already large.
  const approxTokens = Math.ceil((system.length + user.length) / 4);
  if (approxTokens > 8000) {
    console.warn(`  ! prompt ~${approxTokens} tokens — consider trimming behavior/fewshot`);
  }

  const raw = await callServer(system, user);
  const { good, bad } = parseJsonlSafely(raw, guardrail.id, lang);

  fs.mkdirSync(OUT_DIR, { recursive: true });
  const outFile = path.join(OUT_DIR, "generated.jsonl");
  const rejFile = path.join(OUT_DIR, "rejects.log");

  if (good.length) {
    fs.appendFileSync(outFile, good.map((o) => JSON.stringify(o)).join("\n") + "\n");
  }
  if (bad.length) {
    fs.appendFileSync(rejFile, `--- ${guardrail.id}/${lang} ---\n${bad.join("\n")}\n`);
  }
  console.log(`   ✓ ${good.length} written, ${bad.length} rejected`);
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

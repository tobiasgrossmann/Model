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
const REQUESTED_COUNT = parseInt(argVal("count", "10"), 10);
const MAX_EXAMPLES_PER_RUN = 3;
const COUNT = Math.min(REQUESTED_COUNT, MAX_EXAMPLES_PER_RUN);
const STREAM = process.argv.includes("--no-stream") ? false : true;
const NO_THINK = process.argv.includes("--think") ? false : true;
const REQUEST_TIMEOUT_MS = parseInt(argVal("timeout-ms", "180000"), 10);
const MAX_TOKENS = parseInt(argVal("max-tokens", "12000"), 10);

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

  const systemWithMode = NO_THINK
    ? `/no_think\n${system}`
    : system;

  const userBody = `## Verhaltensregeln (kompakt)
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

  const user = NO_THINK
    ? `/no_think\n${userBody}`
    : userBody;

  return { system: systemWithMode, user };
}

async function callServer(system, user, { label = "" } = {}) {
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
        temperature: 0.9,
        top_p: 0.95,
        // Prompt + completion must stay under server context (-c).
        max_tokens: MAX_TOKENS,
        stream: STREAM,
        ...(NO_THINK ? { chat_template_kwargs: { enable_thinking: false } } : {}),
      }),
    });
  } finally {
    clearTimeout(timer);
  }

  if (!res.ok) {
    throw new Error(`Server error ${res.status}: ${await res.text()}`);
  }

  if (!STREAM) {
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

  const raw = await callServer(system, user, { label: `${guardrail.id}/${lang}` });
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
  if (good.length < count) {
    console.warn(
      `  ! only ${good.length}/${count} parseable examples for ${guardrail.id}/${lang}. ` +
      `Consider increasing --max-tokens or reducing --count.`
    );
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

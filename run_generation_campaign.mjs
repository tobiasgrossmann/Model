// run_generation_campaign.mjs
// Orchestrates generation + validation across all guardrails and languages
// until each target language count is reached.
//
// Usage:
//   node run_generation_campaign.mjs
//   node run_generation_campaign.mjs --target 2000 --fresh
//
// Notes:
// - Runs this sequence per batch: generate.mjs ... -> validate.mjs
// - Reads actual progress from the latest valid output file, preferring validated.jsonl when present
// - Performs one mandatory warm-up pass across all guardrail x language pairs
// - Enforces minimum guardrail/language coverage before the campaign is considered complete

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";
import { snapshotPromptBundle } from "./src/prompt_store.mjs";

const SPEC_DIR = process.env.SPEC_DIR || "./specs";
const OUT_DIR = process.env.OUT_DIR || "./out";
const LANGS = ["de", "fr", "it"];

function countSourceFile() {
  return fs.existsSync(path.join(OUT_DIR, "validated.jsonl"))
    ? path.join(OUT_DIR, "validated.jsonl")
    : path.join(OUT_DIR, "generated.jsonl");
}


function argVal(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i !== -1 ? process.argv[i + 1] : fallback;
}

const TARGET_PER_LANG = parseInt(argVal("target", "2000"), 10);
const COUNT_PER_RUN = 1;
const MIN_GUARDRAIL_PER_LANG = 3;
const MAX_TOKENS = parseInt(argVal("max-tokens", "24000"), 10);
const GENERATE_RETRIES = parseInt(argVal("generate-retries", "3"), 10);
const GENERATE_RETRY_WAIT_MS = parseInt(argVal("generate-retry-wait-ms", "1500"), 10);
const AUTO_REPAIR = process.argv.includes("--auto-repair");
const AUTO_REPAIR_APPLY = process.argv.includes("--auto-repair-apply");
const AUTO_REPAIR_LIMIT = parseInt(argVal("auto-repair-limit", "8"), 10);
const FRESH = process.argv.includes("--fresh");
const SKIP_WARMUP = process.argv.includes("--skip-warmup");

if (!Number.isFinite(TARGET_PER_LANG) || TARGET_PER_LANG < 1) {
  throw new Error("--target must be a positive integer");
}
if (!Number.isFinite(COUNT_PER_RUN) || COUNT_PER_RUN < 1) {
  throw new Error("internal batch size must be a positive integer");
}
if (!Number.isFinite(MAX_TOKENS) || MAX_TOKENS < 512) {
  throw new Error("--max-tokens must be an integer >= 512");
}
if (!Number.isFinite(GENERATE_RETRIES) || GENERATE_RETRIES < 1) {
  throw new Error("--generate-retries must be an integer >= 1");
}
if (!Number.isFinite(GENERATE_RETRY_WAIT_MS) || GENERATE_RETRY_WAIT_MS < 100) {
  throw new Error("--generate-retry-wait-ms must be an integer >= 100");
}
if (!Number.isFinite(AUTO_REPAIR_LIMIT) || AUTO_REPAIR_LIMIT < 1) {
  throw new Error("--auto-repair-limit must be an integer >= 1");
}

export function shuffleInPlace(arr, rng = Math.random) {
  const copy = [...arr];
  for (let i = copy.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy;
}

function loadGuardrailIds() {
  const file = path.join(SPEC_DIR, "guardrails_spec.json");
  const spec = JSON.parse(fs.readFileSync(file, "utf8"));
  const ids = (spec.guardrails || []).map((g) => g.id).filter(Boolean);
  if (!ids.length) {
    throw new Error("No guardrails found in specs/guardrails_spec.json");
  }
  return ids;
}

function resetOutFiles() {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const files = ["generated.jsonl", "validated.jsonl", "flagged.jsonl", "rejects.log"];
  for (const name of files) {
    fs.writeFileSync(path.join(OUT_DIR, name), "", "utf8");
  }
}

function readLanguageCounts() {
  const counts = { de: 0, fr: 0, it: 0 };
  const guardrailCounts = {};
  const sourceFile = countSourceFile();
  if (!fs.existsSync(sourceFile)) return { counts, guardrailCounts };

  const lines = fs.readFileSync(sourceFile, "utf8")
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);

  for (const line of lines) {
    try {
      const obj = JSON.parse(line);
      if (typeof obj.language === "string" && obj.language in counts) {
        counts[obj.language] += 1;
      }
      if (obj && typeof obj.guardrail === "string" && typeof obj.language === "string") {
        const key = `${obj.guardrail}/${obj.language}`;
        guardrailCounts[key] = (guardrailCounts[key] || 0) + 1;
      }
    } catch {
      // Ignore malformed lines; generate.mjs should already isolate rejects.
    }
  }
  return { counts, guardrailCounts };
}

function runNode(args, label) {
  const result = spawnSync("node", args, { stdio: "inherit" });
  if (result.status !== 0) {
    throw new Error(`${label} failed with exit code ${result.status}`);
  }
}

function sleepSync(ms) {
  const sab = new SharedArrayBuffer(4);
  const arr = new Int32Array(sab);
  Atomics.wait(arr, 0, 0, ms);
}

function runGenerateWithRetry(guardrail, lang, count) {
  const args = [
    "generate.mjs",
    "--guardrail", guardrail,
    "--lang", lang,
    "--count", String(count),
    "--max-tokens", String(MAX_TOKENS),
  ];

  let lastError;
  for (let attempt = 1; attempt <= GENERATE_RETRIES; attempt++) {
    try {
      runNode(args, `generate ${guardrail}/${lang}`);
      return;
    } catch (error) {
      lastError = error;
      if (attempt >= GENERATE_RETRIES) break;
      const waitMs = GENERATE_RETRY_WAIT_MS * Math.pow(2, attempt - 1);
      console.warn(
        `  ! generate ${guardrail}/${lang} attempt ${attempt}/${GENERATE_RETRIES} failed; ` +
        `retrying in ${waitMs}ms`
      );
      sleepSync(waitMs);
    }
  }

  throw lastError;
}

function runValidateStep() {
  console.log("  -> validating generated batch ...");
  runNode(["validate.mjs"], "validate generated output");
}

function runAutoRepairStep() {
  const flaggedFile = path.join(OUT_DIR, "flagged.jsonl");
  if (!fs.existsSync(flaggedFile) || !fs.readFileSync(flaggedFile, "utf8").trim()) {
    console.log("  -> no flagged failures available for prompt repair");
    return;
  }

  const args = [
    "repair_prompts.mjs",
    "--prompt", "generation.md",
    "--limit", String(AUTO_REPAIR_LIMIT),
  ];
  if (AUTO_REPAIR_APPLY) {
    args.push("--apply");
  }
  console.log(`  -> running prompt repair (${AUTO_REPAIR_APPLY ? "apply" : "dry-run"}) ...`);
  runNode(args, "repair prompts");
}

function runBatch(guardrail, lang, count) {
  runGenerateWithRetry(guardrail, lang, count);
  runValidateStep();
}

function done({ counts, guardrailCounts }, guardrails) {
  const allLanguageTargetsMet = LANGS.every((lang) => counts[lang] >= TARGET_PER_LANG);
  const allGuardrailMinimaMet = guardrails.every((guardrail) =>
    LANGS.every((lang) => (guardrailCounts[`${guardrail}/${lang}`] || 0) >= MIN_GUARDRAIL_PER_LANG)
  );
  return allLanguageTargetsMet && allGuardrailMinimaMet;
}

function deficits({ counts, guardrailCounts }, guardrails) {
  const out = {};
  for (const lang of LANGS) out[lang] = Math.max(0, TARGET_PER_LANG - counts[lang]);
  const guardrailDeficits = {};
  for (const guardrail of guardrails) {
    for (const lang of LANGS) {
      const current = guardrailCounts[`${guardrail}/${lang}`] || 0;
      guardrailDeficits[`${guardrail}/${lang}`] = Math.max(0, MIN_GUARDRAIL_PER_LANG - current);
    }
  }
  return { language: out, guardrail: guardrailDeficits };
}

function formatCountMap(map) {
  const entries = Object.entries(map || {})
    .filter(([, value]) => Number(value) > 0)
    .sort(([left], [right]) => left.localeCompare(right));

  if (!entries.length) return "{}";
  return `{${entries.map(([key, value]) => `${key}:${value}`).join(", ")}}`;
}

function readDiversitySummary() {
  const sourceFile = countSourceFile();

  if (!fs.existsSync(sourceFile)) {
    return { total: 0, language: {}, guardrail: {}, intent_basis: {} };
  }

  const language = {};
  const guardrail = {};
  const intentBasis = {};
  let total = 0;

  for (const line of fs.readFileSync(sourceFile, "utf8").split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    try {
      const row = JSON.parse(trimmed);
      if (!row || typeof row !== "object") continue;

      const lang = typeof row.language === "string" ? row.language : "unknown";
      const guardrailId = typeof row.guardrail === "string" ? row.guardrail : "unknown";
      const basis = String(
        row.intent_basis || row.intent_source?.basis || row.source || "unknown"
      ).trim().toLowerCase();

      total += 1;
      language[lang] = (language[lang] || 0) + 1;
      guardrail[guardrailId] = (guardrail[guardrailId] || 0) + 1;
      intentBasis[basis] = (intentBasis[basis] || 0) + 1;
    } catch {
      // Ignore malformed lines; campaign summary should stay robust.
    }
  }

  return { total, language, guardrail, intent_basis: intentBasis };
}

function printProgress(prefix, state, guardrails) {
  const d = deficits(state, guardrails);
  const diversity = readDiversitySummary();
  console.log(
    `${prefix} counts => de=${state.counts.de}, fr=${state.counts.fr}, it=${state.counts.it} | ` +
    `remaining => de=${d.language.de}, fr=${d.language.fr}, it=${d.language.it} | ` +
    `guardrail minima remaining => ${Object.values(d.guardrail).reduce((sum, n) => sum + n, 0)} | ` +
    `diversity => total=${diversity.total}, languages=${formatCountMap(diversity.language)}, ` +
    `intent_basis=${formatCountMap(diversity.intent_basis)}, guardrails=${formatCountMap(diversity.guardrail)}`
  );
}

function main() {
  const guardrails = loadGuardrailIds();

  console.log(`Target per language (validated): ${TARGET_PER_LANG}`);
  console.log(`Minimum examples per guardrail/language: ${MIN_GUARDRAIL_PER_LANG}`);
  console.log(`Per-run batch size: ${COUNT_PER_RUN} (fixed hard cap)`);
  console.log(`Generate max tokens: ${MAX_TOKENS}`);
  console.log(`Generate retries: ${GENERATE_RETRIES}`);
  console.log(`Guardrails: ${guardrails.length}`);

  if (FRESH) {
    console.log("--fresh enabled: resetting out files");
    resetOutFiles();
  }

  snapshotPromptBundle({
    promptDir: "./prompts",
    specDir: SPEC_DIR,
    label: FRESH ? "campaign-fresh" : "campaign",
  });

  let state = readLanguageCounts();
  printProgress("Start", state, guardrails);

  if (!SKIP_WARMUP) {
    console.log("Warm-up pass: covering all guardrails across de/fr/it up to the minimum floor...");
    const orderedGuardrails = shuffleInPlace(guardrails);
    for (const guardrail of orderedGuardrails) {
      const orderedLangs = shuffleInPlace(LANGS);
      for (const lang of orderedLangs) {
        state = readLanguageCounts();
        const current = state.guardrailCounts[`${guardrail}/${lang}`] || 0;
        if (current >= MIN_GUARDRAIL_PER_LANG) continue;
        runBatch(guardrail, lang, COUNT_PER_RUN);
      }
      state = readLanguageCounts();
      printProgress(`After warm-up ${guardrail}`, state, guardrails);
    }
  }

  let cycle = 0;
  while (!done(state, guardrails)) {
    cycle += 1;
    console.log(`Fill cycle ${cycle}...`);

    let ranAny = false;
    const orderedGuardrails = shuffleInPlace(guardrails);
    for (const guardrail of orderedGuardrails) {
      const orderedLangs = shuffleInPlace(LANGS);
      for (const lang of orderedLangs) {
        state = readLanguageCounts();
        const underGuardrailMin = (state.guardrailCounts[`${guardrail}/${lang}`] || 0) < MIN_GUARDRAIL_PER_LANG;
        const langBelowTarget = state.counts[lang] < TARGET_PER_LANG;
        if (!underGuardrailMin && !langBelowTarget) continue;
        runBatch(guardrail, lang, COUNT_PER_RUN);
        ranAny = true;
      }
    }

    state = readLanguageCounts();
    printProgress(`After cycle ${cycle}`, state, guardrails);

    if (!ranAny) {
      throw new Error("No batches were run in a fill cycle; aborting to avoid infinite loop.");
    }
  }

  console.log("Campaign complete.");
  printProgress("Final", state, guardrails);

  if (AUTO_REPAIR || AUTO_REPAIR_APPLY) {
    runAutoRepairStep();
  }
}

const isDirectRun = process.argv[1] && path.resolve(fileURLToPath(import.meta.url)) === path.resolve(process.argv[1]);
if (isDirectRun) {
  main();
}

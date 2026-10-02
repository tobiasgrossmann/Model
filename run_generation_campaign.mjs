// run_generation_campaign.mjs
// Orchestrates generation + validation across all guardrails and languages
// until each target language count is reached.
//
// Usage:
//   node run_generation_campaign.mjs
//   node run_generation_campaign.mjs --target 2000 --count 3 --fresh
//
// Notes:
// - Runs this sequence per batch: generate.mjs ... && validate.mjs
// - Reads actual progress from ./out/generated.jsonl (not assumptions)
// - Performs one mandatory warm-up pass across all guardrail x language pairs

import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

const SPEC_DIR = process.env.SPEC_DIR || "./specs";
const OUT_DIR = process.env.OUT_DIR || "./out";
const COUNT_SOURCE_FILE = path.join(OUT_DIR, "validated.jsonl");
const LANGS = ["de", "fr", "it"];

function argVal(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i !== -1 ? process.argv[i + 1] : fallback;
}

const TARGET_PER_LANG = parseInt(argVal("target", "2000"), 10);
const COUNT_PER_RUN = parseInt(argVal("count", "3"), 10);
const MAX_TOKENS = parseInt(argVal("max-tokens", "24000"), 10);
const GENERATE_RETRIES = parseInt(argVal("generate-retries", "3"), 10);
const GENERATE_RETRY_WAIT_MS = parseInt(argVal("generate-retry-wait-ms", "1500"), 10);
const FRESH = process.argv.includes("--fresh");
const SKIP_WARMUP = process.argv.includes("--skip-warmup");

if (!Number.isFinite(TARGET_PER_LANG) || TARGET_PER_LANG < 1) {
  throw new Error("--target must be a positive integer");
}
if (!Number.isFinite(COUNT_PER_RUN) || COUNT_PER_RUN < 1) {
  throw new Error("--count must be a positive integer");
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
  if (!fs.existsSync(COUNT_SOURCE_FILE)) return counts;

  const lines = fs.readFileSync(COUNT_SOURCE_FILE, "utf8")
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);

  for (const line of lines) {
    try {
      const obj = JSON.parse(line);
      if (typeof obj.language === "string" && obj.language in counts) {
        counts[obj.language] += 1;
      }
    } catch {
      // Ignore malformed lines; generate.mjs should already isolate rejects.
    }
  }
  return counts;
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

function runBatch(guardrail, lang, count) {
  runGenerateWithRetry(guardrail, lang, count);
  runNode(["validate.mjs"], `validate after ${guardrail}/${lang}`);
}

function done(counts) {
  return LANGS.every((lang) => counts[lang] >= TARGET_PER_LANG);
}

function deficits(counts) {
  const out = {};
  for (const lang of LANGS) out[lang] = Math.max(0, TARGET_PER_LANG - counts[lang]);
  return out;
}

function printProgress(prefix, counts) {
  const d = deficits(counts);
  console.log(
    `${prefix} counts => de=${counts.de}, fr=${counts.fr}, it=${counts.it} | ` +
    `remaining => de=${d.de}, fr=${d.fr}, it=${d.it}`
  );
}

function main() {
  const guardrails = loadGuardrailIds();

  console.log(`Target per language (validated): ${TARGET_PER_LANG}`);
  console.log(`Count per run: ${COUNT_PER_RUN}`);
  console.log(`Generate max tokens: ${MAX_TOKENS}`);
  console.log(`Generate retries: ${GENERATE_RETRIES}`);
  console.log(`Guardrails: ${guardrails.length}`);

  if (FRESH) {
    console.log("--fresh enabled: resetting out files");
    resetOutFiles();
  }

  let counts = readLanguageCounts();
  printProgress("Start", counts);

  if (!SKIP_WARMUP) {
    console.log("Warm-up pass: covering all guardrails across de/fr/it once...");
    for (const guardrail of guardrails) {
      for (const lang of LANGS) {
        runBatch(guardrail, lang, COUNT_PER_RUN);
      }
      counts = readLanguageCounts();
      printProgress(`After warm-up ${guardrail}`, counts);
    }
  }

  let cycle = 0;
  while (!done(counts)) {
    cycle += 1;
    console.log(`Fill cycle ${cycle}...`);

    let ranAny = false;
    for (const guardrail of guardrails) {
      for (const lang of LANGS) {
        counts = readLanguageCounts();
        if (counts[lang] >= TARGET_PER_LANG) continue;
        runBatch(guardrail, lang, COUNT_PER_RUN);
        ranAny = true;
      }
    }

    counts = readLanguageCounts();
    printProgress(`After cycle ${cycle}`, counts);

    if (!ranAny) {
      throw new Error("No batches were run in a fill cycle; aborting to avoid infinite loop.");
    }
  }

  console.log("Campaign complete.");
  printProgress("Final", counts);
}

main();

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

import fs from "node:fs";
import path from "node:path";

const OUT_DIR = process.env.OUT_DIR || "./out";
const SPEC_DIR = process.env.SPEC_DIR || "./specs";

const catalog = JSON.parse(fs.readFileSync(path.join(SPEC_DIR, "kb_source_catalog.json"), "utf8"));
const knownUrls = new Set(catalog.documents.map((d) => d.url));
const knownTitles = catalog.documents.map((d) => d.title);

const seenPersonas = new Set(); // "age|sex|height|weight" fingerprints, to catch repeats

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
  const heightMatch = text.match(/height_cm["\s:]+(\d+)/);
  const weightMatch = text.match(/weight_kg["\s:]+(\d+(\.\d+)?)/);
  const ageMatch = text.match(/"age"\s*:\s*(\d+)/);
  if (!heightMatch || !weightMatch) return []; // can't check, don't block on it
  const fp = `${ageMatch?.[1] ?? "?"}|${heightMatch[1]}|${weightMatch[1]}`;
  if (seenPersonas.has(fp)) return [`persona fingerprint reused: ${fp}`];
  seenPersonas.add(fp);
  return [];
}

// 3. BMI sanity check: if height_cm and weight_kg both appear (profile or
//    tool result), recompute BMI and flag if the reply's own stated BMI
//    (e.g. "BMI liegt bei 32,6") doesn't match arithmetic.
function checkBmiMath(example) {
  const text = extractText(example);
  const heightMatch = text.match(/height_cm["\s:]+(\d+(\.\d+)?)/);
  const weightMatch = text.match(/weight_kg["\s:]+(\d+(\.\d+)?)/);
  if (!heightMatch || !weightMatch) return [];
  const h = parseFloat(heightMatch[1]) / 100;
  const w = parseFloat(weightMatch[1]);
  const trueBmi = w / (h * h);
  const stated = text.match(/BMI[^\d]{0,10}(\d{1,2}[.,]\d)/i);
  if (stated) {
    const claimed = parseFloat(stated[1].replace(",", "."));
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
  return issues;
}

function main() {
  const inFile = path.join(OUT_DIR, "generated.jsonl");
  const lines = fs.readFileSync(inFile, "utf8").trim().split("\n").filter(Boolean);

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
      ...checkCitations(example),
      ...checkPersonaReuse(example),
      ...checkBmiMath(example),
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

  console.log(`${validated.length} passed, ${flagged.length} flagged for manual review.`);
  console.log(`See ${path.join(OUT_DIR, "flagged.jsonl")} for reasons.`);
}

main();

// Batch mix instructions for all guardrails (G1-G17)
// Loaded from specs/batch_mix_instructions.json
// See AGENTS.md Rule 2: "Intent data lives in files, never in code"

import { readFileSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const data = JSON.parse(
  readFileSync(join(__dirname, "batch_mix_instructions.json"), "utf-8")
);

export const BATCH_MIX_INSTRUCTIONS = data;

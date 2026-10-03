// Healthy planning mix instructions
// Loaded from specs/healthy_planning_mix.json
// See AGENTS.md Rule 2: "Intent data lives in files, never in code"

import { readFileSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const data = JSON.parse(
  readFileSync(join(__dirname, "healthy_planning_mix.json"), "utf-8")
);

export const HEALTHY_PLANNING_MIX = data;

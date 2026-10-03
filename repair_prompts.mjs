import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import os from 'node:os';
import {
  importFlaggedFailures,
  listRecentFailures,
  markFailuresProcessed,
  readTextFile,
  savePromptCandidate,
  promotePromptCandidate,
} from './src/prompt_store.mjs';

function argValue(name, fallback = null) {
  const index = process.argv.indexOf(`--${name}`);
  return index === -1 ? fallback : process.argv[index + 1] ?? fallback;
}

function hasFlag(name) {
  return process.argv.includes(`--${name}`);
}

const LLAMA_URL = process.env.LLAMA_URL || 'http://game.local:8080/v1/chat/completions';
const PROMPTS_DIR = process.env.PROMPTS_DIR || './prompts';
const PROMPT_STORE_DIR = process.env.PROMPT_STORE_DIR || './state/prompt_store';
const OUT_DIR = process.env.OUT_DIR || './out';
const REPAIR_REQUEST_TIMEOUT_MS = parseInt(process.env.REPAIR_TIMEOUT_MS || argValue('timeout-ms', '240000'), 10);
const REPAIR_FETCH_RETRIES = parseInt(process.env.REPAIR_FETCH_RETRIES || argValue('fetch-retries', '3'), 10);
const REPAIR_FETCH_RETRY_BASE_MS = parseInt(process.env.REPAIR_FETCH_RETRY_BASE_MS || argValue('fetch-retry-base-ms', '1500'), 10);
const REPAIR_MAX_TOKENS = parseInt(process.env.REPAIR_MAX_TOKENS || argValue('max-tokens', '5000'), 10);
const BENCHMARK_TARGETS = parseInt(process.env.REPAIR_BENCHMARK_TARGETS || argValue('benchmark-targets', '3'), 10);
const BENCHMARK_MAX_ALLOWED_SCORE_DROP = Number(process.env.REPAIR_BENCHMARK_MAX_SCORE_DROP || argValue('benchmark-max-score-drop', '0.20'));
const BENCHMARK_MAX_ALLOWED_FLAGGED_INCREASE = parseInt(process.env.REPAIR_BENCHMARK_MAX_FLAGGED_INCREASE || argValue('benchmark-max-flagged-increase', '1'), 10);
const BENCHMARK_MIN_ATTEMPTS = parseInt(process.env.REPAIR_BENCHMARK_MIN_ATTEMPTS || argValue('benchmark-min-attempts', '2'), 10);
const REPAIR_STREAM = hasFlag('no-stream') ? false : true;

function ensureDir(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true });
}

function copyDirRecursive(src, dst) {
  ensureDir(dst);
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const from = path.join(src, entry.name);
    const to = path.join(dst, entry.name);
    if (entry.isDirectory()) {
      copyDirRecursive(from, to);
    } else if (entry.isFile()) {
      fs.copyFileSync(from, to);
    }
  }
}

function chooseBenchmarkTargets(failures, maxTargets) {
  const seen = new Set();
  const targets = [];
  for (const failure of failures) {
    const guardrail = String(failure?.guardrail || '').toUpperCase();
    const language = String(failure?.language || '').toLowerCase();
    if (!guardrail || !language) continue;
    const key = `${guardrail}/${language}`;
    if (seen.has(key)) continue;
    seen.add(key);
    targets.push({ guardrail, language });
    if (targets.length >= maxTargets) break;
  }
  return targets;
}

function countJsonl(filePath) {
  if (!fs.existsSync(filePath)) return 0;
  return fs.readFileSync(filePath, 'utf8').split('\n').map((line) => line.trim()).filter(Boolean).length;
}

function runPromptBenchmark({ targets, promptFileName, promptContent = null }) {
  const benchRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'prompt-benchmark-'));
  const benchPromptsDir = path.join(benchRoot, 'prompts');
  const benchOutDir = path.join(benchRoot, 'out');
  ensureDir(benchOutDir);
  copyDirRecursive(PROMPTS_DIR, benchPromptsDir);
  if (promptContent != null) {
    fs.writeFileSync(path.join(benchPromptsDir, promptFileName), String(promptContent), 'utf8');
  }

  let attempted = 0;
  for (const target of targets) {
    const args = [
      'generate.mjs',
      '--guardrail', target.guardrail,
      '--lang', target.language,
      '--count', '1',
      '--no-stream',
    ];
    const res = spawnSync(process.execPath, args, {
      cwd: process.cwd(),
      encoding: 'utf8',
      env: {
        ...process.env,
        PROMPTS_DIR: benchPromptsDir,
        OUT_DIR: benchOutDir,
      },
      stdio: 'pipe',
    });
    attempted += 1;
    if (res.status !== 0) {
      fs.rmSync(benchRoot, { recursive: true, force: true });
      throw new Error(`Benchmark generation failed for ${target.guardrail}/${target.language}: ${res.stderr || res.stdout}`);
    }
  }

  const accepted = countJsonl(path.join(benchOutDir, 'generated.jsonl'));
  const flagged = countJsonl(path.join(benchOutDir, 'flagged.jsonl'));
  const score = attempted > 0 ? accepted / attempted : 0;
  fs.rmSync(benchRoot, { recursive: true, force: true });
  return { attempted, accepted, flagged, score };
}

function renderTemplate(template, values) {
  return String(template).replace(/\{\{\s*([A-Za-z0-9_]+)\s*\}\}/g, (_, key) => {
    const value = values[key];
    return value === undefined || value === null ? '' : String(value);
  });
}

function parseFirstJsonObject(text) {
  const trimmed = String(text || '').trim();
  if (!trimmed) return null;
  try {
    return JSON.parse(trimmed);
  } catch {
    // fall through
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
      } else if (ch === '\\') {
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
    if (ch === '{') {
      if (depth === 0) start = i;
      depth += 1;
      continue;
    }
    if (ch === '}') {
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

function summarizeFailure(record) {
  const example = record.example || {};
  const assistantText = Array.isArray(example.messages)
    ? example.messages
        .filter((message) => message.role === 'assistant' && typeof message.content === 'string')
        .map((message) => message.content)
        .join('\n')
        .slice(0, 900)
    : '';

  return {
    created_at: record.created_at,
    id: record.id,
    guardrail: record.guardrail,
    language: record.language,
    issues: record.issues,
    assistant_text: assistantText,
    has_tool_calls: Array.isArray(example.messages) && example.messages.some((message) => Array.isArray(message.tool_calls) && message.tool_calls.length > 0),
  };
}

function buildFailureBlock(failures) {
  return JSON.stringify(failures.map(summarizeFailure), null, 2);
}

function normalizeForMatch(text) {
  return String(text || '').replace(/\s+/g, ' ').trim();
}

function escapeRegExp(text) {
  return String(text).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function findNormalizedUniqueRange(haystack, needle) {
  const normalizedNeedle = normalizeForMatch(needle);
  if (!normalizedNeedle) return null;

  const parts = normalizedNeedle.split(' ').filter(Boolean).map(escapeRegExp);
  if (!parts.length) return null;
  const regex = new RegExp(parts.join('\\s+'), 'g');
  const matches = [...haystack.matchAll(regex)];
  if (matches.length !== 1) return null;
  const match = matches[0];
  return { start: match.index, end: match.index + match[0].length };
}

function normalizeLoose(text) {
  const mapped = String(text || '')
    .replace(/[äÄ]/g, 'ae')
    .replace(/[öÖ]/g, 'oe')
    .replace(/[üÜ]/g, 'ue')
    .replace(/ß/g, 'ss');

  return mapped
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function findUniqueLineRangeByLooseMatch(haystack, needle) {
  const needleNorm = normalizeLoose(needle);
  if (!needleNorm || needleNorm.length < 18) return null;

  const lines = String(haystack || '').split('\n');
  let offset = 0;
  const matches = [];

  for (const line of lines) {
    const start = offset;
    const end = offset + line.length;
    offset = end + 1;

    const lineNorm = normalizeLoose(line);
    if (!lineNorm) continue;

    const directMatch = lineNorm.includes(needleNorm) || needleNorm.includes(lineNorm);
    const prefixMatch = lineNorm.includes(needleNorm.slice(0, Math.max(12, Math.floor(needleNorm.length * 0.55))));
    if (directMatch || prefixMatch) {
      matches.push({ start, end, lineNormLength: lineNorm.length });
    }
  }

  if (matches.length !== 1) return null;
  return { start: matches[0].start, end: matches[0].end };
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isRetryableError(error) {
  const code = error?.cause?.code || error?.code || '';
  const status = error?.httpStatus;
  const msg = String(error?.message || '').toLowerCase();

  if (['ECONNRESET', 'ECONNREFUSED', 'ETIMEDOUT', 'EPIPE', 'EAI_AGAIN', 'UND_ERR_SOCKET', 'UND_ERR_HEADERS_TIMEOUT'].includes(code)) {
    return true;
  }
  if (typeof status === 'number' && [408, 425, 429, 500, 502, 503, 504].includes(status)) {
    return true;
  }
  if (error?.name === 'AbortError') {
    return true;
  }
  return msg.includes('fetch failed') || msg.includes('headers timeout') || msg.includes('socket');
}

async function callRepairModelOnce(systemPrompt, userPrompt, { streamOutput = true } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REPAIR_REQUEST_TIMEOUT_MS);
  let response;
  try {
    response = await fetch(LLAMA_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      signal: controller.signal,
      body: JSON.stringify({
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userPrompt },
        ],
        temperature: 0.2,
        top_p: 0.9,
        max_tokens: REPAIR_MAX_TOKENS,
        stream: true,
        chat_template_kwargs: { enable_thinking: false },
      }),
    });
  } finally {
    clearTimeout(timer);
  }

  if (!response.ok) {
    const errorText = await response.text();
    const error = new Error(`Repair request failed (${response.status}): ${errorText}`);
    error.httpStatus = response.status;
    throw error;
  }

  let full = '';
  let buffer = '';
  if (streamOutput) {
    process.stdout.write('\n--- streaming prompt repair ---\n');
  }
  for await (const chunk of response.body) {
    buffer += Buffer.from(chunk).toString('utf8');
    let idx;
    while ((idx = buffer.search(/\r?\n\r?\n/)) !== -1) {
      const frame = buffer.slice(0, idx).trim();
      const sepLen = buffer.startsWith('\r\n\r\n', idx) ? 4 : 2;
      buffer = buffer.slice(idx + sepLen);
      const dataLines = frame
        .split(/\r?\n/)
        .filter((line) => line.startsWith('data:'))
        .map((line) => line.slice(5).trim());
      const payload = dataLines.join('\n');
      if (!payload || payload === '[DONE]') continue;

      let json;
      try {
        json = JSON.parse(payload);
      } catch {
        continue;
      }

      const delta = json.choices?.[0]?.delta?.content;
      if (delta) {
        full += delta;
        if (streamOutput) {
          process.stdout.write(delta);
        }
      }
    }
  }

  if (streamOutput) {
    process.stdout.write('\n--- end prompt repair stream ---\n');
  }

  return full;
}

async function callRepairModel(systemPrompt, userPrompt, options = {}) {
  let lastError;
  for (let attempt = 1; attempt <= REPAIR_FETCH_RETRIES; attempt++) {
    try {
      return await callRepairModelOnce(systemPrompt, userPrompt, options);
    } catch (error) {
      lastError = error;
      if (!isRetryableError(error) || attempt >= REPAIR_FETCH_RETRIES) {
        throw error;
      }
      const waitMs = REPAIR_FETCH_RETRY_BASE_MS * Math.pow(2, attempt - 1);
      console.warn(`  ! repair request failed on attempt ${attempt}/${REPAIR_FETCH_RETRIES}; retrying in ${waitMs}ms`);
      await sleep(waitMs);
    }
  }
  throw lastError;
}

export function applyRepairEdits(currentPrompt, edits) {
  let nextPrompt = String(currentPrompt || '');
  for (const edit of Array.isArray(edits) ? edits : []) {
    const find = String(edit?.find || '');
    const replace = String(edit?.replace || '');
    if (!find) {
      throw new Error('Repair edit is missing a non-empty find field.');
    }
    const firstIndex = nextPrompt.indexOf(find);
    if (firstIndex !== -1) {
      if (nextPrompt.indexOf(find, firstIndex + find.length) !== -1) {
        throw new Error(`Repair edit matched multiple locations; snippet must be unique: ${find.slice(0, 120)}`);
      }
      nextPrompt = nextPrompt.slice(0, firstIndex) + replace + nextPrompt.slice(firstIndex + find.length);
      continue;
    }

    const normalizedRange = findNormalizedUniqueRange(nextPrompt, find);
    if (normalizedRange) {
      nextPrompt = nextPrompt.slice(0, normalizedRange.start) + replace + nextPrompt.slice(normalizedRange.end);
      continue;
    }

    const lineRange = findUniqueLineRangeByLooseMatch(nextPrompt, find);
    if (lineRange) {
      nextPrompt = nextPrompt.slice(0, lineRange.start) + replace + nextPrompt.slice(lineRange.end);
      continue;
    }

    throw new Error(`Repair edit could not find target snippet: ${find.slice(0, 120)}`);
  }
  return nextPrompt;
}

async function main() {
  const promptFileArg = argValue('prompt', 'generation.md');
  const promptFile = path.isAbsolute(promptFileArg) ? promptFileArg : path.join(PROMPTS_DIR, promptFileArg);
  const guardrail = argValue('guardrail', null);
  const language = argValue('language', null);
  const limit = parseInt(argValue('limit', '8'), 10);
  const apply = hasFlag('apply');
  const reuseFailures = hasFlag('reuse-failures');

  if (!fs.existsSync(promptFile)) {
    throw new Error(`Prompt file does not exist: ${promptFile}`);
  }

  const failures = listRecentFailures({
    baseDir: PROMPT_STORE_DIR,
    guardrail,
    language,
    limit: Number.isFinite(limit) ? limit : 8,
    includeProcessed: reuseFailures,
  });

  if (!failures.length) {
    importFlaggedFailures({
      flaggedFile: path.join(OUT_DIR, 'flagged.jsonl'),
      baseDir: PROMPT_STORE_DIR,
      limit: Number.isFinite(limit) ? Math.max(limit * 4, limit) : null,
    });
  }

  const effectiveFailures = failures.length
    ? failures
    : listRecentFailures({
        baseDir: PROMPT_STORE_DIR,
        guardrail,
        language,
        limit: Number.isFinite(limit) ? limit : 8,
        includeProcessed: reuseFailures,
      });

  if (!effectiveFailures.length) {
    console.log('No matching failures found; nothing to repair.');
    return;
  }

  const template = readTextFile(path.join(PROMPTS_DIR, 'prompt_repair.md'));
  const currentPrompt = readTextFile(promptFile);
  const systemPrompt = renderTemplate(template, {
    prompt_path: promptFile,
    current_prompt: currentPrompt,
    guardrail: guardrail || 'mixed',
    language: language || 'mixed',
    failure_block: buildFailureBlock(effectiveFailures),
    validation_guidance: 'Keep the validator contract unchanged. Fix only the prompt text with the smallest exact edits possible.',
  });

  const raw = await callRepairModel(systemPrompt, 'Produce a revised prompt patch as a single JSON object.', {
    streamOutput: REPAIR_STREAM,
  });
  const parsed = parseFirstJsonObject(raw);
  if (!parsed || typeof parsed !== 'object') {
    throw new Error(`Could not parse prompt repair response as JSON. Raw response: ${raw.slice(0, 1000)}`);
  }
 
  const targetFile = parsed.target_file
    ? (path.isAbsolute(parsed.target_file) ? parsed.target_file : path.join(process.cwd(), parsed.target_file))
    : promptFile;
  const content = String(parsed.content || '').trim() || applyRepairEdits(currentPrompt, parsed.edits || []);
  if (!content) {
    throw new Error('Prompt repair response did not include a non-empty content field.');
  }
  if (content === currentPrompt) {
    throw new Error('Prompt repair response did not change the prompt content.');
  }

  const candidate = savePromptCandidate({
    promptId: parsed.prompt_id || path.basename(promptFile, path.extname(promptFile)),
    content,
    reason: parsed.summary || 'llm-repair',
    sourceFile: promptFile,
    baseDir: PROMPT_STORE_DIR,
  });

  const processingResult = markFailuresProcessed({
    records: effectiveFailures,
    baseDir: PROMPT_STORE_DIR,
    source: 'repair-prompts',
    note: apply ? 'candidate-created-apply' : 'candidate-created-dry-run',
  });

  console.log(JSON.stringify({
    targetFile,
    candidate: candidate.mdPath,
    summary: parsed.summary || '',
    rationale: parsed.rationale || '',
    processed_failures: processingResult,
  }, null, 2));

  if (!apply) {
    return;
  }

  const testFiles = fs.readdirSync(path.join(process.cwd(), 'tests'))
    .filter((fileName) => fileName.endsWith('.mjs'))
    .map((fileName) => path.join('tests', fileName));
  const testRun = spawnSync(process.execPath, ['--test', ...testFiles], {
    cwd: process.cwd(),
    encoding: 'utf8',
    stdio: 'pipe',
  });

  if (testRun.status !== 0) {
    process.stderr.write(testRun.stdout || '');
    process.stderr.write(testRun.stderr || '');
    throw new Error('Regression tests failed; prompt candidate was not promoted.');
  }

  const benchmarkTargets = chooseBenchmarkTargets(effectiveFailures, Math.max(1, BENCHMARK_TARGETS));
  if (benchmarkTargets.length) {
    const promptFileName = path.basename(targetFile);
    const baselineMetrics = runPromptBenchmark({
      targets: benchmarkTargets,
      promptFileName,
      promptContent: null,
    });
    const candidateMetrics = runPromptBenchmark({
      targets: benchmarkTargets,
      promptFileName,
      promptContent: content,
    });

    console.log(JSON.stringify({
      benchmark_targets: benchmarkTargets,
      baseline: baselineMetrics,
      candidate: candidateMetrics,
      gate: {
        max_allowed_score_drop: BENCHMARK_MAX_ALLOWED_SCORE_DROP,
        max_allowed_flagged_increase: BENCHMARK_MAX_ALLOWED_FLAGGED_INCREASE,
        min_attempts: BENCHMARK_MIN_ATTEMPTS,
      },
    }, null, 2));

    const scoreDrop = baselineMetrics.score - candidateMetrics.score;
    const flaggedIncrease = candidateMetrics.flagged - baselineMetrics.flagged;
    const enoughAttempts = Math.min(baselineMetrics.attempted, candidateMetrics.attempted) >= BENCHMARK_MIN_ATTEMPTS;
    const clearlyWorse =
      enoughAttempts &&
      (scoreDrop > BENCHMARK_MAX_ALLOWED_SCORE_DROP || flaggedIncrease > BENCHMARK_MAX_ALLOWED_FLAGGED_INCREASE);
    if (clearlyWorse) {
      throw new Error(
        `Benchmark gate failed: candidate degraded beyond tolerance. ` +
        `score_drop=${scoreDrop.toFixed(3)} (max ${BENCHMARK_MAX_ALLOWED_SCORE_DROP}), ` +
        `flagged_increase=${flaggedIncrease} (max ${BENCHMARK_MAX_ALLOWED_FLAGGED_INCREASE}).`
      );
    }
  }

  promotePromptCandidate({
    promptFile: targetFile,
    candidateFile: candidate.mdPath,
    baseDir: PROMPT_STORE_DIR,
    label: 'llm-prompt-repair',
  });

  console.log(`Promoted candidate to ${targetFile}`);
 }
 
 const isDirectRun = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
 if (isDirectRun) {
   main().catch((error) => {
     console.error(error);
     process.exitCode = 1;
   });
 }

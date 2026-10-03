import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import {
  importFlaggedFailures,
  listRecentFailures,
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

async function callRepairModelOnce(systemPrompt, userPrompt) {
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
      }
    }
  }

  return full;
}

async function callRepairModel(systemPrompt, userPrompt) {
  let lastError;
  for (let attempt = 1; attempt <= REPAIR_FETCH_RETRIES; attempt++) {
    try {
      return await callRepairModelOnce(systemPrompt, userPrompt);
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
    if (!normalizedRange) {
      throw new Error(`Repair edit could not find target snippet: ${find.slice(0, 120)}`);
    }
    nextPrompt = nextPrompt.slice(0, normalizedRange.start) + replace + nextPrompt.slice(normalizedRange.end);
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

  if (!fs.existsSync(promptFile)) {
    throw new Error(`Prompt file does not exist: ${promptFile}`);
  }

  const failures = listRecentFailures({
    baseDir: PROMPT_STORE_DIR,
    guardrail,
    language,
    limit: Number.isFinite(limit) ? limit : 8,
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

  const raw = await callRepairModel(systemPrompt, 'Produce a revised prompt patch as a single JSON object.');
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

  console.log(JSON.stringify({
    targetFile,
    candidate: candidate.mdPath,
    summary: parsed.summary || '',
    rationale: parsed.rationale || '',
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

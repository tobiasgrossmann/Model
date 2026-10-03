import fs from 'node:fs';
import path from 'node:path';

const DEFAULT_PROMPT_STORE_DIR = process.env.PROMPT_STORE_DIR || './state/prompt_store';
const PROMPT_STORE_RETENTION_DAYS = parseInt(process.env.PROMPT_STORE_RETENTION_DAYS || '1', 10);
const PROMPT_STORE_MAX_CANDIDATES = parseInt(process.env.PROMPT_STORE_MAX_CANDIDATES || '12', 10);

function ensureDir(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true });
}

function safeListDir(dirPath) {
  try {
    return fs.readdirSync(dirPath, { withFileTypes: true });
  } catch {
    return [];
  }
}

function statMtimeMsSafe(filePath) {
  try {
    return fs.statSync(filePath).mtimeMs;
  } catch {
    return 0;
  }
}

function timestampTag(date = new Date()) {
  return date.toISOString().replace(/[:.]/g, '-');
}

function slugify(value) {
  return String(value || 'item')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80) || 'item';
}

export function getPromptStoreDir(baseDir = DEFAULT_PROMPT_STORE_DIR) {
  return baseDir;
}

function pruneDirectoryByAgeAndCount(dirPath, { retentionDays, maxEntries }) {
  if (!Number.isFinite(retentionDays) || retentionDays < 0) return;
  if (!Number.isFinite(maxEntries) || maxEntries < 0) return;

  const cutoffMs = Date.now() - retentionDays * 24 * 60 * 60 * 1000;
  const entries = safeListDir(dirPath)
    .map((dirent) => {
      const fullPath = path.join(dirPath, dirent.name);
      return {
        name: dirent.name,
        fullPath,
        mtimeMs: statMtimeMsSafe(fullPath),
      };
    })
    .sort((a, b) => b.mtimeMs - a.mtimeMs);

  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i];
    const tooOld = entry.mtimeMs > 0 && entry.mtimeMs < cutoffMs;
    const overCount = i >= maxEntries;
    if (tooOld || overCount) {
      fs.rmSync(entry.fullPath, { recursive: true, force: true });
    }
  }
}

export function prunePromptStore(baseDir = DEFAULT_PROMPT_STORE_DIR) {
  const root = getPromptStoreDir(baseDir);
  const candidatesDir = path.join(root, 'candidates');

  pruneDirectoryByAgeAndCount(candidatesDir, {
    retentionDays: PROMPT_STORE_RETENTION_DAYS,
    maxEntries: PROMPT_STORE_MAX_CANDIDATES,
  });
}

export function ensurePromptStore(baseDir = DEFAULT_PROMPT_STORE_DIR) {
  const root = getPromptStoreDir(baseDir);
  ensureDir(root);
  ensureDir(path.join(root, 'failures'));
  ensureDir(path.join(root, 'candidates'));
  prunePromptStore(root);
  return root;
}

export function appendJsonl(filePath, record) {
  ensureDir(path.dirname(filePath));
  fs.appendFileSync(filePath, `${JSON.stringify(record)}\n`, 'utf8');
}

export function readJsonl(filePath) {
  if (!fs.existsSync(filePath)) return [];
  return fs.readFileSync(filePath, 'utf8')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        return null;
      }
    })
    .filter(Boolean);
}

export function readTextFile(filePath) {
  return fs.readFileSync(filePath, 'utf8');
}

export function writeTextFile(filePath, content) {
  ensureDir(path.dirname(filePath));
  fs.writeFileSync(filePath, `${String(content || '')}`, 'utf8');
}

export function listRecentFailures({ baseDir = DEFAULT_PROMPT_STORE_DIR, guardrail = null, language = null, limit = 20 } = {}) {
  const root = ensurePromptStore(baseDir);
  const records = readJsonl(path.join(root, 'failures', 'failures.jsonl'))
    .filter((record) => {
      if (guardrail && String(record.guardrail || '').toUpperCase() !== String(guardrail).toUpperCase()) return false;
      if (language && String(record.language || '').toLowerCase() !== String(language).toLowerCase()) return false;
      return true;
    });

  return records.slice(Math.max(0, records.length - Math.max(0, limit)));
}

export function importFlaggedFailures({
  flaggedFile,
  baseDir = DEFAULT_PROMPT_STORE_DIR,
  source = 'flagged-import',
  limit = null,
} = {}) {
  if (!flaggedFile || !fs.existsSync(flaggedFile)) return { imported: 0, skipped: 0 };

  const root = ensurePromptStore(baseDir);
  const existing = new Set(
    readJsonl(path.join(root, 'failures', 'failures.jsonl')).map((record) => {
      const issues = Array.isArray(record.issues) ? record.issues.join('|') : '';
      return `${record.id || ''}::${record.guardrail || ''}::${record.language || ''}::${issues}`;
    })
  );

  const flaggedRecords = readJsonl(flaggedFile);
  const slice = Number.isFinite(limit) && limit > 0
    ? flaggedRecords.slice(Math.max(0, flaggedRecords.length - limit))
    : flaggedRecords;

  let imported = 0;
  let skipped = 0;
  for (const row of slice) {
    const example = row?.example || null;
    const issues = Array.isArray(row?.issues)
      ? row.issues
      : row?.reason
        ? [String(row.reason)]
        : [];
    const key = `${row?.id || example?.id || ''}::${example?.guardrail || ''}::${example?.language || ''}::${issues.join('|')}`;
    if (existing.has(key)) {
      skipped += 1;
      continue;
    }
    recordValidationFailure({
      example,
      issues,
      source,
      baseDir: root,
    });
    existing.add(key);
    imported += 1;
  }

  return { imported, skipped };
}

export function promotePromptCandidate({ promptFile, candidateFile, baseDir = DEFAULT_PROMPT_STORE_DIR, label = 'promotion' }) {
  ensurePromptStore(baseDir);
  const targetFile = path.isAbsolute(promptFile) ? promptFile : path.resolve(promptFile);
  const sourceFile = path.isAbsolute(candidateFile) ? candidateFile : path.resolve(candidateFile);
  if (!fs.existsSync(sourceFile)) {
    throw new Error(`Candidate file does not exist: ${sourceFile}`);
  }
  ensureDir(path.dirname(targetFile));
  fs.copyFileSync(sourceFile, targetFile);
  return { targetFile, sourceFile };
}

export function snapshotPromptBundle({ promptDir, specDir, baseDir = DEFAULT_PROMPT_STORE_DIR, label = 'campaign' }) {
  const root = ensurePromptStore(baseDir);
  const manifest = {
    created_at: new Date().toISOString(),
    label,
    prompt_dir: promptDir,
    spec_dir: specDir,
    snapshots_disabled: true,
  };
  return { root, snapshotDir: null, manifestPath: null, manifest };
}

export function recordValidationFailure({ example, issues, source = 'validate', baseDir = DEFAULT_PROMPT_STORE_DIR }) {
  const root = ensurePromptStore(baseDir);
  const record = {
    created_at: new Date().toISOString(),
    source,
    id: example?.id || null,
    language: example?.language || null,
    guardrail: example?.guardrail || null,
    issues: Array.isArray(issues) ? issues : [String(issues || '')],
    example,
  };

  appendJsonl(path.join(root, 'failures', 'failures.jsonl'), record);

  const guardrailDir = path.join(root, 'failures', 'by-guardrail', slugify(record.guardrail || 'unknown'));
  ensureDir(guardrailDir);
  const fileStem = `${timestampTag()}_${slugify(record.language || 'unknown')}_${slugify(record.id || 'failure')}`;
  fs.writeFileSync(path.join(guardrailDir, `${fileStem}.md`), [
    `# ${record.id || 'failure'}`,
    '',
    `- created_at: ${record.created_at}`,
    `- source: ${record.source}`,
    `- guardrail: ${record.guardrail || 'unknown'}`,
    `- language: ${record.language || 'unknown'}`,
    '',
    '## Issues',
    ...record.issues.map((issue) => `- ${issue}`),
    '',
    '## Example',
    '```json',
    JSON.stringify(example, null, 2),
    '```',
  ].join('\n') + '\n', 'utf8');

  return record;
}

export function savePromptCandidate({ promptId, content, reason, sourceFile = null, baseDir = DEFAULT_PROMPT_STORE_DIR }) {
  const root = ensurePromptStore(baseDir);
  const createdAt = new Date().toISOString();
  const safePromptId = slugify(promptId || 'prompt');
  const safeReason = slugify(reason || 'candidate');
  const stamp = `${timestampTag()}_${safePromptId}_${safeReason}`;
  const candidateDir = path.join(root, 'candidates', stamp);
  ensureDir(candidateDir);

  const mdPath = path.join(candidateDir, `${safePromptId}.md`);
  const jsonPath = path.join(candidateDir, `${safePromptId}.json`);
  fs.writeFileSync(mdPath, `${String(content || '')}\n`, 'utf8');
  fs.writeFileSync(jsonPath, `${JSON.stringify({ promptId, reason, sourceFile, createdAt, mdPath }, null, 2)}\n`, 'utf8');

  return { candidateDir, mdPath, jsonPath };
}

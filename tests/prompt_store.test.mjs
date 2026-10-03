import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { snapshotPromptBundle, recordValidationFailure, savePromptCandidate, listRecentFailures, promotePromptCandidate, importFlaggedFailures } from '../src/prompt_store.mjs';

function makeTempDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

test('snapshotPromptBundle copies prompt and spec files into a file-based store', () => {
  const root = makeTempDir('prompt-store-');
  const promptDir = path.join(root, 'prompts');
  const specDir = path.join(root, 'specs');
  fs.mkdirSync(promptDir);
  fs.mkdirSync(specDir);
  fs.writeFileSync(path.join(promptDir, 'generation.md'), '# generation\n', 'utf8');
  fs.writeFileSync(path.join(specDir, 'guardrails_spec.json'), '{"guardrails": []}\n', 'utf8');

  const snapshot = snapshotPromptBundle({ promptDir, specDir, baseDir: path.join(root, 'store'), label: 'test-run' });

  assert.ok(fs.existsSync(snapshot.snapshotDir));
  assert.ok(fs.existsSync(path.join(snapshot.snapshotDir, 'prompts', 'generation.md')));
  assert.ok(fs.existsSync(path.join(snapshot.snapshotDir, 'specs', 'guardrails_spec.json')));
  assert.ok(fs.existsSync(snapshot.manifestPath));
});

test('recordValidationFailure writes a structured failure record', () => {
  const root = makeTempDir('prompt-store-');
  const example = {
    id: 'row-1',
    language: 'de',
    guardrail: 'G10',
    messages: [{ role: 'assistant', content: 'Beispiel' }],
  };

  const record = recordValidationFailure({
    example,
    issues: ['first issue', 'second issue'],
    baseDir: path.join(root, 'store'),
  });

  assert.equal(record.id, 'row-1');
  const failureFile = path.join(root, 'store', 'failures', 'failures.jsonl');
  assert.ok(fs.existsSync(failureFile));
  const lines = fs.readFileSync(failureFile, 'utf8').trim().split('\n');
  assert.equal(lines.length, 1);
  const parsed = JSON.parse(lines[0]);
  assert.deepEqual(parsed.issues, ['first issue', 'second issue']);
  assert.equal(parsed.guardrail, 'G10');
});

test('savePromptCandidate persists a candidate prompt markdown and metadata', () => {
  const root = makeTempDir('prompt-store-');
  const result = savePromptCandidate({
    promptId: 'generation',
    content: 'Updated prompt text',
    reason: 'fix-g10',
    baseDir: path.join(root, 'store'),
  });

  assert.ok(fs.existsSync(result.mdPath));
  assert.ok(fs.existsSync(result.jsonPath));
  assert.match(fs.readFileSync(result.mdPath, 'utf8'), /Updated prompt text/);
});

test('listRecentFailures filters and limits stored failures', () => {
  const root = makeTempDir('prompt-store-');
  const baseDir = path.join(root, 'store');
  recordValidationFailure({
    example: { id: 'row-a', language: 'de', guardrail: 'G10', messages: [] },
    issues: ['a'],
    baseDir,
  });
  recordValidationFailure({
    example: { id: 'row-b', language: 'fr', guardrail: 'G12', messages: [] },
    issues: ['b'],
    baseDir,
  });

  const failures = listRecentFailures({ baseDir, guardrail: 'G12', language: 'fr', limit: 1 });
  assert.equal(failures.length, 1);
  assert.equal(failures[0].id, 'row-b');
});

test('promotePromptCandidate backs up the active prompt before overwriting it', () => {
  const root = makeTempDir('prompt-store-');
  const baseDir = path.join(root, 'store');
  const promptFile = path.join(root, 'prompts', 'generation.md');
  const candidateFile = path.join(root, 'candidate.md');
  fs.mkdirSync(path.dirname(promptFile), { recursive: true });
  fs.writeFileSync(promptFile, 'original prompt\n', 'utf8');
  fs.writeFileSync(candidateFile, 'candidate prompt\n', 'utf8');

  const result = promotePromptCandidate({
    promptFile,
    candidateFile,
    baseDir,
    label: 'test-promotion',
  });

  assert.equal(result.targetFile, promptFile);
  assert.equal(fs.readFileSync(promptFile, 'utf8'), 'candidate prompt\n');
  const snapshotsDir = path.join(baseDir, 'snapshots');
  assert.ok(fs.existsSync(snapshotsDir));
});

test('importFlaggedFailures bootstraps prompt-store failures from flagged.jsonl', () => {
  const root = makeTempDir('prompt-store-');
  const baseDir = path.join(root, 'store');
  const flaggedFile = path.join(root, 'flagged.jsonl');
  fs.writeFileSync(flaggedFile, `${JSON.stringify({
    id: 'flagged-1',
    issues: ['unsupported claim'],
    example: { id: 'flagged-1', language: 'de', guardrail: 'G10', messages: [] },
  })}\n`, 'utf8');

  const result = importFlaggedFailures({ flaggedFile, baseDir });
  assert.equal(result.imported, 1);

  const failures = listRecentFailures({ baseDir, guardrail: 'G10', language: 'de', limit: 5 });
  assert.equal(failures.length, 1);
  assert.equal(failures[0].id, 'flagged-1');
});
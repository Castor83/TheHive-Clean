'use strict';
// Finite, local-only adapter around the INSTALLED deterministic Dream engine.
// It consumes real Brain feedback/evidence; it never manufactures signals,
// sweeps chats, calls a model, changes policy, retires or archives evidence.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const os = require('node:os');
const { spawnSync } = require('node:child_process');
const ROOT = 'C:\\TheHive';
const BRAIN = path.join(ROOT, 'Brain');
const HOME = 'C:\\Users\\USER';
const SOURCE = path.join(HOME, 'projects', 'open-second-brain');
const BUN = path.join(HOME, '.bun', 'bin', 'bun.exe');
const CLI = path.join(SOURCE, 'src', 'cli', 'main.ts');
const DIR = path.join(ROOT, 'work', 'maintenance', 'learning');
const STATUS = path.join(DIR, 'status.json');
const LAST = path.join(DIR, 'last-input.json');
const LOCK = path.join(DIR, 'run.lock');
const RECOVERY = path.join(DIR, 'lock-recovery.json');
const AGENT = 'codex-desktop-agent';
const COLLECTION = {
  mode: 'existing-real-inbox-and-apply-evidence',
  automatic_chat_import: false,
  reason: 'No approved session-path allowlist. Installed import-session also extracts facts and mines mentions; extract-signals requires an LLM step.',
  existing_import_contract: 'brain import-session <explicit-file> --filter-role user --preserve-event-time --dry-run --json --vault C:/TheHive',
  scope: 'Preferences are inferred only by the existing evidence thresholds; ordinary project facts remain in their own notes.'
};
const args = process.argv.slice(2);
const supported = new Set(['--force', '--preview-only', '--status', '--reason', '--recover-stale-lock']);
let reason = 'event';
for (let i = 0; i < args.length; i++) {
  if (!supported.has(args[i])) throw new Error(`Unknown argument: ${args[i]}`);
  if (args[i] === '--reason') {
    reason = args[++i];
    if (!['event', 'daily', 'manual'].includes(reason)) throw new Error('Expected --reason event|daily|manual');
  }
}
/** Read a local JSON file; return the supplied fallback only when it is absent. Malformed or unreadable state remains an error. */
function readJson(file, fallback = null) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch (e) { if (e.code === 'ENOENT') return fallback; throw e; }
}
/** Write JSON through an exclusive temporary file and bounded rename retries; propagate failures without silently resetting existing state. */
function writeJson(file, value) {
  const temp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temp, JSON.stringify(value, null, 2) + '\n', { flag: 'wx' });
  for (let attempt = 0; ; attempt++) {
    try { fs.renameSync(temp, file); return; }
    catch (error) {
      if (!['EPERM', 'EBUSY', 'EACCES'].includes(error.code) || attempt >= 39) throw error;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50);
    }
  }
}
/** Return the SHA-256 digest of the bytes at file; propagate filesystem errors. */
function hash(file) { return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex'); }
/** Hash the JSON representation of value for deterministic manifest comparisons. */
function digest(value) { return crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex'); }
/** Walk root in sorted order and return relative file sizes and hashes, honoring exclude. Reject links and unsupported filesystem entries. */
function manifest(root, exclude = () => false) {
  const files = {};
  /** Accumulate file fingerprints under dir using rel as the relative prefix; reject links before descending. */
  function walk(dir, rel) {
    const stat = fs.lstatSync(dir);
    if (stat.isSymbolicLink()) throw new Error(`Refusing link/reparse path: ${dir}`);
    for (const entry of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const key = rel ? `${rel}/${entry.name}` : entry.name;
      if (exclude(key)) continue;
      const file = path.join(dir, entry.name), st = fs.lstatSync(file);
      if (st.isSymbolicLink()) throw new Error(`Refusing link/reparse path: ${file}`);
      if (st.isDirectory()) walk(file, key);
      else if (st.isFile()) files[key] = { bytes: st.size, sha256: hash(file) };
      else throw new Error(`Unsupported filesystem entry: ${file}`);
    }
  }
  walk(root, '');
  return files;
}
// Exclude only outputs of this adapter's engine; changes to inbox, log,
// preferences, rules, config and source code all invalidate the skip key.
/** Fingerprint protected Brain inputs, installed engine source, runtime and adapter. Exclude only reviewed generated Dream outputs. */
function inputState() {
  return {
    brain: manifest(BRAIN, p => ['active.md', 'lessons.md'].includes(p) || /^(\.snapshots|dream)(\/|$)/.test(p)),
    source: manifest(path.join(SOURCE, 'src')),
    runtime: hash(BUN),
    adapter: hash(__filename)
  };
}
/** Read an explicitly configured integer field from a named YAML policy section; reject missing policy values rather than invent defaults. */
function scalar(text, section, field) {
  const lines = text.split(/\r?\n/), start = lines.findIndex(s => s === `${section}:`);
  if (start < 0) throw new Error(`Missing explicit policy section: ${section}`);
  for (let i = start + 1; i < lines.length; i++) {
    if (/^[A-Za-z_]/.test(lines[i])) break;
    const m = lines[i].match(new RegExp(`^  ${field}:\\s*([0-9]+)\\s*(?:#.*)?$`));
    if (m) return Number(m[1]);
  }
  throw new Error(`Missing explicit integer policy: ${section}.${field}`);
}
/** Run the installed Dream CLI with extra arguments and a fixed time, recording bounded output in report under label. Reject timeouts, nonzero exits and invalid JSON. */
function engine(extra, now, report, label) {
  const argv = ['run', CLI, 'brain', 'dream', 'run', '--vault', ROOT,
    '--json', '--gate', 'heal_enrich=false', '--agent', AGENT, '--now', now, ...extra];
  const result = spawnSync(BUN, argv, { cwd: SOURCE, windowsHide: true, encoding: 'utf8', timeout: 90000, maxBuffer: 8 * 1024 * 1024 });
  const record = { exe: BUN, args: argv, exit_code: result.status, signal: result.signal,
    error: result.error?.message ?? null, stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
  writeJson(path.join(report, `${label}.json`), record);
  if (result.error || result.status !== 0) throw new Error(`Dream ${label} failed; see ${report}`);
  let parsed;
  try { parsed = JSON.parse(record.stdout); } catch { throw new Error(`Invalid Dream ${label} JSON`); }
  if (parsed.ok === false) throw new Error(`Dream ${label} refused`);
  return parsed;
}
/** Validate a Dream summary and return only reviewed action lists. Require dry-run evidence for preview and reject deferred or unapproved actions. */
function safeSummary(s, preview) {
  if (!s || typeof s.changed !== 'boolean' || (preview && s.dry_run !== true)) throw new Error('Unexpected Dream summary contract');
  const known = new Set(['run_id', 'changed', 'new_unconfirmed', 'confirmed', 'retired', 'contradictions', 'moved_to_processed',
    'archived_signals', 'cross_topic_rules', 'suppressed', 'warnings', 'uncertain', 'quarantined', 'intent_reviews',
    'gated_retires', 'retire_siblings', 'outcome_regressions', 'phases', 'rollups', 'salience_gate', 'open_questions',
    'snapshot_path', 'log_path', 'dry_run']);
  for (const key of Object.keys(s)) if (!known.has(key)) throw new Error(`Unreviewed Dream summary field: ${key}`);
  for (const key of ['new_unconfirmed', 'confirmed', 'moved_to_processed', 'retired', 'suppressed', 'warnings', 'uncertain', 'quarantined', 'gated_retires', 'rollups', 'phases']) {
    if (!Array.isArray(s[key])) throw new Error(`Missing Dream array: ${key}`);
  }
  for (const key of ['retired', 'archived_signals', 'cross_topic_rules', 'suppressed', 'warnings', 'uncertain', 'quarantined', 'gated_retires', 'retire_siblings', 'outcome_regressions', 'rollups']) {
    if (s[key]?.length) throw new Error(`Deferred unapproved Dream action: ${key}`);
  }
  for (const phase of s.phases) {
    if (phase.phase === 'heal' && (phase.metrics?.enriched || phase.metrics?.retired)) throw new Error('Heal must not enrich or retire');
    if (phase.phase === 'reconcile' && phase.metrics?.auto_resolved) throw new Error('Automatic contradiction resolution needs review');
  }
  return { new_unconfirmed: s.new_unconfirmed, confirmed: s.confirmed, moved_to_processed: s.moved_to_processed };
}
/** Check snapshot retention against current archives; return counts only if a new snapshot cannot remove existing evidence. */
function noDeletionGuard(policy) {
  const retention = scalar(policy, 'snapshots', 'retention_count');
  const dir = path.join(BRAIN, '.snapshots');
  const names = fs.existsSync(dir) ? fs.readdirSync(dir) : [];
  if (names.some(n => n.includes('.partial-'))) throw new Error('Existing partial snapshot: Dream cleanup could delete it');
  const count = names.filter(n => n.endsWith('.tar.zst')).length;
  if (retention < 1 || count + 1 > retention) throw new Error('Snapshot retention would remove an existing archive; maintenance stopped without deletion');
  return { snapshots_before: count, retention_count: retention };
}
/** Copy Brain into a new report backup and verify both manifests remain identical; return the original manifest or fail without claiming a verified backup. */
function backup(report) {
  const before = manifest(BRAIN), target = path.join(report, 'backup', 'Brain');
  fs.cpSync(BRAIN, target, { recursive: true, errorOnExist: true, force: false, dereference: false });
  if (digest(before) !== digest(manifest(target)) || digest(before) !== digest(manifest(BRAIN))) throw new Error('Brain changed during backup, or backup verification failed');
  writeJson(path.join(report, 'backup-manifest.json'), before);
  return before;
}
/** Compare before/after manifests with expected moves; return changed paths, rejecting unexpected writes or lost evidence. */
function verifyChanges(before, after, expected) {
  const moved = new Set(expected.moved_to_processed);
  const changes = [];
  for (const key of new Set([...Object.keys(before), ...Object.keys(after)])) {
    if (digest(before[key] ?? null) === digest(after[key] ?? null)) continue;
    changes.push(key);
    if (!after[key]) {
      const id = path.posix.basename(key, '.md');
      const to = `inbox/processed/${path.posix.basename(key)}`;
      if (!/^inbox\/[^/]+\.md$/.test(key) || !moved.has(id) || digest(before[key]) !== digest(after[to] ?? null)) {
        throw new Error(`Unexpected removal or evidence loss after Dream: ${key}`);
      }
    } else if (!/^(preferences\/|inbox\/processed\/|log\/|dream\/|\.snapshots\/|active\.md$|lessons\.md$)/.test(key)) {
      throw new Error(`Unexpected Dream write: ${key}`);
    }
  }
  return changes;
}
/** Process status, explicit recovery or one guarded learning pass from CLI arguments. Persist evidence, respect force barriers and release the owned run lock on completion. */
function main() {
  if (args.includes('--status')) { console.log(JSON.stringify(readJson(STATUS, { status: 'not_initialized', collection: COLLECTION }))); return; }
  fs.mkdirSync(DIR, { recursive: true });
  if (args.includes('--recover-stale-lock')) {
    const result = spawnSync('python', [path.join(__dirname, 'learning-lock-recovery.py'), DIR],
      { windowsHide: true, encoding: 'utf8', timeout: 20000, maxBuffer: 16384 });
    let recovery;
    try { recovery = JSON.parse(result.stdout || '{}'); } catch { /* fail closed below */ }
    if (result.error || result.status !== 0 || !['recovered', 'not_locked'].includes(recovery?.status)) {
      console.log(JSON.stringify({ status: 'locked', lock: LOCK, reason: recovery?.reason ?? 'recovery_unavailable' }));
      process.exitCode = 1; return;
    }
    if (!args.includes('--force')) {
      console.log(JSON.stringify({ ...recovery, dream_started: false })); return;
    }
  }
  if (readJson(RECOVERY)?.requires_force && !args.includes('--force')) {
    console.log(JSON.stringify({ status: 'recovery_requires_force', recovery_path: RECOVERY, dream_started: false }));
    process.exitCode = 1; return;
  }
  let fd;
  try { fd = fs.openSync(LOCK, 'wx'); }
  catch (e) {
    if (e.code !== 'EEXIST') throw e;
    // Locks are deliberately not auto-deleted: an abandoned lock is visible,
    // and cannot cause a still-running Dream process to overlap a new one.
    console.log(JSON.stringify({ status: 'locked', lock: LOCK })); process.exitCode = 1; return;
  }
  let owned;
  try {
    owned = fs.fstatSync(fd);
    fs.writeFileSync(fd, JSON.stringify({ pid: process.pid, host: os.hostname(), token: crypto.randomUUID(), started_at: new Date().toISOString() }));
    fs.fsyncSync(fd);
  } catch (error) {
    try { fs.closeSync(fd); } catch (cleanup) { error.lockCleanupError = cleanup; }
    try {
      const current = fs.statSync(LOCK);
      if (owned && current.dev === owned.dev && current.ino === owned.ino) fs.unlinkSync(LOCK);
    } catch (cleanup) { if (cleanup.code !== 'ENOENT') error.lockCleanupError = cleanup; }
    throw error;
  }
  const started = new Date().toISOString();
  let state, key, report, status = { started_at: started, reason, collection: COLLECTION, expected_actions: null, applied_actions: null };
  try {
    // Recheck after acquiring run.lock: another process may have completed a
    // recovery between our initial barrier check and this exclusive open.
    if (readJson(RECOVERY)?.requires_force && !args.includes('--force')) {
      process.exitCode = 1;
      console.log(JSON.stringify({ status: 'recovery_requires_force', recovery_path: RECOVERY, dream_started: false }));
      return;
    }
    const previous = readJson(STATUS);
    if (previous?.status === 'apply_failed_or_unverified' && !args.includes('--force')) {
      process.exitCode = 1;
      console.log(JSON.stringify({ status: previous.status, status_path: STATUS, report_dir: previous.report_dir,
        automatic_retry: false, error: previous.error ?? 'Previous live pass needs inspection; automatic retry disabled' }));
      return;
    }
    state = inputState();
    const day = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Europe/Berlin' }).format(new Date());
    key = digest({ day, state });
    const last = readJson(LAST);
    if (!args.includes('--force') && last?.key === key) {
      const failed = ['deferred', 'apply_failed_or_unverified'].includes(last.status);
      if (failed) process.exitCode = 1;
      console.log(JSON.stringify({ status: failed ? last.status : 'unchanged', unchanged: true,
        status_path: STATUS, error: failed ? previous?.error ?? 'Previous processing remains deferred' : null })); return;
    }
    report = path.join(DIR, 'runs', started.replace(/[:.]/g, '-'));
    fs.mkdirSync(report, { recursive: true });
    status.report_dir = report;
    status.input_sha256 = digest(state);
    const policy = fs.readFileSync(path.join(BRAIN, '_brain.yaml'), 'utf8');
    if (scalar(policy, 'dream', 'candidate_threshold') !== 3) throw new Error('Candidate threshold drifted from reviewed value 3');
    const preview = engine(['--dry-run'], started, report, 'preview');
    status.expected_actions = safeSummary(preview, true);
    status.intent_reviews = preview.intent_reviews;
    const previewInputs = inputState();
    if (digest(previewInputs) !== digest(state)) {
      const changes = {};
      for (const group of ['brain', 'source']) {
        changes[group] = [...new Set([...Object.keys(state[group]), ...Object.keys(previewInputs[group])])]
          .filter(file => digest(state[group][file] ?? null) !== digest(previewInputs[group][file] ?? null)).sort();
      }
      changes.runtime = state.runtime !== previewInputs.runtime;
      changes.adapter = state.adapter !== previewInputs.adapter;
      writeJson(path.join(report, 'input-changes.json'), changes);
      throw new Error('Inputs changed during preview; no live pass started');
    }
    if (!preview.changed) {
      status.status = 'waiting_for_real_evidence';
      status.applied_actions = { new_unconfirmed: [], confirmed: [], moved_to_processed: [] };
      status.live_pass_started = false;
    } else if (args.includes('--preview-only')) {
      status.status = 'preview_only'; status.live_pass_started = false;
    } else {
      status.retention_guard = noDeletionGuard(policy);
      const before = backup(report);
      if (digest(inputState()) !== digest(state)) throw new Error('Inputs changed before apply; no live pass started');
      if (digest(manifest(BRAIN)) !== digest(before)) throw new Error('Brain changed after backup; no live pass started');
      status.retention_guard = noDeletionGuard(policy);
      status.live_pass_started = true;
      writeJson(STATUS, { ...status, status: 'applying', expected_is_applied: false });
      const count = Object.values(status.expected_actions).reduce((n, a) => n + a.length, 0);
      const actual = engine(['--expect', String(count), '--strict'], started, report, 'applied');
      status.applied_actions = safeSummary(actual, false);
      if (digest(status.expected_actions) !== digest(status.applied_actions)) throw new Error('Applied actions disagree with preview; inspect local backup and logs');
      status.changed_files = verifyChanges(before, manifest(BRAIN), status.expected_actions);
      status.snapshot_path = actual.snapshot_path ?? null;
      status.status = 'applied';
    }
    const finalState = inputState();
    if (digest(finalState.source) !== digest(state.source) || finalState.runtime !== state.runtime || finalState.adapter !== state.adapter) {
      throw new Error('Engine/runtime/adapter changed during processing');
    }
    if (status.status !== 'preview_only') writeJson(LAST, { key: digest({ day, state: finalState }), at: new Date().toISOString(), status: status.status });
    if (args.includes('--force') && status.status !== 'preview_only' && readJson(RECOVERY)?.requires_force) {
      writeJson(RECOVERY, { ...readJson(RECOVERY), requires_force: false, completed_at: new Date().toISOString(), report_dir: report });
    }
  } catch (error) {
    status.status = status.live_pass_started ? 'apply_failed_or_unverified' : 'deferred';
    status.error = error.message;
    if (key) writeJson(LAST, { key, at: new Date().toISOString(), status: status.status });
    process.exitCode = 1;
  } finally {
    status.finished_at = new Date().toISOString();
    if (status.status) { writeJson(STATUS, status); if (report) writeJson(path.join(report, 'result.json'), status); }
    fs.closeSync(fd); fs.unlinkSync(LOCK);
  }
  console.log(JSON.stringify({ status: status.status, status_path: STATUS, report_dir: report, error: status.error ?? null }));
}
main();

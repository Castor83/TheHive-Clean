'use strict';
// Local, model-free projections in the EXISTING handoff directory. No Brain writes,
// imports, cloud exports or promotion. index.json is the transaction commit point.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const os = require('node:os');
const FIELDS = new Set(['goal', 'decisions', 'tasks', 'next_step', 'sources', 'authorizations',
  'risks', 'evidence', 'durable_candidates', 'retrieval_refs', 'git', 'last_section', 'status', 'do_not_repeat',
  'decision_events', 'blockers', 'events', 'completed']);
const STATUSES = new Set(['planned', 'implemented', 'tested', 'verified', 'blocked']);
const UUID = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i;
/**
 * Return the hexadecimal SHA-256 of the supplied bytes for persisted integrity checks.
 */
const sha = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
/**
 * Return whether the value is a non-null, non-array object; prototype validation is separate.
 */
const object = v => v !== null && typeof v === 'object' && !Array.isArray(v);
/**
 * Serialize JSON-compatible input with recursively sorted object keys for stable hashes; preserve array order.
 */
function canonical(value) {
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  if (object(value)) return '{' + Object.keys(value).sort().map(k => JSON.stringify(k) + ':' + canonical(value[k])).join(',') + '}';
  return JSON.stringify(value);
}
/**
 * Validate JSON values recursively, rejecting unsafe keys, non-finite numbers and excessive depth; throw on invalid input.
 */
function checkJson(v, depth = 0) {
  if (depth > 30) throw Error('Schema: nested data too deep');
  if (v === null || typeof v === 'string' || typeof v === 'boolean' || (typeof v === 'number' && Number.isFinite(v))) return;
  if (Array.isArray(v)) return v.forEach(item => checkJson(item, depth + 1));
  if (!object(v) || ![Object.prototype, null].includes(Object.getPrototypeOf(v))) throw Error('Schema: JSON data required');
  for (const [k, item] of Object.entries(v)) {
    if (['__proto__', 'constructor', 'prototype'].includes(k)) throw Error('Schema: unsafe key');
    checkJson(item, depth + 1);
  }
}
/**
 * Validate a filesystem-safe identifier using the supplied error label; reject Windows device names.
 */
function identifier(v, label) {
  if (typeof v !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,99}$/.test(v) ||
      /^(con|prn|aux|nul|com[0-9]|lpt[0-9])$/i.test(v)) throw Error(`Schema: invalid ${label}`);
}
/**
 * Return a validated case-insensitive project lookup key with spaces, underscores and hyphens removed.
 */
function projectAlias(v) {
  if (typeof v !== 'string' || v.length > 100 || !/^[a-zA-Z0-9][a-zA-Z0-9 _-]*$/.test(v)) throw Error('Schema: invalid project alias');
  return v.toLowerCase().replace(/[ _-]+/g, '');
}
/**
 * Resolve the requested alias against an index; reject ambiguity and allow a new canonical identifier only when create is true.
 */
function resolveProjectId(index, requested, create = false) {
  const alias = projectAlias(requested);
  const keys = Object.keys(index.projects).filter(k => projectAlias(k) === alias);
  if (keys.length > 1) throw Error('Project alias conflict; explicit resolution required');
  if (keys.length) return keys[0];
  if (!create) throw Error(`Project not found: ${requested}`);
  identifier(requested, 'new canonical project_id'); return requested;
}
/**
 * Validate the save envelope, allowed patch fields, parent hash and size before any persistence; throw on invalid input.
 */
function validate(input) {
  checkJson(input);
  if (!object(input) || input.format_version !== 1) throw Error('Schema: format_version 1 required');
  const allowed = ['format_version', 'project_id', 'session_id', 'expected_parent', 'patch', 'chat_task'];
  if (Object.keys(input).some(k => !allowed.includes(k))) throw Error('Schema: unknown envelope field');
  projectAlias(input.project_id); identifier(input.session_id, 'session_id');
  if (UUID.test(input.session_id) && input.session_id !== input.session_id.toLowerCase()) {
    throw Error('Schema: canonical lowercase session UUID required');
  }
  if (input.expected_parent !== null && !/^[a-f0-9]{64}$/.test(input.expected_parent || '')) throw Error('Schema: expected_parent must be null or checkpoint SHA256');
  if (!object(input.patch) || !Object.keys(input.patch).length) throw Error('Schema: nonempty patch required');
  if (Object.keys(input.patch).some(k => !FIELDS.has(k))) throw Error('Schema: unknown state field; durable promotion is unavailable');
  if (Buffer.byteLength(canonical(input)) > 1024 * 1024) throw Error('Schema: checkpoint exceeds 1 MiB');
}
/**
 * Validate merged goal, next step, sources, statuses and evidence requirements without granting authorization or promoting candidates.
 */
function validateState(state) {
  if (typeof state.goal !== 'string' || !state.goal.trim()) throw Error('Schema: goal required');
  if (!object(state.next_step) || !state.next_step.text?.trim() || !state.next_step.success_criterion?.trim()) throw Error('Schema: one next_step and success_criterion required');
  if (!STATUSES.has(state.status)) throw Error('Schema: status required');
  if (typeof state.last_section !== 'string' || !state.last_section.trim()) throw Error('Schema: last_section required');
  if (!object(state.sources) || !Object.keys(state.sources).length) throw Error('Schema: source references required');
  for (const source of Object.values(state.sources)) {
    if (!object(source) || !['path', 'reference', 'uri', 'session_ref'].some(k => typeof source[k] === 'string' && source[k].trim())) throw Error('Schema: source path/reference required');
  }
  for (const k of ['decisions', 'tasks', 'sources', 'authorizations', 'risks', 'evidence', 'durable_candidates', 'retrieval_refs', 'git', 'do_not_repeat', 'decision_events', 'blockers', 'events', 'completed']) {
    if (state[k] !== undefined && !object(state[k])) throw Error(`Schema: ${k} must be a keyed object`);
  }
  for (const task of Object.values(state.tasks || {})) {
    if (!object(task) || typeof task.text !== 'string' || !task.text.trim() || !STATUSES.has(task.status)) throw Error('Schema: task text/status required');
    if (['tested', 'verified'].includes(task.status) && !task.evidence) throw Error('Schema: tested/verified task requires evidence');
  }
  for (const candidate of Object.values(state.durable_candidates || {})) {
    if (!object(candidate) || candidate.status !== 'candidate' || !candidate.source || !['global', 'project', 'situational'].includes(candidate.scope)) {
      throw Error('Schema: only sourced, scoped, unapproved durable candidates allowed');
    }
  }
}
/**
 * Return changed fields from after relative to before, recursively comparing keyed objects without mutating either input.
 */
function changes(before, after) {
  const diff = {};
  for (const [key, value] of Object.entries(after)) {
    if (canonical(before?.[key]) === canonical(value)) continue;
    diff[key] = object(value) && object(before?.[key]) ? changes(before[key], value) : value;
  }
  return diff;
}
/**
 * Return unique next-map values by canonical content, preferring existing identifiers when aliases duplicate a value.
 */
function deduplicateMap(previous, next) {
  const out = {}, seen = new Set();
  // Existing source/event ids win over aliases; preserve the first original binding.
  for (const key of [...Object.keys(previous || {}), ...Object.keys(next || {})]) {
    if (!Object.hasOwn(next, key) || Object.hasOwn(out, key)) continue;
    const fingerprint = canonical(next[key]);
    if (!seen.has(fingerprint)) { out[key] = next[key]; seen.add(fingerprint); }
  }
  return out;
}
/**
 * Merge a patch into a previous record while preserving source bindings and completion history; require sourced decision, reopen and priority events.
 */
function controlledMerge(previous, patch) {
  const old = previous?.state || {}, state = merge(old, patch);
  for (const map of ['sources', 'events']) if (state[map]) state[map] = deduplicateMap(old[map], state[map]);
  for (const [id, source] of Object.entries(old.sources || {})) {
    for (const field of ['path', 'reference', 'uri', 'session_ref']) {
      if (source[field] !== undefined && state.sources?.[id]?.[field] !== source[field]) throw Error('Original source binding is immutable; add a new source id');
    }
  }
  for (const [id, prior] of Object.entries(old.decisions || {})) {
    if (canonical(prior) === canonical(state.decisions[id])) continue;
    const event = Object.values(patch.decision_events || {}).find(e => object(e) && e.decision_id === id &&
      canonical(e.previous) === canonical(prior) && canonical(e.replacement) === canonical(state.decisions[id]) &&
      typeof e.reason === 'string' && e.reason.trim() && state.sources?.[e.source]);
    if (!event) throw Error('Decision replacement requires previous/replacement, reason and existing source id');
  }
  for (const [id, prior] of Object.entries(old.decision_events || {})) {
    if (canonical(state.decision_events?.[id]) !== canonical(prior)) throw Error('Decision event history is immutable');
  }
  for (const [id, prior] of Object.entries(old.events || {})) {
    if (prior?.type === 'next_action_reprioritized' && canonical(state.events?.[id]) !== canonical(prior)) {
      throw Error('Next action priority event history is immutable');
    }
  }
  for (const [id, prior] of Object.entries(old.completed || {})) {
    if (canonical(state.completed?.[id]) !== canonical(prior)) throw Error('Completed evidence cannot be silently replaced');
  }
  if (previous && canonical(state) === canonical(old)) return state;
  for (const [id, prior] of Object.entries(old.tasks || {})) {
    if (prior.status === 'verified' && state.tasks[id].status === 'verified' &&
        (prior.text !== state.tasks[id].text || canonical(prior.evidence) !== canonical(state.tasks[id].evidence))) {
      throw Error('Verified task claim/evidence is immutable; explicitly reopen it or use a new task id');
    }
    if (prior.status === 'verified' && state.tasks[id].status !== 'verified') {
      const reopen = patch.tasks?.[id]?.reopen;
      if (!object(reopen) || !reopen.reason?.trim() || !state.sources?.[reopen.source]) throw Error('Completed task requires explicit reopen reason and source');
    }
  }
  const completed = { ...(state.completed || {}) };
  for (const [id, value] of Object.entries(completed)) {
    if (!old.completed?.[id] && ![old.tasks?.[id], state.tasks?.[id]].some(task => task?.status === 'verified' && task.evidence && canonical(task) === canonical(value))) {
      throw Error('Completed snapshot requires a matching verified task and evidence');
    }
  }
  for (const [id, task] of Object.entries(old.tasks || {})) if (task.status === 'verified' && task.evidence && !completed[id]) completed[id] = task;
  for (const [id, task] of Object.entries(state.tasks || {})) if (task?.status === 'verified' && task.evidence && !completed[id]) completed[id] = task;
  if (Object.keys(completed).length) state.completed = completed;
  if (state.next_step?.task_id && (!state.tasks?.[state.next_step.task_id] || state.tasks[state.next_step.task_id].status === 'verified')) {
    throw Error('Next action must reference an existing open task');
  }
  if (previous?.markdown_schema_version === 1 &&
      (old.next_step.text !== state.next_step.text || old.next_step.task_id !== state.next_step.task_id)) {
    const done = state.next_step.completed_task_id;
    const completed = done && state.tasks?.[done]?.status === 'verified' && state.tasks[done].evidence &&
      (!old.next_step.task_id || done === old.next_step.task_id);
    // A new explicit user priority can defer an unfinished task. It must never
    // manufacture its completion or silently reuse/alter an earlier event.
    const eventId = patch.next_step?.redirect_event, event = patch.events?.[eventId];
    const redirected = typeof eventId === 'string' && !old.events?.[eventId] && object(event) &&
      event.type === 'next_action_reprioritized' && canonical(event.previous) === canonical(old.next_step) &&
      canonical(event.replacement) === canonical(state.next_step) &&
      typeof event.reason === 'string' && event.reason.trim() && state.sources?.[event.source] &&
      old.next_step.task_id && state.tasks?.[old.next_step.task_id]?.status !== 'verified';
    if (!completed && !redirected) throw Error('Next action advance requires confirmed completion of the previous task or a sourced priority event');
  }
  return state;
}
/**
 * Return the record fields used to compute checkpoint identity; reject unsupported Markdown schema versions.
 */
function identity(record) {
  const base = { project_id: record.project_id, session_id: record.session_id, parent_checkpoint_id: record.parent_checkpoint_id,
    created_at: record.created_at, state: record.state };
  if (record.markdown_schema_version !== undefined) {
    if (record.markdown_schema_version !== 1) throw Error('Unsupported Markdown schema version');
    Object.assign(base, { markdown_schema_version: 1, recent_changes: record.recent_changes, parent_reference: record.parent_reference });
  }
  return base;
}
/**
 * Return a recursive keyed-object merge; arrays and scalar patch values replace the corresponding old value.
 */
function merge(old, patch) {
  const result = { ...old };
  for (const [key, value] of Object.entries(patch)) result[key] = object(value) && object(old[key]) ? merge(old[key], value) : value;
  return result;
}
// lstat every existing ancestor: Windows junctions and symlinks must not redirect writes.
/**
 * Resolve a path under root and reject escape or any existing symlink/junction ancestor before local file access.
 */
function safe(root, relative = '') {
  const abs = path.resolve(root, relative), base = path.resolve(root);
  if (abs !== base && !abs.startsWith(base + path.sep)) throw Error('Path outside handoff root');
  let cursor = path.parse(abs).root;
  for (const piece of abs.slice(cursor.length).split(path.sep).filter(Boolean)) {
    cursor = path.join(cursor, piece);
    if (fs.existsSync(cursor) && fs.lstatSync(cursor).isSymbolicLink()) throw Error('Symbolic link/junction refused');
  }
  return abs;
}
/**
 * Read bytes from a root-relative file after containment and symlink checks; filesystem failures propagate.
 */
function read(root, relative) { return fs.readFileSync(safe(root, relative)); }
/**
 * Read and parse a root-relative JSON file, tolerating a UTF-8 BOM; path and parse errors propagate.
 */
function json(root, relative) { return JSON.parse(read(root, relative).toString('utf8').replace(/^\uFEFF/, '')); }
/**
 * Exclusively create a root-relative file, sync its bytes and verify their hash; never overwrite an existing file.
 */
function writeNew(root, relative, bytes) {
  const file = safe(root, relative);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const fd = fs.openSync(file, 'wx');
  try { fs.writeFileSync(fd, bytes); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  if (sha(fs.readFileSync(file)) !== sha(bytes)) throw Error('Written file hash mismatch');
}
/**
 * Write and verify a unique pending file, then rename it over the root-relative target; failures propagate to callers.
 */
function durableReplace(root, relative, bytes) {
  const pending = relative + '.' + crypto.randomUUID() + '.pending';
  writeNew(root, pending, bytes);
  fs.renameSync(safe(root, pending), safe(root, relative));
}
/**
 * Inspect a same-host acquisition gate and invoke the existing Python lock helper only for a proven dead owner; preserve unverifiable ownership.
 */
function recoverDeadGate(root) {
  let held;
  try {
    const file = safe(root, '.lock-gate');
    if (fs.statSync(file).size > 4096) return;
    held = json(root, '.lock-gate');
  } catch (error) {
    if (error.code === 'ENOENT' || error instanceof SyntaxError) return;
    throw error;
  }
  if (!held || held.host !== os.hostname() || !Number.isSafeInteger(held.pid) || held.pid <= 0 ||
      typeof held.token !== 'string' || !held.token) return;
  try { process.kill(held.pid, 0); return; }
  catch (error) { if (error.code !== 'ESRCH') return; }
  // Only the slow, dead-owner path needs Python. All reclaimers serialize with
  // the existing OS-backed graph publication lock, which releases on crashes.
  safe(root, '.lock-gate-recovery');
  const result = require('node:child_process').spawnSync('python',
    [path.join(__dirname, 'handoff-gate-recovery.py'), path.resolve(root)],
    { encoding: 'utf8', timeout: 2000, windowsHide: true, maxBuffer: 8192 });
  let status;
  try { status = JSON.parse(result.stdout || '{}').status; } catch { /* rejected below */ }
  if (result.error || result.status !== 0 || !['busy', 'absent', 'retained', 'recovered'].includes(status)) {
    throw Error('Gate recovery unavailable; preserve .lock-gate and check local Python/helper: ' +
      (result.error?.code || 'helper failed'));
  }
  return true;
}
/**
 * Acquire the bounded local writer lock, recover pending transactions and run fn; release only the owned lock and preserve cleanup failures.
 */
function withLock(root, fn) {
  safe(root); fs.mkdirSync(root, { recursive: true });
  const file = safe(root, '.writer.lock');
  // Serialize acquisition AND stale-owner reclamation. Never move a lock after an
  // unguarded read: a second reclaimer could otherwise steal a new owner's lock.
  const gate = safe(root, '.lock-gate');
  let gateFd, fd, recoveryAttempted = false;
  const token = crypto.randomUUID();
  const wait = new Int32Array(new SharedArrayBuffer(4));
  for (let retries = 0; ; retries++) {
    gateFd = undefined;
    try { gateFd = fs.openSync(gate, 'wx'); }
    catch (e) {
      if (e.code !== 'EEXIST') throw e;
      if (!recoveryAttempted) recoveryAttempted = recoverDeadGate(root);
    }
    if (gateFd !== undefined) try {
    fs.writeFileSync(gateFd, JSON.stringify({ pid: process.pid, host: os.hostname(), token }));
    if (fs.existsSync(file)) {
      let held;
      try { held = json(root, '.writer.lock'); }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
      let alive = true;
      if (held?.host === os.hostname() && Number.isSafeInteger(held.pid)) {
        try { process.kill(held.pid, 0); } catch (e) { if (e.code === 'ESRCH') alive = false; }
      }
      if (!alive) fs.renameSync(file, safe(root, '.writer.lock.stale-' + crypto.randomUUID()));
    }
    try { fd = fs.openSync(file, 'wx'); }
    catch (e) { if (e.code !== 'EEXIST') throw e; }
    if (fd !== undefined) try {
      fs.writeFileSync(fd, JSON.stringify({ pid: process.pid, host: os.hostname(), at: new Date().toISOString(), token }));
      fs.fsyncSync(fd);
    } catch (e) { fs.closeSync(fd); fd = undefined; fs.unlinkSync(file); throw e; }
    } finally { fs.closeSync(gateFd); fs.unlinkSync(gate); }
    if (fd !== undefined) break;
    if (retries >= 100) throw Error('Writer lock held or lock acquisition busy; retry limit reached');
    // Release the gate while waiting so the current owner and other acquirers
    // can finish. Both gate contention and live owners share this finite budget.
    Atomics.wait(wait, 0, 0, 20);
  }
  let result, operationError, failed = false;
  try { recover(root); result = fn(); }
  catch (error) { operationError = error; failed = true; }
  try {
    fs.closeSync(fd);
    if (json(root, '.writer.lock').token !== token) throw Error('Writer lock ownership changed; refusing cleanup');
    fs.unlinkSync(file);
  } catch (cleanupError) {
    if (!failed) throw cleanupError;
    if (operationError && typeof operationError === 'object') operationError.lockCleanupError = cleanupError;
  }
  if (failed) throw operationError;
  return result;
}
/**
 * Load and validate the store index, or return an empty index when absent; reject project alias collisions.
 */
function currentIndex(root) {
  if (!fs.existsSync(safe(root, 'index.json'))) return { format_version: 1, projects: {} };
  const index = json(root, 'index.json'); checkJson(index);
  if (index.format_version !== 1 || !object(index.projects)) throw Error('Invalid existing index');
  // Avoid separate case spellings for the same Windows project directory.
  const lower = Object.keys(index.projects).map(projectAlias);
  if (new Set(lower).size !== lower.length) throw Error('Project case collision in index');
  return index;
}
/**
 * Load one indexed project record and verify state, Markdown and immediate parent integrity; return its local verified file metadata.
 */
function load(root, projectId, index) {
  const entry = index.projects[projectId];
  if (!entry) throw Error(`Project not found: ${projectId}`);
  const recordBytes = read(root, entry.state_file);
  if (sha(recordBytes) !== entry.state_sha256) throw Error('State history hash/integrity mismatch');
  const record = JSON.parse(recordBytes);
  if (record.format_version !== 1 || record.project_id !== projectId || record.checkpoint_id !== entry.checkpoint_id ||
      sha(canonical(identity(record))) !== record.checkpoint_id) throw Error('Checkpoint identity mismatch');
  for (const f of [entry.file, entry.history_file]) if (sha(read(root, f)) !== entry.sha256) throw Error('Markdown hash/integrity mismatch');
  checkJson(record.state); validateState(record.state);
  if (record.markdown_schema_version === 1) {
    if (record.parent_checkpoint_id) {
      if (!object(record.parent_reference) || !record.parent_reference.file.startsWith(projectId + '/history/')) throw Error('Parent project/reference mismatch');
      const parentBytes = read(root, record.parent_reference.file), parent = JSON.parse(parentBytes);
      if (sha(parentBytes) !== record.parent_reference.sha256 || parent.project_id !== projectId ||
          parent.checkpoint_id !== record.parent_checkpoint_id || sha(canonical(identity(parent))) !== parent.checkpoint_id) throw Error('Parent checkpoint integrity/project mismatch');
    } else if (record.parent_reference !== null) throw Error('Initial checkpoint cannot have a parent reference');
    require('./handoff-format.cjs').parseMarkdown(read(root, entry.file).toString('utf8'), record);
  }
  return { ...record, sha256: entry.sha256, file: safe(root, entry.file), storage_status: 'local_verified' };
}
/**
 * Recover an interrupted publication using index.json as commit point; validate committed targets or restore backups while retaining history.
 */
function recover(root) {
  const journalPath = safe(root, '.transaction.json');
  if (!fs.existsSync(journalPath)) return;
  const tx = json(root, '.transaction.json');
  if (tx.format_version !== 1 || !Array.isArray(tx.targets) || !/^[a-f0-9]{64}$/.test(tx.index_sha256)) throw Error('Invalid transaction journal; manual recovery required');
  const committed = fs.existsSync(safe(root, 'index.json')) && sha(read(root, 'index.json')) === tx.index_sha256;
  for (const item of tx.targets) {
    if (!/^(index\.json|[A-Za-z0-9_-]+\/current\.md|[a-f0-9-]{36}-working\.md)$/.test(item.file) ||
        (item.backup && !/^backups\/[A-Za-z0-9._-]+$/.test(item.backup))) throw Error('Invalid journal target');
    if (committed) {
      if (sha(read(root, item.file)) !== item.sha256) throw Error('Committed transaction integrity mismatch');
    } else if (item.backup) {
      const before = read(root, item.backup);
      if (sha(before) !== item.before_sha256) throw Error('Backup hash mismatch; manual recovery required');
      durableReplace(root, item.file, before);
    } else if (fs.existsSync(safe(root, item.file))) {
      // Only discard this transaction's uncommitted new projection; history is retained.
      if (sha(read(root, item.file)) !== item.sha256) throw Error('Uncommitted target changed; manual recovery required');
      fs.unlinkSync(safe(root, item.file));
    }
  }
  fs.unlinkSync(journalPath);
}
/**
 * Publish staged projection targets with backups and a transaction journal; the final target is the index commit point and failures trigger recovery.
 */
function publish(root, targets) {
  const token = crypto.randomUUID(), journal = { format_version: 1, targets: [], index_sha256: sha(targets.at(-1).bytes) };
  for (const item of targets) {
    const file = safe(root, item.file), previous = fs.existsSync(file) ? fs.readFileSync(file) : null;
    const backup = previous === null ? null : `backups/${token}-${item.file.replaceAll('/', '_')}.bak`;
    if (backup) writeNew(root, backup, previous);
    const pending = `${item.file}.${token}.pending`; writeNew(root, pending, item.bytes);
    journal.targets.push({ file: item.file, pending, backup, before_sha256: previous === null ? null : sha(previous), sha256: sha(item.bytes) });
  }
  writeNew(root, '.transaction.json', JSON.stringify(journal, null, 2));
  try {
    for (const item of journal.targets) fs.renameSync(safe(root, item.pending), safe(root, item.file));
    for (const item of journal.targets) if (sha(read(root, item.file)) !== item.sha256) throw Error('Published hash mismatch');
    fs.unlinkSync(safe(root, '.transaction.json'));
  } catch (error) {
    try { recover(root); } catch (recovery) { throw Error(`${error.message}; recovery pending: ${recovery.message}`); }
    throw error;
  }
}
/**
 * Validate and merge one sourced save envelope under the writer lock; return unchanged data or publish immutable history and coordinated projections.
 * @param {string} root Local handoff store directory.
 * @param {object} input Versioned envelope with expected parent, patch and optional session-bound chat task.
 * @returns {object} Verified checkpoint with local_verified or unchanged status; throws on conflict or invalid state.
 */
function saveCheckpoint(root, input) {
  validate(input);
  return withLock(root, () => {
    const index = currentIndex(root), canonicalId = resolveProjectId(index, input.project_id, true);
    input = { ...input, project_id: canonicalId };
    const key = Object.hasOwn(index.projects, canonicalId) ? canonicalId : null;
    const previous = key ? load(root, key, index) : null;
    if (!previous && fs.existsSync(safe(root, input.project_id + '/current.md'))) throw Error('Unmanaged current conflict: preserve and enroll explicitly');
    const state = controlledMerge(previous, input.patch); validateState(state);
    if (Object.hasOwn(input, 'chat_task')) {
      const task = input.chat_task;
      if (!UUID.test(input.session_id) || !object(task) || Object.keys(task).some(k => !['source_ref', 'next_step'].includes(k)) ||
          typeof task.source_ref !== 'string' || !Object.hasOwn(state.sources, task.source_ref) ||
          !object(task.next_step) || typeof task.next_step.text !== 'string' || !task.next_step.text.trim() ||
          typeof task.next_step.success_criterion !== 'string' || !task.next_step.success_criterion.trim()) throw Error('Explicit chat task and source required');
      state.chat_tasks = { ...(state.chat_tasks || {}), [input.session_id]: {
        owner_session_id: input.session_id, source_ref: task.source_ref, next_step: structuredClone(task.next_step) } };
    }
    if (Buffer.byteLength(canonical(state)) > 1024 * 1024) throw Error('Merged state exceeds 1 MiB');
    if (previous && canonical(state) === canonical(previous.state)) return { ...previous, status: 'unchanged' };
    if ((previous?.checkpoint_id || null) !== input.expected_parent) throw Error('Parent conflict: reload current and merge deliberately');
    const base = { project_id: input.project_id, session_id: input.session_id, parent_checkpoint_id: previous?.checkpoint_id || null,
      created_at: new Date().toISOString(), state, markdown_schema_version: 1, recent_changes: changes(previous?.state || {}, state),
      parent_reference: previous ? { file: index.projects[key].state_file, sha256: index.projects[key].state_sha256 } : null };
    const record = { format_version: 1, checkpoint_id: sha(canonical(base)), ...base };
    const format = require('./handoff-format.cjs');
    const history = `${input.project_id}/history/${record.created_at.replace(/[:.]/g, '')}-${record.checkpoint_id}`, bytes = Buffer.from(format.renderMarkdown(record));
    format.parseMarkdown(bytes.toString('utf8'), record);
    const stateBytes = Buffer.from(JSON.stringify(record, null, 2) + '\n');
    writeNew(root, history + '.json', stateBytes); writeNew(root, history + '.md', bytes);
    const entry = { scope: { type: 'project', project_id: input.project_id }, checkpoint_id: record.checkpoint_id, parent_checkpoint_id: record.parent_checkpoint_id, session_id: input.session_id,
      created_at: record.created_at, file: input.project_id + '/current.md', sha256: sha(bytes),
      history_file: history + '.md', state_file: history + '.json', state_sha256: sha(stateBytes), storage_status: 'local_verified' };
    const nextIndex = { ...index, projects: { ...index.projects, [input.project_id]: entry } };
    const targets = [{ file: entry.file, bytes }];
    if (UUID.test(input.session_id)) targets.push({ file: input.session_id + '-working.md', bytes });
    targets.push({ file: 'index.json', bytes: Buffer.from(JSON.stringify(nextIndex, null, 2) + '\n') });
    publish(root, targets);
    return { ...load(root, input.project_id, nextIndex), status: 'local_verified' };
  });
}
/**
 * Load the requested project alias under the store lock; integrity checks and pending transaction recovery can write recovery metadata.
 * @param {string} root Local handoff store directory.
 * @param {string} projectId Explicit project identifier or unambiguous alias.
 * @returns {object} Validated indexed checkpoint, never a newest-project fallback.
 */
function resumeProject(root, projectId) {
  projectAlias(projectId);
  return withLock(root, () => { const index = currentIndex(root); return load(root, resolveProjectId(index, projectId), index); });
}
/**
 * Return a cloned explicit assignment owned by the record session; reject missing sources, foreign ownership or completed referenced tasks.
 * @param {object} record Validated checkpoint containing chat_tasks.
 * @param {string} session Actual owner UUID.
 * @returns {object} Sourced next-step assignment; throws CHAT_TASK_UNBOUND when no explicit binding exists.
 */
function chatTaskForCheckpoint(record, session) {
  const task = record?.state?.chat_tasks?.[session];
  if (!UUID.test(session || '') || record?.session_id !== session || !object(task) || task.owner_session_id !== session ||
      typeof task.source_ref !== 'string' || !Object.hasOwn(record.state.sources || {}, task.source_ref) ||
      !object(task.next_step) || typeof task.next_step.text !== 'string' || !task.next_step.text.trim() ||
      typeof task.next_step.success_criterion !== 'string' || !task.next_step.success_criterion.trim()) {
    const error = Error('No explicit session-bound chat task; manual continuation required'); error.code = 'CHAT_TASK_UNBOUND'; throw error;
  }
  if (task.next_step.task_id && (!record.state.tasks?.[task.next_step.task_id] ||
      ['tested', 'verified'].includes(record.state.tasks[task.next_step.task_id].status))) throw Error('Chat continuation task is missing or already complete');
  return structuredClone(task);
}
/**
 * Resolve an own-session checkpoint or an explicitly named origin handoff; verify successor journal and optional manual authorization before returning continuation.
 */
function resumeChatContinuation(root, options) {
  if (options.handoff_file !== undefined) {
    if (!path.isAbsolute(options.handoff_file)) throw Error('Absolute named handoff required');
    const relative = path.relative(path.resolve(root), options.handoff_file);
    if (relative.startsWith('..') || path.isAbsolute(relative) || !relative.endsWith('.md')) throw Error('Named handoff outside store');
    const file = safe(root, relative);
    if (fs.statSync(file).size > 1024 * 1024) throw Error('Named handoff exceeds bound');
    const markdown = fs.readFileSync(file, 'utf8'), meta = require('./handoff-format.cjs').parseMarkdown(markdown).metadata;
    if (!UUID.test(options.session_id || '') || !UUID.test(meta.session_id || '') || meta.session_id === options.session_id) throw Error('Successor identity required');
    const journalFile = safe(root, meta.session_id + '-status.json');
    if (fs.statSync(journalFile).size > 4 * 1024 * 1024) throw Error('Oversized origin journal');
    const journalBytes = fs.readFileSync(journalFile), j = JSON.parse(journalBytes);
    if ((j.originThreadId || j.origin_thread_id) !== meta.session_id ||
        (j.successorThreadId || j.successor_thread_id) !== options.session_id ||
        (j.originThreadId && j.origin_thread_id && j.originThreadId !== j.origin_thread_id) ||
        (j.successorThreadId && j.successor_thread_id && j.successorThreadId !== j.successor_thread_id) ||
        !['successor_created', 'successor_visible', 'takeover_verified', 'archived_after_takeover'].includes(j.phase) ||
        (j.automationCancelledAt && !j.manualAuthorization) || j.project_id !== meta.project_id || j.checkpointId !== meta.checkpoint_id ||
        j.freshnessBaseline?.checkpoint_id !== meta.checkpoint_id || path.resolve(j.handoffFile || '') !== path.resolve(file)) throw Error('Named handoff is not bound to this successor');
    const result = resumeBoundCheckpoint(root, {session_id:meta.session_id, workspace:options.workspace, markdown});
    if (path.resolve(result.checkpoint.file) !== path.resolve(file) || !fs.readFileSync(journalFile).equals(journalBytes)) throw Error('Origin binding changed');
    const manual = j.manualAuthorization ? require('./handoff-manual-start.cjs').manualContext(j,options.session_id,
      process.env.CODEX_HOME || path.join(require('node:os').homedir(),'.codex')) : null;
    return {...result, continuation:{...chatTaskForCheckpoint(result.checkpoint,meta.session_id), origin_session_id:meta.session_id,
      ...(manual ? {manual_context:manual} : {})}};
  }
  const result = resumeBoundCheckpoint(root, options);
  return { ...result, continuation: chatTaskForCheckpoint(result.checkpoint, options.session_id) };
}
/**
 * Resolve an exact session/workspace checkpoint through verified ancestry, pinning the result to immutable history; never substitute another session latest state.
 * @param {string} root Local handoff store directory.
 * @param {object} options Canonical session_id, actual workspace and optional exact snapshot Markdown.
 * @returns {object} Bound checkpoint and current project record; throws on identity, path, hash or ancestry failure.
 */
function resumeBoundCheckpoint(root, { session_id, workspace, markdown } = {}) {
  if (!UUID.test(session_id || '') || session_id !== session_id.toLowerCase()) throw Error('Canonical session required');
  /**
   * Canonicalize an explicit local directory for workspace comparisons; reject network paths, missing directories and invalid values.
   */
  const localWorkspace = value => {
    if (typeof value !== 'string' || !path.isAbsolute(value) || value.includes('\0') ||
        (value.startsWith('\\\\') && !/^\\\\\?\\[a-z]:\\/i.test(value)) || value.startsWith('//')) throw Error('Absolute local workspace required');
    const resolved = fs.realpathSync.native(value);
    if (!fs.statSync(resolved).isDirectory()) throw Error('Workspace must be a directory');
    return resolved;
  };
  const expectedWorkspace = localWorkspace(workspace);
  /**
   * Require the record workspace, or legacy repository fallback, to canonicalize to the caller workspace; throw on mismatch.
   */
  const checkWorkspace = record => {
    const git = record.state.git, value = git && Object.hasOwn(git, 'workspace') ? git.workspace : git?.repository;
    if (path.relative(localWorkspace(value), expectedWorkspace) !== '') throw Error('Bound checkpoint workspace mismatch');
  };
  /**
   * Read one safe root-relative source with size checks before and after the read; return its bytes or reject growth beyond limit.
   */
  const boundedRead = (relative, limit) => {
    const file = safe(root, relative);
    if (fs.statSync(file).size > limit) throw Error('Bound checkpoint source exceeds limit');
    const bytes = read(root, relative);
    if (bytes.length > limit) throw Error('Bound checkpoint source grew beyond limit');
    return bytes;
  };
  return withLock(root, () => {
    const format = require('./handoff-format.cjs');
    const working = markdown === undefined ? boundedRead(session_id + '-working.md', 1024 * 1024).toString('utf8') : markdown;
    const meta = format.parseMarkdown(working).metadata;
    if (meta.session_id !== session_id) throw Error('Working session mismatch');
    const index = currentIndex(root), projectId = resolveProjectId(index, meta.project_id);
    if (projectId !== meta.project_id) throw Error('Canonical working project required');
    const current = load(root, projectId, index); checkWorkspace(current);
    let record = current, stateFile = index.projects[projectId].state_file;
    for (let depth = 0; depth < 128; depth++) {
      if (record.project_id !== projectId || sha(canonical(identity(record))) !== record.checkpoint_id) throw Error('Bound ancestor identity mismatch');
      checkJson(record.state); validateState(record.state);
      if (record.checkpoint_id === meta.checkpoint_id) {
        if (record.session_id !== session_id) throw Error('Bound ancestor session mismatch');
        checkWorkspace(record); format.parseMarkdown(working, record);
        // A writer may advance current.md immediately after this lock is released.
        // Pin every bound starter to its immutable history, even while current.
        const relative = stateFile.replace(/\.json$/, '.md');
        const bytes = boundedRead(relative, 1024 * 1024);
        format.parseMarkdown(bytes.toString('utf8'), record);
        if (!bytes.equals(Buffer.from(working, 'utf8'))) throw Error('Bound working bytes differ');
        return { checkpoint: { ...record, file: safe(root, relative), sha256: sha(bytes), storage_status: 'local_verified' }, current };
      }
      const ref = record.parent_reference;
      if (!object(ref) || typeof ref.file !== 'string' || !ref.file.startsWith(projectId + '/history/') ||
          !ref.file.endsWith('.json') || !/^[a-f0-9]{64}$/.test(ref.sha256 || '')) throw Error('No bound session ancestor');
      const history = safe(root, projectId + '/history'), candidate = safe(root, ref.file), relative = path.relative(history, candidate);
      if (relative === '..' || relative.startsWith('..' + path.sep) || path.isAbsolute(relative)) throw Error('Ancestor outside project history');
      const bytes = boundedRead(ref.file, 4 * 1024 * 1024);
      if (sha(bytes) !== ref.sha256) throw Error('Bound ancestor hash mismatch');
      const parent = JSON.parse(bytes.toString('utf8'));
      if (parent.project_id !== projectId || parent.checkpoint_id !== record.parent_checkpoint_id) throw Error('Bound ancestor project/parent mismatch');
      stateFile = ref.file; record = parent;
    }
    throw Error('Bound session ancestry exceeds 128 records');
  });
}
/**
 * Parse explicit save/resume CLI arguments and invoke the existing store; save reads one bounded input envelope and resume requires a project.
 */
function main(argv) {
  const command = argv.shift(), args = {};
  for (let i = 0; i < argv.length; i += 2) {
    if (!['--root', '--input', '--project'].includes(argv[i]) || !argv[i + 1] || args[argv[i]]) throw Error('Invalid or duplicate CLI argument');
    args[argv[i]] = argv[i + 1];
  }
  const root = args['--root'] || path.resolve(__dirname, '..', 'handoff');
  if (command === 'save' && args['--input'] && !args['--project']) {
    const file = path.resolve(args['--input']);
    if (fs.lstatSync(file).isSymbolicLink() || fs.statSync(file).size > 1024 * 1024) throw Error('Invalid input file');
    return saveCheckpoint(root, JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '')));
  }
  if (command === 'resume' && args['--project'] && !args['--input']) return resumeProject(root, args['--project']);
  throw Error('Usage: handoff-store.cjs save --input patch.json | resume --project TheHive [--root handoff-dir]');
}
if (require.main === module) {
  try { console.log(JSON.stringify(main(process.argv.slice(2)), null, 2)); }
  catch (e) { console.error(`handoff-store: ${e.message}`); process.exitCode = 1; }
}
module.exports = { saveCheckpoint, resumeProject, resumeBoundCheckpoint, chatTaskForCheckpoint, resumeChatContinuation };

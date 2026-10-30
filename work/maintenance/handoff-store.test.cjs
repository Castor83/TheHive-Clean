'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const { saveCheckpoint, resumeProject } = require('./handoff-store.cjs');
const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'thehive-handoff-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}
function input() {
  return { format_version: 1, project_id: 'TheHive', session_id: 'session-one', expected_parent: null,
    patch: { goal: 'Implement checkpoint storage', status: 'implemented', last_section: 'A3',
      decisions: { canonical: 'C:\\TheHive remains canonical' },
      authorizations: { models: 'No model calls or downloads' },
      tasks: { storage: { text: 'Checkpoint storage', status: 'implemented' },
        review: { text: 'Independent review', status: 'planned' } },
      sources: { master: { path: 'master.md', status: 'historical' } },
      next_step: { text: 'Review checkpoint recovery', success_criterion: 'Review cites persisted task' },
      retrieval_refs: { situational: 'Hör jetzt auf zu testen' } } };
}

test('new checkpoint is persisted with verifiable index, immutable history and Markdown', t => {
  const root = fixture(t), r = saveCheckpoint(root, input());
  assert.equal(r.status, 'local_verified');
  const index = JSON.parse(fs.readFileSync(path.join(root, 'index.json')));
  const entry = index.projects.TheHive;
  assert.equal(entry.checkpoint_id, r.checkpoint_id);
  assert.equal(hash(fs.readFileSync(r.file)), entry.sha256);
  assert.equal(fs.readFileSync(r.file, 'utf8'), fs.readFileSync(path.join(root, entry.history_file), 'utf8'));
  const loaded = resumeProject(root, 'TheHive');
  assert.equal(loaded.state.next_step.text, 'Review checkpoint recovery');
  assert.equal(loaded.session_id, 'session-one');
  assert.equal(loaded.parent_checkpoint_id, null);
  assert.equal(loaded.state.retrieval_refs.situational, 'Hör jetzt auf zu testen');
  assert.equal(fs.existsSync(path.join(root, '..', 'Brain')), false);
});

test('identical retry makes no new history, index rewrite or backup', t => {
  const root = fixture(t), first = saveCheckpoint(root, input());
  const snapshot = fs.readFileSync(path.join(root, 'index.json'));
  const history = fs.readdirSync(path.join(root, 'TheHive', 'history'));
  const second = saveCheckpoint(root, input());
  assert.equal(second.status, 'unchanged');
  assert.equal(second.checkpoint_id, first.checkpoint_id);
  assert.deepEqual(fs.readFileSync(path.join(root, 'index.json')), snapshot);
  assert.deepEqual(fs.readdirSync(path.join(root, 'TheHive', 'history')), history);
  assert.equal(fs.existsSync(path.join(root, 'backups')), false);
});

test('incremental task update preserves decisions and source references and backs up prior current', t => {
  const root = fixture(t), first = saveCheckpoint(root, input());
  const original = fs.readFileSync(first.file);
  const second = saveCheckpoint(root, { format_version: 1, project_id: 'TheHive', session_id: 'session-one',
    expected_parent: first.checkpoint_id, patch: { tasks: { storage: { status: 'tested', evidence: 'new A6 test result' },
      bridge: { text: 'Bridge adapter', status: 'planned' } } } });
  const loaded = resumeProject(root, 'TheHive');
  assert.equal(loaded.parent_checkpoint_id, first.checkpoint_id);
  assert.equal(loaded.state.tasks.storage.text, 'Checkpoint storage');
  assert.equal(loaded.state.tasks.storage.status, 'tested');
  assert.equal(loaded.state.tasks.review.status, 'planned');
  assert.equal(loaded.state.decisions.canonical, 'C:\\TheHive remains canonical');
  assert.equal(loaded.state.sources.master.path, 'master.md');
  assert.notEqual(second.checkpoint_id, first.checkpoint_id);
  assert.ok(fs.readdirSync(path.join(root, 'backups')).some(name =>
    fs.readFileSync(path.join(root, 'backups', name)).equals(original)));
});

test('stale parent, writer lock, invalid schema and durable promotion cannot overwrite valid state', t => {
  const root = fixture(t), first = saveCheckpoint(root, input());
  const before = fs.readFileSync(first.file);
  const change = { ...input(), expected_parent: null, patch: { goal: 'Stale writer' } };
  assert.throws(() => saveCheckpoint(root, change), /conflict/i);
  for (const invalid of [
    { ...input(), project_id: '../Brain' },
    { ...input(), expected_parent: first.checkpoint_id, patch: { durable_knowledge: 'promote' } },
    { ...input(), expected_parent: first.checkpoint_id, patch: { durable_candidates: { x: { status: 'approved' } } } },
    { ...input(), expected_parent: first.checkpoint_id, patch: JSON.parse('{"decisions":{"__proto__":{"polluted":true}}}') },
  ]) assert.throws(() => saveCheckpoint(root, invalid));
  fs.writeFileSync(path.join(root, '.writer.lock'), JSON.stringify({ pid: process.pid }));
  assert.throws(() => saveCheckpoint(root, input()), /lock|writer/i);
  fs.unlinkSync(path.join(root, '.writer.lock'));
  assert.deepEqual(fs.readFileSync(first.file), before);
  assert.equal(resumeProject(root, 'TheHive').checkpoint_id, first.checkpoint_id);
});

test('project retrieval is isolated; corrupted current is rejected instead of silently trusted', t => {
  const root = fixture(t), first = saveCheckpoint(root, input());
  saveCheckpoint(root, { ...input(), project_id: 'PC', patch: { ...input().patch,
    goal: 'Private PC task', next_step: { text: 'Check cable', success_criterion: 'Cable attached' } } });
  const hive = resumeProject(root, 'TheHive');
  assert.equal(hive.state.goal, 'Implement checkpoint storage');
  assert.doesNotMatch(JSON.stringify(hive), /Private PC task/);
  assert.throws(() => resumeProject(root, 'Unknown'), /not found/i);
  fs.appendFileSync(first.file, '\ncorrupted');
  assert.throws(() => resumeProject(root, 'TheHive'), /hash|integrity/i);
});

test('failed index publication rolls current back while preserving last confirmed index', t => {
  const root = fixture(t), first = saveCheckpoint(root, input());
  const currentBefore = fs.readFileSync(first.file), indexFile = path.join(root, 'index.json');
  const indexBefore = fs.readFileSync(indexFile), rename = fs.renameSync;
  fs.renameSync = function (from, to) {
    if (to === indexFile && String(from).endsWith('.pending')) throw Error('injected disk publication failure');
    return rename.apply(this, arguments);
  };
  try {
    assert.throws(() => saveCheckpoint(root, { ...input(), expected_parent: first.checkpoint_id,
      patch: { goal: 'Changed goal' } }), /publication failure/);
  } finally { fs.renameSync = rename; }
  assert.deepEqual(fs.readFileSync(first.file), currentBefore);
  assert.deepEqual(fs.readFileSync(indexFile), indexBefore);
  assert.equal(resumeProject(root, 'TheHive').checkpoint_id, first.checkpoint_id);
});

test('unmanaged existing current and symlink destination are preserved', t => {
  const root = fixture(t);
  fs.mkdirSync(path.join(root, 'TheHive'));
  const file = path.join(root, 'TheHive', 'current.md');
  fs.writeFileSync(file, 'existing handoff not yet enrolled');
  assert.throws(() => saveCheckpoint(root, input()), /unmanaged|conflict/i);
  assert.equal(fs.readFileSync(file, 'utf8'), 'existing handoff not yet enrolled');
  // Windows junctions need no symlink privilege; redirecting a project must be rejected.
  const other = fixture(t);
  fs.symlinkSync(other, path.join(root, 'PC'), 'junction');
  assert.throws(() => saveCheckpoint(root, { ...input(), project_id: 'PC' }), /link|junction/i);
  assert.deepEqual(fs.readdirSync(other), []);
});

test('checkpoints without source, status or last section cannot become local_verified', t => {
  const root = fixture(t);
  for (const field of ['sources', 'status', 'last_section']) {
    const data = input(); delete data.patch[field];
    assert.throws(() => saveCheckpoint(root, data), /Schema/);
  }
  assert.equal(fs.existsSync(path.join(root, 'index.json')), false);
});

test('an exclusive lock-acquisition guard prevents concurrent stale-lock takeover', t => {
  const root = fixture(t), dead = spawnSync(process.execPath, ['-e', 'process.exit(0)']);
  fs.writeFileSync(path.join(root, '.writer.lock'), JSON.stringify({ pid: dead.pid, host: os.hostname() }));
  fs.writeFileSync(path.join(root, '.lock-gate'), JSON.stringify({ pid: process.pid, host: os.hostname() }));
  assert.throws(() => saveCheckpoint(root, input()), /lock|acquisition/i);
  assert.equal(JSON.parse(fs.readFileSync(path.join(root, '.writer.lock'))).pid, dead.pid);
  assert.equal(fs.existsSync(path.join(root, 'index.json')), false);
});

test('process crash before commit is recovered to previous current and isolated project remains unchanged', t => {
  const root = fixture(t), first = saveCheckpoint(root, input());
  const pc = saveCheckpoint(root, { ...input(), project_id: 'PC' });
  const pcBytes = fs.readFileSync(pc.file), before = fs.readFileSync(first.file);
  const script = `const fs=require('node:fs'), path=require('node:path');
    const store=require(${JSON.stringify(require.resolve('./handoff-store.cjs'))});
    const rename=fs.renameSync;
    fs.renameSync=function(a,b){const r=rename.apply(this,arguments);if(b===path.join(process.argv[1],'TheHive','current.md'))process.exit(47);return r};
    store.saveCheckpoint(process.argv[1], JSON.parse(process.argv[2]));`;
  const changed = { ...input(), expected_parent: first.checkpoint_id, patch: { goal: 'Uncommitted update' } };
  const child = spawnSync(process.execPath, ['-e', script, root, JSON.stringify(changed)], { windowsHide: true });
  assert.equal(child.status, 47, child.stderr?.toString());
  const resumed = resumeProject(root, 'TheHive');
  assert.equal(resumed.checkpoint_id, first.checkpoint_id);
  assert.deepEqual(fs.readFileSync(first.file), before);
  assert.deepEqual(fs.readFileSync(pc.file), pcBytes);
  assert.equal(resumeProject(root, 'PC').checkpoint_id, pc.checkpoint_id);
  assert.equal(fs.existsSync(path.join(root, '.transaction.json')), false);
});

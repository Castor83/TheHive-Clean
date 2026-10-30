'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const bridge = require('./handoff-bridge.cjs');

function fixture(t, raw) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'thehive-bridge-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const source = path.join(dir, 'checkpoint.json');
  fs.writeFileSync(source, raw ?? JSON.stringify({ format_version: 1, project_id: 'TheHive',
    session_id: 'bridge-test', expected_parent: null,
    patch: { goal: 'Fortsetzung', status: 'planned', last_section: 'A3', tasks: { review: { text: 'Prüfer separat abnehmen', status: 'planned' } },
      next_step: { text: 'Prüfer abnehmen', success_criterion: 'Menschliche Sollfälle verglichen' },
      sources: { original: { path: 'C:\\TheHive\\work\\handoff\\TheHive\\master.md' } } } }));
  return { dir, source, root: path.join(dir, 'handoff') };
}

// Break caught: a preview writes a checkpoint or claims the source is in the vault.
test('preview only fingerprints a synchronized local envelope and leaves the vault absent', t => {
  const { source, root } = fixture(t);
  const preview = bridge.execute({ source, root, apply: false });
  assert.equal(preview.status, 'preview_only');
  assert.equal(preview.storage_stage, 'pc_synced');
  assert.equal(preview.project_id, 'TheHive');
  assert.equal(preview.sha256, crypto.createHash('sha256').update(fs.readFileSync(source)).digest('hex'));
  assert.equal(fs.existsSync(root), false);
});

// Break caught: changed/partial sync accepted merely because an old preview succeeded.
test('apply rejects a source changed after preview without touching the vault', t => {
  const { source, root } = fixture(t);
  const preview = bridge.execute({ source, root, apply: false });
  fs.appendFileSync(source, '\n');
  assert.throws(() => bridge.execute({ source, root, apply: true, confirmSha256: preview.sha256 }), /Hash|hash|geändert/);
  assert.equal(fs.existsSync(root), false);
});

// Break caught: malformed and oversized files reach the store or a link is followed.
test('malformed and oversized transfer files are refused', t => {
  const { source, root } = fixture(t, '{"format_version":1,');
  assert.throws(() => bridge.execute({ source, root, apply: false }), /JSON|unvollständig/);
  fs.writeFileSync(source, ' '.repeat(1024 * 1024 + 1));
  assert.throws(() => bridge.execute({ source, root, apply: false }), /MiB|groß/);
  assert.equal(fs.existsSync(root), false);
});

test('a directory source is refused before any write', t => {
  const { dir, root } = fixture(t);
  assert.throws(() => bridge.execute({ source: dir, root, apply: false }), /Einzeldatei|Datei/);
  assert.equal(fs.existsSync(root), false);
});

test('source through a directory junction is refused', t => {
  const { dir, source, root } = fixture(t);
  const link = path.join(dir, 'linked');
  fs.symlinkSync(dir, link, process.platform === 'win32' ? 'junction' : 'dir');
  assert.throws(() => bridge.execute({ source: path.join(link, path.basename(source)), root, apply: false }), /Link|link|Verknüpfung/);
  assert.equal(fs.existsSync(root), false);
});

// Break caught: implicit apply/default apply allows an unaudited write.
test('CLI defaults to preview and refuses missing hash confirmation or unknown flags', t => {
  const { source, root } = fixture(t);
  const options = bridge.parseArgs(['--source', source, '--root', root]);
  assert.equal(options.apply, false);
  assert.throws(() => bridge.parseArgs(['--source', source, '--apply']), /confirm-sha256/);
  assert.throws(() => bridge.parseArgs(['--source', source, '--confirm-sha256', 'a'.repeat(64)]), /apply/);
  assert.throws(() => bridge.parseArgs(['--source', source, '--export']), /Unbekannt/);
  const command = spawnSync(process.execPath, [path.join(__dirname, 'handoff-bridge.cjs'), '--source', source, '--root', root], { encoding: 'utf8', windowsHide: true });
  assert.equal(command.status, 0, command.stderr);
  assert.equal(JSON.parse(command.stdout).status, 'preview_only');
  assert.equal(fs.existsSync(root), false);
});

// Break caught: apply reports success before the store persists a verifiable file,
// or a later incomplete transfer destroys the last valid checkpoint.
test('confirmed intake uses the real checkpoint store and preserves the last valid revision on transfer failure', t => {
  const { source, root } = fixture(t);
  const preview = bridge.execute({ source, root, apply: false });
  const saved = bridge.execute({ source, root, apply: true, confirmSha256: preview.sha256 });
  assert.equal(saved.status, 'local_verified');
  assert.equal(saved.storage_stage, 'local_verified');
  const store = require('./handoff-store.cjs');
  const loaded = store.resumeProject(root, 'TheHive');
  assert.equal(loaded.checkpoint_id, saved.checkpoint_id);
  assert.equal(loaded.state.goal, 'Fortsetzung');
  assert.equal(loaded.state.tasks.review.status, 'planned');
  assert.equal(crypto.createHash('sha256').update(fs.readFileSync(saved.file)).digest('hex'), saved.sha256);
  fs.writeFileSync(source, '{"format_version":1,');
  assert.throws(() => bridge.execute({ source, root, apply: true, confirmSha256: preview.sha256 }), /JSON|unvollständig/);
  assert.equal(store.resumeProject(root, 'TheHive').checkpoint_id, saved.checkpoint_id);
});

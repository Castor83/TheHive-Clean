'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { saveCheckpoint, resumeProject } = require('./handoff-store.cjs');

// Break caught: Windows Git line-ending conversion invalidates committed hashes
// after checkout, making an otherwise intact checkpoint impossible to resume.
test('checkpoint hashes survive a real Git checkout with Windows autocrlf enabled', t => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'thehive-git-'));
  t.after(() => fs.rmSync(repo, { recursive: true, force: true }));
  const root = path.join(repo, 'work', 'handoff');
  function git(args) {
    const r = spawnSync('git', ['-c', 'core.autocrlf=true', ...args], { cwd: repo, encoding: 'utf8', windowsHide: true });
    assert.equal(r.status, 0, r.stderr); return r;
  }
  git(['init']);
  const saved = saveCheckpoint(root, { format_version: 1, project_id: 'TheHive', session_id: 'git-checkout', expected_parent: null,
    patch: { goal: 'Preserve checkpoint bytes', status: 'implemented', last_section: 'Git persistence',
      sources: { source: { reference: 'A3 hash invariant' } }, next_step: { text: 'Read after checkout', success_criterion: 'Hashes match' } } });
  const attributes = path.join(__dirname, '..', 'handoff', '.gitattributes');
  if (fs.existsSync(attributes)) fs.copyFileSync(attributes, path.join(root, '.gitattributes'));
  git(['add', '--', 'work/handoff']);
  git(['-c', 'user.name=Codex test', '-c', 'user.email=codex@localhost', 'commit', '-m', 'fixture']);
  for (const file of git(['ls-files', '-z']).stdout.split('\0').filter(Boolean)) fs.unlinkSync(path.join(repo, file));
  git(['checkout-index', '--all', '--force']);
  assert.equal(resumeProject(root, 'TheHive').checkpoint_id, saved.checkpoint_id);
});

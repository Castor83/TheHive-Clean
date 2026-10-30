'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const { saveCheckpoint } = require('./handoff-store.cjs');
const bun = path.join(os.homedir(), '.bun', 'bin', 'bun.exe');
const script = path.join(__dirname, 'handoff-resume.ts');

/**
 * Create parent directories and write fixture bytes at the supplied temporary path.
 */
function put(file, bytes) { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, bytes); }
/**
 * Recursively record fixture file hashes and symlink targets to detect persistent writes during reader calls.
 */
function manifest(dir) {
  const out = {};
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const file = path.join(dir, entry.name);
    if (entry.isSymbolicLink()) out[entry.name] = 'link:' + fs.readlinkSync(file);
    else if (entry.isDirectory()) for (const [k, v] of Object.entries(manifest(file))) out[entry.name + '/' + k] = v;
    else out[entry.name] = crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
  }
  return out;
}
/**
 * Create a temporary sourced checkpoint plus distinct global/project/foreign rules and an unapproved preference for scope-isolation assertions.
 */
function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'thehive-resume-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const vault = path.join(dir, 'vault'), workspace = path.join(dir, 'TheHive');
  fs.mkdirSync(workspace, { recursive: true });
  const saved = saveCheckpoint(path.join(vault, 'work', 'handoff'), {
    format_version: 1, project_id: 'TheHive', session_id: 'resume-test', expected_parent: null,
    patch: { goal: 'Gezielte Fortsetzung', status: 'implemented', last_section: 'Anhang A9',
      sources: { original: { path: path.join(dir, 'auftrag.md') } },
      next_step: { text: 'Genau gespeicherte nächste Aktion', success_criterion: 'Aktion fachlich geprüft' } }
  });
  put(path.join(vault, 'Brain', 'standing-rules.md'), 'GLOBAL_APPROVED\n');
  put(path.join(vault, 'Brain', 'standing-rules', 'project', 'thehive.md'), 'THEHIVE_APPROVED\n');
  put(path.join(vault, 'Brain', 'standing-rules', 'project', 'other.md'), 'FOREIGN_PRIVATE_RULE\n');
  put(path.join(vault, 'Brain', 'preferences', 'pref-do-not-load.md'), 'NOT_SCOPE_BOUND_PREFERENCE\n');
  return { dir, vault, workspace, saved };
}
/**
 * Spawn the existing Bun resume CLI against the fixture project/workspace/vault with optional arguments and environment; return its bounded process result.
 */
function run(f, extras = [], env = {}) {
  return spawnSync(bun, ['run', script, '--project', 'TheHive', '--workspace', f.workspace, '--vault', f.vault, ...extras], {
    encoding: 'utf8', windowsHide: true, env: { ...process.env, ...env }, timeout: 30000,
  });
}

// Break caught: loading newest/foreign checkpoint or reading broad memory instead of exact rules.
test('resumes exact checkpoint and only existing global plus pointer-bound project rules without persistent writes', t => {
  const f = fixture(t);
  put(path.join(f.workspace, '.o2b-vault.json'), JSON.stringify({ vault: f.vault }));
  const before = manifest(f.dir), result = run(f);
  assert.equal(result.status, 0, result.stderr);
  const output = JSON.parse(result.stdout);
  assert.equal(output.checkpoint.checkpoint_id, f.saved.checkpoint_id);
  assert.equal(output.checkpoint.state.next_step.text, 'Genau gespeicherte nächste Aktion');
  assert.equal(output.rules.global.status, 'loaded');
  assert.equal(output.rules.global.text, 'GLOBAL_APPROVED');
  assert.equal(output.rules.project.status, 'loaded');
  assert.match(output.rules.project.text, /THEHIVE_APPROVED/);
  assert.doesNotMatch(result.stdout, /FOREIGN_PRIVATE_RULE|NOT_SCOPE_BOUND_PREFERENCE/);
  assert.equal(output.rules.learned_preferences.status, 'not_loaded');
  assert.deepEqual(manifest(f.dir), before);
});

test('missing pointer and mismatched project binding hold project rules instead of guessing', t => {
  const f = fixture(t);
  const missing = run(f);
  assert.equal(missing.status, 0, missing.stderr);
  assert.equal(JSON.parse(missing.stdout).rules.project.status, 'binding_unavailable');
  assert.doesNotMatch(missing.stdout, /THEHIVE_APPROVED|FOREIGN_PRIVATE_RULE/);
  const other = path.join(f.dir, 'Other');
  put(path.join(other, '.o2b-vault.json'), JSON.stringify({ vault: f.vault }));
  f.workspace = other;
  const mismatch = run(f);
  assert.equal(mismatch.status, 0, mismatch.stderr);
  assert.equal(JSON.parse(mismatch.stdout).rules.project.status, 'scope_mismatch');
  assert.doesNotMatch(mismatch.stdout, /THEHIVE_APPROVED|FOREIGN_PRIVATE_RULE/);
});

test('unknown or omitted project fails before loading rule modules and has no newest fallback', t => {
  const f = fixture(t);
  const unknown = spawnSync(bun, ['run', script, '--project', 'Unknown', '--vault', f.vault], {
    encoding: 'utf8', windowsHide: true, env: { ...process.env, OSB_SOURCE: path.join(f.dir, 'absent-osb') }, timeout: 30000,
  });
  assert.notEqual(unknown.status, 0);
  assert.match(unknown.stderr, /Project not found/);
  const omitted = spawnSync(bun, ['run', script, '--vault', f.vault], { encoding: 'utf8', windowsHide: true, timeout: 30000 });
  assert.notEqual(omitted.status, 0);
  assert.match(omitted.stderr, /--project/);
});

test('missing and unreadable rule classes are reported honestly', t => {
  const f = fixture(t);
  put(path.join(f.workspace, '.o2b-vault.json'), JSON.stringify({ vault: f.vault }));
  fs.unlinkSync(path.join(f.vault, 'Brain', 'standing-rules.md'));
  fs.unlinkSync(path.join(f.vault, 'Brain', 'standing-rules', 'project', 'thehive.md'));
  let result = run(f);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).rules.global.status, 'missing');
  assert.equal(JSON.parse(result.stdout).rules.project.status, 'missing');
  fs.mkdirSync(path.join(f.vault, 'Brain', 'standing-rules.md'));
  fs.mkdirSync(path.join(f.vault, 'Brain', 'standing-rules', 'project', 'thehive.md'));
  result = run(f);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).rules.global.status, 'unavailable');
  assert.equal(JSON.parse(result.stdout).rules.project.status, 'unavailable');
});

test('existing OSB reader truncation is retained in the result', t => {
  const f = fixture(t);
  put(path.join(f.workspace, '.o2b-vault.json'), JSON.stringify({ vault: f.vault }));
  put(path.join(f.vault, 'Brain', 'standing-rules.md'), ('GLOBAL RULE\n').repeat(5000));
  put(path.join(f.vault, 'Brain', 'standing-rules', 'project', 'thehive.md'), ('PROJECT RULE\n').repeat(5000));
  const result = run(f);
  assert.equal(result.status, 0, result.stderr);
  const output = JSON.parse(result.stdout);
  assert.equal(output.rules.global.truncated, true);
  assert.equal(output.rules.project.truncated, true);
});

// New self-binding cases run only with --test-name-pattern="local fixed self-binding".
// The fixture adapter changes the approved ROOT CONSTANT in an isolated copy;
// production has no option/environment override for that authorization.
/**
 * Create an isolated vault and adapt only the fixed-root constant in a temporary reader copy; preserve production authorization and register verified cleanup.
 */
function selfFixture(t, projectId = 'TheHive') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'thehive-self-binding-'));
  const realDir = fs.realpathSync.native(dir);
  t.after(() => {
    const target = fs.realpathSync.native(dir);
    assert.equal(target, realDir);
    assert.equal(path.dirname(target), fs.realpathSync.native(os.tmpdir()));
    assert.ok(path.basename(target).startsWith('thehive-self-binding-'));
    fs.rmSync(target, { recursive: true, force: true });
  });
  const vault = path.join(dir, 'vault');
  const saved = saveCheckpoint(path.join(vault, 'work', 'handoff'), {
    format_version: 1, project_id: projectId, session_id: 'self-binding-test', expected_parent: null,
    patch: { goal: 'Isolated self-binding fixture', status: 'implemented', last_section: 'fixture',
      sources: { request: { path: path.join(dir, 'request.md') } },
      next_step: { text: 'Fixture next step', success_criterion: 'Fixture only' } }
  });
  put(path.join(vault, 'Brain', 'standing-rules.md'), 'GLOBAL_EXISTING_BOUNDARY\n');
  put(path.join(vault, 'Brain', 'standing-rules', 'project', 'thehive.md'), 'ROOT_PROJECT_RULE\n');
  put(path.join(vault, 'Brain', 'standing-rules', 'project', 'other.md'), 'OTHER_PROJECT_RULE\n');
  put(path.join(vault, 'Brain', 'standing-rules', 'host', 'host.md'), 'DO_NOT_LOAD_HOST\n');
  put(path.join(vault, 'Brain', 'preferences', 'pref-test.md'), 'DO_NOT_LOAD_PREFERENCE\n');
  const original = fs.readFileSync(script, 'utf8');
  const rootDeclaration = "const LOCAL_FIXED_ROOT = 'C:\\\\TheHive';";
  assert.ok(original.split(rootDeclaration).length <= 2, 'at most one fixed production authorization');
  const adapted = original.replace(rootDeclaration, `const LOCAL_FIXED_ROOT = ${JSON.stringify(vault)};`)
    .replace("require('./handoff-store.cjs')", `require(${JSON.stringify(path.join(__dirname, 'handoff-store.cjs'))})`);
  const fixtureScript = path.join(dir, 'resume.ts');
  put(fixtureScript, adapted);
  return { dir, vault, saved, fixtureScript };
}
/**
 * Run the selected fixture or production reader with explicit project/workspace/vault options; assert CLI success and return parsed output.
 */
function selfRun(f, { project = f.saved.project_id, workspace = f.vault, vault = f.vault, actualAdapter = false } = {}) {
  const argv = ['run', actualAdapter ? script : f.fixtureScript, '--project', project, '--vault', vault];
  if (workspace !== null) argv.push('--workspace', workspace);
  const result = spawnSync(bun, argv, { encoding: 'utf8', windowsHide: true, timeout: 30000 });
  assert.equal(result.status, 0, result.stderr);
  return { result, output: JSON.parse(result.stdout) };
}

test('local fixed self-binding loads exact project only, reports paths and preserves missing rules', t => {
  const f = selfFixture(t), before = manifest(f.dir);
  const { output, result } = selfRun(f);
  assert.equal(output.rules.project.status, 'loaded');
  assert.match(output.rules.project.text, /ROOT_PROJECT_RULE/);
  assert.equal(output.rules.project.binding.type, 'local_fixed_self_binding');
  assert.equal(output.rules.project.binding.project_id, 'TheHive');
  for (const p of Object.values(output.rules.project.binding.canonical_paths)) {
    assert.equal(path.relative(p, fs.realpathSync.native(f.vault)), '');
  }
  assert.equal(Object.keys(output.rules.project.binding.canonical_paths).length, 3);
  assert.equal(output.rules.global.text, 'GLOBAL_EXISTING_BOUNDARY');
  assert.equal(output.rules.learned_preferences.status, 'not_loaded');
  assert.doesNotMatch(result.stdout, /OTHER_PROJECT_RULE|DO_NOT_LOAD_HOST|DO_NOT_LOAD_PREFERENCE/);
  assert.equal(fs.existsSync(path.join(f.vault, '.o2b-vault.json')), false);
  assert.deepEqual(manifest(f.dir), before);
  // Caller aliases resolve to the exact persisted ID; they do not grant authority.
  assert.equal(selfRun(f, { project: 'thehive' }).output.checkpoint.project_id, 'TheHive');
  fs.unlinkSync(path.join(f.vault, 'Brain', 'standing-rules', 'project', 'thehive.md'));
  const missingBefore = manifest(f.dir), missing = selfRun(f).output;
  assert.equal(missing.rules.project.status, 'missing');
  assert.equal(missing.rules.project.binding.type, 'local_fixed_self_binding');
  assert.deepEqual(manifest(f.dir), missingBefore);
  // --vault cannot turn a temp vault into production's authorized C:\TheHive.
  assert.equal(selfRun(f, { actualAdapter: true }).output.rules.project.status, 'binding_unavailable');
});

test('local fixed self-binding rejects checkpoint spelling variants and missing, foreign or nested workspaces', t => {
  for (const id of ['thehive', 'THEHIVE', 'Thehive', 'The_Hive']) {
    const f = selfFixture(t, id), { output, result } = selfRun(f);
    assert.equal(output.checkpoint.project_id, id);
    assert.equal(output.rules.project.status, 'binding_unavailable');
    assert.equal(output.rules.project.reason_code, 'checkpoint_project_id_mismatch');
    assert.equal(output.rules.project.binding, undefined);
    assert.doesNotMatch(result.stdout, /ROOT_PROJECT_RULE/);
  }
  const f = selfFixture(t), child = path.join(f.vault, 'child'), foreign = path.join(f.dir, 'foreign');
  fs.mkdirSync(child); fs.mkdirSync(foreign);
  // Even an unsupported manual parent pointer must not leak Root scope to children.
  put(path.join(f.vault, '.o2b-vault.json'), JSON.stringify({ vault: f.vault }));
  for (const workspace of [null, child, foreign, path.join(f.dir, 'absent')]) {
    const { output, result } = selfRun(f, { workspace });
    assert.equal(output.rules.project.status, 'binding_unavailable');
    assert.equal(output.rules.project.binding, undefined);
    assert.doesNotMatch(result.stdout, /ROOT_PROJECT_RULE/);
  }
});

test('local fixed self-binding canonicalizes Windows spellings and accepts only aliases of the same target', t => {
  const f = selfFixture(t);
  for (const workspace of [f.vault.toUpperCase(), f.vault.replaceAll('\\', '/')]) {
    assert.equal(selfRun(f, { workspace }).output.rules.project.binding.type, 'local_fixed_self_binding');
  }
  const same = path.join(f.dir, 'same'), other = path.join(f.dir, 'other'), different = path.join(f.dir, 'different');
  fs.mkdirSync(other);
  fs.symlinkSync(f.vault, same, 'junction');
  fs.symlinkSync(other, different, 'junction');
  assert.equal(selfRun(f, { workspace: same }).output.rules.project.binding.type, 'local_fixed_self_binding');
  assert.equal(selfRun(f, { workspace: different }).output.rules.project.status, 'binding_unavailable');
  const broken = path.join(f.dir, 'broken');
  fs.symlinkSync(path.join(f.dir, 'not-present'), broken, 'junction');
  const unavailable = selfRun(f, { workspace: broken }).output.rules.project;
  assert.equal(unavailable.status, 'binding_unavailable');
  assert.equal(unavailable.reason_code, 'canonical_path_unavailable');
  const short = spawnSync('cmd.exe', ['/d', '/c', `for %I in ("${f.vault}") do @echo %~sI`], {
    encoding: 'utf8', windowsHide: true, windowsVerbatimArguments: true,
  });
  assert.equal(short.status, 0, short.stderr);
  const shortPath = short.stdout.trim();
  if (shortPath.toLowerCase() !== f.vault.toLowerCase()) {
    const project = selfRun(f, { workspace: shortPath }).output.rules.project;
    assert.equal(project.binding?.type, 'local_fixed_self_binding', JSON.stringify({ shortPath, project }));
  } else t.diagnostic('8.3 alias unavailable on this volume; no distinct short-name case claimed');
});

test('local fixed self-binding preserves external pointer workspaces and their exact project scope', t => {
  const f = selfFixture(t);
  saveCheckpoint(path.join(f.vault, 'work', 'handoff'), {
    format_version: 1, project_id: 'Other', session_id: 'external-test', expected_parent: null,
    patch: { goal: 'Other fixture', status: 'implemented', last_section: 'fixture',
      sources: { request: { path: path.join(f.dir, 'other.md') } },
      next_step: { text: 'Other next', success_criterion: 'Other only' } }
  });
  const external = path.join(f.dir, 'Other');
  put(path.join(external, '.o2b-vault.json'), JSON.stringify({ vault: f.vault }));
  const before = manifest(f.dir), { output, result } = selfRun(f, { project: 'Other', workspace: external });
  assert.equal(output.rules.project.status, 'loaded');
  assert.equal(output.rules.project.resolved_scope, 'other');
  assert.equal(output.rules.project.binding, undefined);
  assert.match(output.rules.project.text, /OTHER_PROJECT_RULE/);
  assert.doesNotMatch(result.stdout, /ROOT_PROJECT_RULE|DO_NOT_LOAD_PREFERENCE/);
  assert.deepEqual(manifest(f.dir), before);
  const mismatch = selfRun(f, { project: 'TheHive', workspace: external }).output.rules.project;
  assert.equal(mismatch.status, 'scope_mismatch');
  // A valid external vault/pointer must not depend on the fixed local root existing.
  const unavailableRootScript = path.join(f.dir, 'resume-unavailable-root.ts');
  const fixtureRoot = `const LOCAL_FIXED_ROOT = ${JSON.stringify(f.vault)};`;
  put(unavailableRootScript, fs.readFileSync(f.fixtureScript, 'utf8').replace(fixtureRoot,
    `const LOCAL_FIXED_ROOT = ${JSON.stringify(path.join(f.dir, 'missing-fixed-root'))};`));
  const independent = selfRun({ ...f, fixtureScript: unavailableRootScript }, { project: 'Other', workspace: external }).output;
  assert.equal(independent.rules.project.status, 'loaded');
  assert.equal(independent.rules.project.resolved_scope, 'other');
  assert.equal(independent.rules.project.binding, undefined);
});

// Breaks caught: guessing human permission from status/scope, dropping source or
// application checks, broad recall, and turning advisory data into operator rules.
/**
 * Create synthetic confirmed preference, signal provenance, successful application log and matching trusted grant; allow deliberate metadata changes.
 */
function preferenceFixture(t, changes = {}) {
  const f = selfFixture(t);
  const principle = 'FIXTURE_ONLY: cite the checked project artifact.';
  const hash = crypto.createHash('sha256').update(principle + '\nthehive').digest('hex');
  f.pref = { kind: 'brain-preference', id: 'pref-test', created_at: '2026-10-20T10:00:00Z',
    _confirmed_at: '2026-10-21T11:00:00Z', unconfirmed_until: '2026-11-20T10:00:00Z',
    tags: ['brain'], topic: 'fixture', scope: 'thehive', _status: 'confirmed', principle,
    _evidenced_by: ['[[sig-fixture]]'], _content_hash: hash, ...changes };
  f.preferenceFile = path.join(f.vault, 'Brain', 'preferences', 'pref-test.md');
  writeFixturePreference(f);
  put(path.join(f.vault, 'Brain', 'inbox', 'sig-fixture.md'), fixtureMarkdown({
    kind: 'brain-signal', id: 'sig-fixture', created_at: '2026-10-19T10:00:00Z',
    tags: ['brain'], topic: 'fixture', scope: 'thehive', signal: 'positive',
    agent: '@codex-desktop-agent', principle, session_ref: 'fixture-origin#turn-1',
  }));
  f.artifact = '10_Projekte/fixture-artifact.md';
  put(path.join(f.vault, f.artifact), 'Isolated reviewed fixture result.\n');
  f.event = { ts: '2026-10-21T11:00:00Z', kind: 'apply-evidence', payload: {
    preference: '[[pref-test]]', result: 'applied', outcome: 'success',
    artifact: `[[${f.artifact}]]`, agent: '@codex-desktop-agent',
  } };
  f.logFile = path.join(f.vault, 'Brain', 'log', '2026-10-21.jsonl');
  put(f.logFile, JSON.stringify(f.event) + '\n');
  f.grant = { project_id: 'TheHive', scope: 'thehive', preference_id: 'pref-test',
    content_hash: hash, source_ref: 'fixture-human-approval#turn-2',
    application: { artifact: f.artifact,
      sha256: crypto.createHash('sha256').update('Isolated reviewed fixture result.\n').digest('hex') } };
  return f;
}
/**
 * Serialize defined fixture metadata as JSON-valued YAML frontmatter for existing OSB parsers.
 */
function fixtureMarkdown(meta) {
  return '---\n' + Object.entries(meta).filter(([, v]) => v !== undefined)
    .map(([k, v]) => `${k}: ${JSON.stringify(v)}`).join('\n') + '\n---\n';
}
/**
 * Write the fixture current preference metadata to its temporary preference file.
 */
function writeFixturePreference(f) { put(f.preferenceFile, fixtureMarkdown(f.pref)); }
/**
 * Write a temporary caller supplying explicit trusted grants, invoke Bun and require all reader-visible fixture files to remain unchanged.
 */
function preferenceRun(f, grants = [f.grant], workspace = f.vault) {
  const caller = path.join(f.dir, 'preference-caller.ts');
  put(caller, `import { resumeWithRules } from ${JSON.stringify(f.fixtureScript)};\n` +
    `console.log(JSON.stringify(await resumeWithRules(${JSON.stringify({project:'TheHive', workspace, vault:f.vault})}, ${JSON.stringify(grants)})));\n`);
  const before = manifest(f.dir);
  const result = spawnSync(bun, ['run', caller], { encoding: 'utf8', windowsHide: true, timeout: 30000 });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(manifest(f.dir), before, 'resume must only read fixture files');
  return { output: JSON.parse(result.stdout), result };
}

test('learned preference loads only explicitly authorized exact-project data with provenance and checked application', t => {
  const f = preferenceFixture(t), { output } = preferenceRun(f);
  const data = output.rules.learned_preferences;
  assert.equal(data.status, 'loaded');
  assert.equal(data.data_class, 'learned_preference');
  assert.equal(data.authority, 'advisory');
  assert.equal(data.items.length, 1);
  assert.equal(data.items[0].id, 'pref-test');
  assert.equal(data.items[0].principle, 'FIXTURE_ONLY: cite the checked project artifact.');
  assert.equal(data.items[0].scope, 'thehive');
  assert.equal(data.items[0].provenance.origins[0].sessionKey, 'fixture-origin');
  assert.equal(data.items[0].authorization.source_ref, 'fixture-human-approval#turn-2');
  assert.equal(data.items[0].application.artifact, '10_Projekte/fixture-artifact.md');
  assert.equal(data.items[0].application.outcome, 'success');
});

test('learned preference rejects foreign unconfirmed unauthorized and unproven data without content leakage', t => {
  const cases = [
    ['no grant', f => [], 'authorization_missing'],
    ['wrong grant project', f => [{...f.grant, project_id:'Other'}], 'authorization_missing'],
    ['scope spelling', f => { f.pref.scope = 'TheHive'; return [f.grant]; }, 'scope_mismatch'],
    ['foreign scope', f => { f.pref.scope = 'other'; return [f.grant]; }, 'scope_mismatch'],
    ['unconfirmed', f => { f.pref._status = 'unconfirmed'; return [f.grant]; }, 'not_confirmed'],
    ['legacy hash', f => { f.pref._content_hash = undefined; return [f.grant]; }, 'content_hash_unverified'],
    ['drift', f => { f.pref.principle += ' changed'; return [f.grant]; }, 'content_hash_unverified'],
    ['foreign owner', f => { f.pref.owner = 'another-agent'; return [f.grant]; }, 'owner_mismatch'],
    ['unresolved provenance', f => { f.pref._evidenced_by = ['[[sig-missing]]']; return [f.grant]; }, 'provenance_unresolved'],
    ['missing application', f => { fs.unlinkSync(f.logFile); return [f.grant]; }, 'application_unverified'],
    ['failed application', f => { f.event.payload.outcome = 'failure'; put(f.logFile, JSON.stringify(f.event)+'\n'); return [f.grant]; }, 'application_unverified'],
    ['application predates creation by milliseconds', f => {
      f.pref.created_at = '2026-10-21T11:00:00.100Z'; f.pref._confirmed_at = '2026-10-21T11:01:00Z';
      return [f.grant];
    }, 'application_unverified'],
    ['artifact drift', f => { put(path.join(f.vault, f.artifact), 'Changed unchecked bytes'); return [f.grant]; }, 'application_unverified'],
    ['invalid time', f => { f.pref.valid_until = 'bad-date'; return [f.grant]; }, 'invalid_or_inactive_time'],
    ['missing confirmation time', f => { f.pref._confirmed_at = undefined; return [f.grant]; }, 'invalid_or_inactive_time'],
    ['invalid calendar date', f => { f.pref.valid_from = '2026-02-30T00:00:00Z'; return [f.grant]; }, 'invalid_or_inactive_time'],
    ['date wrong type', f => { f.pref.valid_until = ['bad-date']; return [f.grant]; }, 'invalid_or_inactive_time'],
    ['empty date', f => { f.pref.valid_from = ''; return [f.grant]; }, 'invalid_or_inactive_time'],
    ['identity mismatch', f => { f.pref.id = 'pref-other'; return [f.grant]; }, 'preference_identity_mismatch'],
    ['expired', f => { f.pref.expiration_date = '2026-10-01'; return [f.grant]; }, 'invalid_or_inactive_time'],
    ['merged', f => { f.pref.merged_into = '[[pref-other]]'; return [f.grant]; }, 'merged_preference'],
  ];
  for (const [name, change, reason] of cases) {
    const f = preferenceFixture(t), grants = change(f);
    writeFixturePreference(f);
    const { output, result } = preferenceRun(f, grants), data = output.rules.learned_preferences;
    assert.equal(data.status, 'not_loaded', name);
    assert.deepEqual(data.items, [], name);
    assert.ok(data.withheld[reason] >= 1, `${name}: ${JSON.stringify(data.withheld)}`);
    assert.doesNotMatch(result.stdout, /FIXTURE_ONLY/, name);
  }
  const f = preferenceFixture(t);
  const unbound = preferenceRun(f, [f.grant], path.join(f.dir, 'not-present')).output.rules.learned_preferences;
  assert.equal(unbound.reason_code, 'project_binding_unavailable');
  // Data fields named approval/confirmed cannot become an invocation grant.
  f.pref.approval = f.grant; writeFixturePreference(f);
  const cli = selfRun(f).output.rules.learned_preferences;
  assert.equal(cli.status, 'not_loaded');
  assert.deepEqual(cli.items, []);
});

test('learned preference reports genuinely empty storage without artificial productive data', t => {
  const f = preferenceFixture(t);
  fs.unlinkSync(f.preferenceFile);
  const { output } = preferenceRun(f, []);
  assert.equal(output.rules.learned_preferences.status, 'empty');
  assert.deepEqual(output.rules.learned_preferences.items, []);
  assert.equal(output.rules.learned_preferences.scanned, 0);
});

test('learned preference accepts later application evidence within the creation second', t => {
  const f = preferenceFixture(t);
  f.pref.created_at = '2026-10-21T11:00:00Z';
  f.pref._confirmed_at = '2026-10-21T11:01:00Z';
  writeFixturePreference(f);
  f.event.ts = '2026-10-21T11:00:00.100Z';
  put(f.logFile, JSON.stringify(f.event)+'\n');
  const data = preferenceRun(f).output.rules.learned_preferences;
  assert.equal(data.status, 'loaded');
  assert.equal(data.items[0].application.timestamp, '2026-10-21T11:00:00.100Z');
});

test('learned preference remains separate and never creates or modifies operator rules', t => {
  const f = preferenceFixture(t);
  const { output } = preferenceRun(f);
  assert.equal(output.rules.learned_preferences.status, 'loaded');
  assert.equal(output.rules.global.text, 'GLOBAL_EXISTING_BOUNDARY');
  assert.match(output.rules.project.text, /ROOT_PROJECT_RULE/);
  assert.doesNotMatch(output.rules.global.text + output.rules.project.text, /FIXTURE_ONLY/);
  fs.unlinkSync(path.join(f.vault, 'Brain', 'standing-rules.md'));
  fs.unlinkSync(path.join(f.vault, 'Brain', 'standing-rules', 'project', 'thehive.md'));
  const absent = preferenceRun(f).output;
  assert.equal(absent.rules.learned_preferences.status, 'loaded');
  assert.equal(absent.rules.global.status, 'missing');
  assert.equal(absent.rules.project.status, 'missing');
  assert.equal(fs.existsSync(path.join(f.vault, 'Brain', 'standing-rules.md')), false);
});

test('learned preference rejects escaped artifacts sources and log directories', t => {
  for (const kind of ['artifact', 'source', 'log']) {
    const f = preferenceFixture(t), external = path.join(f.dir, 'external');
    fs.mkdirSync(external);
    const link = path.join(f.vault, 'escape');
    fs.symlinkSync(external, link, 'junction');
    if (kind === 'artifact') {
      put(path.join(external, 'result.md'), 'Isolated reviewed fixture result.\n');
      f.grant.application.artifact = 'escape/result.md';
      f.event.payload.artifact = '[[escape/result.md]]';
      put(f.logFile, JSON.stringify(f.event)+'\n');
    } else if (kind === 'source') {
      const processed = path.join(f.vault, 'Brain', 'inbox', 'processed');
      fs.symlinkSync(external, processed, 'junction');
      put(path.join(external, 'sig-escape.md'), fixtureMarkdown({ kind:'brain-signal', id:'sig-escape',
        created_at:'2026-10-19T10:00:00Z', tags:['brain'], topic:'fixture', signal:'positive',
        agent:'@codex-desktop-agent', principle:'External source', session_ref:'foreign#turn-1' }));
      f.pref._evidenced_by = ['[[sig-escape]]']; writeFixturePreference(f);
    } else {
      put(path.join(external, '2026-10-21.jsonl'), JSON.stringify(f.event)+'\n');
      fs.unlinkSync(f.logFile);
      fs.rmdirSync(path.dirname(f.logFile)); // Empty fixture directory only.
      fs.symlinkSync(external, path.dirname(f.logFile), 'junction');
    }
    const data = preferenceRun(f).output.rules.learned_preferences;
    assert.equal(data.status, 'not_loaded', kind);
    assert.deepEqual(data.items, [], kind);
    assert.ok(data.reason_code === 'project_binding_unavailable' ||
      data.withheld[kind === 'source' ? 'provenance_unresolved' : 'application_unverified'], `${kind}: ${JSON.stringify(data)}`);
  }
});

test('learned preference rejects an artifact escaping through a junction to another drive', t => {
  const drive = ['E:\\', 'D:\\'].find(root => fs.existsSync(root) && path.parse(root).root !== path.parse(os.tmpdir()).root);
  assert.ok(drive, 'This Windows acceptance requires a second existing local drive');
  const external = fs.mkdtempSync(path.join(drive, 'thehive-preference-test-'));
  const realExternal = fs.realpathSync.native(external);
  t.after(() => {
    assert.equal(fs.realpathSync.native(external), realExternal);
    assert.equal(path.dirname(realExternal), fs.realpathSync.native(drive));
    assert.ok(path.basename(realExternal).startsWith('thehive-preference-test-'));
    fs.rmSync(realExternal, {recursive:true, force:true});
  });
  const f = preferenceFixture(t);
  put(path.join(external, 'result.md'), 'Isolated reviewed fixture result.\n');
  fs.symlinkSync(external, path.join(f.vault, 'cross-drive'), 'junction');
  f.grant.application.artifact = 'cross-drive/result.md';
  f.event.payload.artifact = '[[cross-drive/result.md]]';
  put(f.logFile, JSON.stringify(f.event)+'\n');
  const data = preferenceRun(f).output.rules.learned_preferences;
  assert.equal(data.status, 'not_loaded');
  assert.deepEqual(data.items, []);
  assert.ok(data.withheld.application_unverified);
});

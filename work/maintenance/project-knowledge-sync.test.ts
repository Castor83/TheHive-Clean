import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
const modulePath = './project-knowledge-sync.ts';
async function api() {
  let mod: any;
  try { mod = await import(modulePath); } catch (error: any) {
    if (!/Cannot find|not found|ENOENT/.test(error.message)) throw error;
  }
  assert.equal(typeof mod?.syncKnowledge, 'function', 'registered project result intake must exist');
  return mod.syncKnowledge;
}
function fixture() {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'thehive-results-'));
  const vault = path.join(base, 'vault'), workspace = path.join(base, 'project');
  fs.mkdirSync(path.join(vault, '10_Projekte'), { recursive: true });
  fs.mkdirSync(path.join(workspace, 'work/handoff'), { recursive: true });
  fs.mkdirSync(path.join(workspace, 'work/verification'), { recursive: true });
  const thread = '01a17a70-1242-7c83-9b8e-986b9a7ce151';
  const source = path.join(workspace, 'work/handoff', thread + '-working.md');
  const report = path.join(workspace, 'work/verification/result.md');
  fs.writeFileSync(report, '# Ergebnis\n\nKontext tatsächlich 32768.\n');
  fs.writeFileSync(source, `# OpenCode\n\nUrsprung: ${thread}\n\n## Neuester Stand\n\nLesetest aus Nutzersicht nicht bestanden.\nQuelle: \`${report}\`\n`);
  const registry = path.join(base, 'sources.json');
  const project = { id: 'OpenCode', workspace, thread_id: thread,
    checkpoint: `work/handoff/${thread}-working.md`, reports_dir: 'work/verification' };
  fs.writeFileSync(registry, JSON.stringify({ schema_version: 1, projects: [project] }));
  let writes = 0;
  const writer = async (v: string, op: any) => {
    writes++;
    const file = path.join(v, op.path);
    fs.writeFileSync(file, '---\ntyp: projekt\n---\n\n' + (op.content ?? op.body));
    return { done: true, applied: 1, results: [{ kind: op.kind, created: true, updated: true, write_id: 'test-note-write' }] };
  };
  return { base, vault, workspace, source, report, registry, project, writer,
    stateDir: path.join(base, 'state'), target: path.join(vault, '10_Projekte/OpenCode-Quellenansicht.md'),
    writes: () => writes };
}
test('registered source plus referenced report is ingested once; later correction replaces only generated view', async () => {
  const sync = await api(), f = fixture();
  const manual = path.join(f.vault, '10_Projekte/OpenCode.md'); fs.writeFileSync(manual, 'Manuelle Quelle erhalten.');
  const first = await sync(f); assert.equal(first.status, 'updated');
  const text = fs.readFileSync(f.target, 'utf8');
  assert(text.includes('nicht bestanden')); assert(text.includes('32768')); assert(text.includes(f.project.thread_id));
  const mtime = fs.statSync(f.target).mtimeMs;
  assert.equal((await sync(f)).status, 'unchanged'); assert.equal(f.writes(), 1);
  assert.equal(fs.statSync(f.target).mtimeMs, mtime);
  fs.appendFileSync(f.source, '\n## Neue Korrektur\n\nFortsetzung noch offen.\n');
  assert.equal((await sync(f)).status, 'updated'); assert.equal(f.writes(), 2);
  assert(fs.readFileSync(f.target, 'utf8').includes('Fortsetzung noch offen'));
  assert.equal(fs.readFileSync(manual, 'utf8'), 'Manuelle Quelle erhalten.');
});
test('missing source preserves previous projection and reports failure', async () => {
  const sync = await api(), f = fixture(); await sync(f); const before = fs.readFileSync(f.target);
  fs.renameSync(f.source, f.source + '.away');
  await assert.rejects(() => sync(f), /source|ENOENT/i);
  assert.deepEqual(fs.readFileSync(f.target), before);
});
test('manual target drift is preserved even if source changes', async () => {
  const sync = await api(), f = fixture(); await sync(f);
  fs.appendFileSync(f.target, '\nMenschliche Ergänzung.\n'); const before = fs.readFileSync(f.target);
  fs.appendFileSync(f.source, '\nNeue Arbeitsdaten.\n');
  await assert.rejects(() => sync(f), /target.*(changed|conflict)|Ziel/i);
  assert.deepEqual(fs.readFileSync(f.target), before);
});
test('foreign preexisting target is never adopted or overwritten', async () => {
  const sync = await api(), f = fixture(); fs.writeFileSync(f.target, 'Fremde Notiz.');
  await assert.rejects(() => sync(f), /target|Ziel/i);
  assert.equal(fs.readFileSync(f.target, 'utf8'), 'Fremde Notiz.');
});
test('symlink sources and workspace traversal are refused', async () => {
  const sync = await api(), f = fixture(); const original = f.source + '.real'; fs.renameSync(f.source, original);
  try { fs.symlinkSync(original, f.source); }
  catch (e: any) { if (e.code !== 'EPERM') throw e; fs.linkSync(original, f.source); }
  if (fs.lstatSync(f.source).isSymbolicLink()) await assert.rejects(() => sync(f), /link|reparse/i);
  f.project.checkpoint = '../outside.md'; fs.writeFileSync(f.registry, JSON.stringify({ schema_version: 1, projects: [f.project] }));
  await assert.rejects(() => sync(f), /path|checkpoint|workspace/i);
});
test('credential-looking input is not copied and cannot become a success', async () => {
  const sync = await api(), f = fixture(); fs.appendFileSync(f.report, '\napi_key=sk-012345678901234567890123456789\n');
  await assert.rejects(() => sync(f), /credential|secret/i); assert.equal(fs.existsSync(f.target), false);
});
test('unstable source detected before write preserves existing view', async () => {
  const sync = await api(), f = fixture(); await sync(f); const before = fs.readFileSync(f.target);
  fs.appendFileSync(f.source, '\nNeuer Stand.\n');
  await assert.rejects(() => sync({ ...f, beforeWrite: () => fs.appendFileSync(f.source, '\nGleichzeitige Änderung.\n') }), /source.*changed|unstable/i);
  assert.deepEqual(fs.readFileSync(f.target), before);
});
test('staged or unaudited OSB writes are not reported as accepted', async () => {
  const sync = await api(), f = fixture();
  await assert.rejects(() => sync({ ...f, writer: async () => ({ done: true, results: [{ kind: 'create_note', staged: true }] }) }), /write|audit|staged/i);
});
test('source recovery clears a prior failed status without rewriting identical target', async () => {
  const sync = await api(), f = fixture(); await sync(f);
  fs.renameSync(f.source, f.source + '.away'); await assert.rejects(() => sync(f));
  fs.renameSync(f.source + '.away', f.source);
  assert.equal((await sync(f)).status, 'unchanged');
  assert.equal(JSON.parse(fs.readFileSync(path.join(f.stateDir, 'status.json'), 'utf8')).status, 'unchanged');
  assert.equal(f.writes(), 1);
});
test('preview exposes exact source bindings without creating a view or accepted-state record', async () => {
  const sync = await api(), f = fixture(); const result = await sync({ ...f, preview: true });
  assert.equal(result.status, 'preview_only'); assert.equal(result.projects[0].sources.length, 2);
  assert.equal(f.writes(), 0); assert.equal(fs.existsSync(f.target), false);
  assert.equal(fs.existsSync(path.join(f.stateDir, 'state.json')), false);
});
test('dead recorded intake owner is archived and recovered; live or unknown owner remains locked', async () => {
  const sync = await api(), f = fixture(); fs.mkdirSync(f.stateDir, { recursive: true });
  const lock = path.join(f.stateDir, 'run.lock');
  const dead = spawnSync(process.execPath, ['-e', 'process.stdout.write(String(process.pid))'], { encoding: 'utf8' });
  assert.equal(dead.status, 0);
  fs.writeFileSync(lock, JSON.stringify({ kind: 'thehive-project-results-lock/v1', pid: Number(dead.stdout) }));
  assert.equal((await sync({ ...f, preview: true })).status, 'preview_only');
  assert(fs.readdirSync(f.stateDir).some(n => n.startsWith('run.lock.stale-')));
  const live = JSON.stringify({ kind: 'thehive-project-results-lock/v1', pid: process.pid }); fs.writeFileSync(lock, live);
  await assert.rejects(() => sync(f), /locked/i); assert.equal(fs.readFileSync(lock, 'utf8'), live);
  fs.writeFileSync(lock, 'unbekannter Besitzer');
  await assert.rejects(() => sync(f), /locked/i); assert.equal(fs.readFileSync(lock, 'utf8'), 'unbekannter Besitzer');
});

test('missing historical reports do not block current result intake and are counted',async()=>{
  const sync=await api(),f=fixture();
  const missing=path.join(f.workspace,'work/verification/old-missing.md');
  fs.appendFileSync(f.source,`\nHistorical: \`${missing}\`\nAgain: \`${missing}\`\n`);
  const result=await sync(f);
  assert.equal(result.status,'updated');
  const text=fs.readFileSync(f.target,'utf8');
  assert.ok(text.includes('32768'));
  assert.match(text,/Nicht mehr vorhandene Markdown-Berichtsverweise: 1/);
  assert.equal((await sync(f)).status,'unchanged');
});

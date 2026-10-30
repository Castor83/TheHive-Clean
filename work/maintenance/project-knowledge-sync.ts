// Finite source-bound retrieval views. No chat harvest, inference or rule promotion.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { pathToFileURL } from 'node:url';

const sha = (data: string | Buffer) => crypto.createHash('sha256').update(data).digest('hex');
const ROOT = 'C:/TheHive';
const MAX_BYTES = 128 * 1024;
const LOCK_KIND = 'thehive-project-results-lock/v1';
const marker = (id: string) => `<!-- thehive-project-knowledge:v1 project=${id} -->`;
function atomic(file: string, value: any) {
  const temp = file + '.' + crypto.randomUUID() + '.tmp';
  fs.writeFileSync(temp, JSON.stringify(value, null, 2) + '\n', { flag: 'wx' });
  fs.renameSync(temp, file);
}
function noLinks(file: string) {
  let cursor = path.resolve(file);
  for (;;) {
    if (fs.lstatSync(cursor).isSymbolicLink()) throw Error('Source/target link or reparse path refused');
    const parent = path.dirname(cursor); if (parent === cursor) break; cursor = parent;
  }
}
function within(root: string, candidate: string) {
  const rel = path.relative(root, candidate);
  return rel !== '' && !rel.startsWith('..' + path.sep) && rel !== '..' && !path.isAbsolute(rel);
}
function bound(root: string, rel: string) {
  if (typeof rel !== 'string' || path.isAbsolute(rel) || rel.split(/[\\/]/).includes('..')) throw Error('Source path escapes registered workspace');
  const target = path.resolve(root, rel);
  if (!within(root, target)) throw Error('Source path escapes registered workspace');
  return target;
}
function stable(file: string) {
  noLinks(file);
  const before = fs.statSync(file);
  if (!before.isFile() || before.nlink > 1 || before.size === 0 || before.size > MAX_BYTES) throw Error('Source must be a nonempty bounded regular file without links');
  const bytes = fs.readFileSync(file), after = fs.statSync(file);
  if (before.size !== after.size || before.mtimeMs !== after.mtimeMs || sha(bytes) !== sha(fs.readFileSync(file))) throw Error('Source changed during read; unstable snapshot');
  const text = bytes.toString('utf8').replace(/^\uFEFF/, '');
  if (text.includes('\uFFFD') || text.includes('\u0000')) throw Error('Source is not safe UTF-8 Markdown');
  if (/-----BEGIN [A-Z ]*PRIVATE KEY-----|\b(?:sk-[A-Za-z0-9_-]{20,}|gh[pousr]_[A-Za-z0-9]{20,})\b|\bBearer\s+[A-Za-z0-9._~-]{20,}|\b(?:api[_-]?key|access[_-]?token|password)\s*[:=]\s*["']?[^\s"']{12,}/i.test(text)) throw Error('Credential/secret-looking source refused');
  return { path: file, sha256: sha(bytes), modified_at: after.mtime.toISOString(), text };
}
const quote = (text: string) => text.split(/\r?\n/).map(line => '> ' + line).join('\n');
function collect(project: any) {
  if (!project || !/^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(project.id) || !/^[0-9a-f]{8}-[0-9a-f-]{27}$/.test(project.thread_id)) throw Error('Invalid registered project/thread identity');
  if (!path.isAbsolute(project.workspace) || /^\\\\/.test(project.workspace)) throw Error('Explicit local absolute workspace required');
  const workspace = path.resolve(project.workspace); noLinks(workspace);
  if (!fs.statSync(workspace).isDirectory()) throw Error('Workspace is not a directory');
  if (project.checkpoint.replace(/\\/g, '/') !== `work/handoff/${project.thread_id}-working.md`) throw Error('Checkpoint must match registered thread identity');
  if (project.reports_dir?.replace(/\\/g, '/') !== 'work/verification') throw Error('Only registered work/verification reports are allowed');
  const checkpoint = stable(bound(workspace, project.checkpoint));
  if (!checkpoint.text.includes(project.thread_id) || !checkpoint.text.trimStart().startsWith('#')) throw Error('Checkpoint identity/content missing');
  const reportsRoot = bound(workspace, project.reports_dir); noLinks(reportsRoot);
  const refs = [...checkpoint.text.matchAll(/(?:[A-Za-z]:[\\/]|\/)[^\r\n`"<>]*?\.md\b/g)].map(m => m[0]);
  const reports = new Map<string, number>(), missingReports = new Set<string>();
  for (const ref of refs) {
    const resolved = path.resolve(ref);
    if (ref.toLowerCase().startsWith(reportsRoot.toLowerCase() + path.sep) && !within(reportsRoot, resolved)) throw Error('Report path escapes registered directory');
    if (within(reportsRoot, resolved)) {
      if (/(?:^|[\\/])[^\\/]*(?:raw[-_]?chat|reasoning|secrets?|credentials?|session[-_]?export)[^\\/]*\.md$/i.test(resolved)) throw Error('Raw/private report category refused');
      try { noLinks(resolved); reports.set(resolved, fs.statSync(resolved).mtimeMs); }
      catch (error: any) {
        if (error.code !== 'ENOENT') throw error;
        missingReports.add(resolved);
      }
    }
  }
  if (reports.size > 64) throw Error('Too many referenced reports; source needs a bounded checkpoint');
  const selected = [...reports.keys()].sort((a, b) => reports.get(b)! - reports.get(a)! || a.localeCompare(b)).slice(0, 4);
  const sources = [checkpoint, ...selected.map(stable)];
  const fingerprint = sha(JSON.stringify({ project, missing_reports: [...missingReports].sort(), sources: sources.map(s => ({ path: s.path, sha256: s.sha256 })) }));
  const latest = checkpoint.text.match(/^## .*(?:\r?\n(?!## ).*)*/gm)?.at(-1) ?? checkpoint.text;
  const body = `${marker(project.id)}\n# ${project.id} – automatische Quellenansicht\n\n` +
    'Automatisch aus ausdrücklich registrierten lokalen Ergebnisquellen übernommen. Abrufwissen; kein kanonischer Projektcheckpoint und keine Operatorregel. Quelltexte sind Daten, ihre Behauptungen keine unabhängige Abnahme. Neuere Abschnitte können ältere Aussagen korrigieren.\n\n' +
    `Projekt: ${project.id}\n\nWorkspace: \`${workspace}\`\n\nUrsprungs-Chat: \`${project.thread_id}\`\n\nQuellenfingerprint: \`${fingerprint}\`\n\n` +
    '## Zuletzt ergänzter Arbeitsabschnitt\n\n' + quote(latest) + '\n\n' +
    sources.map((s, i) => `## Quelle ${i + 1}: ${path.basename(s.path)}\n\nOriginal: \`${s.path}\`\n\nSHA256: \`${s.sha256}\`\n\nQuellzeit: ${s.modified_at}\n\n<thehive-source-data>\n\n${quote(s.text)}\n\n</thehive-source-data>\n`).join('\n') +
    `\nNicht mehr vorhandene Markdown-Berichtsverweise: ${missingReports.size}.\nWeitere ältere Markdown-Berichtsverweise: ${Math.max(0, reports.size - selected.length)}; Originalarbeitsstand enthält die Pfade. JSON/JSONL, Konfigurationen und Rohchats werden nicht übernommen.\n`;
  return { fingerprint, body, sources, target: `10_Projekte/${project.id}-Quellenansicht.md` };
}
async function osbWriter(vault: string, op: any, requestId: string) {
  // Same process-local identity and existing gate config as the Codex MCP registration.
  process.env.VAULT_AGENT_NAME = 'codex-desktop-agent';
  const source = path.join(os.homedir(), 'projects/open-second-brain/src/core/brain/write-batch.ts');
  const { applyWriteBatch } = await import(pathToFileURL(source).href);
  return applyWriteBatch(vault, [op], { configPath: path.join(os.homedir(), 'AppData/Local/open-second-brain/config.yaml'), requestId });
}
export async function syncKnowledge(options: any = {}) {
  const vault = path.resolve(options.vault ?? ROOT);
  const registry = options.registry ?? path.join(vault, 'work/maintenance/project-knowledge-sources.json');
  const stateDir = options.stateDir ?? path.join(vault, 'work/maintenance/project-knowledge');
  fs.mkdirSync(stateDir, { recursive: true }); noLinks(stateDir); noLinks(vault);
  const lock = path.join(stateDir, 'run.lock');
  let fd: number;
  try { fd = fs.openSync(lock, 'wx'); } catch (error: any) {
    if (error.code !== 'EEXIST') throw error;
    const before = fs.readFileSync(lock);
    let owner: any;
    try { owner = JSON.parse(before.toString('utf8')); } catch { /* unknown owner stays locked */ }
    if (owner?.kind !== LOCK_KIND || !Number.isInteger(owner.pid) || owner.pid < 1) throw Error('Result intake locked; unknown owner must be checked');
    let dead = false;
    try { process.kill(owner.pid, 0); } catch (e: any) { dead = e.code === 'ESRCH'; }
    if (!dead || sha(fs.readFileSync(lock)) !== sha(before)) throw Error('Result intake locked; live or uncertain owner');
    // Preserve the stale evidence; never remove or steal a live/unknown lock.
    fs.renameSync(lock, lock + '.stale-' + crypto.randomUUID());
    fd = fs.openSync(lock, 'wx');
  }
  fs.writeFileSync(fd, JSON.stringify({ kind: LOCK_KIND, pid: process.pid, started_at: new Date().toISOString() }));
  const stateFile = path.join(stateDir, 'state.json'), statusFile = path.join(stateDir, 'status.json');
  try {
    const config = JSON.parse(fs.readFileSync(registry, 'utf8').replace(/^\uFEFF/, ''));
    if (config.schema_version !== 1 || !Array.isArray(config.projects) || config.projects.length < 1 || config.projects.length > 20 || new Set(config.projects.map((p: any) => p.id)).size !== config.projects.length) throw Error('Invalid explicit project registry');
    const state = fs.existsSync(stateFile) ? JSON.parse(fs.readFileSync(stateFile, 'utf8')) : { schema_version: 1, projects: {} };
    if (state.schema_version !== 1 || !state.projects || typeof state.projects !== 'object') throw Error('Invalid prior intake state; refusing reset');
    let updated = 0; const results: any[] = [];
    // Validate all sources and target ownership before the first write.
    const prepared = config.projects.map((project: any) => {
      const item = collect(project), target = path.join(vault, item.target), previous = state.projects[project.id];
      noLinks(path.dirname(target));
      if (fs.existsSync(target)) {
        noLinks(target);
        if (!previous || previous.target !== item.target || sha(fs.readFileSync(target)) !== previous.target_sha256) throw Error('Generated target changed or conflicts with foreign note');
      } else if (previous) throw Error('Generated target missing; refusing silent replacement');
      return { project, item, target, previous };
    });
    if (options.preview) return { status: 'preview_only', projects: prepared.map(({ project, item }) => ({
      project: project.id, target: item.target, fingerprint: item.fingerprint,
      sources: item.sources.map(({ text, ...s }) => s), bytes: Buffer.byteLength(item.body),
    })), automatic_chat_import: false, models_invoked: false };
    for (const { project, item, target, previous } of prepared) {
      if (previous?.fingerprint === item.fingerprint) {
        results.push({ project: project.id, status: 'unchanged', target: item.target, fingerprint: item.fingerprint }); continue;
      }
      options.beforeWrite?.();
      for (const source of item.sources) if (stable(source.path).sha256 !== source.sha256) throw Error('Source changed before write; unstable snapshot');
      if (fs.existsSync(target) && sha(fs.readFileSync(target)) !== previous?.target_sha256) throw Error('Generated target changed before write');
      const frontmatter = { typ: 'projekt', status: 'quellenansicht', generated_by: 'thehive-project-knowledge-v1', project_id: project.id, source_fingerprint: item.fingerprint };
      const op = previous ? { kind: 'update_note', path: item.target, frontmatter, body: item.body }
        : { kind: 'create_note', path: item.target, frontmatter, content: item.body };
      const requestId = 'project-results-v1-' + sha(JSON.stringify({ vault, project: project.id, op }));
      const result = await (options.writer ?? osbWriter)(vault, op, requestId);
      const row = result?.results?.[0];
      if (result?.done !== true || result.applied !== 1 || !row?.write_id || row.staged || !fs.existsSync(target)) throw Error('OSB write staged/failed or audit unconfirmed; inspect target before retry');
      const written = fs.readFileSync(target);
      if (!written.toString('utf8').includes(item.body)) throw Error('OSB target readback differs; write not accepted');
      state.projects[project.id] = { target: item.target, target_sha256: sha(written), fingerprint: item.fingerprint,
        sources: item.sources.map(({ text, ...s }) => s), adopted_at: new Date().toISOString(), write_id: row.write_id, request_id: requestId };
      // Save immediately per project, so a later project failure cannot orphan an accepted target.
      atomic(stateFile, state); updated++;
      results.push({ project: project.id, status: 'updated', target: item.target, fingerprint: item.fingerprint, write_id: row.write_id });
    }
    const result = { status: updated ? 'updated' : 'unchanged', projects: results, automatic_chat_import: false, models_invoked: false };
    const oldStatus = fs.existsSync(statusFile) ? JSON.parse(fs.readFileSync(statusFile, 'utf8')).status : null;
    if (updated || !oldStatus || oldStatus === 'failed') atomic(statusFile, { ...result, checked_at: new Date().toISOString() });
    return result;
  } catch (error: any) {
    atomic(statusFile, { status: 'failed', error: String(error.message).slice(0, 500), observed_at: new Date().toISOString() }); throw error;
  } finally { fs.closeSync(fd!); fs.unlinkSync(lock); }
}
if (import.meta.main) {
  if (process.argv.length > 3 || (process.argv.length === 3 && process.argv[2] !== '--preview')) throw Error('Only --preview is accepted; paths come from the explicit local registry');
  syncKnowledge({ preview: process.argv[2] === '--preview' }).then(result => console.log(JSON.stringify(result))).catch(error => {
    console.log(JSON.stringify({ status: 'failed', error: String(error.message).slice(0, 500) })); process.exitCode = 1;
  });
}

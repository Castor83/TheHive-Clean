// Fachnavigation via existing OSB reference detection and guarded note writes.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { pathToFileURL } from 'node:url';

const ROOT = 'C:/TheHive';
const FOLDERS = {
  '10_Projekte': 'Projektindex', '20_Wissen': 'Wissensindex',
  '30_Entscheidungen': 'Entscheidungsindex', '40_Fehler-Loesungen': 'Fehlerindex',
};
/**
 * Hash source bytes or text for content and write-request identity.
 * @param data - UTF-8 text or raw bytes.
 * @returns SHA-256 hex digest.
 */
const sha = (data: string | Buffer) => crypto.createHash('sha256').update(data).digest('hex');
/**
 * Normalize a note path for case-insensitive, extension-free target matching.
 * @param p - Relative link or note path.
 * @returns Unicode-normalized lookup key.
 */
const noteKey = (p: string) => p.replace(/\\/g, '/').replace(/\.md$/i, '').normalize('NFC').toLowerCase();
/**
 * Remove wikilink delimiters and line breaks from a display label.
 * @param s - Untrusted title or path.
 * @returns Trimmed single-line label.
 */
const label = (s: string) => s.replace(/[\[\]|\r\n]/g, ' ').trim();
const MARKER = '<!-- thehive-navigation:v1 -->';
const VAULT_INDEX = '20_Wissen/Vaultindex.md';

/**
 * List visible regular Markdown files without following linked or hidden trees.
 * @param vault - Absolute vault root.
 * @returns Sorted paths and excluded link/administration entries.
 */
function inventory(vault: string) {
  const paths: string[] = []; const excluded: { path: string; reason: string }[] = [];
  /**
   * Accumulate inventory paths and exclusion reasons below a directory.
   * @param dir - Directory within the vault.
   */
  function walk(dir: string) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const abs = path.join(dir, entry.name);
      const rel = path.relative(vault, abs).replace(/\\/g, '/');
      if (entry.name.startsWith('.')) { if (entry.isDirectory()) excluded.push({ path: rel, reason: 'hidden administration/archive' }); continue; }
      // Non-Markdown transaction files may disappear after readdir; they are not inventory sources.
      if (entry.isFile() && !/\.md$/i.test(entry.name)) continue;
      const stat = fs.lstatSync(abs);
      if (stat.isSymbolicLink() || stat.isFile() && stat.nlink > 1) { excluded.push({ path: rel, reason: 'link/reparse target not followed' }); continue; }
      if (stat.isDirectory()) walk(abs);
      else if (stat.isFile() && /\.md$/i.test(entry.name)) paths.push(rel);
    }
  }
  walk(vault);
  return { paths: paths.sort(), excluded };
}

/**
 * Choose the structural section of the vault index from a relative path.
 * @param rel - Vault-relative note path.
 * @returns Section label; no semantic classification is performed.
 */
function category(rel: string) {
  if (rel.startsWith('00_System/')) return 'Systemregeln – Originale nur lesen';
  if (rel.startsWith('Brain/')) return 'Brain – Originalstatus und Herkunft gelten weiter';
  if (/^(?:work\/backups\/|work\/handoff\/.*\/history\/|graphify-out\/archive\/)/.test(rel)) return 'Sicherungen und unveränderliche Historie';
  if (rel.startsWith('work/')) return 'Technische Arbeitsstände und Prüfnachweise';
  if (rel.startsWith('graphify-out/')) return 'Graphansichten und Berichte';
  if (rel.startsWith('docs/')) return 'Dokumentation';
  if (Object.keys(FOLDERS).some(p => rel.startsWith(p + '/'))) return 'Fachordner';
  return 'Weitere Vaultnotizen';
}

/**
 * Render a note list entry, using encoded Markdown for unsafe wikilink names.
 * @param rel - Vault-relative Markdown path.
 * @returns One list entry with a safe display label.
 */
function pathLink(rel: string) {
  /**
   * Percent-encode one URL path segment, including Markdown-sensitive punctuation.
   * @param part - Single path segment.
   * @returns Encoded segment.
   */
  const encode = (part: string) => encodeURIComponent(part).replace(/[!'()*]/g, c => '%' + c.charCodeAt(0).toString(16).toUpperCase());
  if (/[\[\]|#^]/.test(rel)) return `- [${label(rel)}](${rel.split('/').map(encode).join('/')})`;
  return `- [[${rel.replace(/\.md$/i, '')}|${label(rel)}]]`;
}

/**
 * Load the installed OSB parsing, repair, write and locking APIs.
 * @returns Merged module exports; importing does not itself write notes.
 */
async function library() {
  const base = path.join(os.homedir(), 'projects/open-second-brain/src/core');
  /**
   * Import one OSB core module through its absolute file URL.
   * @param rel - Path relative to the installed core directory.
   * @returns Module import promise.
   */
  const get = (rel: string) => import(pathToFileURL(path.join(base, rel)).href);
  const [vault, repair, writes, links, locks] = await Promise.all([
    get('vault.ts'), get('brain/link-graph/repair-lane.ts'),
    get('brain/write-batch.ts'), get('search/links.ts'), get('brain/sync-lockfile.ts'),
  ]);
  return { ...vault, ...repair, ...writes, ...links, ...locks };
}

/**
 * Inspect a path and reject symbolic links or multiply linked files.
 * @param p - Existing source or directory path.
 * @returns Filesystem metadata; throws for refused links.
 */
function regular(p: string) {
  const stat = fs.lstatSync(p);
  if (stat.isSymbolicLink() || stat.nlink > 1 && stat.isFile()) throw Error('Link/reparse source refused: ' + p);
  return stat;
}

/**
 * Read eligible Fach folders and retain source hashes, metadata and parse warnings.
 * @param vault - Absolute vault root.
 * @param lib - OSB frontmatter parser API.
 * @returns Map of note records; rejects unsafe paths, encodings and oversized files.
 */
function scan(vault: string, lib: any) {
  // Verify ancestors as well as directory entries; never follow junctions.
  for (let cursor = vault; ; cursor = path.dirname(cursor)) {
    regular(cursor); if (path.dirname(cursor) === cursor) break;
  }
  const notes = new Map<string, any>();
  /**
   * Recursively parse Fach notes after checking each directory and entry for links.
   * @param dir - Fach directory under the vault.
   */
  function walk(dir: string) {
    regular(dir);
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const abs = path.join(dir, entry.name); const stat = regular(abs);
      if (stat.isDirectory()) { walk(abs); continue; }
      if (!stat.isFile() || !entry.name.endsWith('.md')) continue;
      if (stat.size > 1024 * 1024) throw Error('Oversized Fachnote: ' + abs);
      const bytes = fs.readFileSync(abs); const raw = bytes.toString('utf8');
      if (raw.includes('\uFFFD') || raw.includes('\0')) throw Error('Invalid UTF-8 note: ' + abs);
      const rel = path.relative(vault, abs).replace(/\\/g, '/');
      if (/[\[\]|#^]/.test(rel)) throw Error('Unsafe wikilink target: ' + rel);
      const [meta, body, notices] = lib.parseFrontmatterTextWithNotices(raw, { site: 'thehive-navigation' });
      const generated = Boolean(meta.generated_by) || /-Quellenansicht\.md$/i.test(rel);
      const test = meta.status === 'test' || /(?:^|\/)OpenCode-Dateitest\.md$/i.test(rel);
      notes.set(rel, { rel, abs, raw, hash: sha(bytes), meta, body, generated, test, lossy: notices.length > 0,
        title: String(meta.title || body.match(/^#\s+(.+)$/m)?.[1] || path.basename(rel, '.md')) });
    }
  }
  for (const folder of Object.keys(FOLDERS)) {
    const dir = path.join(vault, folder); if (fs.existsSync(dir)) walk(dir);
  }
  return notes;
}

/**
 * Resolve explicit note links only when one known target matches.
 * @param body - Source note body.
 * @param source - Vault-relative source path.
 * @param notes - Candidate note map.
 * @param lib - OSB link extraction API.
 * @returns Set of unambiguous vault-relative targets.
 */
function targets(body: string, source: string, notes: Map<string, any>, lib: any) {
  const found = new Set<string>();
  for (const link of lib.extractLinks(body)) {
    if (!link.targetPath || link.linkType === 'tag') continue;
    let decoded = link.targetPath.split('#')[0];
    if (link.linkType === 'markdown_link') {
      try { decoded = decodeURIComponent(decoded); } catch { /* retain literal invalid encoding */ }
    }
    const target = noteKey(decoded);
    const direct = [...notes.keys()].filter(p => noteKey(p) === target);
    const relative = [...notes.keys()].filter(p => noteKey(p) === noteKey(path.posix.join(path.posix.dirname(source), target)));
    const byBase = [...notes.keys()].filter(p => noteKey(path.posix.basename(p)) === target);
    const matches = direct.length ? direct : relative.length ? relative : byBase;
    if (matches.length === 1) found.add(matches[0]);
  }
  return found;
}

/**
 * Plan missing navigation and optionally apply audited, read-back-verified OSB writes.
 * @param options - Vault, preview, writer and reconciliation hooks.
 * @returns Coverage, blocked notes and planned or accepted writes; no model calls.
 */
async function synchronize(options: any = {}) {
  const vault = path.resolve(options.vault ?? ROOT);
  const lib = await library(); const notes = scan(vault, lib);
  const visible = inventory(vault);
  const eligible = [...notes.values()].filter(n => !n.test);
  const indices = Object.entries(FOLDERS)
    .filter(([folder]) => fs.existsSync(path.join(vault, folder)))
    .map(([folder, name]) => ({ folder, name, rel: `${folder}/${name}.md` }));
  const indexPaths = new Set([...indices.map(i => i.rel), VAULT_INDEX]);
  for (const index of [...indices, { rel: VAULT_INDEX }]) {
    const note = notes.get(index.rel);
    if (note && (note.generated || note.test || note.lossy)) throw Error('Protected Fachindex cannot be changed: ' + index.rel);
  }
  const blocked = eligible.filter(n => n.lossy).map(n => ({ path: n.rel, reason: 'frontmatter cannot round-trip; original preserved' }));
  const contents = new Map<string, string[]>();
  /**
   * Append a unique navigation line to the pending content for one note.
   * @param rel - Vault-relative destination.
   * @param value - Navigation line to add.
   */
  const add = (rel: string, value: string) => { const list = contents.get(rel) ?? []; if (!list.includes(value)) list.push(value); contents.set(rel, list); };
  for (const index of indices) {
    const note = notes.get(index.rel);
    const linked = targets(note?.body ?? '', index.rel, notes, lib);
    for (const target of eligible) {
      if (!target.rel.startsWith(index.folder + '/') || target.rel === index.rel || linked.has(target.rel)) continue;
      add(index.rel, `- [[${target.rel.slice(0, -3)}|${label(target.title)}]]`);
    }
    // One shared navigation spine, explicitly structural rather than semantic.
    for (const other of indices) {
      if (other.rel === index.rel || linked.has(other.rel)) continue;
      if (index.folder !== '20_Wissen' && other.folder !== '20_Wissen') continue;
      add(index.rel, `- [[${other.rel.slice(0, -3)}|${other.name}]]`);
    }
  }
  const allPaths = new Set([...visible.paths, ...indices.map(i => i.rel), VAULT_INDEX]);
  const allNotes = new Map([...allPaths].map(rel => [rel, notes.get(rel) ?? { rel }]));
  const master = notes.get(VAULT_INDEX);
  const masterLinks = targets(master?.body ?? '', VAULT_INDEX, allNotes, lib);
  let group = '';
  for (const rel of [...allPaths].sort((a, b) => category(a).localeCompare(category(b)) || a.localeCompare(b))) {
    if (rel === VAULT_INDEX || masterLinks.has(rel)) continue;
    const next = category(rel);
    if (next !== group) { add(VAULT_INDEX, `### ${next}`); group = next; }
    add(VAULT_INDEX, pathLink(rel));
  }
  const knowledgeIndex = '20_Wissen/Wissensindex.md';
  if (!master && indices.some(i => i.rel === knowledgeIndex) && !targets(notes.get(knowledgeIndex)?.body ?? '', knowledgeIndex, allNotes, lib).has(VAULT_INDEX)) {
    add(knowledgeIndex, '- [[20_Wissen/Vaultindex|Vaultindex – alle sichtbaren Markdown-Dateien]]');
  }
  const coverage = { markdown_files: allPaths.size, indexed_targets: allPaths.size - 1, excluded: visible.excluded,
    protected_originals_unchanged: true, scope: 'all visible regular Markdown files' };
  const pagePaths = eligible.filter(n => !indexPaths.has(n.rel) && !n.generated).map(n => n.rel);
  const pool = new Set(pagePaths);
  const collection = lib.collectRepairCandidatesWithRefusals(vault, { pagePaths });
  const candidates = collection.candidates.filter((c: any) => c.strength === 'explicit_reference' && pool.has(c.source) && pool.has(c.target) && !notes.get(c.source).lossy);
  const dry = lib.runRepairLane(vault, candidates, { apply: false });
  for (const edge of dry.decisions.filter((d: any) => d.action === 'write')) {
    const source = notes.get(edge.source);
    if (!targets(source.body, edge.source, notes, lib).has(edge.target)) {
      add(edge.source, `- [[${edge.target.replace(/\.md$/, '')}]] — ausdrücklich im Text erwähnt.`);
    }
  }
  const operations = [...contents.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([rel, lines]) => {
    const note = notes.get(rel);
    const introduction = rel === VAULT_INDEX
      ? '## Gesamter Vault\n\nDateiverzeichnis aller sichtbaren Markdown-Dateien. Die Bereiche kennzeichnen Herkunft und Zweck. Ein Verweis bestätigt keine Aussage, aktiviert keine Regel und erweitert keine Berechtigung. Geschützte Originaldateien bleiben unverändert. Verborgene Verwaltungs- und Snapshotverzeichnisse sowie externe Verknüpfungen werden nicht verfolgt.'
      : indexPaths.has(rel)
      ? '## Automatisch ergänzte Navigation\n\nNotizen dieses Fachbereichs und weitere Inhaltsverzeichnisse:'
      : '## Explizit erwähnte Notizen\n\nDiese Notizen werden im Text ausdrücklich erwähnt:';
    const content = (note?.body.includes(MARKER) ? '' : `${MARKER}\n${introduction}\n\n`) + lines.join('\n');
    return note ? { kind: 'append_note', path: rel, content }
      : { kind: 'create_note', path: rel, frontmatter: { typ: 'wissen', status: 'aktiv', agent: '@codex-desktop-agent', tags: ['wissen/index'] }, content: `# ${rel === VAULT_INDEX ? 'Vaultindex' : indices.find(i => i.rel === rel)!.name}\n\n${content}` };
  });
  if (options.preview) return { status: 'preview_only', operations, coverage, blocked, explicit_references: dry.written, models_invoked: false };
  const expected = new Map([...notes].map(([rel, n]) => [rel, n.hash]));
  const runId = crypto.randomUUID(); // A new scan after an audited revert is a new logical request.
  /**
   * Apply one OSB operation under the navigation identity and restore the environment.
   * @param _vault - Unused writer-interface vault argument.
   * @param op - Planned note operation.
   * @param requestId - Audited idempotency key.
   * @returns OSB batch result.
   */
  const writer = options.writer ?? (async (_vault: string, op: any, requestId: string) => {
    const previousAgent = process.env.VAULT_AGENT_NAME;
    try {
      process.env.VAULT_AGENT_NAME = '@codex-desktop-agent';
      return lib.applyWriteBatch(vault, [op], {
        configPath: options.configPath ?? path.join(os.homedir(), 'AppData/Local/open-second-brain/config.yaml'), requestId,
      });
    } finally {
      if (previousAgent === undefined) delete process.env.VAULT_AGENT_NAME;
      else process.env.VAULT_AGENT_NAME = previousAgent;
    }
  });
  const written: any[] = [];
  const expectedPaths = new Set(visible.paths);
  for (const op of operations) {
    options.beforeWrite?.();
    const current = scan(vault, lib);
    if (current.size !== expected.size || [...expected].some(([p, h]) => current.get(p)?.hash !== h)) throw Error('Fachnote changed since preview; no stale write');
    const currentPaths = inventory(vault).paths;
    if ([...expectedPaths].some(p => !currentPaths.includes(p))) throw Error('Vault file inventory changed; no stale navigation write');
    const before = notes.get(op.path);
    const requestId = 'navigation-v1-' + sha(JSON.stringify({ vault, runId, parent: before?.hash ?? null, op }));
    const result = await writer(vault, op, requestId);
    const row = result?.results?.[0];
    if (result?.done !== true || result.applied !== 1 || !row?.write_id || row.staged) throw Error('Navigation write refused/staged or audit missing; inspect target before retry');
    const abs = path.join(vault, op.path);
    if (!fs.existsSync(abs)) throw Error('Navigation readback missing');
    regular(abs); const raw = fs.readFileSync(abs, 'utf8');
    const [meta, body] = lib.parseFrontmatterText(raw);
    if (!body.includes(op.content.trim()) || before && (!body.startsWith(before.body) || !isDeepStrictEqual(meta, before.meta))) throw Error('Navigation readback differs; preservation unconfirmed');
    expected.set(op.path, sha(Buffer.from(raw)));
    expectedPaths.add(op.path);
    notes.set(op.path, { ...before, hash: expected.get(op.path), meta, body, raw, rel: op.path, abs });
    written.push({ path: op.path, write_id: row.write_id, sha256: expected.get(op.path) });
  }
  // A first native write may create its daily audit Markdown. Reconcile once
  // inside the same lock; never create a self-triggering unbounded loop.
  const newPaths = inventory(vault).paths.filter(p => !expectedPaths.has(p));
  if (newPaths.length && !options.reconciled) {
    const next = await synchronize({ ...options, reconciled: true });
    return { ...next, written: [...written, ...next.written], status: next.blocked.length || next.coverage.pending_paths?.length ? 'partial' : 'updated' };
  }
  const finalCoverage = { ...coverage, pending_paths: newPaths };
  return { status: blocked.length || newPaths.length ? 'partial' : written.length ? 'updated' : 'unchanged', written, coverage: finalCoverage, blocked, explicit_references: dry.written, models_invoked: false };
}

/**
 * Preview navigation or serialize a write pass using the existing OSB lock.
 * @param options - Vault override, preview flag and optional writer/test hooks.
 * @returns Synchronization result; releases the acquired lock even on failure.
 */
export async function syncNavigation(options: any = {}) {
  if (options.preview) return synchronize(options);
  const vault = path.resolve(options.vault ?? ROOT);
  for (let cursor = vault; ; cursor = path.dirname(cursor)) {
    regular(cursor); if (path.dirname(cursor) === cursor) break;
  }
  for (const dir of ['work', 'work/maintenance']) {
    const abs = path.join(vault, dir);
    if (!fs.existsSync(abs)) fs.mkdirSync(abs);
    if (!regular(abs).isDirectory()) throw Error('Navigation state directory is not a directory');
  }
  const lib = await library(); let lock: any;
  try { lock = lib.acquireLockSync(path.join(vault, 'work/maintenance/navigation')); }
  catch (error: any) { if (error.code === 'ELOCKED') throw Error('Navigation is locked; owner preserved'); throw error; }
  try {
    return await synchronize(options);
  } finally {
    lock.release();
  }
}

if (import.meta.main) {
  if (process.argv.length > 3 || process.argv[2] && process.argv[2] !== '--preview') throw Error('Only --preview is accepted');
  syncNavigation({ preview: process.argv[2] === '--preview' }).then(result => console.log(JSON.stringify(result))).catch(error => {
    console.log(JSON.stringify({ status: 'failed', error: String(error.message).slice(0, 500) })); process.exitCode = 1;
  });
}

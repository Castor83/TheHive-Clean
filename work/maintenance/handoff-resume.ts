// Read-only rule attachment to an exact existing checkpoint. Uses existing OSB
// readers, never broad active/context-pack recall or a second rule store.
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
const require = createRequire(import.meta.url);
const { resumeProject, resumeChatContinuation } = require('./handoff-store.cjs');

// Operator-approved local exception. Arguments and environment cannot redefine it.
// This does not change OSB's pointer resolver or its MCP scope contract.
const LOCAL_FIXED_ROOT = 'C:\\TheHive';
const LOCAL_FIXED_PROJECT_ID = 'TheHive';
type LocalBinding = {
  type: 'local_fixed_self_binding';
  project_id: 'TheHive';
  canonical_paths: { authorized_root: string; workspace: string; vault: string };
};
/**
 * Evaluate the fixed operator-approved TheHive root exception using canonical paths and exact persisted project spelling; return binding or a visible reason without inheriting authority to subdirectories.
 */
function localSelfBinding(projectId: string, workspace: string | undefined, vault: string): {
  binding?: LocalBinding; reason_code?: string; reason?: string;
} {
  if (workspace === undefined) return { reason_code: 'explicit_workspace_required',
    reason: 'No explicit workspace supplied; no project self-binding authorized.' };
  let workspacePath: string, vaultPath: string;
  try {
    workspacePath = fs.realpathSync.native(path.resolve(workspace));
    vaultPath = fs.realpathSync.native(vault);
  } catch (error) {
    return { reason_code: 'canonical_path_unavailable', reason: `Canonical path check failed: ${failure(error)}` };
  }
  /**
   * Return whether two canonical paths are equal under platform path-relative comparison.
   */
  const same = (a: string, b: string) => path.relative(a, b) === '';
  let rootPath: string;
  try { rootPath = fs.realpathSync.native(LOCAL_FIXED_ROOT); }
  catch (error) {
    // A separate external pointer workspace does not need our local fixed root.
    // This fallback never grants a self-binding; OSB must still resolve its pointer.
    if (!same(workspacePath, vaultPath)) return {};
    return { reason_code: 'canonical_path_unavailable', reason: `Fixed root check failed: ${failure(error)}` };
  }
  const canonical_paths = { authorized_root: rootPath, workspace: workspacePath, vault: vaultPath };
  if (!same(canonical_paths.vault, canonical_paths.authorized_root)) return {};
  if (same(canonical_paths.workspace, canonical_paths.authorized_root)) {
    // Exact persisted spelling is part of the authorization, before scopedRuleKey.
    if (projectId !== LOCAL_FIXED_PROJECT_ID) return { reason_code: 'checkpoint_project_id_mismatch',
      reason: 'The local root binding authorizes exactly checkpoint.project_id === TheHive.' };
    return { binding: { type: 'local_fixed_self_binding', project_id: LOCAL_FIXED_PROJECT_ID, canonical_paths } };
  }
  const relative = path.relative(canonical_paths.authorized_root, canonical_paths.workspace);
  if (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative)) {
    return { reason_code: 'root_scope_not_inherited',
      reason: 'A workspace below the vault root must not inherit its local Root project binding.' };
  }
  return {}; // Other workspaces retain the existing OSB pointer path.
}

type Options = { project: string; workspace?: string; vault?: string; handoff?: string };
/**
 * Parse explicit project, workspace, vault and named-handoff arguments; reject duplicates/missing values and never select a newest project.
 */
export function parseArgs(argv: string[]): Options {
  const values: Record<string, string> = {};
  for (let i = 0; i < argv.length; i += 2) {
    if (!['--project', '--workspace', '--vault', '--handoff'].includes(argv[i]) || !argv[i + 1] ||
        argv[i + 1].startsWith('--') || Object.hasOwn(values, argv[i])) throw Error('Unknown, incomplete or duplicate argument');
    values[argv[i]] = argv[i + 1];
  }
  if (!values['--project']) throw Error('--project <confirmed project_id> required; no latest-project fallback');
  return { project: values['--project'], workspace: values['--workspace'], vault: values['--vault'], handoff: values['--handoff'] };
}
/**
 * Return a bounded Error message for reader diagnostics or a generic unavailable message for non-Error failures.
 */
function failure(error: unknown): string {
  return error instanceof Error ? error.message.slice(0, 500) : 'Rule reader unavailable';
}

// Trusted host input: the caller must already possess the human authorization
// and have checked the application. This type does NOT authenticate a person.
// Never populate it from checkpoint/note fields, arguments or environment.
export type PreferenceAuthorization = {
  project_id: string; scope: string; preference_id: string; content_hash: string;
  source_ref: string; owner?: string;
  application: { artifact: string; sha256: string };
};
/**
 * Read advisory preferences only for an approved exact project scope, validating time, content hash, trusted grants, owner, provenance and reviewed application evidence.
 * @param {string} vault Local vault path.
 * @param {string} projectId Verified checkpoint project identity.
 * @param {object} project Resolved project-rule binding/status.
 * @param {string} source Existing OSB source checkout used for read modules.
 * @param {readonly PreferenceAuthorization[]} authorizations Trusted host grants, never inferred from notes or checkpoint data.
 * @returns {Promise<object>} Advisory items and withholding counts; unsafe or unavailable readers fail closed without loading broad recall.
 */
async function readLearnedPreferences(vault: string, projectId: string, project: any,
  source: string, authorizations: readonly PreferenceAuthorization[]) {
  const result: any = { status: 'not_loaded', data_class: 'learned_preference', authority: 'advisory',
    items: [], scanned: 0, withheld: {} };
  if (!['loaded', 'missing'].includes(project.status) || !project.resolved_scope) {
    return { ...result, reason_code: 'project_binding_unavailable' };
  }
  /**
   * Increment the withholding count for a stable validation reason in the current preference-read result.
   */
  const hold = (reason: string) => { result.withheld[reason] = (result.withheld[reason] || 0) + 1; };
  try {
    /**
     * Import the named existing OSB reader module relative to the currently selected source directory; no module installation is performed.
     */
    const load = (file: string) => import(pathToFileURL(path.join(source, 'src', 'core', file)).href);
    const [collection, preference, hashes, origins, signals, evidence, paths, safety, frontmatter] = await Promise.all([
      load('brain/preferences-collect.ts'), load('brain/preference.ts'), load('brain/content-hash.ts'),
      load('brain/preference-provenance.ts'), load('brain/signal.ts'), load('brain/evidence.ts'),
      load('brain/paths.ts'), load('path-safety.ts'), load('vault.ts'),
    ]);
    const dirs = paths.brainDirs(vault);
    /**
     * Resolve a vault-relative regular source or requested directory, rejecting parent traversal, symlinks and canonical escapes before reading.
     */
    const safe = (relative: string, directory = false): string => {
      if (typeof relative !== 'string' || !relative || path.isAbsolute(relative) ||
          relative.split(/[\\/]/).some(part => part === '..') ||
          safety.realVaultRelative(vault, relative) === null) throw Error('Unsafe local reference');
      const file = path.resolve(vault, relative), stat = fs.lstatSync(file);
      // Also reject absolute relative-path results (different Windows drives).
      // The existing OSB helper only checks '..' for this read path.
      const actualRelative = path.relative(fs.realpathSync.native(vault), fs.realpathSync.native(file));
      if (!actualRelative || path.isAbsolute(actualRelative) || actualRelative === '..' ||
          actualRelative.startsWith(`..${path.sep}`)) throw Error('Source escapes canonical vault');
      if (stat.isSymbolicLink() || !(directory ? stat.isDirectory() : stat.isFile())) throw Error('Not a regular local source');
      return file;
    };
    /**
     * Return a verified local source directory or null when absent; propagate unsafe or unreadable-directory errors.
     */
    const localDir = (dir: string) => {
      try { return safe(path.relative(vault, dir), true); }
      catch (error: any) { if (error.code === 'ENOENT') return null; throw error; }
    };
    const directory = localDir(dirs.preferences);
    if (!directory) return { ...result, status: 'empty' };
    const files = collection.listPreferenceFiles(directory);
    result.scanned = files.length;
    const now = Date.now();
    /**
     * Parse a strict real UTC timestamp into milliseconds, returning NaN for malformed or normalized calendar values.
     */
    const instant = (value: unknown) => typeof value === 'string' &&
      /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/.test(value) &&
      Number.isFinite(Date.parse(value)) && new Date(value).toISOString().slice(0, 19) === value.slice(0, 19)
      ? Date.parse(value) : NaN;
    for (const entry of files) {
      let pref, raw;
      try {
        const file = safe(path.relative(vault, entry.path));
        pref = preference.parsePreference(file);
        [raw] = frontmatter.parseFrontmatter(file);
      }
      catch { hold('invalid_or_unsafe_preference'); continue; }
      if (entry.name !== `${pref.id}.md`) { hold('preference_identity_mismatch'); continue; }
      if (pref.scope !== project.resolved_scope) { hold('scope_mismatch'); continue; }
      if (pref.status !== 'confirmed') { hold('not_confirmed'); continue; }
      if (pref.merged_into) { hold('merged_preference'); continue; }
      // Optional OSB scalars discard malformed values. Preserve the difference
      // between absent and present-but-invalid validity metadata here.
      if (['valid_from', 'valid_until', 'expiration_date'].some(key => Object.hasOwn(raw, key) &&
          (typeof raw[key] !== 'string' || !raw[key].trim()))) {
        hold('invalid_or_inactive_time'); continue;
      }
      const created = instant(pref.created_at), confirmed = instant(pref.confirmed_at);
      const from = pref.valid_from === undefined ? created : instant(pref.valid_from);
      const until = pref.valid_until === undefined ? Infinity : instant(pref.valid_until);
      let expiration = Infinity;
      if (pref.expiration_date !== undefined) {
        const value = pref.expiration_date;
        expiration = /^\d{4}-\d{2}-\d{2}$/.test(value) ? instant(`${value}T00:00:00Z`) : instant(value);
      }
      if (![created, confirmed, from].every(Number.isFinite) || created > confirmed || confirmed > now ||
          from > now || Number.isNaN(until) || until <= now || Number.isNaN(expiration) || expiration <= now) {
        hold('invalid_or_inactive_time'); continue;
      }
      if (!pref.content_hash || !/^[a-f0-9]{64}$/.test(pref.content_hash) || !hashes.verifyContentHash(pref).ok) {
        hold('content_hash_unverified'); continue;
      }
      const grants = authorizations.filter(grant => grant && grant.project_id === projectId &&
        grant.scope === project.resolved_scope && grant.preference_id === pref.id &&
        grant.content_hash === pref.content_hash && typeof grant.source_ref === 'string' && grant.source_ref.trim());
      if (!grants.length) { hold('authorization_missing'); continue; }
      const grant = grants.find(candidate => candidate.owner === pref.owner);
      if (!grant) { hold('owner_mismatch'); continue; }
      let provenance;
      try {
        provenance = origins.resolvePreferenceProvenance(pref, (id: string) => {
          if (!/^sig-[A-Za-z0-9_-]+$/.test(id)) return undefined;
          const found: string[] = [];
          for (const dir of [dirs.inbox, dirs.processed, dirs.archived]) {
            if (!localDir(dir)) continue;
            const file = path.join(dir, `${id}.md`);
            if (!fs.existsSync(file)) continue;
            const signal = signals.parseSignal(safe(path.relative(vault, file)));
            if (signal.id === id && signal.session_ref) found.push(signal.session_ref);
          }
          return found.length === 1 ? found[0] : undefined;
        });
      } catch { provenance = null; }
      if (!provenance) { hold('provenance_unresolved'); continue; }
      let application;
      try {
        const reviewed = grant.application;
        if (!reviewed || typeof reviewed.artifact !== 'string' || !/^[a-f0-9]{64}$/.test(reviewed.sha256)) throw Error('No reviewed artifact');
        const artifact = safe(reviewed.artifact);
        const digest = createHash('sha256').update(fs.readFileSync(artifact)).digest('hex');
        if (digest !== reviewed.sha256) throw Error('Reviewed artifact changed');
        // The existing evidence reader scans a flat log directory. Check every
        // candidate before calling it so its fallback cannot read an escape.
        if (localDir(dirs.log)) for (const file of fs.readdirSync(dirs.log)) {
          if (/\.(md|jsonl)$/.test(file)) safe(path.relative(vault, path.join(dirs.log, file)));
        }
        const collected = evidence.collectEvidenceForSlug(vault, pref.id.replace(/^pref-/, ''),
          { sinceIso: new Date(created).toISOString(), maxApplied: Number.MAX_SAFE_INTEGER, maxViolated: 0 });
        const matching = collected.applied.find((row: any) => {
          const timestamp = instant(row.timestamp);
          if (row.outcome !== 'success' || !Number.isFinite(timestamp) || timestamp < created || timestamp > now) return false;
          const ref = /^\[\[([^\[\]|#]+)\]\]$/.exec(row.artifact)?.[1];
          if (!ref) return false;
          try { return path.relative(fs.realpathSync.native(safe(ref)), fs.realpathSync.native(artifact)) === ''; }
          catch { return false; }
        });
        if (matching) application = { artifact: reviewed.artifact, sha256: digest,
          timestamp: matching.timestamp, outcome: matching.outcome };
      } catch { /* An unreadable or missing application stays withheld. */ }
      if (!application) { hold('application_unverified'); continue; }
      result.items.push({ id: pref.id, principle: pref.principle, scope: pref.scope,
        path: path.relative(vault, entry.path), content_hash: pref.content_hash, provenance,
        authorization: { source_ref: grant.source_ref, project_id: grant.project_id }, application });
    }
    result.status = result.items.length ? 'loaded' : files.length ? 'not_loaded' : 'empty';
    return result;
  } catch {
    return { ...result, status: 'unavailable', items: [], reason_code: 'preference_reader_unavailable' };
  }
}
/**
 * Resolve an explicit checkpoint first, then attach own continuation, approved global/project rules and separately authorized advisory preferences.
 * @param {Options} options Explicit project and optional actual workspace, local vault and exact named handoff.
 * @param {readonly PreferenceAuthorization[]} [authorizations] Trusted host preference grants; default grants nothing.
 * @returns {Promise<object>} Checkpoint, continuation and rule-class statuses with errors/truncation preserved; uses existing readers and performs no preference promotion.
 */
export async function resumeWithRules(options: Options, authorizations: readonly PreferenceAuthorization[] = []) {
  if (!options.project) throw Error('--project <confirmed project_id> required; no latest-project fallback');
  const vault = path.resolve(options.vault || 'C:\\TheHive');
  if (options.workspace !== undefined && !path.isAbsolute(options.workspace)) throw Error('--workspace must be an explicit absolute trusted workspace path');
  // Resolve/verify the requested checkpoint FIRST. Unknown projects must never
  // trigger broad rule reads, source discovery or newest-checkpoint fallbacks.
  const checkpoint = resumeProject(path.join(vault, 'work', 'handoff'), options.project);
  let continuation: any = { status: 'unbound', reason_code: 'explicit_chat_task_required' };
  if (options.handoff && (!options.workspace || !process.env.CODEX_THREAD_ID)) throw Error('Named handoff requires actual session and workspace');
  if (options.workspace && process.env.CODEX_THREAD_ID) {
    try {
      const own = resumeChatContinuation(path.join(vault, 'work', 'handoff'),
        { session_id: process.env.CODEX_THREAD_ID, workspace: options.workspace, ...(options.handoff?{handoff_file:options.handoff}:{}) });
      if (own.checkpoint.project_id !== checkpoint.project_id) throw Error('Chat continuation project mismatch');
      continuation = { status: 'loaded', ...own.continuation,
        checkpoint_id: own.checkpoint.checkpoint_id, file: own.checkpoint.file };
    } catch (error) { if (options.handoff) throw error; /* Shared project knowledge is readable; it is not a chat order. */ }
  }
  let learned_preferences: any = { status: 'not_loaded',
    reason: 'No approved project-scope binding for learned preferences is established; active.md and context-pack are not an approved global rule list.' };
  const source = path.resolve(process.env.OSB_SOURCE || path.join(os.homedir(), 'projects', 'open-second-brain'));
  let readers;
  try {
    /**
     * Import the named existing OSB reader module relative to the currently selected source directory; no module installation is performed.
     */
    const load = (file: string) => import(pathToFileURL(path.join(source, 'src', 'core', 'brain', file)).href);
    const [standing, identity, scoped] = await Promise.all([
      load('standing-rules.ts'), load('scope-identity.ts'), load('scoped-rules.ts'),
    ]);
    readers = { ...standing, ...identity, ...scoped };
  } catch (error) {
    return { checkpoint, continuation, rules: { global: { status: 'unavailable', error: failure(error) },
      project: { status: 'unavailable', error: 'Existing OSB readers unavailable; no substitute rules loaded' }, learned_preferences } };
  }
  let global;
  try {
    const rules = readers.readStandingRules(vault);
    global = rules === null ? { status: 'missing', path: path.join(vault, 'Brain', 'standing-rules.md'), truncated: false }
      : { status: 'loaded', ...rules };
  } catch (error) { global = { status: 'unavailable', error: failure(error) }; }
  let project;
  try {
    const self = localSelfBinding(checkpoint.project_id, options.workspace, vault);
    const resolved = self.binding ? readers.scopedRuleKey(LOCAL_FIXED_PROJECT_ID)
      : self.reason_code ? null : readers.resolveProjectScope(options.workspace ? path.resolve(options.workspace) : null, vault);
    const expected = readers.scopedRuleKey(checkpoint.project_id);
    if (self.reason_code) {
      project = { status: 'binding_unavailable', expected_scope: expected,
        reason_code: self.reason_code, reason: self.reason };
    } else if (resolved === null) {
      project = { status: 'binding_unavailable', expected_scope: expected,
        reason: 'No existing operator-owned workspace pointer binds this project to the serving vault; no project rules loaded.' };
    } else if (resolved !== expected) {
      project = { status: 'scope_mismatch', expected_scope: expected, resolved_scope: resolved,
        reason: 'Workspace scope differs from the requested checkpoint; no project rules loaded.' };
    } else {
      const rules = readers.readScopedRules(vault, { project: resolved, harness: null, host: null });
      const unavailable = rules.text.split(/\r?\n/).some((line: string) => line.startsWith('UNAVAILABLE: '));
      project = { status: unavailable ? 'unavailable' : rules.files.length ? 'loaded' : 'missing',
        resolved_scope: resolved, files: rules.files, text: rules.text,
        truncated: rules.files.some((file: { truncated: boolean }) => file.truncated),
        ...(self.binding ? { binding: self.binding } : {}) };
    }
  } catch (error) { project = { status: 'unavailable', error: failure(error) }; }
  learned_preferences = await readLearnedPreferences(vault, checkpoint.project_id, project, source, authorizations);
  return { checkpoint, continuation, rules: { global, project, learned_preferences } };
}

if (import.meta.main) {
  try { console.log(JSON.stringify(await resumeWithRules(parseArgs(process.argv.slice(2))), null, 2)); }
  catch (error) { console.error(`handoff-resume: ${failure(error)}`); process.exitCode = 1; }
}

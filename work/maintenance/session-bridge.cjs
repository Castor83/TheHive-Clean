'use strict';
// Opt-in, one-file bridge into the EXISTING Open Second Brain importer.
// Preview is the default. No discovery, background loops or LLM calls.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const os = require('node:os');

/**
 * Parse one explicit JSONL session and importer format; require separate user-turn-storage consent and preview hash for apply.
 */
function parseArgs(argv) {
  const options = { apply: false, acceptUserTurnStorage: false };
  const flags = new Set(['--apply', '--accept-user-turn-storage']);
  const values = { '--session': 'session', '--format': 'format', '--confirm-sha256': 'confirmSha256' };
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    if (flags.has(flag)) { options[flag === '--apply' ? 'apply' : 'acceptUserTurnStorage'] = true; continue; }
    const key = values[flag];
    if (!key || i + 1 >= argv.length || argv[i + 1].startsWith('--')) throw Error(`Unbekanntes oder unvollständiges Argument: ${flag}`);
    if (options[key] !== undefined) throw Error(`Argument doppelt: ${flag}`);
    options[key] = argv[++i];
  }
  if (!options.session || !['codex', 'opencode'].includes(options.format)) {
    throw Error('Aufruf: --session <eine JSONL-Datei> --format codex|opencode [--apply --accept-user-turn-storage --confirm-sha256 <Preview-Hash>]');
  }
  if (options.apply && (!options.acceptUserTurnStorage || !options.confirmSha256)) {
    throw Error('--apply braucht --accept-user-turn-storage und --confirm-sha256 aus der Vorschau');
  }
  if (!options.apply && (options.acceptUserTurnStorage || options.confirmSha256)) {
    throw Error('Einwilligung und Hash nur mit --apply angeben');
  }
  if (options.confirmSha256 && !/^[a-f0-9]{64}$/.test(options.confirmSha256)) throw Error('SHA-256 muss 64 Kleinbuchstaben/Hexzeichen haben');
  return options;
}

/**
 * Hash one regular non-symlink JSONL session up to 128 MiB using bounded reads; always close the source descriptor.
 */
function fingerprint(file) {
  const lstat = fs.lstatSync(file);
  if (!lstat.isFile() || lstat.isSymbolicLink()) throw Error('Nur echte Einzeldateien erlaubt; keine Verzeichnisse oder Links');
  if (path.extname(file).toLowerCase() !== '.jsonl') throw Error('Nur JSONL-Sitzungsdateien erlaubt');
  if (lstat.size > 128 * 1024 * 1024) throw Error('Sitzungsdatei über 128 MiB: gesondert prüfen');
  const fd = fs.openSync(file, 'r');
  try {
    const hash = crypto.createHash('sha256');
    const buffer = Buffer.allocUnsafe(64 * 1024);
    let amount;
    while ((amount = fs.readSync(fd, buffer, 0, buffer.length, null)) !== 0) hash.update(buffer.subarray(0, amount));
    return hash.digest('hex');
  } finally { fs.closeSync(fd); }
}

/**
 * Build the existing OSB importer command with user-only preference extraction and preserved event times; dry-run is default and no command is executed here.
 */
function buildInvocation(opts, home = os.homedir()) {
  const root = process.env.THEHIVE_ROOT || 'C:\\TheHive';
  const source = process.env.OSB_SOURCE || path.win32.join(home, 'projects', 'open-second-brain');
  const bun = process.env.BUN_EXE || path.win32.join(home, '.bun', 'bin', 'bun.exe');
  const cli = path.win32.join(source, 'src', 'cli', 'main.ts');
  return {
    bun, source,
    argv: ['run', cli, 'brain', 'import-session', opts.session, '--format', opts.format,
      '--preference-only', '--filter-role', 'user', '--preserve-event-time',
      '--recall', '--agent', 'thehive-session-bridge', '--vault', root, '--json',
      ...(opts.apply ? [] : ['--dry-run'])],
  };
}

/**
 * Fingerprint one session, invoke the existing importer with a timeout, validate its isolated report and recheck the unchanged source.
 * @param {object} opts Explicit session, format and optional apply consent/hash.
 * @param {Function} [spawn] Injectable synchronous process runner, defaulting to spawnSync.
 * @returns {object} Preview or applied counts and source hash; no Dream or subsequent model extraction is started.
 */
function execute(opts, spawn = spawnSync) {
  const file = path.resolve(opts.session);
  const before = fingerprint(file);
  if (opts.apply && before !== opts.confirmSha256) throw Error('Datei seit der Vorschau geändert: Import verweigert');
  const invocation = buildInvocation({ ...opts, session: file });
  const res = spawn(invocation.bun, invocation.argv, {
    cwd: invocation.source, windowsHide: true, shell: false, encoding: 'utf8', timeout: 120000, maxBuffer: 8 * 1024 * 1024,
  });
  if (res.error || res.status !== 0) throw Error(`Importer fehlgeschlagen: ${res.error?.message || String(res.stderr || res.status).slice(0, 1200)}`);
  let report;
  try { report = JSON.parse(res.stdout); } catch { throw Error('Importer lieferte keinen gültigen JSON-Bericht'); }
  if (!Array.isArray(report.files) || report.files.length !== 1 || report.warnings?.length || report.failed?.length) {
    throw Error('Unerwarteter Importbericht, Ergebnis nicht als Erfolg werten');
  }
  const item = report.files[0];
  if (item.write_mode !== (opts.apply ? 'applied' : 'dry_run')) throw Error('Schreibstatus passt nicht zum Aufruf');
  if (item.facts_extracted !== 0 || item.facts_withheld !== 0 || item.facts_ambient_withheld !== 0) {
    throw Error('Fakten-Lane wurde nicht isoliert: bitte Änderungen prüfen');
  }
  const after = fingerprint(file);
  if (after !== before) throw Error('Quelldatei wurde während des Imports geändert: Ergebnis prüfen, nicht automatisch wiederholen');
  return {
    status: opts.apply ? 'applied' : 'preview_only',
    source_file: file, sha256: before, format: item.format, turns_scanned: item.turns_scanned,
    signals_written: item.signals_created, signals_forecast: item.signals_withheld,
    signals_deduped: item.signals_deduped, user_turns_saved_to_recall: item.recall_turns_imported,
    next: opts.apply ? 'LLM-Signalextraktion noch separat nötig; Dream nicht automatisch gestartet' :
      'Nur Vorschau: noch nichts importiert. Nach fachlicher Prüfung ist eine ausdrückliche Freigabe erforderlich.',
  };
}

if (require.main === module) {
  try { console.log(JSON.stringify(execute(parseArgs(process.argv.slice(2))), null, 2)); }
  catch (error) { console.error(`session-bridge: ${error.message}`); process.exitCode = 1; }
}
module.exports = { parseArgs, buildInvocation, fingerprint, execute };

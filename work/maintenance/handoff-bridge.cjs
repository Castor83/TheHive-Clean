'use strict';
// Explicit, one-file local intake from the EXISTING synchronized Drive bridge.
// Preview is the default. No network calls, export, discovery, raw-chat import or learning.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { TextDecoder } = require('node:util');
const MAX_BYTES = 1024 * 1024;

/**
 * Parse one explicit synchronized envelope source; preview is default and apply requires a supplied preview SHA-256.
 */
function parseArgs(argv) {
  const options = { apply: false, root: 'C:\\TheHive\\work\\handoff' };
  const seen = new Set();
  const values = { '--source': 'source', '--root': 'root', '--confirm-sha256': 'confirmSha256' };
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    if (seen.has(flag)) throw Error(`Argument doppelt: ${flag}`);
    seen.add(flag);
    if (flag === '--apply') { options.apply = true; continue; }
    if (!Object.hasOwn(values, flag) || !argv[i + 1] || argv[i + 1].startsWith('--')) {
      throw Error(`Unbekanntes oder unvollständiges Argument: ${flag}`);
    }
    options[values[flag]] = argv[++i];
  }
  if (!options.source) throw Error('--source <eine synchronisierte Checkpoint-JSON-Datei> erforderlich');
  if (options.apply && !options.confirmSha256) throw Error('--apply braucht --confirm-sha256 <Hash aus der Vorschau>');
  if (!options.apply && options.confirmSha256) throw Error('--confirm-sha256 nur zusammen mit --apply verwenden');
  if (options.confirmSha256 && !/^[a-f0-9]{64}$/i.test(options.confirmSha256)) throw Error('Ungültiger SHA-256-Hash');
  return options;
}

/**
 * Return an absolute path comparison key, folding case only on Windows.
 */
function normalized(file) {
  const absolute = path.resolve(file);
  return process.platform === 'win32' ? absolute.toLowerCase() : absolute;
}

/**
 * Read one bounded regular UTF-8 JSON envelope while checking link redirection and file stability; return parsed input, absolute source and SHA-256.
 * @param {string} source Explicit synchronized local JSON file.
 * @returns {object} Fingerprinted version-1 envelope; full schema validation remains the store responsibility.
 */
function readEnvelope(source) {
  const absolute = path.resolve(source);
  const before = fs.lstatSync(absolute);
  if (before.isSymbolicLink() || !before.isFile()) throw Error('Nur eine echte Einzeldatei erlaubt, keine Links oder Verzeichnisse');
  if (normalized(fs.realpathSync.native(absolute)) !== normalized(absolute)) throw Error('Quelle über Link/Verknüpfung nicht erlaubt');
  if (before.size === 0 || before.size > MAX_BYTES) throw Error('Leere oder zu große Quelldatei (maximal 1 MiB)');
  const fd = fs.openSync(absolute, 'r');
  let bytes;
  try {
    const opened = fs.fstatSync(fd);
    if (opened.ino !== before.ino || opened.dev !== before.dev || opened.size !== before.size) throw Error('Quelldatei beim Öffnen geändert');
    bytes = Buffer.alloc(opened.size);
    let read = 0;
    while (read < bytes.length) {
      const amount = fs.readSync(fd, bytes, read, bytes.length - read, read);
      if (!amount) throw Error('Datei unvollständig synchronisiert');
      read += amount;
    }
    const after = fs.fstatSync(fd);
    const current = fs.lstatSync(absolute);
    if (after.size !== before.size || after.mtimeMs !== before.mtimeMs || after.ctimeMs !== before.ctimeMs ||
        current.ino !== before.ino || current.dev !== before.dev || current.size !== before.size ||
        current.mtimeMs !== before.mtimeMs || current.isSymbolicLink() ||
        normalized(fs.realpathSync.native(absolute)) !== normalized(absolute)) throw Error('Quelldatei während des Lesens geändert');
  } finally { fs.closeSync(fd); }
  let input;
  try { input = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes).replace(/^\uFEFF/, '')); }
  catch { throw Error('Ungültige oder unvollständige UTF-8-JSON-Datei'); }
  if (!input || input.format_version !== 1 || typeof input.project_id !== 'string' ||
      typeof input.session_id !== 'string' || !input.patch || typeof input.patch !== 'object' || Array.isArray(input.patch)) {
    throw Error('Kein Checkpoint-Envelope Version 1; das vollständige Schema wird beim lokalen Speichern geprüft');
  }
  return { source_file: absolute, input, sha256: crypto.createHash('sha256').update(bytes).digest('hex') };
}

/**
 * Preview a synchronized envelope without persistence, or save it through the store after matching and rechecking its confirmed hash.
 * @param {object} options Source, optional store root, apply flag and confirmed preview hash.
 * @returns {object} Preview metadata or confirmed local store result; never performs synchronization or network calls.
 */
function execute(options) {
  const source = readEnvelope(options.source);
  const metadata = { source_file: source.source_file, source_sha256: source.sha256,
    project_id: source.input.project_id, session_id: source.input.session_id };
  if (!options.apply) return { ...metadata, sha256: source.sha256, status: 'preview_only', storage_stage: 'pc_synced',
    next: 'Nur Quelldatei lokal gelesen. Nach Inhaltsprüfung mit --apply --confirm-sha256 <sha256> lokal speichern.' };
  if (typeof options.confirmSha256 !== 'string' || options.confirmSha256.toLowerCase() !== source.sha256) {
    throw Error('SHA-256-Hash fehlt oder Quelle seit der Vorschau geändert: keine Speicherung');
  }
  const latest = readEnvelope(source.source_file);
  if (latest.sha256 !== source.sha256) throw Error('Quelldatei nach Prüfung geändert: keine Speicherung');
  // The store owns schema, scope, parent conflict, transaction and persistence checks.
  const result = require('./handoff-store.cjs').saveCheckpoint(options.root || 'C:\\TheHive\\work\\handoff', source.input);
  if (!['local_verified', 'unchanged'].includes(result.status)) throw Error('Lokale Speicherung nicht bestätigt');
  return { ...metadata, ...result, storage_stage: 'local_verified', source_stage: 'pc_synced' };
}

if (require.main === module) {
  try { console.log(JSON.stringify(execute(parseArgs(process.argv.slice(2))), null, 2)); }
  catch (error) { console.error(`handoff-bridge: ${error.message}`); process.exitCode = 1; }
}
module.exports = { parseArgs, readEnvelope, execute };

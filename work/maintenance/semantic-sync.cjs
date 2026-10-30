'use strict';

// Finite, local qmd maintenance. CLI: node semantic-sync.cjs [--status]
// Internal worker: existing Bun + this file --qmd-worker <request.json>.
// No global configuration edits, force re-embedding, downloads, or daemon.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn, spawnSync } = require('node:child_process');
const { pathToFileURL } = require('node:url');
const { createRequire } = require('node:module');

const ROOT = 'C:\\TheHive';
const DIR = path.join(ROOT, 'work', 'maintenance');
const USER = 'C:\\Users\\USER';
const PKG = path.join(USER, '.bun', 'install', 'global', 'node_modules', '@tobilu', 'qmd');
const BUN = path.join(USER, '.bun', 'bin', 'bun.exe');
const CONFIG = path.join(USER, '.config', 'qmd', 'index.yml');
const DB = path.join(USER, '.cache', 'qmd', 'index.sqlite');
const MODEL = path.join(USER, '.cache', 'qmd', 'models', 'hf_Qwen_Qwen3-Embedding-0.6B-Q8_0.gguf');
const MODEL_ID = 'hf:Qwen/Qwen3-Embedding-0.6B-GGUF/Qwen3-Embedding-0.6B-Q8_0.gguf';
const STATUS = path.join(DIR, 'semantic-sync.json');
const LOCK = path.join(DIR, 'semantic-sync.lock');
const EMBED_LOCK = path.join(path.dirname(DB), '.qmd-embed.lock');
const MAX_MS = 180000;
const LOG_BYTES = 256 * 1024;
const SCHEMA = 2;
const CUDA_MIN_FREE_MB = 4096;
const EXCLUDES = [
  '**/node_modules/**', '**/.*/**', '**/vendor/**', '**/dist/**', '**/build/**',
  'work/**', 'graphify-out/**', 'Brain/log/**', 'Brain/active.md', 'Brain/lessons.md',
  '20_Wissen/TheHive-Abnahmetest-20261023.md', '10_Projekte/OpenCode-Dateitest.md',
  'MCP-Verbindungstest.md',
];
/**
 * Fingerprint configuration, source bytes and maintenance contracts.
 * @param value - Bytes or text to hash.
 * @returns SHA-256 hex digest.
 */
const sha = value => crypto.createHash('sha256').update(value).digest('hex');
/**
 * Capture the current UTC time for persisted maintenance evidence.
 * @returns ISO 8601 timestamp.
 */
const now = () => new Date().toISOString();
/**
 * Read and parse an existing UTF-8 JSON file without fallback/reset.
 * @param file - Absolute JSON path.
 * @returns Parsed value; read/parse errors propagate.
 */
const readJson = file => JSON.parse(fs.readFileSync(file, 'utf8'));

/**
 * Probe free memory on CUDA device zero and choose CPU unless the bounded check passes.
 * @returns Device selection evidence; does not load a model or alter GPU processes.
 */
function selectDevice() {
  const base = { selected: 'cpu', cpu_only: true, checked_at: now(), gpu_index: 0, min_free_mb: CUDA_MIN_FREE_MB };
  // Read only the default CUDA device; free memory on a different card would
  // not establish that the device subsequently chosen by qmd has room.
  const probe = spawnSync('C:\\Windows\\System32\\nvidia-smi.exe', [
    '--id=0', '--query-gpu=memory.free', '--format=csv,noheader,nounits',
  ], { windowsHide: true, shell: false, encoding: 'utf8', timeout: 3000, maxBuffer: 16384 });
  if (probe.error || probe.status !== 0) return { ...base, reason: 'bounded_nvidia_smi_unavailable' };
  const value = probe.stdout.trim();
  if (!/^\d+$/.test(value)) return { ...base, reason: 'unrecognized_free_memory_result' };
  const freeMb = Number(value);
  if (!Number.isSafeInteger(freeMb) || freeMb < CUDA_MIN_FREE_MB) return { ...base, free_mb: freeMb, reason: 'insufficient_free_vram' };
  return { ...base, selected: 'cuda', cpu_only: false, free_mb: freeMb, reason: 'existing_gpu_has_required_free_vram' };
}

/**
 * Replace worker HTTP, fetch and socket entrypoints with throwing guards before qmd imports.
 * @returns Verified CommonJS/ESM guard evidence; mutations are local to this process.
 */
async function blockWorkerNetwork() {
  // Defense in depth, installed ONLY in this finite worker before qmd imports.
  // Local model binding and packaged-only runtime remain the primary contract.
  /**
   * Reject a network attempt inside the finite semantic worker.
   * @returns Never returns; always throws.
   */
  const deny = () => { throw Error('Network access is disabled in TheHive semantic worker'); };
  globalThis.fetch = async () => deny();
  const http = require('node:http'), https = require('node:https');
  const net = require('node:net'), tls = require('node:tls');
  http.request = deny; http.get = deny; https.request = deny; https.get = deny;
  net.connect = deny; net.createConnection = deny; net.Socket.prototype.connect = deny;
  tls.connect = deny; tls.createConnection = deny;
  const modules = require('node:module');
  let synced = false;
  if (typeof modules.syncBuiltinESMExports === 'function') {
    try { modules.syncBuiltinESMExports(); synced = true; }
    catch (error) { console.log(JSON.stringify({ step: 'network-guard-builtin-sync', supported: false, reason: error.message })); }
  }
  const [httpEsm, httpsEsm, netEsm, tlsEsm] = await Promise.all([
    import('node:http'), import('node:https'), import('node:net'), import('node:tls'),
  ]);
  if (httpEsm.request !== deny || httpEsm.get !== deny || httpsEsm.request !== deny || httpsEsm.get !== deny || netEsm.connect !== deny || netEsm.createConnection !== deny || tlsEsm.connect !== deny) throw Error('ESM network guard is incompatible with installed runtime; refusing qmd import');
  return { fetch_blocked: true, http_https_blocked: true, net_tls_blocked: true, esm_bindings_verified: true, builtin_exports_synced: synced, scope: 'this worker process only' };
}

/**
 * Write JSON through an exclusive temporary file, retrying transient rename errors.
 * @param file - Destination path.
 * @param value - JSON-serializable report or request.
 */
function atomicJson(file, value) {
  const temp = file + '.' + process.pid + '.tmp';
  fs.writeFileSync(temp, JSON.stringify(value, null, 2) + '\n', { flag: 'wx' });
  for (let attempt = 0; ; attempt++) {
    try { fs.renameSync(temp, file); return; }
    catch (error) {
      if (!['EPERM', 'EBUSY', 'EACCES'].includes(error.code) || attempt >= 39) throw error;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50);
    }
  }
}

/**
 * Check the approved local model size, regular-file status and GGUF magic.
 * @returns Model path, size and mtime; this is not a full content hash check.
 */
function modelCheck() {
  const st = fs.lstatSync(MODEL);
  if (!st.isFile() || st.isSymbolicLink() || st.size !== 639150592) throw Error('Existing approved Qwen GGUF is absent or has changed size');
  const fd = fs.openSync(MODEL, 'r');
  const magic = Buffer.alloc(4);
  try { fs.readSync(fd, magic, 0, 4, 0); } finally { fs.closeSync(fd); }
  if (magic.toString('ascii') !== 'GGUF') throw Error('Local model is not GGUF');
  return { path: MODEL, bytes: st.size, mtime_ms: st.mtimeMs };
}

/**
 * Validate the existing qmd version, single collection and model/configuration contract.
 * @returns Parsed config, original bytes/hash, package resolver and merged exclusions.
 */
function configuration() {
  const bytes = fs.readFileSync(CONFIG);
  const localRequire = createRequire(path.join(PKG, 'package.json'));
  const cfg = localRequire('yaml').parse(bytes.toString('utf8'));
  if (!cfg || Object.keys(cfg.collections || {}).join(',') !== 'thehive') throw Error('Only the existing thehive collection is allowed');
  const col = cfg.collections.thehive;
  if (path.resolve(col.path).toLowerCase() !== ROOT.toLowerCase() || col.pattern !== '**/*.md' || col.update) throw Error('Unexpected collection path, pattern, or update hook');
  if (cfg.models?.embed !== MODEL_ID || !cfg.models.generate || !cfg.models.rerank) throw Error('Existing complete model configuration is required');
  if (!Array.isArray(col.ignore) || !col.ignore.every(v => typeof v === 'string')) throw Error('Unexpected qmd ignore policy');
  const version = readJson(path.join(PKG, 'package.json')).version;
  if (version !== '2.8.3') throw Error('qmd version changed; maintenance source contract must be reviewed');
  return { cfg, bytes, sha256: sha(bytes), localRequire, ignores: [...new Set([...col.ignore, ...EXCLUDES])] };
}

/**
 * Fingerprint the bounded Markdown corpus using the validated ignore policy.
 * @param conf - Validated configuration and package-local glob resolver.
 * @returns Nonempty path/hash records and empty paths; refuses files resolved outside the vault.
 */
function sources(conf) {
  const glob = conf.localRequire('fast-glob');
  const files = glob.sync('**/*.md', { cwd: ROOT, onlyFiles: true, followSymbolicLinks: false, dot: false, ignore: conf.ignores }).sort();
  const nonempty = [], empty = [];
  let totalBytes = 0;
  for (const file of files) {
    const absolute = path.join(ROOT, file);
    const real = fs.realpathSync(absolute);
    if (!real.toLowerCase().startsWith(ROOT.toLowerCase() + path.sep)) throw Error('Source outside vault');
    const bytes = fs.readFileSync(absolute);
    totalBytes += bytes.length;
    if (totalBytes > 32 * 1024 * 1024 || files.length > 5000) throw Error('Source corpus exceeds bounded maintenance size');
    if (bytes.toString('utf8').trim()) nonempty.push({ path: file.replaceAll('\\', '/'), sha256: sha(bytes) });
    else empty.push(file.replaceAll('\\', '/'));
  }
  return { nonempty, empty };
}

/**
 * Hash the installed qmd store, LLM and database entrypoints.
 * @returns Package-relative file to SHA-256 map used for parent/worker consistency.
 */
function sourceContract() {
  const files = ['dist/store.js', 'dist/llm.js', 'dist/db.js'];
  return Object.fromEntries(files.map(file => [file, sha(fs.readFileSync(path.join(PKG, file)))]));
}

/**
 * Acquire an exclusive lock, archiving only a demonstrably dead recorded owner.
 * @param file - Lock path.
 * @param token - Ownership nonce for JSON locks.
 * @param qmdFormat - Use qmd single-PID format when true.
 * @returns Release callback that removes only the still-matching owner lock.
 */
function takeLock(file, token, qmdFormat = false) {
  const content = qmdFormat ? `${process.pid}\n` : JSON.stringify({ pid: process.pid, token, started_at: now() }) + '\n';
  try { fs.writeFileSync(file, content, { flag: 'wx' }); }
  catch (error) {
    if (error.code !== 'EEXIST') throw error;
    let pid;
    try { const raw = fs.readFileSync(file, 'utf8'); pid = Number(raw.trim()); if (!Number.isInteger(pid)) pid = JSON.parse(raw).pid; }
    catch { throw Error('Unreadable existing lock; inspect ' + file); }
    if (!Number.isInteger(pid) || pid <= 0) throw Error('Invalid existing lock; inspect ' + file);
    try { process.kill(pid, 0); throw Error('Maintenance lock is held by live PID ' + pid); }
    catch (probe) { if (probe.code !== 'ESRCH') throw probe; }
    // Keep stale evidence. A racing new owner wins the subsequent exclusive write.
    fs.renameSync(file, file + '.stale.' + Date.now() + '.' + process.pid);
    fs.writeFileSync(file, content, { flag: 'wx' });
  }
  return () => {
    try {
      const raw = fs.readFileSync(file, 'utf8');
      if (qmdFormat ? Number(raw.trim()) === process.pid : (() => { const owner = JSON.parse(raw); return owner.pid === process.pid && owner.token === token; })()) fs.unlinkSync(file);
    } catch {}
  };
}

/**
 * Create or validate a fingerprint-specific config and SQLite online backup.
 * @param fingerprint - Corpus/config/model contract key.
 * @param conf - Validated configuration bytes and hash.
 * @returns Backup directory; incomplete prior directories are preserved and block replacement.
 */
async function backupOnce(fingerprint, conf) {
  const target = path.join(DIR, 'semantic-backups', fingerprint);
  const marker = path.join(target, 'complete.json');
  if (fs.existsSync(marker)) {
    const prior = readJson(marker);
    if (prior.fingerprint !== fingerprint || prior.config_sha256 !== conf.sha256 || !fs.existsSync(path.join(target, 'index.sqlite'))) throw Error('Prior backup is incomplete');
    return target;
  }
  fs.mkdirSync(path.dirname(target), { recursive: true });
  // An interrupted incomplete directory is preserved and blocks automatic replacement.
  fs.mkdirSync(target);
  fs.writeFileSync(path.join(target, 'index.yml'), conf.bytes, { flag: 'wx' });
  const { DatabaseSync, backup } = require('node:sqlite');
  const db = new DatabaseSync(DB, { readOnly: true });
  try {
    db.exec('PRAGMA busy_timeout=5000');
    const deadline = Date.now() + 20000;
    await backup(db, path.join(target, 'index.sqlite'), { rate: 128, progress: () => {
      if (Date.now() > deadline) throw Error('SQLite backup exceeded time limit');
    } });
  } finally { if (db.isOpen) db.close(); }
  if (sha(fs.readFileSync(CONFIG)) !== conf.sha256) throw Error('Configuration changed during SQLite backup');
  atomicJson(marker, { fingerprint, created_at: now(), config_sha256: conf.sha256, database: 'node:sqlite online backup', source: DB });
  return target;
}

/**
 * Launch the finite Bun worker with bounded logs, device settings and termination deadlines.
 * @param requestFile - Validated worker request JSON path.
 * @param logFile - New log destination.
 * @param device - Parent device selection evidence.
 * @returns Promise for exit/log metadata; retains locks for a worker that fails to stop.
 */
function runWorker(requestFile, logFile, device) {
  return new Promise((resolve, reject) => {
    const fd = fs.openSync(logFile, 'wx');
    let kept = 0, seen = 0, timedOut = false, settled = false;
    const child = spawn(BUN, [__filename, '--qmd-worker', requestFile], {
      cwd: ROOT, windowsHide: true, shell: false, stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, QMD_FORCE_CPU: device.selected === 'cuda' ? '0' : '1',
        QMD_LLAMA_GPU: device.selected === 'cuda' ? 'cuda' : 'off', QMD_EMBED_PARALLELISM: '1',
        QMD_CONFIG_DIR: path.dirname(CONFIG), XDG_CACHE_HOME: path.join(USER, '.cache'),
        HF_HUB_OFFLINE: '1', TRANSFORMERS_OFFLINE: '1', NO_COLOR: '1' },
    });
    /**
     * Retain only the configured log budget while counting all child output bytes.
     * @param chunk - Child stdout/stderr buffer.
     */
    const capture = chunk => {
      if (settled) return;
      seen += chunk.length;
      if (kept < LOG_BYTES) { const part = chunk.subarray(0, LOG_BYTES - kept); fs.writeSync(fd, part); kept += part.length; }
    };
    child.stdout.on('data', capture); child.stderr.on('data', capture);
    /**
     * Mark timeout/interruption and request termination of this owned worker.
     */
    const stop = () => { timedOut = true; child.kill('SIGKILL'); };
    process.once('SIGINT', stop); process.once('SIGTERM', stop);
    const timer = setTimeout(stop, MAX_MS);
    const hardTimer = setTimeout(() => {
      try {
        process.kill(child.pid, 0);
        // Retain locks against the actual live child if termination failed.
        // A later run must block until that worker has gone away.
        const held = readJson(LOCK);
        if (held.pid === process.pid) {
          atomicJson(LOCK, { ...held, pid: child.pid, retained_for_worker: true });
          fs.writeFileSync(EMBED_LOCK, `${child.pid}\n`);
        }
      } catch {}
      finish(Error('Worker PID ' + child.pid + ' failed to close after termination request'));
    }, MAX_MS + 10000);
    /**
     * Settle the worker once, close the log and clear timers and signal listeners.
     * @param error - Failure that rejects the worker promise, if present.
     * @param code - Child exit code.
     * @param signal - Child termination signal.
     */
    function finish(error, code, signal) {
      if (settled) return; settled = true; clearTimeout(timer); clearTimeout(hardTimer);
      process.removeListener('SIGINT', stop); process.removeListener('SIGTERM', stop); fs.closeSync(fd);
      if (error) reject(error);
      else resolve({ exit_code: code, signal, timed_out: timedOut, output_bytes: seen, output_truncated: seen > kept, log_path: logFile });
    }
    child.on('error', error => finish(error));
    child.on('close', (code, signal) => finish(null, code, signal));
  });
}

/**
 * Reindex locally and commit a bounded number of resumable embedding chunks.
 * @param requestFile - Parent request binding config, package hashes, model metadata and device.
 * @returns Promise resolving after result persistence and runtime disposal; updates qmd SQLite.
 */
async function worker(requestFile) {
  const networkGuard = await blockWorkerNetwork();
  const request = readJson(requestFile);
  const conf = configuration();
  const model = modelCheck();
  if (conf.sha256 !== request.config_sha256 || JSON.stringify(sourceContract()) !== JSON.stringify(request.source_contract) || model.mtime_ms !== request.model.mtime_ms) throw Error('Inputs changed after preflight');
  const cuda = request.device?.selected === 'cuda';
  if (!['cuda', 'cpu'].includes(request.device?.selected) || process.env.QMD_FORCE_CPU !== (cuda ? '0' : '1') || process.env.QMD_LLAMA_GPU !== (cuda ? 'cuda' : 'off')) throw Error('Worker device environment differs from bounded parent selection');
  // These are the functions invoked by the installed qmd update/embed CLI.
  // A local GGUF path fails if absent. Explicit loadLlamaRuntime(false) below
  // forces packaged-only loading on both devices: build:never,skipDownload:true.
  const api = await import(pathToFileURL(path.join(PKG, 'dist', 'store.js')).href);
  const { LlamaCpp, setDefaultLlamaCpp, getDefaultLlamaCpp } = await import(pathToFileURL(path.join(PKG, 'dist', 'llm.js')).href);
  const store = api.createStore(DB);
  const llm = new LlamaCpp({ embedModel: MODEL, generateModel: MODEL, rerankModel: MODEL, inactivityTimeoutMs: 0 });
  store.llm = llm;
  // qmd's token chunker uses the singleton independently of store.llm.
  // Bind BOTH official entrypoints before any tokenization or model loading.
  setDefaultLlamaCpp(llm);
  if (getDefaultLlamaCpp() !== llm || store.llm !== llm || llm.embedModelName !== MODEL) throw Error('Local model binding is incomplete');
  try {
    api.syncConfigToDb(store.db, conf.cfg);
    const update = await api.reindexCollection(store, ROOT, '**/*.md', 'thehive', { ignorePatterns: [...conf.ignores, ...request.empty_paths] });
    if (update.skippedFiles?.length) throw Error('qmd skipped source files: ' + JSON.stringify(update.skippedFiles));
    console.log(JSON.stringify({ step: 'qmd-update-api', result: update }));
    const pendingBefore = api.getHashesNeedingEmbedding(store.db, 'thehive', MODEL_ID);
    let runtimeDevice = null;
    if (pendingBefore > 0) {
      console.log(JSON.stringify({ step: 'qmd-runtime-start', selected_device: request.device.selected, allow_build: false, allow_download: false }));
      const runtime = await llm.loadLlamaRuntime(false);
      runtimeDevice = runtime.gpu || 'cpu';
      // qmd may internally initialize its CPU prebuilt after a CUDA failure.
      // Reject that result before any model load or tokenization; do not run
      // this selected-CUDA pass on another backend or with changed settings.
      if (cuda && runtime.gpu !== 'cuda') throw Error('Selected packaged CUDA runtime unavailable; refusing model load on another backend');
      console.log(JSON.stringify({ step: 'qmd-runtime-ready', selected_device: request.device.selected, runtime_device: runtimeDevice, cpu_only: !cuda }));
    }
    // generateEmbeddings batches up to32 chunks even for maxDocsPerBatch:1,
    // then removes incomplete documents. Its session timeout cannot interrupt
    // an in-flight native operation. Use qmd's own chunker/formatter/inserter
    // one chunk at a time, keeping completed chunks across bounded passes.
    const fingerprint = api.getEmbeddingFingerprint(MODEL_ID);
    const pendingDocs = store.db.prepare(`
      SELECT d.hash,MIN(d.path) path,c.doc body FROM documents d
      JOIN content c ON c.hash=d.hash
      LEFT JOIN (SELECT hash,COUNT(*) chunk_count,MAX(total_chunks) expected_chunks
        FROM content_vectors WHERE model=? AND embed_fingerprint=? GROUP BY hash) v ON v.hash=d.hash
      WHERE d.active=1 AND d.collection='thehive'
        AND (v.hash IS NULL OR v.chunk_count<v.expected_chunks)
      GROUP BY d.hash ORDER BY length(c.doc),MIN(d.path)
    `).all(MODEL_ID, fingerprint);
    const maxChunks = cuda ? 8 : 2;
    const embed = { chunksEmbedded: 0, documentsCompleted: 0, errors: 0, resumedChunksSkipped: 0, maxChunksPerPass: maxChunks };
    const started = Date.now();
    for (const doc of pendingDocs) {
      if (embed.chunksEmbedded >= maxChunks || Date.now() - started > 110000) break;
      console.log(JSON.stringify({ step: 'qmd-tokenize-start', path: doc.path, characters: doc.body.length }));
      const chunks = await api.chunkDocumentByTokens(doc.body, undefined, undefined, undefined, doc.path);
      if (!chunks.length) throw Error('qmd returned no chunks for nonempty document');
      const done = new Set(store.db.prepare('SELECT seq FROM content_vectors WHERE hash=? AND model=? AND embed_fingerprint=? AND total_chunks=?').all(doc.hash, MODEL_ID, fingerprint, chunks.length).map(row => row.seq));
      embed.resumedChunksSkipped += done.size;
      console.log(JSON.stringify({ step: 'qmd-tokenize-finished', path: doc.path, total_chunks: chunks.length, completed_chunks: done.size }));
      for (let seq = 0; seq < chunks.length; seq++) {
        if (done.has(seq)) continue;
        if (embed.chunksEmbedded >= maxChunks || Date.now() - started > 110000) break;
        const chunk = chunks[seq];
        console.log(JSON.stringify({ step: 'qmd-chunk-start', path: doc.path, seq, total_chunks: chunks.length, tokens: chunk.tokens }));
        const text = api.formatDocForEmbedding(chunk.text, api.extractTitle(doc.body, doc.path), MODEL_ID);
        const vector = await llm.embed(text, { model: MODEL_ID });
        if (!vector || !vector.embedding?.length) throw Error('qmd returned no embedding for ' + doc.path + '#' + seq);
        store.ensureVecTable(vector.embedding.length);
        // Metadata and actual vector commit together; a killed next chunk must
        // not make an uncommitted metadata row look successfully embedded.
        store.db.exec('BEGIN IMMEDIATE');
        try {
          api.insertEmbedding(store.db, doc.hash, seq, chunk.pos, new Float32Array(vector.embedding), MODEL_ID, now(), chunks.length, fingerprint);
          store.db.exec('COMMIT');
        } catch (error) { store.db.exec('ROLLBACK'); throw error; }
        done.add(seq); embed.chunksEmbedded++;
        console.log(JSON.stringify({ step: 'qmd-chunk-committed', path: doc.path, seq, total_chunks: chunks.length, elapsed_ms: Date.now() - started }));
      }
      if (done.size === chunks.length) embed.documentsCompleted++;
    }
    const pendingAfter = api.getHashesNeedingEmbedding(store.db, 'thehive', MODEL_ID);
    console.log(JSON.stringify({ step: 'qmd-embed-api', result: embed, pending_before: pendingBefore, pending_after: pendingAfter }));
    if (pendingBefore > 0 && embed.chunksEmbedded === 0) throw Error('No incremental embedding progress; do not mark completed');
    atomicJson(request.result_path, { updated_at: now(), state: pendingAfter ? 'partial' : 'succeeded', update, embed, pending_before: pendingBefore, pending_after: pendingAfter, network_guard: networkGuard,
      model_path: MODEL, model_identifier: MODEL_ID, device: request.device, runtime_device: runtimeDevice, cpu_only: !cuda, force: false });
  } finally {
    try { await llm.dispose(); } finally { setDefaultLlamaCpp(null); store.close(); }
  }
}

/**
 * Dispatch status/worker mode or run one locked, backed-up semantic maintenance pass.
 * @returns Promise; prints status and persists failure evidence before releasing owned locks.
 */
async function main() {
  if (process.argv[2] === '--qmd-worker') { if (process.argv.length !== 4) throw Error('Invalid worker arguments'); await worker(process.argv[3]); return; }
  if (process.argv.length > 3 || (process.argv[2] && process.argv[2] !== '--status')) throw Error('Usage: node semantic-sync.cjs [--status]');
  if (process.argv[2] === '--status') { console.log(fs.existsSync(STATUS) ? fs.readFileSync(STATUS, 'utf8') : JSON.stringify({ state: 'never_run' })); return; }
  fs.mkdirSync(DIR, { recursive: true });
  const token = crypto.randomUUID();
  const unlock = takeLock(LOCK, token);
  let unlockEmbed;
  const previous = fs.existsSync(STATUS) ? readJson(STATUS) : {};
  const report = { schema: SCHEMA, started_at: now(), state: 'running', last_successful_fingerprint: previous.last_successful_fingerprint || null,
    collection: 'thehive', config_path: CONFIG, database_path: DB, model_identifier: MODEL_ID, cpu_only: null,
    mechanism: 'installed qmd 2.8.3 reindexCollection + resumable chunk/embed/insert APIs', no_global_config_edit: true, force_reembed: false };
  try {
    const conf = configuration();
    const model = modelCheck();
    const corpus = sources(conf);
    const contract = sourceContract();
    const fingerprint = sha(JSON.stringify({ schema: SCHEMA, files: corpus.nonempty, config: conf.sha256, model, contract }));
    Object.assign(report, { fingerprint, source_count: corpus.nonempty.length, config_sha256: conf.sha256, model, excluded: conf.ignores });
    if (fingerprint === previous.last_successful_fingerprint) {
      report.state = 'unchanged'; report.device = previous.device || null; report.cpu_only = previous.cpu_only ?? null;
      report.last_sync_result = previous.result ?? previous.last_sync_result ?? null;
      report.last_result_path = previous.result_path ?? previous.last_result_path ?? null;
      return;
    }
    unlockEmbed = takeLock(EMBED_LOCK, token, true);
    report.backup_dir = await backupOnce(fingerprint, conf);
    // Runtime device and fluctuating free memory never enter the corpus/model
    // fingerprint; completed CPU and CUDA chunks use exactly the same model ID.
    report.device = selectDevice();
    report.cpu_only = report.device.cpu_only;
    const runId = now().replace(/[:.]/g, '-') + '-' + process.pid;
    const requestFile = path.join(DIR, 'semantic-' + runId + '.request.json');
    const resultFile = path.join(DIR, 'semantic-' + runId + '.result.json');
    const logFile = path.join(DIR, 'semantic-' + runId + '.log');
    atomicJson(requestFile, { config_sha256: conf.sha256, source_contract: contract, model, device: report.device, empty_paths: corpus.empty, result_path: resultFile });
    report.worker = await runWorker(requestFile, logFile, report.device);
    if (report.worker.exit_code !== 0 || report.worker.timed_out || !fs.existsSync(resultFile)) throw Error('qmd worker failed; inspect ' + logFile);
    report.result_path = resultFile;
    report.result = readJson(resultFile);
    if (sha(fs.readFileSync(CONFIG)) !== conf.sha256) throw Error('Global configuration changed during maintenance; inspect without overwriting');
    const current = sources(conf);
    if (JSON.stringify(current.nonempty) !== JSON.stringify(corpus.nonempty)) throw Error('Sources changed during sync; next supervisor run must retry');
    report.state = report.result.state;
    if (report.state === 'succeeded') report.last_successful_fingerprint = fingerprint;
  } catch (error) {
    report.state = 'failed'; report.error = error.message; process.exitCode = 1;
  } finally {
    report.finished_at = now();
    try { atomicJson(STATUS, report); console.log(JSON.stringify({ state: report.state, source_count: report.source_count, status_path: STATUS, error: report.error })); }
    finally { if (unlockEmbed) unlockEmbed(); unlock(); }
  }
}

if (require.main === module) main().catch(error => { console.error(error.message); process.exitCode = 1; });

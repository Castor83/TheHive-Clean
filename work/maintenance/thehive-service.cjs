// Local maintenance supervisor. No prompts, providers, or dependency installation.
const fs = require('node:fs');
const path = require('node:path');
const { spawn, execFile } = require('node:child_process');
const { resumeStages } = require('./service-resume.cjs');
const ROOT = 'C:/TheHive';
const DIR = path.join(ROOT, 'work/maintenance');
const LOCK = path.join(DIR, 'service.lock.json');
const STATE = path.join(DIR, 'service-state.json');
const STOP = path.join(DIR, 'service-stop.json');
const mode = process.argv[2] || '--status';
const now = () => new Date().toISOString();
const read = file => JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
const alive = pid => { try { process.kill(pid, 0); return true; } catch (e) { return e.code !== 'ESRCH'; } };
function atomic(file, value) {
  const temp = file + '.' + process.pid + '.tmp';
  fs.writeFileSync(temp, JSON.stringify(value, null, 2) + '\n');
  for (let attempt = 0; ; attempt++) {
    try { fs.renameSync(temp, file); return; }
    catch (error) {
      if (!['EPERM', 'EBUSY', 'EACCES'].includes(error.code) || attempt >= 39) throw error;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50);
    }
  }
}
function existing() {
  if (!fs.existsSync(LOCK)) return null;
  const owner = read(LOCK);
  return { ...owner, alive: Number.isInteger(owner.pid) && alive(owner.pid) };
}
function previousState() {
  try {
    const stored = fs.existsSync(STATE) ? read(STATE) : undefined;
    return { stored, stages: resumeStages(stored) };
  } catch (error) {
    throw Error('Cannot resume prior maintenance state; preserved ' + STATE + ': ' + error.message);
  }
}
if (mode === '--status') {
  try {
    const owner = existing();
    const activity_mode = owner?.alive ? (fs.existsSync(STOP) ? 'switching_to_work' : 'maintenance') : 'work';
    console.log(JSON.stringify({ owner, activity_mode, state: previousState().stored ?? null }));
  }
  catch (error) {
    console.log(JSON.stringify({ owner: existing(), state: null, status: 'failed', state_preserved: true, error: error.message }));
    process.exitCode = 1;
  }
  return;
}
if (mode === '--stop') {
  atomic(STOP, { requested_at: now() });
  console.log(JSON.stringify({ status: 'stop_requested', owner: existing() }));
  return;
}
if (!['--once', '--watch', '--drain'].includes(mode)) throw Error('Use --status, --stop, --once, --drain, or --watch');
const owner = existing();
if (owner?.alive) {
  console.log(JSON.stringify({ status: 'already_running', pid: owner.pid }));
  return;
}
let previousStages;
try { previousStages = previousState().stages; }
catch (error) { console.error(error.message); process.exitCode = 1; return; }
const python = fs.readFileSync(path.join(ROOT, 'graphify-out/.graphify_python'), 'utf8').trim();
if (owner) fs.renameSync(LOCK, LOCK + '.' + Date.now() + '.stale');
fs.writeFileSync(LOCK, JSON.stringify({ pid: process.pid, started_at: now(), mode, entry: __filename }), { flag: 'wx' });
if (fs.existsSync(STOP)) fs.unlinkSync(STOP);
let stopping = false;
const state = { pid: process.pid, started_at: now(), mode, status: 'starting', stages: previousStages, cycles: 0,
  policy: { new_models: false, downloads: false, cloud_calls: false, qmd_embedding: 'existing-local-Qwen; packaged CUDA with sufficient free VRAM, otherwise CPU', synthetic_feedback: false } };
const save = () => atomic(STATE, state);
const powershell = path.join(process.env.SystemRoot || 'C:/Windows', 'System32/WindowsPowerShell/v1.0/powershell.exe');
const stages = [
  { name: 'results', exe: 'C:/Users/USER/.bun/bin/bun.exe', args: [path.join(DIR, 'project-knowledge-sync.ts')], timeout: 60000,
    env: { VAULT_AGENT_NAME: 'codex-desktop-agent' } },
  { name: 'navigation', exe: 'C:/Users/USER/.bun/bin/bun.exe', args: [path.join(DIR, 'note-navigation-sync.ts')], timeout: 60000 },
  { name: 'native', exe: powershell, args: ['-NoProfile', '-File', path.join(DIR, 'native-index-watch.ps1'), '-Action', 'Start'], timeout: 25000 },
  { name: 'learning', exe: process.execPath, args: [path.join(DIR, 'learning-sync.cjs')], timeout: 300000 },
  { name: 'graph', exe: python, args: [path.join(DIR, 'sync-text-graph.py'), '--html'], timeout: 120000 },
  { name: 'semantic', exe: process.execPath, args: [path.join(DIR, 'semantic-sync.cjs')], timeout: 300000 },
];
function run(stage) {
  return new Promise(resolve => {
    const started = now();
    const child = spawn(stage.exe, stage.args, { cwd: ROOT, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, ...stage.env } });
    let stdout = '', parseBuffer = '', resultTooLarge = false, stderr = '', error = null, timedOut = false, settled = false;
    const timer = setTimeout(() => {
      timedOut = true;
      // Only this directly spawned process tree is ours; stop descendants too.
      if (process.platform === 'win32' && child.pid) execFile('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true }, () => {});
      else child.kill();
    }, stage.timeout);
    child.stdout.on('data', value => {
      stdout = (stdout + value).slice(-32768);
      if (!resultTooLarge) {
        if (parseBuffer.length + String(value).length > 1048576) { resultTooLarge = true; parseBuffer = ''; }
        else parseBuffer += value;
      }
    });
    child.stderr.on('data', value => { stderr = (stderr + value).slice(-32768); });
    child.on('error', e => { error = e.message; });
    const hardTimer = setTimeout(() => finish(1, 'unconfirmed-child-close'), stage.timeout + 10000);
    function finish(exit_code, signal) {
      if (settled) return;
      settled = true; clearTimeout(timer); clearTimeout(hardTimer);
      child.stdout.destroy(); child.stderr.destroy();
      let result = null;
      if (resultTooLarge) { if (exit_code === 0) exit_code = 1; error = 'Maintenance stage result exceeds size limit'; }
      else try { result = JSON.parse(parseBuffer.trim()); } catch { /* preserve bounded diagnostic output */ }
      if (result && ['failed', 'deferred', 'locked', 'apply_failed_or_unverified'].includes(result.state ?? result.status)) {
        if (exit_code === 0) exit_code = 1;
        error = result.error ?? ('Maintenance stage is ' + (result.state ?? result.status));
      }
      resolve({ started_at: started, finished_at: now(), exit_code, signal, timed_out: timedOut, error, result, stdout, stderr });
    }
    child.on('close', finish);
    // Windows Start-Process descendants can retain pipe handles after the
    // short-lived launcher exits. Its native watcher readiness was checked
    // by the launcher itself; do not wait for the persistent watcher to exit.
    if (stage.name === 'native') child.on('exit', finish);
  });
}
async function cycle() {
  state.status = 'syncing'; state.cycles++; save();
  for (const stage of stages) {
    if (stopping || fs.existsSync(STOP)) break;
    const previous = state.stages[stage.name];
    if (previous?.retry_not_before && Date.parse(previous.retry_not_before) > Date.now()) continue;
    state.current_stage = stage.name; save();
    try { state.stages[stage.name] = await run(stage); }
    catch (e) { state.stages[stage.name] = { finished_at: now(), exit_code: 1, error: e.message }; }
    const result = state.stages[stage.name];
    if (result.exit_code !== 0) {
      result.consecutive_failures = (previous?.consecutive_failures ?? 0) + 1;
      const backoff = Math.min(3600000, 900000 * (2 ** Math.min(result.consecutive_failures - 1, 2)));
      result.retry_not_before = new Date(Date.now() + backoff).toISOString();
    }
    save();
  }
  delete state.current_stage;
  state.status = Object.values(state.stages).some(s => s.exit_code !== 0) || state.stages.navigation?.result?.status === 'partial' ? 'degraded'
    : state.stages.semantic?.result?.state === 'partial' ? 'catching_up' : 'watching';
  state.last_cycle_at = now(); save();
}
function release() {
  if (fs.existsSync(LOCK) && read(LOCK).pid === process.pid) fs.unlinkSync(LOCK);
}
process.on('SIGINT', () => { stopping = true; });
process.on('SIGTERM', () => { stopping = true; });
(async () => {
  try {
    await cycle();
    if (mode === '--drain') {
      // Explicit maintenance window: catch up, then release the process/model.
      // Bound the window even if writers keep changing the source corpus.
      while (!stopping && !fs.existsSync(STOP) && state.status === 'catching_up' && state.cycles < 32) {
        await new Promise(resolve => setTimeout(resolve, 1000));
        if (!stopping && !fs.existsSync(STOP)) await cycle();
      }
      if (state.status === 'watching') state.status = 'completed';
      state.finished_at = now(); save();
    }
    if (mode === '--once' || mode === '--drain') {
      console.log(JSON.stringify(state));
      if (state.status === 'degraded' || state.status === 'catching_up') process.exitCode = 1;
      return;
    }
    // Helpers fingerprint their own inputs and skip unchanged content. No periodic inference.
    while (!stopping && !fs.existsSync(STOP)) {
      await new Promise(resolve => setTimeout(resolve, state.status === 'catching_up' ? 1000 : 30000));
      if (!stopping && !fs.existsSync(STOP)) await cycle();
    }
    state.status = 'stopped'; state.stopped_at = now(); save();
  } finally { release(); }
})().catch(error => { state.status = 'failed'; state.error = error.message; save(); release(); console.error(error.message); process.exitCode = 1; });

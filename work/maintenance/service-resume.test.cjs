const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { EventEmitter } = require('node:events');
const { resumeStages } = require('./service-resume.cjs');

test('navigation participates before indexing and exposes protected-note partial results', async () => {
  const prior = { stages: { navigation: { exit_code: 0, finished_at: '2026-10-27T12:00:00.000Z', result: { status: 'partial', blocked: [{ path: '10_Projekte/Protected.md' }] } } } };
  assert.deepEqual(resumeStages(prior).navigation, prior.stages.navigation);
  const run = await supervise(undefined, '--once', { 'note-navigation-sync.ts': { stdout: JSON.stringify({ status: 'partial', blocked: [{ path: '10_Projekte/Protected.md' }] }), exit_code: 0 } });
  const nav = run.calls.findIndex(call => call.args.some(arg => /note-navigation-sync\.ts$/.test(arg)));
  const native = run.calls.findIndex(call => call.args.some(arg => /native-index-watch\.ps1$/.test(arg)));
  assert.ok(nav >= 0 && nav < native);
  assert.equal(JSON.parse(run.output.at(-1)).status, 'degraded');
});

const entry = path.join(__dirname, 'thehive-service.cjs');
const directory = 'C:/TheHive/work/maintenance';
const statePath = directory + '/service-state.json';
const key = value => String(value).replaceAll('\\', '/').toLowerCase();
const future = '2099-10-27T12:00:00.000Z';
const failedSemantic = {
  started_at: '2026-10-26T11:59:00.000Z',
  finished_at: '2026-10-26T12:00:00.000Z',
  exit_code: 1, signal: null, timed_out: false, error: 'existing worker deferred',
  result: { state: 'deferred', pending_after: 7 }, stdout: '', stderr: 'diagnostic',
  consecutive_failures: 4, retry_not_before: future,
};

// Run the real supervisor against memory-only files and child-process events.
// No service, model, production state file or external program is started.
async function supervise(prior, mode = '--once', outcomes = {}, setupFiles = () => {}) {
  const files = new Map([[key('C:/TheHive/graphify-out/.graphify_python'), 'C:/Python/python.exe']]);
  if (prior !== undefined) files.set(key(statePath), typeof prior === 'string' ? prior : JSON.stringify(prior));
  setupFiles(files);
  const calls = [], stateWrites = [], output = [], errors = [], timeouts = [];
  const fileSystem = {
    existsSync: file => files.has(key(file)),
    readFileSync(file) {
      if (!files.has(key(file))) throw Object.assign(new Error('missing fixture'), { code: 'ENOENT' });
      return files.get(key(file));
    },
    writeFileSync(file, data, options) {
      if (options?.flag === 'wx' && files.has(key(file))) throw new Error('fixture already exists');
      files.set(key(file), data);
    },
    renameSync(from, to) {
      const data = files.get(key(from));
      files.set(key(to), data); files.delete(key(from));
      if (key(to) === key(statePath)) stateWrites.push(JSON.parse(data));
    },
    unlinkSync: file => files.delete(key(file)),
  };
  const fakeProcess = {
    argv: ['node', entry, mode], execPath: 'C:/Node/node.exe', pid: 42001,
    env: { SystemRoot: 'C:/Windows', TEST_KEEP: 'kept', VAULT_AGENT_NAME: 'other-agent' },
    platform: 'test', on() {},
    kill() { throw Object.assign(new Error('not alive'), { code: 'ESRCH' }); },
  };
  function spawn(executable, args, options) {
    calls.push({ executable, args, options });
    const child = new EventEmitter();
    child.stdout = new EventEmitter(); child.stdout.destroy = () => {};
    child.stderr = new EventEmitter(); child.stderr.destroy = () => {};
    child.kill = () => { throw new Error('Unexpected process stop'); };
    const name = path.basename(args.find(arg => /\.(?:ps1|cjs|py|ts)$/.test(arg)));
    const configured = outcomes[name];
    const outcome = (typeof configured === 'function' ? configured(calls.filter(c => c.args.includes(args.find(a => /\.(?:ps1|cjs|py|ts)$/.test(a)))).length) : configured) ?? { stdout: '{"state":"unchanged"}', exit_code: 0 };
    queueMicrotask(() => {
      child.stdout.emit('data', outcome.stdout);
      child.emit('close', outcome.exit_code, null);
    });
    return child;
  }
  const context = {
    require(name) {
      if (name === 'node:fs') return fileSystem;
      if (name === 'node:child_process') return { spawn, execFile() { throw new Error('Unexpected process action'); } };
      if (name.startsWith('./')) return require(path.join(__dirname, name));
      return require(name);
    },
    __filename: entry,
    process: fakeProcess,
    console: { log: value => output.push(value), error: value => errors.push(value) },
    setTimeout(callback, milliseconds) { timeouts.push(milliseconds); if (mode === '--drain' && milliseconds === 1000) queueMicrotask(callback); return timeouts.length; },
    clearTimeout() {},
  };
  vm.runInNewContext('(function () {\n' + fs.readFileSync(entry, 'utf8') + '\n})();', context, { filename: entry });
  await new Promise(resolve => setImmediate(resolve));
  return { calls, stateWrites, output, errors, timeouts, process: fakeProcess, files };
}

test('results runs first with bounded Bun and process-local OSB identity', async () => {
  const run = await supervise();
  const names = run.calls.map(call => path.basename(call.args.find(arg => /\.(?:ps1|cjs|py|ts)$/.test(arg))));
  assert.deepEqual(names, ['project-knowledge-sync.ts', 'note-navigation-sync.ts', 'native-index-watch.ps1', 'learning-sync.cjs', 'sync-text-graph.py', 'semantic-sync.cjs']);
  assert.equal(key(run.calls[0].executable), key('C:/Users/USER/.bun/bin/bun.exe'));
  assert.deepEqual(Array.from(run.calls[0].args), [path.join('C:/TheHive', 'work/maintenance', 'project-knowledge-sync.ts')]);
  assert.equal(run.timeouts[0], 60000);
  assert.equal(run.calls[0].options.env.VAULT_AGENT_NAME, 'codex-desktop-agent');
  assert.equal(run.calls[0].options.env.TEST_KEEP, 'kept');
  assert.equal(run.process.env.VAULT_AGENT_NAME, 'other-agent');
});

test('restart retains known stage results and semantic retry while replacing process identity', async () => {
  const native = { finished_at: '2026-10-26T12:00:00.000Z', exit_code: 0, result: { pid: 77 } };
  const prior = {
    pid: 11111, owner: { pid: 11111 }, started_at: '2026-10-26T12:00:00.000Z', mode: '--watch',
    current_stage: 'semantic', stages: { native, semantic: failedSemantic, obsolete: { exit_code: 0 } }, cycles: 17,
  };
  const run = await supervise(prior);
  assert.deepEqual(run.stateWrites[0].stages.semantic, failedSemantic);
  assert.deepEqual(run.stateWrites[0].stages.native, native);
  assert.equal(run.stateWrites[0].stages.obsolete, undefined);
  assert.equal(run.stateWrites[0].pid, 42001);
  assert.equal(run.stateWrites[0].owner, undefined);
  assert.notEqual(run.stateWrites[0].started_at, prior.started_at);
  assert.equal(run.stateWrites[0].mode, '--once');
  assert.equal(run.calls.some(call => call.args.some(arg => /semantic-sync\.cjs$/.test(arg))), false);
  const final = JSON.parse(run.output.at(-1));
  assert.deepEqual(final.stages.semantic, failedSemantic);
  assert.equal(final.status, 'degraded');
});

test('missing previous state starts normally', async () => {
  const run = await supervise();
  assert.equal(run.errors.length, 0);
  assert.ok(run.stateWrites.length > 0);
  assert.equal(JSON.parse(run.output.at(-1)).status, 'watching');
});

test('results retains a prior failure and skips its unexpired retry after restart', async () => {
  const prior = { stages: { results: { ...failedSemantic, error: 'source changed' } } };
  const run = await supervise(prior);
  assert.equal(run.calls.some(call => call.args.some(arg => /project-knowledge-sync\.ts$/.test(arg))), false);
  const final = JSON.parse(run.output.at(-1));
  assert.deepEqual(final.stages.results, prior.stages.results);
  assert.equal(final.status, 'degraded');
});

test('results failure continues the previous count and existing capped backoff', async () => {
  const prior = { stages: { results: { ...failedSemantic, consecutive_failures: 2, retry_not_before: '2020-01-01T00:00:00.000Z' } } };
  const before = Date.now();
  const run = await supervise(prior, '--once', {
    'project-knowledge-sync.ts': { stdout: '{"state":"failed","error":"source changed"}', exit_code: 0 },
  });
  const result = JSON.parse(run.output.at(-1)).stages.results;
  assert.equal(result.exit_code, 1);
  assert.equal(result.error, 'source changed');
  assert.equal(result.consecutive_failures, 3);
  assert.ok(Date.parse(result.retry_not_before) >= before + 3600000);
  assert.ok(Date.parse(result.retry_not_before) <= Date.now() + 3600000);
  assert.equal(run.process.exitCode, 1);
});

for (const [name, prior] of [
  ['malformed JSON', '{broken'],
  ['missing stages', { pid: 11111 }],
  ['array stages', { stages: [] }],
  ['invalid retry deadline', { stages: { semantic: { ...failedSemantic, retry_not_before: 'invalid' } } }],
  ['invalid failure count', { stages: { semantic: { ...failedSemantic, consecutive_failures: -1 } } }],
  ['invalid stage result', { stages: { semantic: { ...failedSemantic, exit_code: '1' } } }],
]) {
  test('refuses ' + name + ' and preserves the prior state visibly', async () => {
    const original = typeof prior === 'string' ? prior : JSON.stringify(prior);
    const run = await supervise(prior);
    assert.equal(run.process.exitCode, 1);
    assert.equal(run.calls.length, 0);
    assert.equal(run.stateWrites.length, 0);
    assert.equal(run.files.get(key(statePath)), original);
    assert.match(run.errors.join('\n') + run.output.join('\n'), /prior|previous|resume/i);
    assert.equal(run.files.has(key(directory + '/service.lock.json')), false);
  });
}

test('status exposes malformed prior state without replacing it', async () => {
  const run = await supervise('{broken', '--status');
  assert.equal(run.process.exitCode, 1);
  const status = JSON.parse(run.output.at(-1));
  assert.equal(status.status, 'failed');
  assert.equal(status.state_preserved, true);
  assert.match(status.error, /prior|previous|resume/i);
  assert.equal(run.files.get(key(statePath)), '{broken');
  assert.equal(run.stateWrites.length, 0);
});

// Real supervisor logic, fully simulated transports: no models or services.
test('drain exits after an unchanged pass and releases ownership', async () => {
  const run = await supervise(undefined, '--drain');
  assert.equal(run.errors.length, 0);
  assert.equal(run.calls.length, 6);
  assert.equal(run.stateWrites.at(-1).status, 'completed');
  assert.ok(!run.files.has(key(directory + '/service.lock.json')));
});
test('drain catches up partial embeddings then exits without idle polling', async () => {
  const run = await supervise(undefined, '--drain', {'semantic-sync.cjs': n => ({stdout: JSON.stringify({state:n === 1 ? 'partial' : 'succeeded'}),exit_code:0})});
  assert.equal(run.calls.filter(c=>c.args.some(a=>a.endsWith('semantic-sync.cjs'))).length,2);
  assert.equal(run.stateWrites.at(-1).status,'completed');
  assert.equal(run.errors.length,0);
});
test('drain preserves a failed stage and exits instead of waiting for retry', async () => {
  const run=await supervise(undefined,'--drain',{'semantic-sync.cjs':{stdout:JSON.stringify({state:'failed',error:'source changed'}),exit_code:1}});
  assert.equal(run.calls.length,6);
  assert.equal(run.stateWrites.at(-1).status,'degraded');
  assert.equal(run.process.exitCode,1);
});

test('status reports work mode without a maintenance owner', async () => {
  const run=await supervise(undefined,'--status');
  assert.equal(JSON.parse(run.output.at(-1)).activity_mode,'work');
  assert.equal(run.calls.length,0);
});
test('drain bounds a continuously changing backlog and preserves pending status',async()=>{
  const run=await supervise(undefined,'--drain',{'semantic-sync.cjs':{stdout:'{"state":"partial"}',exit_code:0}});
  assert.equal(run.calls.filter(c=>c.args.some(a=>a.endsWith('semantic-sync.cjs'))).length,32);
  assert.equal(run.stateWrites.at(-1).status,'catching_up');
  assert.equal(run.process.exitCode,1);
});

test('large stage JSON retains failure and partial navigation state',async()=>{
  for(const result of [{state:'failed',error:'source changed',details:'x'.repeat(40000)},{status:'partial',blocked:[{path:'x'.repeat(40000)}]}]){
    const run=await supervise(undefined,'--once',{'note-navigation-sync.ts':{stdout:JSON.stringify(result),exit_code:0}});
    const state=JSON.parse(run.output.at(-1));
    assert.equal(state.status,'degraded');
    assert.equal(state.stages.navigation.result.state??state.stages.navigation.result.status,result.state??result.status);
    assert.ok(state.stages.navigation.stdout.length<=32768);
  }
});
test('oversized stage results fail visibly instead of implying success',async()=>{
  const run=await supervise(undefined,'--once',{'note-navigation-sync.ts':{stdout:JSON.stringify({status:'partial',details:'x'.repeat(1048577)}),exit_code:0}});
  const state=JSON.parse(run.output.at(-1));
  assert.equal(state.status,'degraded');
  assert.notEqual(state.stages.navigation.exit_code,0);
  assert.match(state.stages.navigation.error,/exceed|too large/i);
});

test('missing Python pointer cannot leave a service ownership lock behind',async()=>{
  let files;
  await assert.rejects(()=>supervise(undefined,'--once',{},initial=>{files=initial;files.delete(key('C:/TheHive/graphify-out/.graphify_python'));}),/missing fixture/);
  assert.equal(files.has(key(directory+'/service.lock.json')),false);
});

test('launcher refuses missing native component and Python pointer before spawning',()=>{
  const {spawnSync}=require('node:child_process'),os=require('node:os');
  for(const missing of ['native-index-watch.ps1','pointer']){
    const dir=fs.mkdtempSync(path.join(os.tmpdir(),'thehive-launch-preflight-'));
    try{
      const pointer=path.join(dir,'missing-python-pointer');
      if(missing!=='pointer')fs.writeFileSync(pointer,'python');
      for(const name of ['project-knowledge-sync.ts','note-navigation-sync.ts','native-index-watch.ps1','service-resume.cjs','semantic-sync.cjs','learning-sync.cjs','sync-text-graph.py'])
        if(name!==missing)fs.writeFileSync(path.join(dir,name),'');
      fs.writeFileSync(path.join(dir,'thehive-service.cjs'),'console.log(JSON.stringify({owner:null}));');
      let script=fs.readFileSync(path.join(__dirname,'thehive-service.ps1'),'utf8');
      script=script.replaceAll('C:\\TheHive\\graphify-out\\.graphify_python',pointer);
      script=script.replace("$ErrorActionPreference = 'Stop'","$ErrorActionPreference = 'Stop'\nfunction Start-Process { throw 'UNEXPECTED START' }");
      const file=path.join(dir,'start.ps1');fs.writeFileSync(file,script);
      const result=spawnSync('powershell.exe',['-NoProfile','-File',file,'-Action','Start'],{encoding:'utf8',windowsHide:true});
      assert.notEqual(result.status,0);
      assert.match(result.stderr,missing==='pointer'?/Required Python pointer missing/:/Required maintenance component missing: native-index-watch/);
      assert.doesNotMatch(result.stderr,/UNEXPECTED START/);
    }finally{assert.ok(path.resolve(dir).startsWith(path.resolve(os.tmpdir())+path.sep));fs.rmSync(dir,{recursive:true,force:true});}
  }
});

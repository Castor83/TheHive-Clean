'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const {spawnSync}=require('node:child_process');
/** Replace exactly one fixture target; reject template drift before any adapter can execute. */
function replaceOnce(source, from, to) {
  assert.ok(source.includes(from),'fixture replacement target missing: '+from);
  assert.equal(source.indexOf(from),source.lastIndexOf(from),'fixture replacement target ambiguous: '+from);
  return source.replace(from,to);
}
test('fixture substitutions reject missing or repeated targets before adapter execution',()=>{
  assert.throws(()=>replaceOnce('changed template','ROOT','safe'),/missing/);
  assert.throws(()=>replaceOnce('ROOT ROOT','ROOT','safe'),/ambiguous/);
  assert.equal(replaceOnce('ROOT','ROOT','safe'),'safe');
});

for(const changed of ['brain','source','runtime','adapter','none'])test('preview input diagnostics preserve the mutation guard: '+changed,t=>{
  const base=fs.mkdtempSync(path.join(os.tmpdir(),'hive-preview-inputs-'));
  t.after(()=>fs.rmSync(base,{recursive:true,force:true}));
  fs.mkdirSync(path.join(base,'Brain'));fs.writeFileSync(path.join(base,'Brain/_brain.yaml'),'dream:\n  candidate_threshold: 3\n');
  const before={brain:{'log/a.jsonl':{bytes:1,sha256:'old'}},source:{'cli.ts':{bytes:1,sha256:'old'}},runtime:'old',adapter:'old'};
  const after=JSON.parse(JSON.stringify(before));
  if(changed==='brain')after.brain['log/a.jsonl'].sha256='new';
  else if(changed==='source')after.source['cli.ts'].sha256='new';
  else if(changed!=='none')after[changed]='new';
  let source=fs.readFileSync(path.join(__dirname,'learning-sync.cjs'),'utf8');
  source=replaceOnce(source,"const ROOT = 'C:\\\\TheHive';",'const ROOT = '+JSON.stringify(base)+';');
  source=replaceOnce(source,'function inputState() {','let fixtureReads=0;\nfunction inputState() { return fixtureReads++ === 0 ? '+JSON.stringify(before)+' : '+JSON.stringify(after)+';');
  const preview={changed:false,dry_run:true,new_unconfirmed:[],confirmed:[],moved_to_processed:[],retired:[],suppressed:[],warnings:[],uncertain:[],quarantined:[],gated_retires:[],rollups:[],phases:[]};
  source=replaceOnce(source,"const preview = engine(['--dry-run'], started, report, 'preview');",'const preview = '+JSON.stringify(preview)+';');
  const adapter=path.join(base,'fixture.cjs');fs.writeFileSync(adapter,source);
  const result=spawnSync(process.execPath,[adapter,'--preview-only'],{encoding:'utf8',timeout:10000});
  const status=JSON.parse(result.stdout);
  if(changed==='none'){assert.equal(result.status,0,result.stderr);assert.equal(status.status,'waiting_for_real_evidence');}
  else {
    assert.equal(result.status,1,result.stderr);assert.equal(status.status,'deferred');
    assert.match(status.error,/Inputs changed during preview/);
    const diff=JSON.parse(fs.readFileSync(path.join(status.report_dir,'input-changes.json')));
    assert.deepEqual(diff.brain,changed==='brain'?['log/a.jsonl']:[]);
    assert.deepEqual(diff.source,changed==='source'?['cli.ts']:[]);
    assert.equal(diff.runtime,changed==='runtime');assert.equal(diff.adapter,changed==='adapter');
  }
  assert.notEqual(JSON.parse(fs.readFileSync(path.join(base,'work/maintenance/learning/status.json'))).live_pass_started,true);
});
test('learning lock write failure closes its handle and removes only its own file',t=>{
  const base=fs.mkdtempSync(path.join(os.tmpdir(),'hive-learning-write-'));
  t.after(()=>fs.rmSync(base,{recursive:true,force:true}));
  const source=fs.readFileSync(path.join(__dirname,'learning-sync.cjs'),'utf8');
  for(const failure of ['write','fsync','foreign']){
    const root=path.join(base,failure),lock=path.join(root,'work/maintenance/learning/run.lock');
    const injected=`
let ownFd,closed=false;
const originalOpen=fs.openSync, originalWrite=fs.writeFileSync, originalClose=fs.closeSync, originalFsync=fs.fsyncSync;
fs.openSync=function(file,...args){const fd=originalOpen.call(fs,file,...args);if(file===LOCK)ownFd=fd;return fd;};
fs.closeSync=function(fd){const isOwn=fd===ownFd;if(isOwn)closed=true;const result=originalClose.call(fs,fd);if(isOwn && ${JSON.stringify(failure)}==='foreign'){fs.renameSync(LOCK,LOCK+'.owned');originalWrite.call(fs,LOCK,'foreign');}return result;};
fs.writeFileSync=function(file,...args){if(file===ownFd && ${JSON.stringify(failure)}!=='fsync')throw new Error('fixture-write-error');return originalWrite.call(fs,file,...args);};
fs.fsyncSync=function(fd){if(fd===ownFd && ${JSON.stringify(failure)}==='fsync')throw new Error('fixture-write-error');return originalFsync.call(fs,fd);};
process.on('uncaughtException',error=>{
 console.log(JSON.stringify({error:error.message,closed}));process.exitCode=1;
});
function main() {`;
    let rewritten=replaceOnce(source,"const ROOT = 'C:\\\\TheHive';",'const ROOT = '+JSON.stringify(root)+';');
    rewritten=replaceOnce(rewritten,'function main() {',injected);
    const adapter=path.join(base,failure+'.cjs');fs.writeFileSync(adapter,rewritten);
    const result=spawnSync(process.execPath,[adapter],{encoding:'utf8',timeout:10000});
    assert.equal(result.status,1,result.stderr);const output=JSON.parse(result.stdout);
    assert.equal(output.error,'fixture-write-error');assert.equal(output.closed,true);
    if(failure==='foreign')assert.equal(fs.readFileSync(lock,'utf8'),'foreign');
    else assert.equal(fs.existsSync(lock),false);
  }
});
test('explicit learning recovery archives a dead lock and preserves apply evidence without running Dream',t=>{
  const base=fs.mkdtempSync(path.join(os.tmpdir(),'hive-learning-recovery-'));
  t.after(()=>fs.rmSync(base,{recursive:true,force:true}));
  const dir=path.join(base,'work/maintenance/learning');fs.mkdirSync(dir,{recursive:true});
  const report=path.join(dir,'runs/interrupted'),backup=path.join(report,'backup/Brain');
  fs.mkdirSync(backup,{recursive:true});fs.writeFileSync(path.join(backup,'evidence.md'),'keep backup');
  const status=JSON.stringify({status:'applying',report_dir:report});fs.writeFileSync(path.join(dir,'status.json'),status);
  const dead=spawnSync(process.execPath,['-e','process.stdout.write(String(process.pid))'],{encoding:'utf8'});
  assert.equal(dead.status,0);
  const lock=JSON.stringify({pid:Number(dead.stdout),started_at:new Date().toISOString()});
  fs.writeFileSync(path.join(dir,'run.lock'),lock);
  const source=fs.readFileSync(path.join(__dirname,'learning-sync.cjs'),'utf8');
  // Keep the process inventory deterministic: concurrent unrelated Bun/archive
  // work must make production recovery refuse, rather than make fixtures flaky.
  // This replacement exists only in the isolated adapter copy below.
  const helper=path.join(base,'recovery-fixture.py');
  fs.writeFileSync(helper,`
import importlib.util,json,os,pathlib,sys
spec=importlib.util.spec_from_file_location('fixture_recovery',${JSON.stringify(path.join(__dirname,'learning-lock-recovery.py'))})
mod=importlib.util.module_from_spec(spec);spec.loader.exec_module(mod)
mod.processes=lambda:[{'pid':os.getpid(),'ppid':os.getppid(),'potential':False,'unknown':False}]
print(json.dumps(mod.recover(pathlib.Path(sys.argv[1]))))
`);
  const relocated=replaceOnce(source,"const ROOT = 'C:\\\\TheHive';",'const ROOT = '+JSON.stringify(base)+';');
  const rewritten=replaceOnce(relocated,"path.join(__dirname, 'learning-lock-recovery.py')",JSON.stringify(helper));
  const adapter=path.join(base,'learning-fixture.cjs');fs.writeFileSync(adapter,rewritten);
  const run=(...args)=>spawnSync(process.execPath,[adapter,...args],{encoding:'utf8',timeout:30000});
  const normal=run('--force');assert.equal(normal.status,1);assert.equal(JSON.parse(normal.stdout).status,'locked');
  const result=run('--recover-stale-lock');
  assert.equal(result.status,0,result.stderr+' '+result.stdout);
  const output=JSON.parse(result.stdout);assert.equal(output.status,'recovered');
  assert.equal(output.dream_started,false);
  assert.equal(fs.existsSync(path.join(dir,'run.lock')),false);
  assert.equal(fs.readFileSync(path.join(dir,'status.json'),'utf8'),status);
  assert.equal(fs.readFileSync(path.join(backup,'evidence.md'),'utf8'),'keep backup');
  assert.equal(fs.readFileSync(output.archived_lock,'utf8'),lock);
  assert.equal(fs.readFileSync(output.archived_status,'utf8'),status);
  const automatic=run();
  assert.equal(automatic.status,1);
  assert.equal(JSON.parse(automatic.stdout).status,'recovery_requires_force');
  assert.equal(fs.readFileSync(path.join(dir,'status.json'),'utf8'),status);
  // A forced fixture reaches input preparation; stop before any Dream engine.
  fs.writeFileSync(adapter,replaceOnce(rewritten,'state = inputState();',"throw new Error('FIXTURE_STOP_BEFORE_DREAM');"));
  const forced=run('--force');assert.equal(forced.status,1);
  assert.match(JSON.parse(forced.stdout).error,/FIXTURE_STOP_BEFORE_DREAM/);
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir,'lock-recovery.json'))).requires_force,true);
  fs.writeFileSync(path.join(dir,'run.lock'),lock);
  const combined=run('--recover-stale-lock','--force');assert.equal(combined.status,1);
  assert.match(JSON.parse(combined.stdout).error,/FIXTURE_STOP_BEFORE_DREAM/);
});
test('automatic startup rechecks the force barrier after acquiring its lock',t=>{
  const base=fs.mkdtempSync(path.join(os.tmpdir(),'hive-learning-barrier-'));
  t.after(()=>fs.rmSync(base,{recursive:true,force:true}));
  const source=fs.readFileSync(path.join(__dirname,'learning-sync.cjs'),'utf8');
  const relocated=replaceOnce(source,"const ROOT = 'C:\\\\TheHive';",'const ROOT = '+JSON.stringify(base)+';');
  const rewritten=replaceOnce(relocated,'function main() {',`
const originalOpen=fs.openSync;
fs.openSync=function(file,...rest){
  if(file===LOCK)fs.writeFileSync(RECOVERY,JSON.stringify({requires_force:true}));
  return originalOpen.call(fs,file,...rest);
};
function main() {`);
  const adapter=path.join(base,'learning-fixture.cjs');fs.writeFileSync(adapter,rewritten);
  const result=spawnSync(process.execPath,[adapter],{encoding:'utf8',timeout:10000});
  assert.equal(result.status,1,result.stderr);
  assert.equal(JSON.parse(result.stdout).status,'recovery_requires_force');
  const dir=path.join(base,'work/maintenance/learning');
  assert.equal(fs.existsSync(path.join(dir,'run.lock')),false);
  assert.equal(fs.existsSync(path.join(dir,'status.json')),false);
});

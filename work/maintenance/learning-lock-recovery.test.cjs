'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const {spawnSync}=require('node:child_process');
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
  const rewritten=source.replace("const ROOT = 'C:\\\\TheHive';",'const ROOT = '+JSON.stringify(base)+';')
    .replace("path.join(__dirname, 'learning-lock-recovery.py')",JSON.stringify(helper));
  assert.notEqual(source,rewritten);
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
  fs.writeFileSync(adapter,rewritten.replace('state = inputState();',"throw new Error('FIXTURE_STOP_BEFORE_DREAM');"));
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
  const rewritten=source.replace("const ROOT = 'C:\\\\TheHive';",'const ROOT = '+JSON.stringify(base)+';')
    .replace('function main() {',`
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

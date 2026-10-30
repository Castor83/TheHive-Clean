'use strict';
const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {spawn, spawnSync} = require('node:child_process');
const {once} = require('node:events');
const store = require('./handoff-store.cjs');
/**
 * Create and return an isolated temporary handoff root with test cleanup for lock recovery regressions.
 */
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hive-review-'));
  t.after(() => fs.rmSync(root, {recursive:true, force:true}));
  return root;
}
test('dead acquisition gate is recovered with and without a dead writer', t => {
  for (const writer of [false,true]) {
    const root = fixture(t), dead = spawnSync(process.execPath,['-e','process.stdout.write(String(process.pid))'],{encoding:'utf8'});
    assert.equal(dead.status,0);
    const owner = JSON.stringify({pid:Number(dead.stdout),host:os.hostname(),token:'dead-fixture'});
    fs.writeFileSync(path.join(root,'.lock-gate'),owner);
    if(writer) fs.writeFileSync(path.join(root,'.writer.lock'),owner);
    assert.throws(()=>store.resumeProject(root,'Missing'),/Project not found/);
    assert.equal(fs.existsSync(path.join(root,'.lock-gate')),false);
    const retained = fs.readdirSync(root).filter(n=>n.startsWith('.lock-gate.stale-'));
    assert.equal(retained.length,1);
    assert.equal(fs.readFileSync(path.join(root,retained[0]),'utf8'),owner);
  }
});
test('malformed and foreign-host acquisition gates remain untouched', t => {
  for(const owner of ['partial JSON',JSON.stringify({pid:2147483647,host:'foreign-host',token:'unknown'})]) {
    const root=fixture(t),gate=path.join(root,'.lock-gate');fs.writeFileSync(gate,owner);
    assert.throws(()=>store.resumeProject(root,'Missing'),/retry limit/);
    assert.equal(fs.readFileSync(gate,'utf8'),owner);
  }
});
test('concurrent real saves recover one dead gate without taking a new owners gate', async t => {
  const root=fixture(t),dead=spawnSync(process.execPath,['-e','process.stdout.write(String(process.pid))'],{encoding:'utf8'});
  assert.equal(dead.status,0);
  const owner=JSON.stringify({pid:Number(dead.stdout),host:os.hostname(),token:'concurrent-dead'});
  fs.writeFileSync(path.join(root,'.lock-gate'),owner);
  fs.writeFileSync(path.join(root,'.writer.lock'),owner);
  const children=Array.from({length:4},(_,i)=>spawn(process.execPath,['-e',`
    require(process.argv[1]).saveCheckpoint(process.argv[2],{
      format_version:1,project_id:process.argv[3],session_id:'fixture',expected_parent:null,
      patch:{goal:'Concurrent offline save',status:'planned',last_section:'fixture',
        sources:{test:{reference:'offline fixture'}},next_step:{text:'continue',success_criterion:'saved'}}});
  `,require.resolve('./handoff-store.cjs'),root,'Fixture'+i],{stdio:['ignore','pipe','pipe']}));
  t.after(()=>children.forEach(c=>c.kill()));
  const results=await Promise.all(children.map(async child=>{
    let stderr='';child.stderr.on('data',d=>stderr+=d);
    const [code]=await once(child,'exit');return {code,stderr};
  }));
  for(const result of results)assert.equal(result.code,0,result.stderr);
  assert.equal(fs.readdirSync(root).filter(n=>n.startsWith('.lock-gate.stale-')).length,1);
  assert.equal(fs.readdirSync(root).filter(n=>n.startsWith('.writer.lock.stale-')).length,1);
  for(let i=0;i<4;i++)assert.equal(store.resumeProject(root,'Fixture'+i).project_id,'Fixture'+i);
});
test('a crashed recovery process does not retain the OS mutex', async t => {
  const root=fixture(t),holder=spawn('python',['-u','-c',`
import importlib.util, pathlib, sys, time
spec=importlib.util.spec_from_file_location('lock_helper',sys.argv[1])
mod=importlib.util.module_from_spec(spec);spec.loader.exec_module(mod)
with mod.lock(pathlib.Path(sys.argv[2])) as held:
 print('ready' if held else 'busy',flush=True)
 time.sleep(30)
  `,path.join(__dirname,'sync-text-graph.py'),path.join(root,'.lock-gate-recovery')],{stdio:['ignore','pipe','pipe'],windowsHide:true});
  t.after(()=>holder.kill());
  const [ready]=await once(holder.stdout,'data');assert.match(String(ready),/ready/);
  const dead=spawnSync(process.execPath,['-e','process.stdout.write(String(process.pid))'],{encoding:'utf8'});
  assert.equal(dead.status,0);
  const owner=JSON.stringify({pid:Number(dead.stdout),host:os.hostname(),token:'blocked-recovery'});
  fs.writeFileSync(path.join(root,'.lock-gate'),owner);
  const started=Date.now();
  assert.throws(()=>store.resumeProject(root,'Missing'),/retry limit/);
  assert.ok(Date.now()-started<6000);
  assert.equal(fs.readFileSync(path.join(root,'.lock-gate'),'utf8'),owner);
  const exit=once(holder,'exit');holder.kill();await exit;
  assert.throws(()=>store.resumeProject(root,'Missing'),/Project not found/);
  assert.equal(fs.existsSync(path.join(root,'.lock-gate')),false);
});
test('unavailable Python fails closed and preserves the dead gate for repair', t => {
  const root=fixture(t),dead=spawnSync(process.execPath,['-e','process.stdout.write(String(process.pid))'],{encoding:'utf8'});
  assert.equal(dead.status,0);
  const owner=JSON.stringify({pid:Number(dead.stdout),host:os.hostname(),token:'missing-python'});
  fs.writeFileSync(path.join(root,'.lock-gate'),owner);
  const childProcess=require('node:child_process'),original=childProcess.spawnSync;
  childProcess.spawnSync=()=>({error:{code:'ENOENT'},status:null});
  try { assert.throws(()=>store.resumeProject(root,'Missing'),/Gate recovery unavailable.*Python/); }
  finally { childProcess.spawnSync=original; }
  assert.equal(fs.readFileSync(path.join(root,'.lock-gate'),'utf8'),owner);
});
test('recovery helper preserves a live owner even when called directly', t => {
  const root=fixture(t),owner=JSON.stringify({pid:process.pid,host:os.hostname(),token:'live-helper'});
  fs.writeFileSync(path.join(root,'.lock-gate'),owner);
  const result=spawnSync('python',[path.join(__dirname,'handoff-gate-recovery.py'),root],{encoding:'utf8',windowsHide:true});
  assert.equal(result.status,0,result.stderr);
  assert.equal(JSON.parse(result.stdout).status,'retained');
  assert.equal(fs.readFileSync(path.join(root,'.lock-gate'),'utf8'),owner);
});
test('uppercase UUID writes fail before any checkpoint or transaction is published', t => {
  const root = fixture(t);
  assert.throws(() => store.saveCheckpoint(root, {
    format_version:1,project_id:'Fixture',session_id:'AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA',
    expected_parent:null,patch:{goal:'UUID regression',status:'planned',last_section:'test',
      sources:{test:{reference:'offline fixture'}},next_step:{text:'test',success_criterion:'test'}}
  }), /canonical.*lowercase/i);
  assert.equal(fs.existsSync(path.join(root,'index.json')), false);
  assert.equal(fs.existsSync(path.join(root,'.transaction.json')), false);
});
test('writer acquisition waits for a live owner to release its lock', async t => {
  const root = fixture(t), lock = path.join(root, '.writer.lock');
  const child = spawn(process.execPath, ['-e', `
    const fs=require('fs'),os=require('os');
    fs.writeFileSync(process.argv[1],JSON.stringify({pid:process.pid,host:os.hostname(),token:'live'}));
    process.stdout.write('ready');
    setTimeout(()=>fs.unlinkSync(process.argv[1]),150);
  `, lock], {stdio:['ignore','pipe','pipe']});
  t.after(() => child.kill());
  await once(child.stdout, 'data');
  assert.throws(() => store.resumeProject(root, 'Missing'), /Project not found/);
  assert.equal(fs.readdirSync(root).some(n => n.startsWith('.writer.lock.stale-')), false);
});
test('writer acquisition is bounded and preserves a live owner', t => {
  const root = fixture(t), lock = path.join(root, '.writer.lock');
  const held = JSON.stringify({pid:process.pid,host:os.hostname(),token:'live'});
  fs.writeFileSync(lock, held);
  const start = Date.now();
  assert.throws(() => store.resumeProject(root, 'Missing'), /Writer lock held.*retry limit/);
  assert.ok(Date.now()-start < 5000);
  assert.equal(fs.readFileSync(lock,'utf8'), held);
  assert.equal(fs.existsSync(path.join(root,'.lock-gate')),false);
});

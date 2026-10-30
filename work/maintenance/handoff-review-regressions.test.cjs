'use strict';
const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {spawn} = require('node:child_process');
const {once} = require('node:events');
const store = require('./handoff-store.cjs');
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hive-review-'));
  t.after(() => fs.rmSync(root, {recursive:true, force:true}));
  return root;
}
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

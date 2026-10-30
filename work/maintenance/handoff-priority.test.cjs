'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const {saveCheckpoint,resumeProject} = require('./handoff-store.cjs');

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(),'thehive-priority-'));
  t.after(() => {
    assert.ok(path.resolve(root).startsWith(path.resolve(os.tmpdir())+path.sep));
    fs.rmSync(root,{recursive:true,force:true});
  });
  const base = {format_version:1,project_id:'Fixture',session_id:'fixture-priority',expected_parent:null,
    patch:{goal:'OFFLINE_PRIORITY_FIXTURE',status:'planned',last_section:'Fixture',sources:{request:{reference:'Explicit fixture reprioritization'}},
      tasks:{waiting:{text:'Wait for natural event',status:'planned'},activate:{text:'Activate prerequisite',status:'planned'}},
      next_step:{text:'Wait for natural event',task_id:'waiting',success_criterion:'Real event'}}};
  return {root,base,first:saveCheckpoint(root,base)};
}
function redirect(first) {
  const next = {text:'Activate prerequisite',task_id:'activate',success_criterion:'Real activation',redirect_event:'priority_1'};
  return {next_step:next,events:{priority_1:{type:'next_action_reprioritized',previous:first.state.next_step,replacement:next,
    reason:'New explicit prerequisite; previous task remains open',source:'request'}}};
}
test('sourced priority change preserves unfinished task, evidence and idempotence',t=>{
  const {root,base,first}=fixture(t),patch=redirect(first);
  const next=saveCheckpoint(root,{...base,expected_parent:first.checkpoint_id,patch});
  assert.equal(next.state.tasks.waiting.status,'planned');
  assert.equal(next.state.completed?.waiting,undefined);
  assert.equal(next.state.next_step.task_id,'activate');
  assert.deepEqual(next.state.events.priority_1.previous,first.state.next_step);
  assert.equal(saveCheckpoint(root,{...base,expected_parent:first.checkpoint_id,patch}).status,'unchanged');
  assert.throws(()=>saveCheckpoint(root,{...base,expected_parent:next.checkpoint_id,patch:{events:{priority_1:{reason:'Silently alter history'}}}}),/immutable/i);
});
test('unsourced or mismatched priority change cannot bypass completion guard',t=>{
  const {root,base,first}=fixture(t);
  for(const mutate of [p=>delete p.events.priority_1.source,p=>p.events.priority_1.previous.text='Invented previous',
    p=>delete p.next_step.redirect_event,p=>p.events.priority_1.replacement={...p.events.priority_1.replacement,task_id:'waiting'}]){
    const patch=structuredClone(redirect(first));mutate(patch);
    assert.throws(()=>saveCheckpoint(root,{...base,expected_parent:first.checkpoint_id,patch}),/completion|advance/i);
    assert.equal(resumeProject(root,'Fixture').checkpoint_id,first.checkpoint_id);
  }
});
test('priority exception never silently replaces a completed task or its evidence',t=>{
  const {root,base,first}=fixture(t),patch=redirect(first);
  patch.tasks={waiting:{status:'verified',evidence:'Unrelated completion cannot justify priority exception'}};
  assert.throws(()=>saveCheckpoint(root,{...base,expected_parent:first.checkpoint_id,patch}),/completion|advance/i);
});

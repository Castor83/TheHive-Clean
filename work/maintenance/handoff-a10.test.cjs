'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {saveCheckpoint, resumeProject} = require('./handoff-store.cjs');

test('A10 end-to-end: schema, aliases, incremental evidence, idempotence, isolation and rollback', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'thehive-a10-'));
  t.after(() => fs.rmSync(root,{recursive:true,force:true}));
  const initial={format_version:1,project_id:'TheHive',session_id:'a10-session',expected_parent:null,patch:{
    goal:'A10 controlled update',status:'implemented',last_section:'A10',
    decisions:{canonical:'One existing vault'},sources:{master:{reference:'A10 actual test fixture'}},
    tasks:{schema:{text:'Publish schema',status:'planned'},review:{text:'Review checkpoint',status:'planned'}},
    next_step:{text:'Publish schema',task_id:'schema',success_criterion:'Validated Markdown stored'}}};
  const first=saveCheckpoint(root,initial);
  assert.match(fs.readFileSync(first.file,'utf8'),/^---\nschema_version: 1\n/);
  const {parseMarkdown}=require('./handoff-format.cjs');
  const parsed=parseMarkdown(fs.readFileSync(first.file,'utf8'));
  assert.equal(parsed.metadata.project_id,'TheHive');
  assert.equal(parsed.metadata.parent_checkpoint_id,null);
  assert.equal(resumeProject(root,'The Hive').checkpoint_id,first.checkpoint_id);
  assert.equal(resumeProject(root,'thehive').checkpoint_id,first.checkpoint_id);
  const other=saveCheckpoint(root,{...initial,project_id:'MORPH'}),otherBytes=fs.readFileSync(other.file);
  const patch={tasks:{schema:{status:'verified',evidence:'A10 schema assertion above'}},
    next_step:{text:'Review checkpoint',task_id:'review',completed_task_id:'schema',success_criterion:'Review cites schema'}};
  const second=saveCheckpoint(root,{...initial,project_id:'The Hive',expected_parent:first.checkpoint_id,patch});
  const secondText=fs.readFileSync(second.file,'utf8'), secondParsed=parseMarkdown(secondText);
  assert.match(secondParsed.sections.COMPLETED,/Publish schema/);
  assert.match(secondParsed.sections.NEXT_ACTION,/Review checkpoint/);
  assert.equal(second.state.decisions.canonical,'One existing vault');
  assert.equal(second.parent_checkpoint_id,first.checkpoint_id);
  assert.deepEqual(fs.readFileSync(other.file),otherBytes);
  assert.equal(fs.existsSync(path.join(root,'The Hive')),false);
  const index=fs.readFileSync(path.join(root,'index.json')), history=fs.readdirSync(path.join(root,'TheHive','history'));
  const retry=saveCheckpoint(root,{...initial,project_id:'THE HIVE',expected_parent:first.checkpoint_id,patch});
  assert.equal(retry.status,'unchanged');
  assert.equal(retry.created_at,second.created_at);
  assert.deepEqual(fs.readFileSync(path.join(root,'index.json')),index);
  assert.deepEqual(fs.readdirSync(path.join(root,'TheHive','history')),history);
  assert.throws(()=>saveCheckpoint(root,{...initial,expected_parent:first.checkpoint_id,patch:{goal:'stale'}}),/conflict/i);
  assert.throws(()=>saveCheckpoint(root,{...initial,expected_parent:second.checkpoint_id,patch:{decisions:{canonical:'Replace silently'}}}),/decision/i);
  assert.throws(()=>saveCheckpoint(root,{...initial,expected_parent:second.checkpoint_id,patch:{tasks:{schema:{status:'planned'}}}}),/completed|reopen/i);
  assert.throws(()=>saveCheckpoint(root,{...initial,expected_parent:second.checkpoint_id,patch:{tasks:{schema:{text:'Different unexecuted task'}}}}),/verified|reopen|completed/i);
  assert.throws(()=>saveCheckpoint(root,{...initial,expected_parent:second.checkpoint_id,patch:{next_step:{text:'Skip review'}}}),/completion|advance/i);
  assert.throws(()=>saveCheckpoint(root,{...initial,expected_parent:second.checkpoint_id,patch:{completed:{invented:{text:'Unproven completion',status:'verified',evidence:'invented'}}}}),/completed|verified/i);
  assert.throws(()=>saveCheckpoint(root,{...initial,expected_parent:second.checkpoint_id,patch:{next_step:{text:'Publish schema again',task_id:'schema',completed_task_id:'schema'}}}),/open|completion|advance/i);
  assert.throws(()=>saveCheckpoint(root,{...initial,expected_parent:second.checkpoint_id,patch:{next_step:{task_id:'schema'}}}),/open|completion|advance/i);
  const replaced=saveCheckpoint(root,{...initial,expected_parent:second.checkpoint_id,patch:{decisions:{canonical:'One canonical vault with scoped views'},
    decision_events:{scope_clarified:{decision_id:'canonical',previous:'One existing vault',replacement:'One canonical vault with scoped views',reason:'Clarify scope',source:'master'}}}});
  assert.equal(replaced.state.decision_events.scope_clarified.previous,'One existing vault');
  assert.doesNotMatch(parseMarkdown(fs.readFileSync(replaced.file,'utf8')).sections.RECENT_CHANGES,/A10 controlled update/);
  const before=fs.readFileSync(replaced.file), beforeIndex=fs.readFileSync(path.join(root,'index.json'));
  const rename=fs.renameSync;
  fs.renameSync=function(a,b){if(b===path.join(root,'index.json')&&String(a).endsWith('.pending'))throw Error('A10 simulated publish failure');return rename.apply(this,arguments)};
  try {assert.throws(()=>saveCheckpoint(root,{...initial,expected_parent:replaced.checkpoint_id,patch:{last_section:'A10 failed publish'}}),/publish failure/);}
  finally{fs.renameSync=rename;}
  assert.equal(resumeProject(root,'TheHive').checkpoint_id,replaced.checkpoint_id);
  assert.deepEqual(fs.readFileSync(replaced.file),before);
  assert.deepEqual(fs.readFileSync(path.join(root,'index.json')),beforeIndex);
  assert.deepEqual(fs.readFileSync(other.file),otherBytes);
});

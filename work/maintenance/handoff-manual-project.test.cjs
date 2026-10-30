'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {manualProjectMatches}=require('./handoff-manual-start.cjs');
const cwd=__dirname,session='10203040-1122-3344-5566-778899aabbcc',project='exact-project';
function fixture(){return {row:{threadId:session,kind:'codex',hostId:'local',cwd,projectId:null},authorization:{successor_session_id:session,project_binding:{type:'app_move_acknowledgement',source:'codex',threadId:session,hostId:'local',projectId:project,workspace:cwd}}};}
test('manual membership uses exact move acknowledgement when catalog still has null',()=>{
 const f=fixture();assert.equal(manualProjectMatches(f.row,f.authorization,project,cwd),true);
});
test('manual proof cannot override a different catalog project or workspace',()=>{
 for(const patch of [{projectId:'foreign'},{cwd:require('node:path').dirname(cwd)},{threadId:'different'},{hostId:'remote'},{kind:'chatgpt'}]){
  const f=fixture();Object.assign(f.row,patch);assert.equal(manualProjectMatches(f.row,f.authorization,project,cwd),false);
 }
});
test('missing, foreign or partial acknowledgements never bind manual membership',()=>{
 for(const patch of [{threadId:'foreign'},{projectId:'foreign'},{source:'chatgpt'},{hostId:'remote'},{workspace:require('node:path').dirname(cwd)},{type:'unverified'}]){
  const f=fixture();Object.assign(f.authorization.project_binding,patch);assert.equal(manualProjectMatches(f.row,f.authorization,project,cwd),false);
 }
 const f=fixture();assert.equal(manualProjectMatches(f.row,null,project,cwd),false);
 assert.equal(manualProjectMatches(null,f.authorization,project,cwd),false);
});

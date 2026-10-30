'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {completePending}=require('./handoff-archive-waiter.cjs');

test('serial creation waits for origin idle and returns the visible successor',async()=>{
  let checks=0,waits=0;
  const result=await completePending({operation:'resume_creation',session_id:'origin',turn_id:'turn'},
    {pause:async()=>{},complete:async()=>++checks===1?{status:'waiting_for_origin'}:{status:'successor_visible'},
     app:{listTools:async()=>{waits++;throw Error('wait_threads cannot wait on the calling thread.');}}});
  assert.equal(result.status,'successor_visible');assert.equal(checks,2);assert.equal(waits,0);
});

test('serial creation reports an exhausted wait budget explicitly',async()=>{
  const result=await completePending({operation:'resume_creation',session_id:'origin'},
    {maxWaits:0,complete:async()=>({status:'waiting_for_origin'}),app:{}});
  assert.equal(result.status,'fallback_required');assert.equal(result.reason_code,'origin_did_not_finish');
});

test('serial creation returns an explicit transport failure without retrying creation',async()=>{
  let checks=0;
  const result=await completePending({operation:'resume_creation',session_id:'origin'},
    {complete:async()=>{checks++;const e=Error('Synthetic pipe failure');e.code='APP_CONNECTION_ERROR';throw e;},app:{}});
  assert.equal(result.status,'fallback_required');assert.equal(result.reason_code,'creation_wait_failed');assert.equal(result.error_code,'APP_CONNECTION_ERROR');assert.equal(checks,1);
});
test('existing event wait completes a busy origin without repeating archival',async()=>{
  let checks=0,waits=0;
  const app={listTools:async()=>[{name:'wait_threads'}],callAppTool:async call=>{assert.equal(call.tool.name,'wait_threads');waits++;}};
  const result=await completePending({operation:'resume_archive',session_id:'origin',caller_session_id:'caller'},{app,pause:async()=>{},complete:async()=>++checks===1?{archive_pending_reason:'origin_busy'}:{status:'archived_after_takeover'}});
  assert.equal(result.status,'archived_after_takeover');assert.equal(checks,2);assert.equal(waits,1);
});
test('a cancelled or uncertain archive is never retried by the waiter',async()=>{
  for(const result of [{status:'fallback_required'},{status:'takeover_verified',archive_pending:true}]){
    let checks=0;const r=await completePending({operation:'resume_archive'},{complete:async()=>{checks++;return result;},app:{listTools:()=>{throw Error('Must not wait');}}});
    assert.deepEqual(r,result);assert.equal(checks,1);
  }
});
test('busy reads have a finite wake budget',async()=>{
  let checks=0,waits=0;
  await completePending({operation:'resume_archive'},{maxWaits:2,pause:async()=>{},complete:async()=>{checks++;return {archive_pending_reason:'origin_busy'};},app:{listTools:async()=>[{name:'wait_threads'}],callAppTool:async()=>waits++}});
  assert.equal(checks,3);assert.equal(waits,2);
});

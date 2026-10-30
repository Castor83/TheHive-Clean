'use strict';
// One bounded, model-free completion worker. Only read waits repeat; the guarded
// adapter persists archiveAttemptedAt before the sole archive RPC.
const {ensureSuccessor}=require('./handoff-desktop.cjs');
/**
 * Retry guarded completion only while origin activity or successor visibility is pending; bound attempts/time and use injected pause or existing event waits.
 * @param {object} input Bound resume_creation or resume_archive adapter request.
 * @param {object} [options] Injectable adapter, app client, wait limits and pause callback for offline tests.
 * @returns {Promise<object>} Adapter result or explicit creation fallback; archive errors propagate and no model is launched.
 */
async function completePending(input,{complete=ensureSuccessor,app=require('./codex-app-pipe.cjs'),waitMs=45000,maxWaits=input.operation==='resume_creation'?300:12,pause=()=>new Promise(resolve=>setTimeout(resolve,2000))}={}){
  const creation=input.operation==='resume_creation';
  if(!creation&&input.operation!=='resume_archive')throw Error('Completion only');
  const deadline=performance.now()+600000;
  try{
  for(let attempt=0;attempt<=maxWaits;attempt++){
    const result=await complete(input,{timeoutMs:5000});
    const awaitingVisibility=creation&&result.status==='successor_created'&&result.successor_thread_id;
    const busy=creation?(result.status==='waiting_for_origin'||awaitingVisibility):result.archive_pending_reason==='origin_busy';
    if(!busy)return result;
    if(attempt===maxWaits||performance.now()>=deadline)return creation?{status:'fallback_required',successor_thread_id:result.successor_thread_id||null,reason_code:awaitingVisibility?'successor_not_visible':'origin_did_not_finish'}:result;
    // Creation runs in the origin's caller context. wait_threads explicitly
    // forbids waiting on that caller. The guarded adapter already reads origin
    // status and freshness on every pass; only delay before its next read.
    if(creation){await pause();continue;}
    const tools=await app.listTools({timeoutMs:5000}),tool=tools.find(t=>t.name==='wait_threads');
    if(!tool)throw Error('Existing event wait unavailable');
    await app.callAppTool({tool,args:{targets:[{threadId:input.session_id,hostId:'local'}],timeoutMs:waitMs},
      threadId:creation?input.session_id:input.caller_session_id,turnId:input.turn_id,callId:require('node:crypto').randomUUID(),timeoutMs:Math.min(60000,waitMs+10000)});
    // A needs-attention wake can still be active; cap immediate wakes too.
    await pause();
  }
  }catch(error){
    if(creation)return {status:'fallback_required',successor_thread_id:null,reason_code:'creation_wait_failed',error_code:/^APP_[A-Z_]+$/.test(error?.code||'')?error.code:'LOCAL_COMPLETION_ERROR'};
    throw error;
  }
}
/**
 * Build a length-bounded failure display title from persisted naming metadata and a supplied reason; preserve the manual-start instruction.
 */
function failureTitle(journal,reason){
  const base=require('./handoff-naming.cjs').cleanTitle(journal?.naming?.current_title||journal?.originTitle||'');
  return ('[Weiterleitung fehlgeschlagen] '+(base?Array.from(base).slice(0,120).join('')+' – ':'')+reason+' – manuellen Start verwenden').slice(0,240);
}
module.exports={completePending,failureTitle};
if(require.main===module){
  let data='',bytes=0;process.stdin.setEncoding('utf8');
  process.stdin.on('data',chunk=>{bytes+=Buffer.byteLength(chunk);if(bytes>65536)process.exit(1);data+=chunk;});
  process.stdin.on('end',async()=>{
    try{
      const input=JSON.parse(data);
      const result=await completePending(input);
      require('node:fs').writeFileSync(require('node:path').join(input.snapshot_path,input.operation==='resume_creation'?'creation-completion-result.json':'archive-completion-result.json'),JSON.stringify(result)+'\n');
      if(input.operation==='resume_creation'&&result.status==='fallback_required'){
        try{
          const app=require('./codex-app-pipe.cjs'),tools=await app.listTools({timeoutMs:3000}),tool=tools.find(t=>t.name==='set_thread_title');
          const reasons={new_user_message_after_snapshot:'Neue Nachricht',snapshot_unverifiable:'Nachrichtenprüfung fehlgeschlagen',origin_did_not_finish:'Bisheriger Lauf nicht beendet',successor_not_visible:'Neuer Chat nicht bestätigt',creation_wait_failed:'Hintergrundstart fehlgeschlagen',chat_task_unbound:'Auftrag nicht zugeordnet',app_access_failed:'App-Zugriff fehlgeschlagen',navigation_failed:'Öffnen fehlgeschlagen'};
          let journal={};try{journal=JSON.parse(require('node:fs').readFileSync(require('node:path').join(input.handoff_root,input.session_id+'-status.json'),'utf8'));}catch{}
          if(tool)await app.callAppTool({tool,args:{threadId:input.session_id,title:failureTitle(journal,reasons[result.reason_code]||'Ursache nicht übermittelt')},threadId:input.caller_session_id||input.session_id,turnId:input.turn_id,callId:require('node:crypto').randomUUID(),timeoutMs:3000});
        }catch{}
      }
    }catch{process.exitCode=1;}
  });
}

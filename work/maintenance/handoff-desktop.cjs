'use strict';
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const {resumeProject,resumeBoundCheckpoint,chatTaskForCheckpoint}=require('./handoff-store.cjs');
const UUID=/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i;
/**
 * Return hexadecimal SHA-256 bytes for snapshot, history and journal binding checks.
 */
const hash=b=>crypto.createHash('sha256').update(b).digest('hex');
/**
 * Return whether a value names a fully qualified local path supported by this platform, excluding NUL and network forms.
 */
function localPath(file){return typeof file==='string'&&!file.includes('\0')&&(/^[a-z]:[\\/]/i.test(file)||/^\\\\\?\\[a-z]:\\/i.test(file)||(process.platform!=='win32'&&file.startsWith('/')&&!file.startsWith('//')&&!file.startsWith('/\\')));}
/**
 * Resolve a validated local path and require its canonical target to remain local.
 */
function real(file){if(!localPath(file))throw Error('Fully qualified local path required');const resolved=fs.realpathSync(file);if(!localPath(resolved))throw Error('Local realpath required');return resolved;}
/**
 * Return whether a candidate equals root or is lexically contained beneath it without escaping through a relative parent.
 */
function inside(file,root){const r=path.relative(root,file);return r===''||(!r.startsWith('..'+path.sep)&&r!=='..'&&!path.isAbsolute(r));}
/**
 * Read bounded JSON metadata up to 4 MiB, tolerating a BOM; propagate invalid JSON and filesystem errors.
 */
function read(file){if(fs.statSync(file).size>4*1024*1024)throw Error('Oversized metadata');return JSON.parse(fs.readFileSync(file,'utf8').replace(/^\uFEFF/,''));}
/**
 * Exclusively create and fsync a unique JSON temporary file, then rename it over the journal/proof target.
 */
function write(file,value){const tmp=file+'.'+crypto.randomUUID()+'.tmp';const fd=fs.openSync(tmp,'wx');try{fs.writeFileSync(fd,JSON.stringify(value,null,2)+'\n');fs.fsyncSync(fd);}finally{fs.closeSync(fd);}fs.renameSync(tmp,file);}
/**
 * Verify a named snapshot copy remains within its directory and matches manifest name, byte count and hash; return the canonical file path.
 */
function copied(dir,entry,name){const file=real(path.join(dir,name));if(entry?.file!==name||!inside(file,dir)||fs.statSync(file).size!==entry.bytes||entry.bytes>128*1024*1024||hash(fs.readFileSync(file))!==entry.sha256)throw Error('Snapshot copy mismatch');return file;}
/**
 * Resolve camelCase/snake_case journal identity fields and throw when both exist with conflicting values.
 */
function alias(state,camel,snake){const a=state[camel],b=state[snake];if(a!=null&&b!=null&&a!==b)throw Error('Conflicting journal identity');return a??b;}
/**
 * Follow bounded, hashed project ancestry until the exact origin checkpoint is found and require its working Markdown to match; throw on foreign or missing history.
 */
function verifyOriginSnapshot(root,current,manifest,working,session){
  const history=path.join(root,current.project_id,'history'),resolvedHistory=real(history);
  if(!inside(resolvedHistory,root))throw Error('History escaped handoff root');
  let record=current;
  for(let depth=0;depth<128;depth++){
    if(record.checkpoint_id===manifest.checkpoint_id){
      if(record.session_id!==session||record.project_id!==manifest.project_id)throw Error('Historical origin mismatch');
      require('./handoff-format.cjs').parseMarkdown(fs.readFileSync(working,'utf8'),record);return;
    }
    const ref=record.parent_reference,candidate=typeof ref?.file==='string'?path.resolve(root,ref.file):'';
    if(!candidate||!inside(candidate,history)||path.extname(candidate)!=='.json')throw Error('No bound origin ancestor');
    const file=real(candidate);
    if(!inside(file,resolvedHistory)||fs.statSync(file).size>4*1024*1024)throw Error('Invalid history source');
    const bytes=fs.readFileSync(file),parent=JSON.parse(bytes);
    if(hash(bytes)!==ref.sha256||parent.project_id!==current.project_id||parent.checkpoint_id!==record.parent_checkpoint_id)throw Error('Ancestor hash/project mismatch');
    record=parent;
  }
  throw Error('Origin ancestry exceeds local bound');
}
/**
 * Find a requested uptake checkpoint through bounded hashed project ancestry; return the matching record or reject invalid/missing parents.
 */
function uptakeAncestor(root,current,id){
  const history=real(path.join(root,current.project_id,'history'));
  for(let depth=0;depth<128;depth++){
    if(current.checkpoint_id===id)return current;
    const ref=current.parent_reference,file=ref&&real(path.resolve(root,ref.file));
    if(!file||!inside(file,history)||path.extname(file)!=='.json')throw Error('Missing uptake ancestor');
    const bytes=fs.readFileSync(file);if(bytes.length>4*1024*1024||hash(bytes)!==ref.sha256)throw Error('Invalid uptake ancestor');
    const parent=JSON.parse(bytes);
    if(parent.project_id!==current.project_id||parent.checkpoint_id!==current.parent_checkpoint_id)throw Error('Foreign uptake ancestor');
    current=parent;
  }
  throw Error('Uptake ancestry exceeds bound');
}
/**
 * Coordinate one journal-locked successor creation/recovery or controlled takeover using exact local project/session/snapshot bindings and persistent freshness checks.
 * @param {object} input Bound origin/turn/workspace/snapshot plus optional completion operation and successor identity.
 * @param {object} [options] Existing app transport or offline adapter, Codex home, time budget, bindings and pending-job scheduler.
 * @returns {Promise<object>} Explicit successor, waiting, archive or fallback outcome; may write journals/proof, call desktop tools and schedule a bounded completion worker.
 */
async function ensureSuccessorCore(input,{app,codexHome,timeoutMs=10000,bindings,schedulePending}={}){
  let lock,nonce,journal,state,knownSuccessorId,pendingJob;
  try{
    const live=!app,resuming=input?.operation==='resume_archive',resumingCreation=input?.operation==='resume_creation';
    const confirming=input?.operation==='confirm_takeover'||resuming;
    if(input?.operation!==undefined&&!confirming&&!resumingCreation)throw Error('Unsupported operation');
    const creationCaller=resumingCreation?(input.caller_session_id||input.session_id):null;
    if(resumingCreation&&(!UUID.test(creationCaller||'')||(live&&process.env.CODEX_THREAD_ID!==creationCaller)))throw Error('Creation worker caller mismatch');
    if(!UUID.test(input?.session_id||'')||!UUID.test(input?.turn_id||''))throw Error('Invalid session/turn binding');
    if(confirming&&(!UUID.test(input.successor_session_id||'')||input.successor_session_id===input.session_id||
       (!app&&process.env.CODEX_THREAD_ID!==(resuming?input.caller_session_id:input.successor_session_id))))throw Error('Successor caller binding unavailable');
    if(resuming&&(!UUID.test(input.caller_session_id||'')||input.caller_session_id===input.session_id))throw Error('Invalid completion caller');
    const cwd=real(input.cwd),root=real(input.handoff_root);
    const home=real(codexHome||process.env.CODEX_HOME||path.join(require('node:os').homedir(),'.codex'));
    const dir=real(input.snapshot_path),area=real(path.join(home,'handoff-snapshots',input.session_id));
    if(!inside(dir,area))throw Error('Snapshot/session binding mismatch');
    const manifest=read(path.join(dir,'manifest.json'));
    if(manifest.status!=='PASS'||manifest.session_id!==input.session_id)throw Error('Unverified snapshot');
    const working=copied(dir,manifest.working_state,'working.md');copied(dir,manifest.transcript,'transcript.jsonl');
    const index=read(path.join(root,'index.json'));
    const ids=Object.keys(index.projects).filter(id=>index.projects[id].session_id===input.session_id);
    let reopeningSuccessor,originSnapshot=manifest,firstOrigin=false,cp;
    if(ids.length===0||(ids.length===1&&hash(fs.readFileSync(working))!==index.projects[ids[0]].sha256)){
      ids.length=0;
      const meta=require('./handoff-format.cjs').parseMarkdown(fs.readFileSync(working,'utf8')).metadata;
      if(meta.session_id!==input.session_id||
         (Object.hasOwn(manifest,'project_id')&&manifest.project_id!==meta.project_id)||
         (Object.hasOwn(manifest,'checkpoint_id')&&manifest.checkpoint_id!==meta.checkpoint_id))throw Error('Snapshot metadata mismatch');
      originSnapshot={...manifest,project_id:meta.project_id,checkpoint_id:meta.checkpoint_id};
      const statusFile=path.join(root,input.session_id+'-status.json'),prior=fs.existsSync(statusFile)?read(statusFile):null;
      if(prior&&(['takeover_verified','archived_after_takeover'].includes(prior.phase)||(confirming&&['successor_created','successor_visible'].includes(prior.phase)))){
        const origin=alias(prior,'originThreadId','origin_thread_id'),successor=alias(prior,'successorThreadId','successor_thread_id');
        if(origin!==input.session_id||!UUID.test(successor||'')||successor===origin||!Object.hasOwn(index.projects,originSnapshot.project_id)||
           prior.project_id!==originSnapshot.project_id||prior.checkpointId!==originSnapshot.checkpoint_id||prior.repositoryPath!==cwd||prior.handoffRoot!==root)throw Error('No verified takeover binding');
        reopeningSuccessor=successor;ids.push(originSnapshot.project_id);
      }else{
        if(confirming)throw Error('No verified takeover binding');
        // First capture can outlive another chat's project update. Bind the copied
        // Markdown, never a newer working projection or an unbound history scan.
        cp=resumeBoundCheckpoint(root,{session_id:input.session_id,workspace:cwd,markdown:fs.readFileSync(working,'utf8')}).checkpoint;
        firstOrigin=true;ids.push(cp.project_id);
      }
    }
    if(ids.length!==1)throw Error('No unique indexed session checkpoint');
    if(!cp){
      cp=resumeProject(root,ids[0]);
      const git=cp.state.git;
      if(!confirming&&!reopeningSuccessor&&git&&(Object.hasOwn(git,'workspace')||Object.hasOwn(git,'repository'))){
        const meta=require('./handoff-format.cjs').parseMarkdown(fs.readFileSync(working,'utf8')).metadata;
        if(meta.session_id!==input.session_id||
           (Object.hasOwn(manifest,'project_id')&&manifest.project_id!==meta.project_id)||
           (Object.hasOwn(manifest,'checkpoint_id')&&manifest.checkpoint_id!==meta.checkpoint_id))throw Error('Snapshot metadata mismatch');
        originSnapshot={...manifest,project_id:meta.project_id,checkpoint_id:meta.checkpoint_id};
        cp=resumeBoundCheckpoint(root,{session_id:input.session_id,workspace:cwd,markdown:fs.readFileSync(working,'utf8')}).checkpoint;
        firstOrigin=true;
      }
    }
    if(confirming&&(!reopeningSuccessor||reopeningSuccessor!==input.successor_session_id||(!resuming&&cp.session_id!==input.successor_session_id)))throw Error('No successor-owned checkpoint');
    if(reopeningSuccessor)verifyOriginSnapshot(root,cp,originSnapshot,working,input.session_id);
    else if(cp.session_id!==input.session_id||hash(fs.readFileSync(working))!==cp.sha256||
            (manifest.checkpoint_id&&manifest.checkpoint_id!==cp.checkpoint_id)||
            (manifest.project_id&&manifest.project_id!==cp.project_id))throw Error('Checkpoint identity mismatch');
    const operatorPolicy=read(path.join(__dirname,'handoff-automation-policy.json'));
    const allLocal=operatorPolicy.scope==='all_local_projects';
    const trustedProjects=app?bindings:operatorPolicy.projects;
    if(allLocal){
      const git=cp.state.git,workspace=git&&Object.hasOwn(git,'workspace')?git.workspace:git?.repository;
      if(!localPath(operatorPolicy.handoff_root)||path.relative(real(operatorPolicy.handoff_root),root)!==''||
         !localPath(workspace)||path.relative(real(workspace),cwd)!=='')throw Error('Global checkpoint/workspace binding mismatch');
    }else if(trustedProjects!==undefined){
      if(!trustedProjects||Array.isArray(trustedProjects)||!Object.hasOwn(trustedProjects,cp.project_id))throw Error('Project not registered');
      const binding=trustedProjects[cp.project_id];
      if(typeof binding?.workspace!=='string'||typeof binding?.handoff_root!=='string'||
         path.relative(real(binding.workspace),cwd)!==''||path.relative(real(binding.handoff_root),root)!=='')throw Error('Exact project binding mismatch');
    }else if(!app||!inside(root,cwd)||path.relative(real(path.join(cwd,'work','handoff')),root)!=='')throw Error('Workspace-local fixture binding mismatch');
    if(manifest.trigger==='context_usage'){
      const u=manifest.context_usage;
      if(!Number.isSafeInteger(u?.used_tokens)||!Number.isSafeInteger(u?.limit_tokens)||u.limit_tokens<=0||u.threshold_percent!==80||u.used_tokens*100<u.limit_tokens*80)throw Error('Below threshold');
    }else if(!['auto','manual'].includes(manifest.trigger))throw Error('Unsupported trigger');
    if(!app){if(operatorPolicy.enabled!==true||operatorPolicy.cancel_on_new_user_message!==true)throw Error('Conditional automatic successor paused');app=require('./codex-app-pipe.cjs');}
    // Creation must use the origin's explicit assignment. Project NEXT_ACTION
    // and a valid writer UUID alone never authorize a chat continuation.
    let prompt='';
    journal=path.join(root,input.session_id+'-status.json');lock=path.join(root,input.session_id+'-desktop.lock');nonce=crypto.randomUUID();fs.writeFileSync(lock,nonce,{flag:'wx'});
    state=fs.existsSync(journal)?read(journal):{};
    const origin=alias(state,'originThreadId','origin_thread_id'),successor=alias(state,'successorThreadId','successor_thread_id'),projectId=alias(state,'projectId','app_project_id');
    if(origin!=null&&origin!==input.session_id)throw Error('Foreign origin journal');
    if((state.project_id!=null&&state.project_id!==cp.project_id)||(state.repositoryPath!=null&&state.repositoryPath!==cwd)||(state.handoffRoot!=null&&state.handoffRoot!==root))throw Error('Foreign project journal');
    if(successor!=null&&(!UUID.test(successor)||successor===input.session_id||origin!==input.session_id))throw Error('Invalid stored successor ID');
    if(firstOrigin&&Object.keys(state).length){
      const started=['creation_intent','creation_unknown','creation_pending','successor_created','successor_visible'].includes(state.phase);
      if(origin!==input.session_id||state.project_id!==cp.project_id||state.repositoryPath!==cwd||state.handoffRoot!==root||
         (state.checkpointId!=null&&state.checkpointId!==cp.checkpoint_id)||(state.handoffFile!=null&&state.handoffFile!==cp.file)||
         (started?(state.checkpointId!==cp.checkpoint_id||state.handoffFile!==cp.file):
           (state.phase!=='snapshot_ready'||successor!=null||state.freshnessBaseline?.checkpoint_id!==cp.checkpoint_id)))throw Error('Historical first-origin journal mismatch');
    }
    if(reopeningSuccessor&&(successor!==reopeningSuccessor||(!['takeover_verified','archived_after_takeover'].includes(state.phase)&&!(confirming&&['successor_created','successor_visible'].includes(state.phase)))||state.checkpointId!==originSnapshot.checkpoint_id||state.project_id!==originSnapshot.project_id))throw Error('Takeover journal changed');
    state={...state,originThreadId:origin,successorThreadId:successor,projectId};
    /**
     * Persist a journal phase and extra metadata after checking concurrent identity bindings; preserve verified takeover/archive phases and return successor status.
     */
    const save=(phase,extra={})=>{
      if(fs.existsSync(journal)){
        const latest=read(journal);
        for(const [camel,snake] of [['originThreadId','origin_thread_id'],['successorThreadId','successor_thread_id'],['projectId','app_project_id']]){
          if(alias(latest,camel,snake)!==alias(state,camel,snake))throw Error('Concurrent journal identity changed');
        }
        for(const key of ['project_id','repositoryPath','handoffRoot','checkpointId','handoffFile']){
          if(latest[key]!==state[key])throw Error('Concurrent journal binding changed');
        }
        if(['takeover_verified','archived_after_takeover'].includes(latest.phase)){
          const wasArchived=state.phase==='archived_after_takeover';
          state={...state,...latest};if(wasArchived)state.phase='archived_after_takeover';
        }
      }
      const durablePhase=state.phase==='archived_after_takeover'||phase==='archived_after_takeover'?'archived_after_takeover':state.phase==='takeover_verified'?'takeover_verified':phase;
      state={...state,...extra,phase:durablePhase,originThreadId:input.session_id,origin_thread_id:input.session_id,repositoryPath:cwd,handoffRoot:root,project_id:cp.project_id,updatedAt:new Date().toISOString()};
      state.successor_thread_id=state.successorThreadId||null;state.app_project_id=state.projectId||null;write(journal,state);
      if(state.successorThreadId)knownSuccessorId=state.successorThreadId;
      return {status:phase,successor_thread_id:state.successorThreadId||null};
    };
    /**
     * Check the first snapshot boundary or reviewed manual boundary; persist automatic cancellation on newer/unverifiable input and return a blocking result, otherwise null.
     */
    function fresh(){
      if(operatorPolicy.cancel_on_new_user_message!==true)return null;
      // Explicitly user-started successors have a separate boundary. Never
      // remove the automatic cancellation, or let an automatic worker use it.
      if(confirming&&state.manualAuthorization){
        try{
          const context=require('./handoff-manual-start.cjs').manualContext(state,input.successor_session_id,home);
          const reviewed=cp.state.sources?.['manual_context_review_'+input.successor_session_id+'_'+context.sha256] ?? cp.state.sources?.['manual_context_review_'+input.successor_session_id] ?? cp.state.sources?.manual_context_review;
          if(real(reviewed?.path)!==real(context.transcript_copy)||reviewed?.sha256!==context.sha256)throw Error('Manual context review missing');
          return null;
        }catch{return {status:'fallback_required',successor_thread_id:state.successorThreadId||null,reason_code:'manual_context_review_required'};}
      }
      if(state.automationCancelledAt)return {status:'fallback_required',successor_thread_id:state.successorThreadId||null,reason_code:state.automationCancelReason||'snapshot_unverifiable'};
      if(!state.freshnessBaseline)save(state.phase||'snapshot_ready',{freshnessBaseline:{snapshot_path:dir,checkpoint_id:originSnapshot.checkpoint_id||cp.checkpoint_id}});
      const baseline=state.freshnessBaseline;
      if(typeof baseline.snapshot_path!=='string'||baseline.checkpoint_id!==(originSnapshot.checkpoint_id||cp.checkpoint_id))return {status:'fallback_required',successor_thread_id:state.successorThreadId||null,reason_code:'snapshot_unverifiable'};
      const checked=require('./handoff-freshness.cjs').checkSnapshotFreshness({snapshotPath:baseline.snapshot_path,codexHome:home,sessionId:input.session_id});
      if(checked.status==='unchanged')return null;
      const reason=checked.status==='new_user_message'?'new_user_message_after_snapshot':'snapshot_unverifiable';
      save(state.phase||'snapshot_ready',{automationCancelledAt:new Date().toISOString(),automationCancelReason:reason});
      return {status:'fallback_required',successor_thread_id:state.successorThreadId||null,reason_code:reason};
    }
    const uncertain=['creation_intent','creation_unknown','creation_pending'].includes(state.phase);
    if(!confirming&&!reopeningSuccessor&&!state.successorThreadId&&!uncertain){
      const task=chatTaskForCheckpoint(cp,input.session_id);
      prompt=['Projekt-ID: '+cp.project_id,'Handoff-Datei: '+cp.file,'Naechster offener Arbeitsschritt: '+task.next_step.text.trim().replace(/\s+/g,' ')].join('\n');
      if(prompt.length>3000)throw Error('Minimal starter exceeds limit');
    }
    if(state.successorThreadId){if(!UUID.test(state.successorThreadId)||state.originThreadId!==input.session_id)throw Error('Invalid stored successor ID');if(!allLocal)knownSuccessorId=state.successorThreadId;}
    if(!allLocal&&!knownSuccessorId&&uncertain&&state.reconciliationAttemptedAt)return {status:state.phase==='creation_pending'?'creation_pending':'creation_unknown',successor_thread_id:null};
    if(!Number.isInteger(timeoutMs)||timeoutMs<1||timeoutMs>60000)throw Error('Invalid desktop time budget');
    const deadline=performance.now()+timeoutMs;
    /**
     * Return milliseconds left in the shared desktop deadline; throw once the bounded budget is exhausted.
     */
    const remaining=()=>{const ms=Math.floor(deadline-performance.now());if(ms<1)throw Error('Desktop time budget exhausted');return ms;};
    /**
     * Run an asynchronous start callback within the remaining desktop deadline and clear its rejection timer on settlement.
     */
    async function bounded(start){
      const ms=remaining();let timer;
      try{return await Promise.race([Promise.resolve().then(()=>start(remaining())),new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error('Desktop time budget exhausted')),ms);})]);}
      finally{clearTimeout(timer);}
    }
    const tools=await bounded(ms=>app.listTools({timeoutMs:ms}));
    /**
     * Find an existing tool by name, bind the correct actual caller/turn and invoke/decode it within the shared desktop deadline.
     */
    async function call(name,args){const tool=tools.find(t=>t.name===name);if(!tool)throw Error('Required existing app tool unavailable');return app.decodeToolResult(await bounded(ms=>app.callAppTool({tool,args,threadId:resumingCreation?creationCaller:resuming?input.caller_session_id:confirming?input.successor_session_id:input.session_id,turnId:input.turn_id,callId:crypto.randomUUID(),timeoutMs:ms})));}
    /**
     * Read app projects and require exactly one local project whose canonical workspace matches the caller; return that project row.
     */
    async function exactProject(){
      const projects=(await call('list_projects',{})).projects||[];
      const matches=projects.filter(p=>{
        if(p.projectKind!=='local'||p.hostId!=='local'||typeof p.path!=='string'||typeof p.projectId!=='string'||!p.projectId)return false;
        if(!localPath(p.path))return false;
        try{return path.relative(real(p.path),cwd)==='';}catch{return false;}
      });
      if(matches.length!==1)throw Error('No unique exact local app project');
      return matches[0];
    }
    let project;
    if(allLocal){
      project=await exactProject();
      if((state.projectId!=null&&state.projectId!==project.projectId)||((state.successorThreadId||uncertain)&&state.projectId!==project.projectId))throw Error('Journal app project binding mismatch');
      if(state.successorThreadId)knownSuccessorId=state.successorThreadId;
      if(!knownSuccessorId&&uncertain&&state.reconciliationAttemptedAt)return {status:state.phase==='creation_pending'?'creation_pending':'creation_unknown',successor_thread_id:null};
    }
    /**
     * Attempt a bounded status-title update once per journaled thread/label pair when enabled; persist the attempt and tolerate display failures.
     */
    async function visibleNotice(label,threadId=input.session_id){
      if(operatorPolicy.visible_notice!==true||!tools.some(t=>t.name==='set_thread_title'))return;
      const key=threadId+':'+label;
      if((state.noticeAttempts||[]).includes(key))return;
      save(state.phase||'snapshot_ready',{noticeAttempts:[...(state.noticeAttempts||[]).slice(-15),key]});
      const base=threadId===input.session_id?(state.naming?.current_title||state.originTitle||cp.project_id):(state.naming?.successor_title||cp.project_id+' – Fortsetzung');
      try{await call('set_thread_title',{threadId,title:('['+label+'] '+base).slice(0,240)});}catch{}
    }
    const initialBlock=fresh();if(initialBlock){await visibleNotice('Übergabe angehalten');return initialBlock;}
    if(!confirming&&!state.naming){
      let title=state.originTitle;
      if(!title){
        const origin=await call('read_thread',{threadId:input.session_id,turnLimit:1,includeOutputs:false,maxOutputCharsPerItem:200});
        if(origin.thread?.id!==input.session_id)throw Error('Naming origin identity mismatch');
        title=origin.thread.title;
      }
      const naming=await require('./handoff-naming.cjs').resolveAppNaming({root,session_id:input.session_id,project_id:cp.project_id,workspace:cwd,title:title||cp.project_id},async id=>(await call('read_thread',{threadId:id,turnLimit:1,includeOutputs:false,maxOutputCharsPerItem:200})).thread);
      save(state.phase||'snapshot_ready',{originTitle:title||cp.project_id,naming});
    }
    if(resumingCreation&&creationCaller!==input.session_id){
      if(!project)project=await exactProject();
      const catalog=await call('list_threads',{limit:50});
      if(![...(catalog.pinnedThreads||[]),...(catalog.threads||[])].some(t=>(t.threadId||t.id)===creationCaller&&t.projectId===project.projectId))throw Error('Creation completion caller not in exact project');
    }
    // A newly created chat starts immediately. Wait for the source turn to end
    // BEFORE creation, using the existing bounded event worker, not another model.
    if(!confirming&&!state.successorThreadId&&operatorPolicy.wait_for_origin_idle===true){
      const origin=await call('read_thread',{threadId:input.session_id,turnLimit:1,includeOutputs:false,maxOutputCharsPerItem:200});
      if(origin.thread?.id!==input.session_id)throw Error('Origin read identity mismatch');
      const status=origin.thread?.status?.type||origin.thread?.status;
      if(!['idle','notLoaded','active'].includes(status))throw Error('Unknown origin status');
      if(!state.originTitle&&typeof origin.thread?.title==='string')save(state.phase||'snapshot_ready',{originTitle:origin.thread.title.slice(0,180)});
      if(status==='active'){
        save('snapshot_ready',{checkpointId:cp.checkpoint_id,projectId:project?.projectId||state.projectId,handoffFile:cp.file});
        if(!state.creationWaiterStartedAt){
          save('snapshot_ready',{creationWaiterStartedAt:new Date().toISOString()});
          pendingJob={...input,operation:'resume_creation'};
        }
        await visibleNotice('Übergabe gesichert – Wechsel folgt');
        return {status:'waiting_for_origin',successor_thread_id:null};
      }
      const afterIdle=fresh();if(afterIdle)return afterIdle;
    }
    /**
     * Persist a successor phase, recheck freshness, announce availability and conditionally navigate once per turn; preserve explicit failure and pending-worker outcomes.
     */
    async function finish(phase,extra={}){
      const result=save(phase,extra);
      const blocked=fresh();if(blocked)return blocked;
      if(state.navigationFailedTurnId===input.turn_id)return {status:'fallback_required',successor_thread_id:state.successorThreadId||null,reason_code:'navigation_failed'};
      if(state.successorThreadId){
        await visibleNotice('Übergabe – Nachfolger bereit');
        await visibleNotice('Hier weiter',state.successorThreadId);
      }
      if(phase==='successor_created'&&operatorPolicy.wait_for_origin_idle===true&&!resumingCreation&&!state.creationWaiterStartedAt&&(live||schedulePending)){
        save(phase,{creationWaiterStartedAt:new Date().toISOString()});pendingJob={...input,operation:'resume_creation'};
      }
      const navigationTurns=state.navigationTurnIds??[];
      if(operatorPolicy.navigate===true&&phase==='successor_visible'&&state.successorThreadId&&
         Array.isArray(navigationTurns)&&navigationTurns.length<64&&navigationTurns.every(id=>typeof id==='string'&&UUID.test(id))&&!navigationTurns.includes(input.turn_id)){
        const beforeNavigation=fresh();if(beforeNavigation){await visibleNotice('Übergabe angehalten');await visibleNotice('Übergabe angehalten',state.successorThreadId);return beforeNavigation;}
        // Persist before the call; keep all attempted turns, then leave recovery manual at the bound.
        save(phase,{navigationAttemptedAt:state.navigationAttemptedAt||new Date().toISOString(),navigationTurnIds:[...navigationTurns,input.turn_id]});
        try{await call('navigate_to_codex_page',{threadId:state.successorThreadId});return {...save(phase,{navigatedAt:new Date().toISOString()}),navigation_confirmed:true};}
        catch{
          save(phase,{navigationFailedTurnId:input.turn_id});await visibleNotice('Wechsel fehlgeschlagen');
          return {status:'fallback_required',successor_thread_id:state.successorThreadId||null,reason_code:'navigation_failed'};
        }
      }
      return result;
    }
    /**
     * Read a bounded desktop catalog and return pinned plus ordinary thread rows for identity reconciliation.
     */
    const threads=async()=>{const r=await call('list_threads',{limit:50});return [...(r.pinnedThreads||[]),...(r.threads||[])];};
    if(confirming){
      if(operatorPolicy.cancel_on_new_user_message!==true||operatorPolicy.archive_after_takeover!==true)throw Error('Guarded uptake completion unavailable');
      if(!project)project=await exactProject();
      if(project.projectId!==state.projectId)throw Error('Uptake app project mismatch');
      const catalog=await threads();
      /**
       * Return whether a thread ID belongs to the exact app project, allowing only the verified manual-move acknowledgement fallback.
       */
      const belongs=(id)=>catalog.some(t=>(t.threadId||t.id)===id&&(t.projectId===project.projectId||
        (state.manualAuthorization&&require('./handoff-manual-start.cjs').manualProjectMatches(t,state.manualAuthorization,project.projectId,cwd))));
      if(!belongs(input.successor_session_id))throw Error('Successor not in exact app project');
      if(resuming&&!belongs(input.caller_session_id))throw Error('Completion caller not in exact app project');
      const blocked=fresh();if(blocked)return blocked;
      const proof=path.join(dir,'takeover-proof.json');
      if(resuming){
        const p=read(proof);
        if(!['takeover_verified','archived_after_takeover'].includes(state.phase)||state.takeoverEvidence!==proof||p.uptake_verified!==true||
          p.origin_session_id!==input.session_id||p.successor_session_id!==input.successor_session_id||p.app_project_id!==project.projectId||p.workspace!==cwd||
          p.origin_checkpoint_id!==originSnapshot.checkpoint_id||p.checkpoint_examined!==state.uptakeCheckpointId||
          uptakeAncestor(root,cp,p.checkpoint_examined).session_id!==input.successor_session_id)throw Error('Invalid durable uptake proof');
      }else{
        write(proof,{schema_version:1,origin_session_id:input.session_id,successor_session_id:input.successor_session_id,app_project_id:project.projectId,workspace:cwd,checkpoint_examined:cp.checkpoint_id,origin_checkpoint_id:originSnapshot.checkpoint_id,uptake_verified:true,checked_at_utc:new Date().toISOString()});
        save('takeover_verified',{takenOverAt:state.takenOverAt||new Date().toISOString(),takeoverEvidence:proof,uptakeCheckpointId:cp.checkpoint_id});
      }
      if(state.phase==='archived_after_takeover')return {status:'archived_after_takeover',successor_thread_id:state.successorThreadId};
      const origin=await call('read_thread',{threadId:input.session_id,turnLimit:1,includeOutputs:false,maxOutputCharsPerItem:200});
      const status=origin.thread?.status?.type||origin.thread?.status;
      if(origin.thread?.id!==input.session_id)throw Error('Origin read identity mismatch');
      if(!['idle','notLoaded'].includes(status)){
        if(status!=='active')throw Error('Unknown origin status');
        if(!resuming&&!state.archiveWaiterStartedAt&&(live||schedulePending)){
          save('takeover_verified',{archiveWaiterStartedAt:new Date().toISOString()});
          const job={...input,operation:'resume_archive',caller_session_id:input.successor_session_id};
          pendingJob=job;
        }
        return {status:'takeover_verified',successor_thread_id:state.successorThreadId,archive_pending:true,archive_pending_reason:'origin_busy'};
      }
      const lateBlock=fresh();if(lateBlock)return lateBlock;
      if(state.archiveAttemptedAt)return {status:'takeover_verified',successor_thread_id:state.successorThreadId,archive_pending:true};
      save('takeover_verified',{archiveAttemptedAt:new Date().toISOString()});
      let archiveConfirmed=false;
      try{const archived=await call('set_thread_archived',{threadId:input.session_id,archived:true,hostId:'local'});archiveConfirmed=archived.threadId===input.session_id&&archived.archived===true;}catch{}
      const afterArchive=fresh();
      if(afterArchive){
        let restored=false;
        save('takeover_verified',{archiveRestorationAttemptedAt:new Date().toISOString(),archiveOutcome:archiveConfirmed?'confirmed':'unknown'});
        // A single safety cleanup has its own 1.5s budget even if the original RPC used its deadline.
        let timer;
        try{
          const tool=tools.find(t=>t.name==='set_thread_archived');if(!tool)throw Error('Restore tool unavailable');
          const budget=1500;
          const result=app.decodeToolResult(await Promise.race([app.callAppTool({tool,args:{threadId:input.session_id,archived:false,hostId:'local'},threadId:resuming?input.caller_session_id:input.successor_session_id,turnId:input.turn_id,callId:crypto.randomUUID(),timeoutMs:budget}),new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error('Restore deadline')),budget);})]));
          restored=result.threadId===input.session_id&&result.archived===false;
        }catch{}finally{clearTimeout(timer);}
        save('takeover_verified',{originRestored:restored});
        return {...afterArchive,origin_restored:restored};
      }
      if(!archiveConfirmed)return {status:'takeover_verified',successor_thread_id:state.successorThreadId,archive_pending:true};
      return save('archived_after_takeover',{archivedAt:new Date().toISOString()});
    }
    const title=cp.project_id+' – Fortsetzung '+input.session_id;
    /**
     * Make at most one persisted catalog reconciliation after an uncertain creation; reuse one exact successor and never issue another create.
     */
    async function reconcile(){
      const phase=state.phase==='creation_pending'?'creation_pending':'creation_unknown';
      if(state.reconciliationAttemptedAt)return {status:phase,successor_thread_id:null};
      if(state.checkpointId!==cp.checkpoint_id||state.handoffFile!==cp.file||state.repositoryPath!==cwd||typeof state.projectId!=='string')return save(phase);
      try{remaining();}catch{return save(phase);}
      // Persist before the sole catalog attempt: a crash cannot permit a repeat or another create.
      save(phase,{reconciliationAttemptedAt:new Date().toISOString()});
      try{
        const existing=(await threads()).filter(t=>t.title===title&&t.projectId===state.projectId&&UUID.test(t.threadId||t.id||'')&&(t.threadId||t.id)!==input.session_id);
        if(existing.length===1)return finish('successor_visible',{successorThreadId:existing[0].threadId||existing[0].id});
      }catch{}
      return {status:phase,successor_thread_id:null};
    }
    if(state.successorThreadId){const visible=(await threads()).some(t=>(t.threadId||t.id)===state.successorThreadId&&t.projectId===state.projectId);return await finish(visible?'successor_visible':'successor_created');}
    if(reopeningSuccessor)throw Error('Navigation-only recovery cannot create or reconcile');
    if(uncertain)return await reconcile();
    if(!project)project=await exactProject();
    const existing=(await threads()).filter(t=>t.title===title&&t.projectId===project.projectId&&UUID.test(t.threadId||t.id||'')&&(t.threadId||t.id)!==input.session_id);
    if(existing.length>1)throw Error('Ambiguous existing successor');
    if(existing.length===1)return await finish('successor_visible',{successorThreadId:existing[0].threadId||existing[0].id,projectId:project.projectId});
    save('creation_intent',{checkpointId:cp.checkpoint_id,projectId:project.projectId,successorTitle:title,handoffFile:cp.file});
    const creationBlock=fresh();if(creationBlock)return creationBlock;
    let created;
    try{created=await call('create_thread',{title,prompt,target:{type:'project',projectId:project.projectId,environment:{type:'local'}}});}
    catch{save('creation_unknown');return await reconcile();}
    if(!UUID.test(created?.threadId||'')||created.threadId===input.session_id){save(created?.clientThreadId?'creation_pending':'creation_unknown',{clientThreadId:created?.clientThreadId||null});return await reconcile();}
    save('successor_created',{successorThreadId:created.threadId,successorHostId:created.hostId||null});
    try{if((await threads()).some(t=>(t.threadId||t.id)===created.threadId&&t.projectId===project.projectId))return await finish('successor_visible');}catch{}
    return await finish('successor_created');
  }catch(error){
    if(error?.code==='CHAT_TASK_UNBOUND')return {status:'fallback_required',successor_thread_id:null,reason_code:'chat_task_unbound'};
    if(input?.operation==='resume_archive')return {status:'fallback_required',successor_thread_id:knownSuccessorId||null,reason_code:'archive_completion_unverified'};
    if(/^APP_[A-Z_]+$/.test(error?.code||''))return {status:'fallback_required',successor_thread_id:knownSuccessorId||null,reason_code:'app_access_failed',error_code:error.code};
    return knownSuccessorId?{status:'successor_created',successor_thread_id:knownSuccessorId}:{status:'fallback_required'};
  }
  finally{
    if(lock&&nonce){try{if(fs.readFileSync(lock,'utf8')===nonce)fs.unlinkSync(lock);}catch{pendingJob=null;}}
    // Start only after releasing the journal lock. No model or new chat is run.
    if(pendingJob){try{
      if(schedulePending)schedulePending(pendingJob);
      else {const child=require('node:child_process').spawn(process.execPath,[path.join(__dirname,'handoff-archive-waiter.cjs')],{detached:true,windowsHide:true,stdio:['pipe','ignore','ignore']});child.on('error',()=>{});child.stdin.on('error',()=>{});child.stdin.end(JSON.stringify(pendingJob));child.unref();}
    }catch{/* Missing completion receipt leaves the existing manual recovery intact. */}}
  }
}
/**
 * Dispatch explicit manual-offer requests or guarded desktop transfer; attach a bound local manual offer to eligible fallback/waiting outcomes.
 * @param {object} input Actual origin and transfer operation context.
 * @param {object} [options] Existing adapter options forwarded to the guarded implementation.
 * @returns {Promise<object>} Transfer result with optional manual recovery URL/file; failed offers do not override the original outcome.
 */
async function ensureSuccessor(input,options={}){
  if(input?.operation==='offer_manual_start'){
    try{return {status:'fallback_required',successor_thread_id:null,reason_code:'announcement_required',...require('./handoff-manual-start.cjs').offerManualStart(input,options)};}
    catch{return {status:'fallback_required',successor_thread_id:null,reason_code:'announcement_required'};}
  }
  const result=await ensureSuccessorCore(input,options);
  if(!input?.operation&&['fallback_required','waiting_for_origin','creation_unknown','creation_pending'].includes(result.status)){
    try{return {...result,...require('./handoff-manual-start.cjs').offerManualStart(input,options)};}catch{/* Keep verified local recovery when an offer cannot be bound. */}
  }
  return result;
}
module.exports={ensureSuccessor};
if(require.main===module){
  let chunks=[],bytes=0,done=false;
  /**
   * Write one JSON CLI result and exit after stdout flush; ignore later completion/error attempts.
   */
  const emit=result=>{if(done)return;done=true;process.stdout.write(JSON.stringify(result)+'\n',()=>process.exit(0));};
  process.stdin.on('error',()=>emit({status:'fallback_required'}));
  process.stdin.on('data',chunk=>{if(done)return;bytes+=chunk.length;if(bytes>65536){chunks=[];emit({status:'fallback_required'});return;}chunks.push(chunk);});
  process.stdin.on('end',async()=>{
    if(done)return;
    try{
      const value=JSON.parse(Buffer.concat(chunks).toString('utf8'));
      if(!value||typeof value!=='object'||Array.isArray(value))throw Error('Expected JSON object');
      const {session_id,turn_id,cwd,handoff_root,snapshot_path,operation,successor_session_id,caller_session_id}=value;
      emit(await ensureSuccessor({session_id,turn_id,cwd,handoff_root,snapshot_path,operation,successor_session_id,caller_session_id},{timeoutMs:5000}));
    }catch{emit({status:'fallback_required'});}
  });
}

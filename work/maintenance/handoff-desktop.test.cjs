'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),crypto=require('node:crypto');
const {saveCheckpoint}=require('./handoff-store.cjs');
/**
 * Run the adapter with an injected app and isolated policy disabling live automation/navigation; synthetic creation remains available to the fake app.
 */
const ensureSuccessor=(input,options)=>isolatedAdapter({home:options.codexHome,app:options.app},{enabled:false,navigate:false}).ensureSuccessor(input,options);
/**
 * Return the SHA-256 of fixture bytes for controlled integrity assertions.
 */
const hash=b=>crypto.createHash('sha256').update(b).digest('hex');
/**
 * Create synthetic checkpoints, transcript copies and a counted fake app transport in temporary directories; return controls for identity, visibility and failure scenarios.
 */
function fixture(t,{session=crypto.randomUUID(),checkpointSession=session,central=false,sharedRoot,projectId='Fixture',checkpointWorkspace=false,checkpointRepository=false,bindTask=true,inheritedReview=false}={}){
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'thehive-desktop-fixture-'));
  t.after(()=>{assert.ok(path.resolve(dir).startsWith(path.resolve(os.tmpdir())+path.sep));fs.rmSync(dir,{recursive:true,force:true});});
  const cwd=central?path.join(dir,'workspace'):dir;
  fs.mkdirSync(cwd,{recursive:true});
  const root=sharedRoot||path.join(dir,central?'central':'work','handoff'),home=path.join(dir,'codex'),turn=crypto.randomUUID();
  const git={};
  if(checkpointWorkspace)git.workspace=checkpointWorkspace===true?cwd:checkpointWorkspace;
  if(checkpointRepository)git.repository=checkpointRepository===true?cwd:checkpointRepository;
  const cp=saveCheckpoint(root,{format_version:1,project_id:projectId,session_id:checkpointSession,expected_parent:null,...(bindTask?{chat_task:{source_ref:'human',next_step:{text:'Continue fixture work',success_criterion:'Fixture result'}}}:{}),patch:{goal:'PRIVATE_FULL_FIXTURE_MUST_NOT_ENTER_START',status:'planned',last_section:'Fixture',sources:{human:{reference:'Offline fixture only'},...(inheritedReview?{manual_context_review:{path:path.join(dir,'previous-transcript.jsonl'),sha256:'a'.repeat(64)}}:{})},...(Object.keys(git).length?{git}:{}),next_step:{text:'Continue fixture work',success_criterion:'Fixture result'}}});
  const snapshot=path.join(home,'handoff-snapshots',session,'context-fixture');fs.mkdirSync(snapshot,{recursive:true});
  const working=fs.readFileSync(cp.file),transcript=Buffer.from(JSON.stringify({type:'session_meta',payload:{id:session,source:'cli'}})+'\n'+JSON.stringify({type:'response_item',payload:{type:'message',role:'user',content:[{type:'input_text',text:'Offline fixture request'}]}})+'\n');
  const source=path.join(home,'sessions','rollout-'+session+'.jsonl');fs.mkdirSync(path.dirname(source),{recursive:true});fs.writeFileSync(source,transcript);
  fs.writeFileSync(path.join(snapshot,'working.md'),working);fs.writeFileSync(path.join(snapshot,'transcript.jsonl'),transcript);
  fs.writeFileSync(path.join(snapshot,'manifest.json'),JSON.stringify({status:'PASS',session_id:session,project_id:projectId,checkpoint_id:cp.checkpoint_id,trigger:'context_usage',context_usage:{used_tokens:800,limit_tokens:1000,threshold_percent:80},working_state:{file:'working.md',bytes:working.length,sha256:hash(working)},transcript:{source,file:'transcript.jsonl',bytes:transcript.length,sha256:hash(transcript)}}));
  const input={session_id:session,turn_id:turn,cwd,snapshot_path:snapshot,handoff_root:root};
  const child=crypto.randomUUID(),project=crypto.randomUUID();let creates=0,catalogReads=0,navigations=0,archives=0,restores=0,mode='normal',threads=[{threadId:session}];
  const app={async listTools(){return ['list_projects','list_threads','create_thread','navigate_to_codex_page','read_thread','set_thread_archived'].map(name=>({name,namespace:'fixture'}));},async callAppTool({tool,args}){
    if(tool.name==='list_projects')return {projects:[{projectId:project,projectKind:'local',path:cwd,hostId:'local'},...(mode==='ambiguous'?[{projectId:crypto.randomUUID(),projectKind:'local',path:cwd,hostId:'local'}]:[])]};
    if(tool.name==='list_threads'){catalogReads++;return {threads};}
    if(tool.name==='navigate_to_codex_page'){assert.deepEqual(args,{threadId:child});navigations++;return {status:'ok'};}
    if(tool.name==='read_thread')return {thread:{id:args.threadId,cwd,status:{type:mode==='origin_active'?'active':'idle'}}};
    if(tool.name==='set_thread_archived'){assert.equal(args.threadId,session);if(args.archived)archives++;else restores++;return {threadId:session,archived:args.archived};}
    assert.equal(tool.name,'create_thread');creates++;
    assert.deepEqual(args.target,{type:'project',projectId:project,environment:{type:'local'}});
    const starter=args.prompt.split('\n');
    assert.equal(starter.length,3);assert.equal(starter[0],'Projekt-ID: '+projectId);
    assert.equal(starter[2],'Naechster offener Arbeitsschritt: Continue fixture work');
    assert.ok(starter[1].startsWith('Handoff-Datei: '));
    const pinned=starter[1].slice('Handoff-Datei: '.length);
    const metadata=require('./handoff-format.cjs').parseMarkdown(fs.readFileSync(pinned,'utf8')).metadata;
    assert.equal(metadata.checkpoint_id,cp.checkpoint_id);assert.equal(metadata.session_id,session);
    assert.ok(!args.prompt.includes('PRIVATE_FULL_FIXTURE'));
    if(mode==='timeout'||mode==='timeout_visible'){
      if(mode==='timeout_visible')threads.push({threadId:child,title:args.title,projectId:project});
      const e=Error('fixture timeout');e.requestMayHaveBeenSent=true;throw e;
    }
    if(mode==='malformed')return {accepted:true};
    if(mode!=='not_visible')threads.push({threadId:child,title:args.title,projectId:project});
    return {threadId:child,hostId:'local'};
  },decodeToolResult:v=>v};
  return {input,home,root,session,cp,app,child,project,threads,source,archives:()=>archives,restores:()=>restores,creates:()=>creates,catalogReads:()=>catalogReads,navigations:()=>navigations,mode:v=>mode=v};
}
test('verified snapshot creates exactly one minimal successor and reuses it',async t=>{
  const f=fixture(t);const a=await ensureSuccessor(f.input,{app:f.app,codexHome:f.home});
  assert.equal(a.status,'successor_visible');assert.equal(a.successor_thread_id,f.child);
  const b=await ensureSuccessor(f.input,{app:f.app,codexHome:f.home});assert.equal(b.successor_thread_id,f.child);assert.equal(f.creates(),1);
});
test('legacy unbound order blocks new creation but preserves a known successor',async t=>{
  const f=fixture(t,{bindTask:false});
  const blocked=await ensureSuccessor(f.input,{app:f.app,codexHome:f.home});
  assert.equal(blocked.reason_code,'chat_task_unbound');assert.equal(f.creates(),0);
  fs.writeFileSync(path.join(f.root,f.session+'-status.json'),JSON.stringify({phase:'successor_created',originThreadId:f.session,successorThreadId:f.child,projectId:f.project,project_id:'Fixture'}));
  f.threads.push({threadId:f.child,projectId:f.project});
  const recovered=await ensureSuccessor(f.input,{app:f.app,codexHome:f.home});
  assert.equal(recovered.status,'successor_visible');assert.equal(recovered.successor_thread_id,f.child);assert.equal(f.creates(),0);
});
test('unknown creation outcome gets one catalog reconciliation and never blindly retries',async t=>{
  const f=fixture(t);f.mode('timeout');
  assert.equal((await ensureSuccessor(f.input,{app:f.app,codexHome:f.home})).status,'creation_unknown');
  assert.equal(f.catalogReads(),2);
  assert.equal((await ensureSuccessor(f.input,{app:f.app,codexHome:f.home})).status,'creation_unknown');assert.equal(f.creates(),1);assert.equal(f.catalogReads(),2);
});
test('unrecognized successful response cannot cause a second creation',async t=>{
  const f=fixture(t);f.mode('malformed');
  assert.equal((await ensureSuccessor(f.input,{app:f.app,codexHome:f.home})).status,'creation_unknown');
  await ensureSuccessor(f.input,{app:f.app,codexHome:f.home});assert.equal(f.creates(),1);
});
test('ambiguous local project never creates a chat',async t=>{
  const f=fixture(t);f.mode('ambiguous');
  const result=await ensureSuccessor(f.input,{app:f.app,codexHome:f.home});assert.equal(result.status,'fallback_required');assert.equal(f.creates(),0);
});
test('a known ID not yet visible is preserved without replacement',async t=>{
  const f=fixture(t);f.mode('not_visible');
  const a=await ensureSuccessor(f.input,{app:f.app,codexHome:f.home});assert.equal(a.status,'successor_created');assert.equal(a.successor_thread_id,f.child);
  await ensureSuccessor(f.input,{app:f.app,codexHome:f.home});assert.equal(f.creates(),1);
});
test('corrupt or below-threshold snapshot never reaches creation',async t=>{
  const f=fixture(t);fs.writeFileSync(path.join(f.input.snapshot_path,'working.md'),'Corrupt fixture');
  assert.equal((await ensureSuccessor(f.input,{app:f.app,codexHome:f.home})).status,'fallback_required');assert.equal(f.creates(),0);
});

test('sessions sharing the first eight UUID characters cannot reuse each others successor',async t=>{
  const f=fixture(t,{session:'01a17abc-0000-7000-8000-000000000001'}),foreign=crypto.randomUUID();
  f.threads.push({threadId:foreign,title:'Fixture – Fortsetzung 01a17abc',projectId:f.project});
  const result=await ensureSuccessor(f.input,{app:f.app,codexHome:f.home});
  assert.equal(result.successor_thread_id,f.child);assert.equal(f.creates(),1);
  assert.equal(f.threads.at(-1).title,'Fixture – Fortsetzung 01a17abc-0000-7000-8000-000000000001');
});

test('a lost creation response recovers the full-origin successor from one catalog check',async t=>{
  const f=fixture(t);f.mode('timeout_visible');
  const result=await ensureSuccessor(f.input,{app:f.app,codexHome:f.home});
  assert.equal(result.status,'successor_visible');assert.equal(result.successor_thread_id,f.child);
  assert.equal(f.catalogReads(),2);assert.equal(f.creates(),1);
});

test('a durable intent recovers only its full origin and exact project without creating',async t=>{
  const f=fixture(t,{session:'01a17abc-0000-7000-8000-000000000001'}),title='Fixture – Fortsetzung '+f.session;
  fs.writeFileSync(path.join(f.root,f.session+'-status.json'),JSON.stringify({phase:'creation_intent',originThreadId:f.session,repositoryPath:f.input.cwd,checkpointId:f.cp.checkpoint_id,projectId:f.project,successorTitle:title,handoffFile:f.cp.file}));
  f.threads.push({threadId:crypto.randomUUID(),title:'Fixture – Fortsetzung 01a17abc-0000-7000-8000-000000000002',projectId:f.project});
  f.threads.push({threadId:crypto.randomUUID(),title,projectId:crypto.randomUUID()});
  f.threads.push({threadId:f.child,title,projectId:f.project});
  const result=await ensureSuccessor(f.input,{app:f.app,codexHome:f.home});
  assert.equal(result.successor_thread_id,f.child);assert.equal(result.status,'successor_visible');
  assert.equal(f.catalogReads(),1);assert.equal(f.creates(),0);
});

test('a failed reconciliation is durably attempted once and cannot start another creation',async t=>{
  const f=fixture(t),original=f.app.callAppTool;let catalogAttempts=0;
  f.mode('timeout');f.app.callAppTool=async call=>{
    if(call.tool.name==='list_threads'&&++catalogAttempts===2)throw Error('isolated catalog unavailable');
    return original(call);
  };
  assert.equal((await ensureSuccessor(f.input,{app:f.app,codexHome:f.home})).status,'creation_unknown');
  await ensureSuccessor(f.input,{app:f.app,codexHome:f.home});
  assert.equal(catalogAttempts,2);assert.equal(f.creates(),1);
});

test('one deadline includes tool discovery and never creates after discovery finishes late',async t=>{
  const f=fixture(t),original=f.app.listTools;
  let discoveryStarted;
  f.app.listTools=async()=>{discoveryStarted=performance.now();await new Promise(resolve=>setTimeout(resolve,120));return original();};
  const result=await ensureSuccessor(f.input,{app:f.app,codexHome:f.home,timeoutMs:30});
  assert.equal(result.status,'fallback_required');assert.equal(f.creates(),0);
  assert.ok(performance.now()-discoveryStarted<100,'discovery must obey the total deadline');
  await new Promise(resolve=>setTimeout(resolve,140));assert.equal(f.creates(),0);
});

test('all pipe calls share the remaining budget and catalog requests fit the existing schema',async t=>{
  const f=fixture(t),originalList=f.app.listTools,originalCall=f.app.callAppTool,limits=[];
  let releaseCatalog;const catalogReady=new Promise(resolve=>releaseCatalog=resolve);
  f.app.listTools=async options=>{limits.push(options?.timeoutMs);await new Promise(resolve=>setTimeout(resolve,25));return originalList();};
  f.app.callAppTool=async call=>{
    limits.push(call.timeoutMs);
    if(call.tool.name==='list_threads'){assert.ok(call.args.limit<=50);await catalogReady;}
    else await new Promise(resolve=>setTimeout(resolve,25));
    return originalCall(call);
  };
  // Leave room for Windows timer granularity; deliberately hold the catalog past the deadline.
  const result=await ensureSuccessor(f.input,{app:f.app,codexHome:f.home,timeoutMs:250});
  assert.equal(result.status,'fallback_required');assert.equal(f.creates(),0);
  assert.equal(limits.length,4);assert.ok(limits.every((value,index)=>Number.isInteger(value)&&value>0&&value<=250&&(index===0||value<limits[index-1])));
  releaseCatalog();await new Promise(setImmediate);assert.equal(f.creates(),0);
});

test('a stored successor ID survives failure of a later tool catalog lookup',async t=>{
  const f=fixture(t);f.mode('not_visible');
  await ensureSuccessor(f.input,{app:f.app,codexHome:f.home});
  f.app.listTools=async()=>{throw Error('isolated discovery failure');};
  const result=await ensureSuccessor(f.input,{app:f.app,codexHome:f.home});
  assert.equal(result.successor_thread_id,f.child);assert.equal(result.status,'successor_created');assert.equal(f.creates(),1);
});

test('foreign journal identity cannot preserve or expose its successor ID',async t=>{
  const f=fixture(t);
  fs.writeFileSync(path.join(f.root,f.session+'-status.json'),JSON.stringify({originThreadId:crypto.randomUUID(),successorThreadId:f.child}));
  const result=await ensureSuccessor(f.input,{app:f.app,codexHome:f.home});
  assert.equal(result.status,'fallback_required');assert.equal(result.successor_thread_id,undefined);assert.equal(f.creates(),0);
});

test('a known successor wins over an already attempted uncertain phase',async t=>{
  const f=fixture(t);f.mode('not_visible');await ensureSuccessor(f.input,{app:f.app,codexHome:f.home});
  const journal=path.join(f.root,f.session+'-status.json'),state=JSON.parse(fs.readFileSync(journal,'utf8'));
  fs.writeFileSync(journal,JSON.stringify({...state,phase:'creation_unknown',reconciliationAttemptedAt:new Date().toISOString()}));
  f.app.listTools=async()=>{throw Error('isolated discovery failure');};
  const result=await ensureSuccessor(f.input,{app:f.app,codexHome:f.home});
  assert.equal(result.successor_thread_id,f.child);assert.equal(result.status,'successor_created');assert.equal(f.creates(),1);
});

test('the origin lock remains held while an unknown result is reconciled',async t=>{
  const f=fixture(t),original=f.app.callAppTool;let reads=0,release,entered;
  const reconciling=new Promise(resolve=>entered=resolve);f.mode('timeout');
  f.app.callAppTool=async call=>{
    if(call.tool.name==='list_threads'&&++reads===2){entered();await new Promise(resolve=>release=resolve);}
    return original(call);
  };
  const first=ensureSuccessor(f.input,{app:f.app,codexHome:f.home});await reconciling;
  let second;try{second=await ensureSuccessor(f.input,{app:f.app,codexHome:f.home});}finally{release();await first;}
  assert.equal(second.status,'fallback_required');assert.equal(f.creates(),1);
});

/**
 * Evaluate the adapter with injected policy/filesystem/process/app fixtures; optional CLI mode captures stdin/stdout without contacting the live desktop.
 */
function isolatedAdapter(f,policy,{cli=false,realpathSync,callerSessionId}={}){
  const adapter=path.join(__dirname,'handoff-desktop.cjs'),policyFile=path.join(__dirname,'handoff-automation-policy.json');
  const policyFs={...fs,...(realpathSync?{realpathSync}:{}),statSync(file,...args){if(path.resolve(file)===policyFile)return {size:Buffer.byteLength(JSON.stringify(policy))};return fs.statSync(file,...args);},readFileSync(file,options){
    if(path.resolve(file)===policyFile){const bytes=Buffer.from(JSON.stringify(policy));return options==='utf8'?bytes.toString('utf8'):bytes;}
    return fs.readFileSync(file,options);
  }};
  const module={exports:{}},stdin=new (require('node:stream').PassThrough)();let output='',exitCode;
  const processFake={platform:process.platform,env:{CODEX_HOME:f.home,...(callerSessionId?{CODEX_THREAD_ID:callerSessionId}:{})},argv:['node',adapter],stdin,stdout:{write(chunk,done){output+=chunk;if(done)done();return true;}},exit(code){exitCode=code;},exitCode:undefined};
  /**
   * Return injected filesystem/app modules and delegate other dependencies while evaluating the isolated adapter.
   */
  function localRequire(name){if(name==='node:fs')return policyFs;if(name==='./codex-app-pipe.cjs')return f.app;return require(name);}
  localRequire.main=cli?module:{};
  new Function('require','module','__dirname','process',fs.readFileSync(adapter,'utf8'))(localRequire,module,__dirname,processFake);
  return {...module.exports,async run(body){stdin.end(body);await new Promise(resolve=>setTimeout(resolve,100));return {output,exitCode};}};
}
/**
 * Return the exact fixture project/workspace/store binding accepted by the injected adapter.
 */
const bindingFor=f=>({Fixture:{workspace:f.input.cwd,handoff_root:f.root}});

test('manual review accepts equivalent local path separators but rejects another file or hash',async t=>{
  for(const variant of ['equivalent','foreign','hash']){
    const f=fixture(t,{checkpointWorkspace:true});
    const manifest=JSON.parse(fs.readFileSync(path.join(f.input.snapshot_path,'manifest.json')));
    const auth={origin_session_id:f.session,successor_session_id:f.child,checkpoint_id:f.cp.checkpoint_id,snapshot_path:f.input.snapshot_path,original_snapshot_bytes:manifest.transcript.bytes};
    fs.writeFileSync(path.join(f.input.snapshot_path,'manual-authorization.json'),JSON.stringify(auth));
    const transcript=path.join(f.input.snapshot_path,'transcript.jsonl');
    const reviewed=variant==='foreign'?f.source:transcript.replaceAll('\\','/');
    saveCheckpoint(f.root,{format_version:1,project_id:'Fixture',session_id:f.child,expected_parent:f.cp.checkpoint_id,chat_task:{source_ref:'human',next_step:{text:'Confirm manual uptake',success_criterion:'Guarded archive'}},patch:{sources:{manual_context_review:{path:reviewed,sha256:variant==='hash'?'0'.repeat(64):manifest.transcript.sha256}}}});
    fs.writeFileSync(path.join(f.root,f.session+'-status.json'),JSON.stringify({originThreadId:f.session,successorThreadId:f.child,projectId:f.project,project_id:'Fixture',repositoryPath:f.input.cwd,handoffRoot:f.root,checkpointId:f.cp.checkpoint_id,handoffFile:f.cp.file,phase:'successor_visible',manualAuthorization:auth,automationCancelledAt:new Date().toISOString()}));
    f.threads.push({threadId:f.child,projectId:f.project});
    const adapter=isolatedAdapter(f,{enabled:true,navigate:false,archive_after_takeover:true,cancel_on_new_user_message:true,projects:bindingFor(f)});
    const result=await adapter.ensureSuccessor({...f.input,operation:'confirm_takeover',successor_session_id:f.child},{app:f.app,codexHome:f.home});
    assert.equal(result.status,variant==='equivalent'?'archived_after_takeover':'fallback_required');
    assert.equal(f.archives(),variant==='equivalent'?1:0);
  }
});


test('session-bound manual review preserves an inherited source and still rejects wrong path or hash',async t=>{
  for(const variant of ['equivalent','foreign','hash']){
    const f=fixture(t,{checkpointWorkspace:true,inheritedReview:true});
    const manifest=JSON.parse(fs.readFileSync(path.join(f.input.snapshot_path,'manifest.json')));
    const auth={origin_session_id:f.session,successor_session_id:f.child,checkpoint_id:f.cp.checkpoint_id,snapshot_path:f.input.snapshot_path,original_snapshot_bytes:manifest.transcript.bytes};
    fs.writeFileSync(path.join(f.input.snapshot_path,'manual-authorization.json'),JSON.stringify(auth));
    const transcript=path.join(f.input.snapshot_path,'transcript.jsonl');
    const reviewed=variant==='foreign'?f.source:transcript.replaceAll('\\','/');
    saveCheckpoint(f.root,{format_version:1,project_id:'Fixture',session_id:f.child,expected_parent:f.cp.checkpoint_id,chat_task:{source_ref:'human',next_step:{text:'Confirm manual uptake',success_criterion:'Guarded archive'}},patch:{sources:{['manual_context_review_'+f.child]:{path:reviewed,sha256:variant==='hash'?'0'.repeat(64):manifest.transcript.sha256}}}});
    fs.writeFileSync(path.join(f.root,f.session+'-status.json'),JSON.stringify({originThreadId:f.session,successorThreadId:f.child,projectId:f.project,project_id:'Fixture',repositoryPath:f.input.cwd,handoffRoot:f.root,checkpointId:f.cp.checkpoint_id,handoffFile:f.cp.file,phase:'successor_visible',manualAuthorization:auth,automationCancelledAt:new Date().toISOString()}));
    f.threads.push({threadId:f.child,projectId:f.project});
    const adapter=isolatedAdapter(f,{enabled:true,navigate:false,archive_after_takeover:true,cancel_on_new_user_message:true,projects:bindingFor(f)});
    const result=await adapter.ensureSuccessor({...f.input,operation:'confirm_takeover',successor_session_id:f.child},{app:f.app,codexHome:f.home});
    assert.equal(result.status,variant==='equivalent'?'archived_after_takeover':'fallback_required');
    assert.equal(f.archives(),variant==='equivalent'?1:0);
  }
});


test('renewed manual review preserves earlier reviews of the same successor',async t=>{
  for(const variant of ['equivalent','foreign','hash']){
    const f=fixture(t,{checkpointWorkspace:true,inheritedReview:true});
    const manifest=JSON.parse(fs.readFileSync(path.join(f.input.snapshot_path,'manifest.json')));
    const auth={origin_session_id:f.session,successor_session_id:f.child,checkpoint_id:f.cp.checkpoint_id,snapshot_path:f.input.snapshot_path,original_snapshot_bytes:manifest.transcript.bytes};
    fs.writeFileSync(path.join(f.input.snapshot_path,'manual-authorization.json'),JSON.stringify(auth));
    const transcript=path.join(f.input.snapshot_path,'transcript.jsonl');
    const reviewed=variant==='foreign'?f.source:transcript.replaceAll('\\','/');
    saveCheckpoint(f.root,{format_version:1,project_id:'Fixture',session_id:f.child,expected_parent:f.cp.checkpoint_id,chat_task:{source_ref:'human',next_step:{text:'Confirm manual uptake',success_criterion:'Guarded archive'}},patch:{sources:{['manual_context_review_'+f.child]:{path:f.source,sha256:'b'.repeat(64)},['manual_context_review_'+f.child+'_'+manifest.transcript.sha256]:{path:reviewed,sha256:variant==='hash'?'0'.repeat(64):manifest.transcript.sha256}}}});
    fs.writeFileSync(path.join(f.root,f.session+'-status.json'),JSON.stringify({originThreadId:f.session,successorThreadId:f.child,projectId:f.project,project_id:'Fixture',repositoryPath:f.input.cwd,handoffRoot:f.root,checkpointId:f.cp.checkpoint_id,handoffFile:f.cp.file,phase:'successor_visible',manualAuthorization:auth,automationCancelledAt:new Date().toISOString()}));
    f.threads.push({threadId:f.child,projectId:f.project});
    const adapter=isolatedAdapter(f,{enabled:true,navigate:false,archive_after_takeover:true,cancel_on_new_user_message:true,projects:bindingFor(f)});
    const result=await adapter.ensureSuccessor({...f.input,operation:'confirm_takeover',successor_session_id:f.child},{app:f.app,codexHome:f.home});
    assert.equal(result.status,variant==='equivalent'?'archived_after_takeover':'fallback_required');
    assert.equal(f.archives(),variant==='equivalent'?1:0);
  }
});

test('an exact trusted project binding permits a central store outside its workspace',async t=>{
  const f=fixture(t,{central:true});
  const result=await ensureSuccessor(f.input,{app:f.app,codexHome:f.home,bindings:bindingFor(f)});
  assert.equal(result.status,'successor_visible');assert.equal(result.successor_thread_id,f.child);assert.equal(f.creates(),1);
  const journal=JSON.parse(fs.readFileSync(path.join(f.root,f.session+'-status.json'),'utf8'));
  assert.equal(journal.repositoryPath,fs.realpathSync(f.input.cwd));assert.equal(journal.handoffRoot,fs.realpathSync(f.root));
});

test('unregistered, wrong-workspace and wrong-store bindings never reach the app',async t=>{
  for(const bindings of [{},{Fixture:{workspace:os.tmpdir(),handoff_root:'root'}},{Fixture:{workspace:'cwd',handoff_root:os.tmpdir()}}]){
    const f=fixture(t,{central:true});
    if(bindings.Fixture?.workspace==='cwd')bindings.Fixture.workspace=f.input.cwd;
    if(bindings.Fixture?.handoff_root==='root')bindings.Fixture.handoff_root=f.root;
    let calls=0;f.app.listTools=async()=>{calls++;return [];};
    assert.equal((await ensureSuccessor(f.input,{app:f.app,codexHome:f.home,bindings})).status,'fallback_required');assert.equal(calls,0);
  }
  const f=fixture(t,{central:true});assert.equal((await ensureSuccessor(f.input,{app:f.app,codexHome:f.home})).status,'fallback_required');assert.equal(f.creates(),0);
});

test('a snake-case journal reuses its known successor and app project without creating',async t=>{
  const f=fixture(t);
  fs.writeFileSync(path.join(f.root,f.session+'-status.json'),JSON.stringify({origin_thread_id:f.session,successor_thread_id:f.child,app_project_id:f.project,project_id:'Fixture',origin_archived:false}));
  f.threads.push({threadId:f.child,projectId:f.project});
  const result=await ensureSuccessor(f.input,{app:f.app,codexHome:f.home});
  assert.equal(result.status,'successor_visible');assert.equal(result.successor_thread_id,f.child);assert.equal(f.creates(),0);
});

test('conflicting journal identity aliases cannot expose an ID or create another successor',async t=>{
  for(const extra of [{originThreadId:crypto.randomUUID()},{successorThreadId:crypto.randomUUID()},{projectId:crypto.randomUUID()}]){
    const f=fixture(t);
    fs.writeFileSync(path.join(f.root,f.session+'-status.json'),JSON.stringify({origin_thread_id:f.session,successor_thread_id:f.child,app_project_id:f.project,project_id:'Fixture',...extra}));
    const result=await ensureSuccessor(f.input,{app:f.app,codexHome:f.home});
    assert.equal(result.status,'fallback_required');assert.equal(result.successor_thread_id,undefined);assert.equal(f.creates(),0);
  }
});

test('operator navigation opens a verified successor once and persists the attempt',async t=>{
  const f=fixture(t),adapter=isolatedAdapter(f,{enabled:true,navigate:true,projects:bindingFor(f)});
  assert.equal((await adapter.ensureSuccessor(f.input,{app:f.app,codexHome:f.home})).successor_thread_id,f.child);
  assert.equal((await adapter.ensureSuccessor(f.input,{app:f.app,codexHome:f.home})).successor_thread_id,f.child);
  assert.equal(f.navigations(),1);assert.equal(f.creates(),1);
  const journal=JSON.parse(fs.readFileSync(path.join(f.root,f.session+'-status.json'),'utf8'));
  assert.ok(journal.navigationAttemptedAt);assert.ok(journal.navigatedAt);assert.equal(journal.successor_thread_id,f.child);
});

test('a new origin turn reopens the same confirmed successor without creating another chat',async t=>{
  const f=fixture(t),adapter=isolatedAdapter(f,{enabled:true,navigate:true,projects:bindingFor(f)});
  await adapter.ensureSuccessor(f.input,{app:f.app,codexHome:f.home});
  const file=path.join(f.root,f.session+'-status.json'),first=JSON.parse(fs.readFileSync(file,'utf8'));
  const next={...f.input,turn_id:crypto.randomUUID()};
  const result=await adapter.ensureSuccessor(next,{app:f.app,codexHome:f.home});
  await adapter.ensureSuccessor(next,{app:f.app,codexHome:f.home});
  await adapter.ensureSuccessor(f.input,{app:f.app,codexHome:f.home});
  assert.equal(result.status,'successor_visible');assert.equal(result.successor_thread_id,f.child);
  assert.equal(f.navigations(),2);assert.equal(f.creates(),1);
  assert.equal(JSON.parse(fs.readFileSync(file,'utf8')).navigationAttemptedAt,first.navigationAttemptedAt);
});

test('a legacy navigation journal permits one new attempt for the current origin turn',async t=>{
  const f=fixture(t),adapter=isolatedAdapter(f,{enabled:true,navigate:true,projects:bindingFor(f)});
  const file=path.join(f.root,f.session+'-status.json'),attemptedAt='2026-10-26T10:00:00.000Z';
  fs.writeFileSync(file,JSON.stringify({origin_thread_id:f.session,successor_thread_id:f.child,app_project_id:f.project,project_id:'Fixture',navigationAttemptedAt:attemptedAt}));
  f.threads.push({threadId:f.child,projectId:f.project});
  await adapter.ensureSuccessor(f.input,{app:f.app,codexHome:f.home});
  await adapter.ensureSuccessor(f.input,{app:f.app,codexHome:f.home});
  assert.equal(f.navigations(),1);assert.equal(f.creates(),0);
  assert.equal(JSON.parse(fs.readFileSync(file,'utf8')).navigationAttemptedAt,attemptedAt);
});

test('an unknown navigation timeout is not retried in the same origin turn',async t=>{
  const f=fixture(t),adapter=isolatedAdapter(f,{enabled:true,navigate:true,projects:bindingFor(f)});
  await adapter.ensureSuccessor(f.input,{app:f.app,codexHome:f.home});
  const original=f.app.callAppTool;
  f.app.callAppTool=async call=>{const result=await original(call);if(call.tool.name==='navigate_to_codex_page')await new Promise(()=>{});return result;};
  const next={...f.input,turn_id:crypto.randomUUID()};
  const failed=await adapter.ensureSuccessor(next,{app:f.app,codexHome:f.home,timeoutMs:250});
  assert.equal(failed.status,'fallback_required');assert.equal(failed.reason_code,'navigation_failed');
  await adapter.ensureSuccessor(next,{app:f.app,codexHome:f.home});
  assert.equal(f.navigations(),2);assert.equal(f.creates(),1);
});

test('a full navigation turn journal keeps its IDs and leaves recovery manual',async t=>{
  const f=fixture(t),adapter=isolatedAdapter(f,{enabled:true,navigate:true,projects:bindingFor(f)});
  const file=path.join(f.root,f.session+'-status.json'),navigationTurnIds=Array.from({length:64},()=>crypto.randomUUID());
  fs.writeFileSync(file,JSON.stringify({origin_thread_id:f.session,successor_thread_id:f.child,app_project_id:f.project,project_id:'Fixture',navigationTurnIds}));
  f.threads.push({threadId:f.child,projectId:f.project});
  assert.equal((await adapter.ensureSuccessor(f.input,{app:f.app,codexHome:f.home})).status,'successor_visible');
  assert.equal(f.navigations(),0);assert.equal(f.creates(),0);
  assert.deepEqual(JSON.parse(fs.readFileSync(file,'utf8')).navigationTurnIds,navigationTurnIds);
});

test('late successor checks preserve verified takeover and archive journal phases',async t=>{
  for(const phase of ['takeover_verified','archived_after_takeover']){
    const f=fixture(t),adapter=isolatedAdapter(f,{enabled:true,navigate:true,projects:bindingFor(f)});
    const file=path.join(f.root,f.session+'-status.json'),takenOverAt='2026-10-26T10:00:00.000Z';
    fs.writeFileSync(file,JSON.stringify({origin_thread_id:f.session,successor_thread_id:f.child,app_project_id:f.project,project_id:'Fixture',phase,takenOverAt,...(phase==='archived_after_takeover'?{archivedAt:takenOverAt}:{})}));
    assert.equal((await adapter.ensureSuccessor(f.input,{app:f.app,codexHome:f.home})).status,'successor_created');
    assert.equal(JSON.parse(fs.readFileSync(file,'utf8')).phase,phase);
    f.threads.push({threadId:f.child,projectId:f.project});
    assert.equal((await adapter.ensureSuccessor(f.input,{app:f.app,codexHome:f.home})).status,'successor_visible');
    const state=JSON.parse(fs.readFileSync(file,'utf8'));
    assert.equal(state.phase,phase);assert.equal(state.takenOverAt,takenOverAt);
    if(phase==='archived_after_takeover')assert.equal(state.archivedAt,takenOverAt);
    assert.equal(f.navigations(),1);assert.equal(f.creates(),0);
  }
});

test('an origin snapshot reopens its taken-over successor after a third project chat advances the checkpoint',async t=>{
  const f=fixture(t,{checkpointWorkspace:true}),adapter=isolatedAdapter(f,globalPolicy(f));
  await adapter.ensureSuccessor(f.input,{app:f.app,codexHome:f.home});
  const file=path.join(f.root,f.session+'-status.json'),state=JSON.parse(fs.readFileSync(file,'utf8'));
  fs.writeFileSync(file,JSON.stringify({...state,phase:'archived_after_takeover'}));
  const first=saveCheckpoint(f.root,{format_version:1,project_id:'Fixture',session_id:f.child,expected_parent:f.cp.checkpoint_id,patch:{last_section:'Successor checkpoint'}});
  saveCheckpoint(f.root,{format_version:1,project_id:'Fixture',session_id:crypto.randomUUID(),expected_parent:first.checkpoint_id,patch:{last_section:'Another project chat checkpoint'}});
  const result=await adapter.ensureSuccessor({...f.input,turn_id:crypto.randomUUID()},{app:f.app,codexHome:f.home});
  assert.equal(result.status,'successor_visible');assert.equal(result.successor_thread_id,f.child);
  assert.equal(f.navigations(),2);assert.equal(f.creates(),1);
  assert.equal(JSON.parse(fs.readFileSync(file,'utf8')).phase,'archived_after_takeover');
});

test('an auto PreCompact snapshot without project or checkpoint IDs reopens its bound successor',async t=>{
  const f=fixture(t,{checkpointWorkspace:true}),adapter=isolatedAdapter(f,globalPolicy(f));
  await adapter.ensureSuccessor(f.input,{app:f.app,codexHome:f.home});
  const file=path.join(f.root,f.session+'-status.json'),state=JSON.parse(fs.readFileSync(file,'utf8'));
  fs.writeFileSync(file,JSON.stringify({...state,phase:'archived_after_takeover'}));
  saveCheckpoint(f.root,{format_version:1,project_id:'Fixture',session_id:crypto.randomUUID(),expected_parent:f.cp.checkpoint_id,patch:{last_section:'Another project chat checkpoint'}});
  const manifestFile=path.join(f.input.snapshot_path,'manifest.json');
  const {project_id,checkpoint_id,context_usage,...manifest}=JSON.parse(fs.readFileSync(manifestFile,'utf8'));
  fs.writeFileSync(manifestFile,JSON.stringify({...manifest,trigger:'auto'}));
  const result=await adapter.ensureSuccessor({...f.input,turn_id:crypto.randomUUID()},{app:f.app,codexHome:f.home});
  assert.equal(result.status,'successor_visible');assert.equal(result.successor_thread_id,f.child);
  assert.equal(f.navigations(),2);assert.equal(f.creates(),1);
  assert.equal(JSON.parse(fs.readFileSync(file,'utf8')).phase,'archived_after_takeover');
});

for(const stage of ['list_threads','navigate_to_codex_page'])test('terminal takeover evidence written during '+stage+' survives later desktop saves',async t=>{
  for(const phase of ['takeover_verified','archived_after_takeover']){
    const f=fixture(t),adapter=isolatedAdapter(f,{enabled:true,navigate:true,projects:bindingFor(f)});
    await adapter.ensureSuccessor(f.input,{app:f.app,codexHome:f.home});
    const file=path.join(f.root,f.session+'-status.json'),original=f.app.callAppTool,takenOverAt='2026-10-27T15:04:32.790Z';
    f.app.callAppTool=async call=>{
      const result=await original(call);
      if(call.tool.name===stage){
        const state=JSON.parse(fs.readFileSync(file,'utf8'));
        fs.writeFileSync(file,JSON.stringify({...state,phase,takenOverAt,takeoverEvidence:'verification/offline-takeover.json',...(phase==='archived_after_takeover'?{archivedAt:takenOverAt}:{})}));
      }
      return result;
    };
    await adapter.ensureSuccessor({...f.input,turn_id:crypto.randomUUID()},{app:f.app,codexHome:f.home});
    const state=JSON.parse(fs.readFileSync(file,'utf8'));
    assert.equal(state.phase,phase);assert.equal(state.takenOverAt,takenOverAt);assert.equal(state.takeoverEvidence,'verification/offline-takeover.json');
    if(phase==='archived_after_takeover')assert.equal(state.archivedAt,takenOverAt);
    assert.equal(f.navigations(),2);assert.equal(f.creates(),1);
  }
});

test('a conflicting journal identity written during catalog lookup is preserved without navigation',async t=>{
  for(const aliases of [['originThreadId','origin_thread_id'],['successorThreadId','successor_thread_id'],['projectId','app_project_id']]){
    const f=fixture(t),adapter=isolatedAdapter(f,{enabled:true,navigate:true,projects:bindingFor(f)});
    await adapter.ensureSuccessor(f.input,{app:f.app,codexHome:f.home});
    const file=path.join(f.root,f.session+'-status.json'),original=f.app.callAppTool,foreign=crypto.randomUUID();
    f.app.callAppTool=async call=>{
      const result=await original(call);
      if(call.tool.name==='list_threads'){
        const state=JSON.parse(fs.readFileSync(file,'utf8'));
        fs.writeFileSync(file,JSON.stringify({...state,phase:'takeover_verified',[aliases[0]]:foreign,[aliases[1]]:foreign,takeoverEvidence:'verification/foreign-takeover.json'}));
      }
      return result;
    };
    const result=await adapter.ensureSuccessor({...f.input,turn_id:crypto.randomUUID()},{app:f.app,codexHome:f.home});
    assert.equal(result.status,'successor_created');
    const state=JSON.parse(fs.readFileSync(file,'utf8'));
    assert.equal(state[aliases[0]],foreign);assert.equal(state[aliases[1]],foreign);assert.equal(state.phase,'takeover_verified');
    assert.equal(state.takeoverEvidence,'verification/foreign-takeover.json');assert.equal(f.navigations(),1);assert.equal(f.creates(),1);
  }
});

test('advanced recovery refuses invalid origin, ancestry, project, workspace or catalog bindings',async t=>{
  for(const damage of ['origin_session','unrelated_snapshot','ancestor','project','workspace','catalog','manifest_project','manifest_checkpoint']){
    const f=fixture(t,{checkpointWorkspace:true,...(damage==='origin_session'?{checkpointSession:crypto.randomUUID()}:{})}),adapter=isolatedAdapter(f,globalPolicy(f));
    const file=path.join(f.root,f.session+'-status.json');
    const state={originThreadId:f.session,successorThreadId:f.child,projectId:f.project,project_id:'Fixture',checkpointId:f.cp.checkpoint_id,repositoryPath:f.input.cwd,handoffRoot:f.root,phase:'takeover_verified'};
    fs.writeFileSync(file,JSON.stringify({...state,...(damage==='project'?{project_id:'Other'}:{})}));
    f.threads.push({threadId:f.child,projectId:damage==='catalog'?crypto.randomUUID():f.project});
    const origin=JSON.parse(fs.readFileSync(path.join(f.root,'index.json'),'utf8')).projects.Fixture.state_file;
    const first=saveCheckpoint(f.root,{format_version:1,project_id:'Fixture',session_id:f.child,expected_parent:f.cp.checkpoint_id,patch:{last_section:'Successor checkpoint'}});
    saveCheckpoint(f.root,{format_version:1,project_id:'Fixture',session_id:crypto.randomUUID(),expected_parent:first.checkpoint_id,patch:{last_section:'Later checkpoint',...(damage==='workspace'?{git:{workspace:os.tmpdir()}}:{})}});
    if(damage==='ancestor')fs.appendFileSync(path.join(f.root,origin),'\n');
    if(damage==='unrelated_snapshot'){
      const orphan=saveCheckpoint(path.join(f.home,'orphan'),{format_version:1,project_id:'Fixture',session_id:f.session,expected_parent:null,patch:{goal:'Unrelated branch',status:'planned',last_section:'Orphan',sources:{human:{reference:'Offline fixture only'}},next_step:{text:'Unrelated action',success_criterion:'Unrelated result'}}});
      const working=fs.readFileSync(orphan.file),manifestFile=path.join(f.input.snapshot_path,'manifest.json'),manifest=JSON.parse(fs.readFileSync(manifestFile,'utf8'));
      fs.writeFileSync(path.join(f.input.snapshot_path,'working.md'),working);
      fs.writeFileSync(manifestFile,JSON.stringify({...manifest,checkpoint_id:orphan.checkpoint_id,working_state:{file:'working.md',bytes:working.length,sha256:hash(working)}}));
      fs.writeFileSync(file,JSON.stringify({...state,checkpointId:orphan.checkpoint_id}));
    }
    if(damage.startsWith('manifest_')){
      const manifestFile=path.join(f.input.snapshot_path,'manifest.json'),manifest=JSON.parse(fs.readFileSync(manifestFile,'utf8'));
      if(damage==='manifest_project')manifest.project_id='Other';else manifest.checkpoint_id='0'.repeat(64);
      fs.writeFileSync(manifestFile,JSON.stringify(manifest));
    }
    const result=await adapter.ensureSuccessor({...f.input,turn_id:crypto.randomUUID()},{app:f.app,codexHome:f.home});
    assert.equal(result.status,damage==='catalog'?'successor_created':'fallback_required');
    assert.equal(result.successor_thread_id,damage==='catalog'?f.child:undefined);
    assert.equal(f.navigations(),0);assert.equal(f.creates(),0);
  }
});

test('an unconfirmed or foreign-project known successor is preserved without navigation',async t=>{
  for(const mode of ['foreign','missing']){
    const f=fixture(t),adapter=isolatedAdapter(f,{enabled:true,navigate:true,projects:bindingFor(f)});
    const journal=path.join(f.root,f.session+'-status.json');
    fs.writeFileSync(journal,JSON.stringify({origin_thread_id:f.session,successor_thread_id:f.child,app_project_id:f.project,project_id:'Fixture'}));
    if(mode==='foreign')f.threads.push({threadId:f.child,projectId:crypto.randomUUID()});
    const result=await adapter.ensureSuccessor(f.input,{app:f.app,codexHome:f.home});
    assert.equal(result.status,'successor_created');assert.equal(result.successor_thread_id,f.child);
    assert.equal(f.navigations(),0);assert.equal(f.creates(),0);assert.equal(f.catalogReads(),1);
    assert.equal(JSON.parse(fs.readFileSync(journal,'utf8')).navigationAttemptedAt,undefined);
    f.threads.splice(1,f.threads.length-1,{threadId:f.child,projectId:f.project});
    assert.equal((await adapter.ensureSuccessor(f.input,{app:f.app,codexHome:f.home})).status,'successor_visible');
    await adapter.ensureSuccessor(f.input,{app:f.app,codexHome:f.home});
    assert.equal(f.navigations(),1);assert.equal(f.creates(),0);
  }
});

test('the JSON CLI uses only operator project bindings and returns one compact status',async t=>{
  const f=fixture(t,{central:true}),adapter=isolatedAdapter(f,{enabled:true,navigate:false,cancel_on_new_user_message:true,projects:bindingFor(f)},{cli:true});
  const list=f.app.listTools;let discoveryBudget;
  f.app.listTools=async options=>{discoveryBudget=options.timeoutMs;return list();};
  const body=JSON.stringify({...f.input,bindings:{},policy:{enabled:false}});
  const result=await adapter.run(body+' '.repeat(65536-Buffer.byteLength(body)));
  assert.deepEqual(JSON.parse(result.output||'null'),{status:'successor_visible',successor_thread_id:f.child});
  assert.equal(result.output.trim().split('\n').length,1);assert.equal(result.exitCode,0);assert.equal(f.creates(),1);
  assert.ok(discoveryBudget>0&&discoveryBudget<=5000);
});

test('the JSON CLI rejects malformed, non-object and oversized stdin without app calls',async t=>{
  for(const body of ['{','[]','null',' '.repeat(65537),JSON.stringify({padding:'x'.repeat(65536)})]){
    const f=fixture(t);let calls=0;f.app.listTools=async()=>{calls++;return [];};
    const adapter=isolatedAdapter(f,{enabled:true,navigate:true,projects:bindingFor(f)},{cli:true});
    const result=await adapter.run(body);
    assert.deepEqual(JSON.parse(result.output||'null'),{status:'fallback_required'});assert.equal(calls,0);
  }
  const child=require('node:child_process').spawnSync(process.execPath,[path.join(__dirname,'handoff-desktop.cjs')],{input:'[]',encoding:'utf8',timeout:2000});
  assert.equal(child.status,0);assert.equal(child.stderr,'');assert.deepEqual(JSON.parse(child.stdout),{status:'fallback_required'});
});

test('stdin cannot enable a paused operator policy or inject project bindings',async t=>{
  const f=fixture(t,{central:true}),adapter=isolatedAdapter(f,{enabled:false,navigate:false,projects:{}},{cli:true});
  const result=await adapter.run(JSON.stringify({...f.input,enabled:true,scope:'all_local_projects',projects:bindingFor(f),bindings:bindingFor(f)}));
  assert.deepEqual(JSON.parse(result.output||'null'),{status:'fallback_required'});assert.equal(f.creates(),0);
});

/**
 * Return an enabled all-local-projects fixture policy bound to this temporary handoff root.
 */
const globalPolicy=f=>({enabled:true,navigate:true,cancel_on_new_user_message:true,scope:'all_local_projects',handoff_root:f.root});
/**
 * Return the fixture policy with freshness cancellation and takeover archival enabled while navigation stays disabled.
 */
const conditionalPolicy=f=>({...globalPolicy(f),navigate:false,cancel_on_new_user_message:true,archive_after_takeover:true});

test('busy origin schedules completion; verified uptake survives later project checkpoints',async t=>{
  const f=fixture(t,{checkpointWorkspace:true}),adapter=isolatedAdapter(f,conditionalPolicy(f));
  await adapter.ensureSuccessor(f.input,{app:f.app,codexHome:f.home});
  saveCheckpoint(f.root,{format_version:1,project_id:'Fixture',session_id:f.child,expected_parent:f.cp.checkpoint_id,patch:{last_section:'Successor uptake'}});
  f.mode('origin_active');let scheduled=0;
  const input={...f.input,operation:'confirm_takeover',successor_session_id:f.child};
  const pending=await adapter.ensureSuccessor(input,{app:f.app,codexHome:f.home,schedulePending:()=>scheduled++});
  assert.equal(pending.archive_pending_reason,'origin_busy');assert.equal(scheduled,1);assert.equal(f.archives(),0);
  const current=require('./handoff-store.cjs').resumeProject(f.root,'Fixture');
  saveCheckpoint(f.root,{format_version:1,project_id:'Fixture',session_id:crypto.randomUUID(),expected_parent:current.checkpoint_id,patch:{last_section:'Parallel chat progress'}});
  f.mode('normal');
  const result=await adapter.ensureSuccessor({...input,operation:'resume_archive',caller_session_id:f.child},{app:f.app,codexHome:f.home});
  assert.equal(result.status,'archived_after_takeover');assert.equal(f.archives(),1);assert.equal(f.creates(),1);
  await adapter.ensureSuccessor({...input,operation:'resume_archive',caller_session_id:f.child},{app:f.app,codexHome:f.home});
  assert.equal(f.archives(),1);
});

for(const fault of ['new_message','proof_changed','missing_uptake','wrong_caller'])test('deferred completion blocks '+fault,async t=>{
  const f=fixture(t,{checkpointWorkspace:true}),adapter=isolatedAdapter(f,conditionalPolicy(f));
  await adapter.ensureSuccessor(f.input,{app:f.app,codexHome:f.home});
  saveCheckpoint(f.root,{format_version:1,project_id:'Fixture',session_id:f.child,expected_parent:f.cp.checkpoint_id,patch:{last_section:'Successor uptake'}});
  f.mode('origin_active');const input={...f.input,operation:'confirm_takeover',successor_session_id:f.child};
  await adapter.ensureSuccessor(input,{app:f.app,codexHome:f.home});f.mode('normal');
  if(fault==='new_message')appendUser(f);
  const file=path.join(f.input.snapshot_path,'takeover-proof.json');const proof=JSON.parse(fs.readFileSync(file));
  if(fault==='proof_changed')proof.successor_session_id=crypto.randomUUID();
  if(fault==='missing_uptake')proof.checkpoint_examined=proof.origin_checkpoint_id;
  fs.writeFileSync(file,JSON.stringify(proof));
  await adapter.ensureSuccessor({...input,operation:'resume_archive',caller_session_id:fault==='wrong_caller'?crypto.randomUUID():f.child},{app:f.app,codexHome:f.home});
  assert.equal(f.archives(),0);assert.equal(f.creates(),1);
});
/**
 * Append one synthetic user record to the fixture transcript to invalidate its saved freshness boundary.
 */
const appendUser=f=>fs.appendFileSync(f.source,JSON.stringify({type:'response_item',payload:{type:'message',role:'user',content:[{type:'input_text',text:'New offline user request'}]}})+'\n');

test('a persisted message arriving during archive is followed by one restoration of the origin',async t=>{
  const f=fixture(t,{checkpointWorkspace:true}),adapter=isolatedAdapter(f,conditionalPolicy(f)),original=f.app.callAppTool;await adapter.ensureSuccessor(f.input,{app:f.app,codexHome:f.home});
  saveCheckpoint(f.root,{format_version:1,project_id:'Fixture',session_id:f.child,expected_parent:f.cp.checkpoint_id,patch:{last_section:'Successor uptake'}});
  f.app.callAppTool=async call=>{const r=await original(call);if(call.tool.name==='set_thread_archived'&&call.args.archived)appendUser(f);return r;};
  const r=await adapter.ensureSuccessor({...f.input,operation:'confirm_takeover',successor_session_id:f.child,turn_id:crypto.randomUUID()},{app:f.app,codexHome:f.home});
  assert.equal(r.reason_code,'new_user_message_after_snapshot');assert.equal(f.restores(),1);assert.equal(r.origin_restored,true);assert.notEqual(JSON.parse(fs.readFileSync(path.join(f.root,f.session+'-status.json'),'utf8')).phase,'archived_after_takeover');
});

test('an uncertain archive outcome is never blindly requested twice',async t=>{
  const f=fixture(t,{checkpointWorkspace:true}),adapter=isolatedAdapter(f,conditionalPolicy(f)),original=f.app.callAppTool;await adapter.ensureSuccessor(f.input,{app:f.app,codexHome:f.home});
  saveCheckpoint(f.root,{format_version:1,project_id:'Fixture',session_id:f.child,expected_parent:f.cp.checkpoint_id,patch:{last_section:'Successor uptake'}});
  f.app.callAppTool=async call=>{const r=await original(call);if(call.tool.name==='set_thread_archived')throw Error('Unknown archive outcome');return r;};
  const input={...f.input,operation:'confirm_takeover',successor_session_id:f.child,turn_id:crypto.randomUUID()};await adapter.ensureSuccessor(input,{app:f.app,codexHome:f.home});await adapter.ensureSuccessor(input,{app:f.app,codexHome:f.home});assert.equal(f.archives(),1);
});

for(const failure of ['throw','timeout'])test('new input after an uncertain '+failure+' archive gets one bounded restoration',async t=>{
  const f=fixture(t,{checkpointWorkspace:true}),adapter=isolatedAdapter(f,conditionalPolicy(f)),original=f.app.callAppTool;await adapter.ensureSuccessor(f.input,{app:f.app,codexHome:f.home});
  saveCheckpoint(f.root,{format_version:1,project_id:'Fixture',session_id:f.child,expected_parent:f.cp.checkpoint_id,patch:{last_section:'Successor uptake'}});
  f.app.callAppTool=async call=>{const r=await original(call);if(call.tool.name==='set_thread_archived'&&call.args.archived){appendUser(f);if(failure==='timeout')return new Promise(()=>{});throw Error('Lost archive response');}return r;};
  const r=await adapter.ensureSuccessor({...f.input,operation:'confirm_takeover',successor_session_id:f.child,turn_id:crypto.randomUUID()},{app:f.app,codexHome:f.home,timeoutMs:1000});
  assert.equal(r.reason_code,'new_user_message_after_snapshot');assert.equal(r.origin_restored,true);assert.equal(f.restores(),1);assert.equal(f.archives(),1);
});

test('a message arriving during the archive precheck blocks the archive call',async t=>{
  const f=fixture(t,{checkpointWorkspace:true}),adapter=isolatedAdapter(f,conditionalPolicy(f)),original=f.app.callAppTool;await adapter.ensureSuccessor(f.input,{app:f.app,codexHome:f.home});
  saveCheckpoint(f.root,{format_version:1,project_id:'Fixture',session_id:f.child,expected_parent:f.cp.checkpoint_id,patch:{last_section:'Successor uptake'}});
  f.app.callAppTool=async call=>{const r=await original(call);if(call.tool.name==='read_thread')appendUser(f);return r;};
  const r=await adapter.ensureSuccessor({...f.input,operation:'confirm_takeover',successor_session_id:f.child,turn_id:crypto.randomUUID()},{app:f.app,codexHome:f.home});
  assert.equal(r.reason_code,'new_user_message_after_snapshot');assert.equal(f.archives(),0);
});

test('the takeover CLI requires the actual successor session and permits its own verified uptake',async t=>{
  const f=fixture(t,{checkpointWorkspace:true}),adapter=isolatedAdapter(f,conditionalPolicy(f));await adapter.ensureSuccessor(f.input,{app:f.app,codexHome:f.home});
  saveCheckpoint(f.root,{format_version:1,project_id:'Fixture',session_id:f.child,expected_parent:f.cp.checkpoint_id,patch:{last_section:'Successor uptake'}});
  const payload={...f.input,operation:'confirm_takeover',successor_session_id:f.child,turn_id:crypto.randomUUID()};
  const foreign=await isolatedAdapter(f,conditionalPolicy(f),{cli:true,callerSessionId:crypto.randomUUID()}).run(JSON.stringify(payload));assert.equal(JSON.parse(foreign.output).status,'fallback_required');assert.equal(f.archives(),0);
  const own=await isolatedAdapter(f,conditionalPolicy(f),{cli:true,callerSessionId:f.child}).run(JSON.stringify(payload));assert.equal(JSON.parse(own.output).status,'archived_after_takeover');assert.equal(f.archives(),1);
});

test('conditional creation refuses a user message appended after the snapshot',async t=>{
  const f=fixture(t,{checkpointWorkspace:true}),adapter=isolatedAdapter(f,conditionalPolicy(f));appendUser(f);
  const r=await adapter.ensureSuccessor(f.input,{app:f.app,codexHome:f.home});
  assert.equal(f.creates(),0);assert.equal(r.reason_code,'new_user_message_after_snapshot');assert.equal(f.archives(),0);
});

test('acceptance: new message stops automation then explicit manual takeover retains it and archives once',async t=>{
  const f=fixture(t,{checkpointWorkspace:true}),adapter=isolatedAdapter(f,conditionalPolicy(f));
  appendUser(f);
  assert.equal((await adapter.ensureSuccessor(f.input,{app:f.app,codexHome:f.home})).reason_code,'new_user_message_after_snapshot');
  assert.equal(f.creates(),0);assert.equal(f.archives(),0);
  const manualFile=path.join(__dirname,'handoff-manual-start.cjs'),mod={exports:{}};
  /**
   * Return injected filesystem/app modules and delegate other dependencies while evaluating the isolated adapter.
   */
  const localRequire=name=>name==='./codex-app-pipe.cjs'?f.app:require(name);
  localRequire.main={};
  new Function('require','module','process',fs.readFileSync(manualFile,'utf8'))(localRequire,mod,{env:{CODEX_THREAD_ID:f.child,CODEX_HOME:f.home},cwd:()=>f.input.cwd});
  const offer=mod.exports.offerManualStart(f.input,{codexHome:f.home});
  f.threads.push({threadId:f.child,projectId:f.project});
  const accepted=await mod.exports.acceptManualStart({operation:'accept',offer_file:offer.manual_start_file.replace(/\.md$/,'.json'),turn_id:crypto.randomUUID(),human_requested:true});
  assert.equal(accepted.status,'manual_successor_bound');
  assert.deepEqual(fs.readFileSync(accepted.transcript_copy),fs.readFileSync(f.source));
  assert.ok(fs.statSync(accepted.transcript_copy).size>accepted.original_snapshot_bytes);
  const j=JSON.parse(fs.readFileSync(path.join(f.root,f.session+'-status.json')));
  assert.equal(j.automationCancelReason,'new_user_message_after_snapshot');
  const previousHome=process.env.CODEX_HOME;let loaded;
  try{process.env.CODEX_HOME=f.home;loaded=require('./handoff-store.cjs').resumeChatContinuation(f.root,{session_id:f.child,workspace:f.input.cwd,handoff_file:j.handoffFile});}
  finally{if(previousHome===undefined)delete process.env.CODEX_HOME;else process.env.CODEX_HOME=previousHome;}
  assert.equal(loaded.continuation.origin_session_id,f.session);
  saveCheckpoint(f.root,{format_version:1,project_id:'Fixture',session_id:f.child,expected_parent:f.cp.checkpoint_id,chat_task:{source_ref:'human',next_step:{text:'Finish authorized manual takeover',success_criterion:'Archive once after review'}},patch:{sources:{manual_context_review:{path:accepted.transcript_copy,sha256:accepted.sha256,summary:'Entire new user message retained and reviewed'}}}});
  const close={...f.input,operation:'confirm_takeover',successor_session_id:f.child,turn_id:crypto.randomUUID()};
  assert.equal((await adapter.ensureSuccessor(close,{app:f.app,codexHome:f.home})).status,'archived_after_takeover');
  assert.equal((await adapter.ensureSuccessor(close,{app:f.app,codexHome:f.home})).status,'archived_after_takeover');
  assert.equal(f.archives(),1);assert.equal(f.creates(),0);
});

test('a user message during catalog lookup cancels creation and cannot be hidden by a newer snapshot',async t=>{
  const f=fixture(t,{checkpointWorkspace:true}),adapter=isolatedAdapter(f,conditionalPolicy(f)),original=f.app.callAppTool;let injected=false;
  f.app.callAppTool=async call=>{const r=await original(call);if(call.tool.name==='list_threads'&&!injected){injected=true;appendUser(f);}return r;};
  const r=await adapter.ensureSuccessor(f.input,{app:f.app,codexHome:f.home});assert.equal(f.creates(),0);assert.equal(r.reason_code,'new_user_message_after_snapshot');
  const next=f.input.snapshot_path+'-new';fs.mkdirSync(next);for(const name of ['working.md','transcript.jsonl','manifest.json'])fs.copyFileSync(path.join(f.input.snapshot_path,name),path.join(next,name));
  const bytes=fs.readFileSync(f.source),m=JSON.parse(fs.readFileSync(path.join(next,'manifest.json'),'utf8'));fs.writeFileSync(path.join(next,'transcript.jsonl'),bytes);m.transcript={...m.transcript,bytes:bytes.length,sha256:hash(bytes)};fs.writeFileSync(path.join(next,'manifest.json'),JSON.stringify(m));
  const again=await adapter.ensureSuccessor({...f.input,snapshot_path:next,turn_id:crypto.randomUUID()},{app:f.app,codexHome:f.home});assert.equal(f.creates(),0);assert.equal(again.reason_code,'new_user_message_after_snapshot');
});

test('a message during an already sent creation retains its one ID and blocks opening or archival',async t=>{
  const f=fixture(t,{checkpointWorkspace:true}),adapter=isolatedAdapter(f,{...conditionalPolicy(f),navigate:true}),original=f.app.callAppTool;
  f.app.callAppTool=async call=>{const r=await original(call);if(call.tool.name==='create_thread')appendUser(f);return r;};
  const r=await adapter.ensureSuccessor(f.input,{app:f.app,codexHome:f.home});assert.equal(r.successor_thread_id,f.child);assert.equal(r.reason_code,'new_user_message_after_snapshot');assert.equal(f.creates(),1);assert.equal(f.navigations(),0);assert.equal(f.archives(),0);
});

test('only a successor-owned verified checkpoint can confirm uptake and archive a fresh idle origin',async t=>{
  const f=fixture(t,{checkpointWorkspace:true}),adapter=isolatedAdapter(f,conditionalPolicy(f));await adapter.ensureSuccessor(f.input,{app:f.app,codexHome:f.home});
  assert.equal(f.archives(),0);
  saveCheckpoint(f.root,{format_version:1,project_id:'Fixture',session_id:f.child,expected_parent:f.cp.checkpoint_id,patch:{last_section:'Actual successor uptake'}});
  const r=await adapter.ensureSuccessor({...f.input,operation:'confirm_takeover',successor_session_id:f.child,turn_id:crypto.randomUUID()},{app:f.app,codexHome:f.home});
  assert.equal(r.status,'archived_after_takeover');assert.equal(f.archives(),1);assert.equal(f.creates(),1);
  const state=JSON.parse(fs.readFileSync(path.join(f.root,f.session+'-status.json'),'utf8'));assert.equal(state.phase,'archived_after_takeover');assert.ok(state.takeoverEvidence);
});

for(const mode of ['no_checkpoint','wrong_successor','active_origin','new_message'])test('takeover archive refuses '+mode,async t=>{
  const f=fixture(t,{checkpointWorkspace:true}),adapter=isolatedAdapter(f,conditionalPolicy(f));await adapter.ensureSuccessor(f.input,{app:f.app,codexHome:f.home});
  if(mode!=='no_checkpoint')saveCheckpoint(f.root,{format_version:1,project_id:'Fixture',session_id:f.child,expected_parent:f.cp.checkpoint_id,patch:{last_section:'Successor uptake'}});
  if(mode==='active_origin')f.mode('origin_active');if(mode==='new_message')appendUser(f);
  await adapter.ensureSuccessor({...f.input,operation:'confirm_takeover',successor_session_id:mode==='wrong_successor'?crypto.randomUUID():f.child,turn_id:crypto.randomUUID()},{app:f.app,codexHome:f.home});assert.equal(f.archives(),0);assert.equal(f.creates(),1);
});

test('global scope serves two exact local workspaces with separate checkpoints in one central store',async t=>{
  const first=fixture(t,{central:true,projectId:'FixtureOne',checkpointWorkspace:true,checkpointRepository:os.tmpdir()});
  const second=fixture(t,{central:true,sharedRoot:first.root,projectId:'FixtureTwo',checkpointRepository:true});
  assert.notEqual(first.input.cwd,second.input.cwd);assert.equal(first.root,second.root);
  for(const f of [first,second]){
    const cli=f===second,adapter=isolatedAdapter(f,globalPolicy(first),{cli});
    if(cli)f.mode('timeout_visible');
    const result=cli?JSON.parse((await adapter.run(JSON.stringify(f.input))).output):await adapter.ensureSuccessor(f.input,{app:f.app,codexHome:f.home});
    assert.equal(result.status,'successor_visible');assert.equal(result.successor_thread_id,f.child);
    assert.equal((await adapter.ensureSuccessor(f.input,{app:f.app,codexHome:f.home})).successor_thread_id,f.child);
    assert.equal(f.creates(),1);assert.equal(f.navigations(),1);
  }
});

test('global scope rejects a checkpoint workspace mismatch before contacting the app',async t=>{
  const f=fixture(t,{checkpointWorkspace:os.tmpdir(),checkpointRepository:true}),adapter=isolatedAdapter(f,globalPolicy(f));
  let discoveries=0;f.app.listTools=async()=>{discoveries++;return [];};
  assert.equal((await adapter.ensureSuccessor(f.input,{app:f.app,codexHome:f.home})).status,'fallback_required');
  assert.equal(discoveries,0);assert.equal(f.creates(),0);assert.equal(f.navigations(),0);
});

test('global scope rejects a foreign root even when the checkpoint workspace matches',async t=>{
  const f=fixture(t,{checkpointWorkspace:true}),adapter=isolatedAdapter(f,{...globalPolicy(f),handoff_root:os.tmpdir()});
  assert.equal((await adapter.ensureSuccessor(f.input,{app:f.app,codexHome:f.home})).status,'fallback_required');
  assert.equal(f.creates(),0);assert.equal(f.navigations(),0);
});

test('global scope requires an explicit checkpoint workspace rather than only its session',async t=>{
  const f=fixture(t),adapter=isolatedAdapter(f,globalPolicy(f));
  assert.equal((await adapter.ensureSuccessor(f.input,{app:f.app,codexHome:f.home})).status,'fallback_required');
  assert.equal(f.creates(),0);assert.equal(f.navigations(),0);
});

test('global scope cannot derive checkpoint or catalog workspace identity from a relative path',async t=>{
  const current=fs.realpathSync(process.cwd());
  for(const relative of ['checkpoint','catalog']){
    const f=fixture(t,{central:true,checkpointWorkspace:relative==='checkpoint'?'.':current});
    f.input.cwd=current;
    const adapter=isolatedAdapter(f,globalPolicy(f)),original=f.app.callAppTool;
    f.app.callAppTool=async call=>call.tool.name==='list_projects'?{projects:[{projectId:f.project,projectKind:'local',hostId:'local',path:relative==='catalog'?'.':current}]}:original(call);
    assert.equal((await adapter.ensureSuccessor(f.input,{app:f.app,codexHome:f.home})).status,'fallback_required');
    assert.equal(f.creates(),0);assert.equal(f.navigations(),0);
  }
});

test('global scope rejects nonlocal or incomplete paths before realpath while accepting local absolute forms',async t=>{
  const cases=[
    {role:'cwd',value:'\\\\server\\share\\workspace',allowed:false},
    {role:'policy',value:'\\\\?\\UNC\\server\\share\\handoff',allowed:false},
    {role:'checkpoint',value:'\\\\.\\C:\\workspace',allowed:false},
    {role:'catalog',value:'\\workspace',allowed:false},
    {role:'cwd',value:'C:workspace',allowed:false},
    {role:'cwd',value:'\\\\?\\GLOBALROOT\\Device\\volume\\workspace',allowed:false},
    {role:'policy',value:'//server/share/handoff',allowed:false},
    {role:'cwd',value:'Q:\\offline-fixture\\workspace',allowed:true},
    {role:'checkpoint',value:'\\\\?\\Q:\\offline-fixture\\workspace',allowed:true,unavailable:true},
    {role:'cwd',value:'/offline-fixture/workspace',allowed:process.platform!=='win32'},
  ];
  for(const {role,value,allowed,unavailable} of cases){
    const f=fixture(t,{central:true,checkpointWorkspace:role==='checkpoint'?value:true}),input={...f.input};
    const policy=globalPolicy(f);let probes=0;
    if(role==='cwd')input.cwd=value;
    if(role==='policy')policy.handoff_root=value;
    const original=f.app.callAppTool;
    if(role==='catalog')f.app.callAppTool=async call=>call.tool.name==='list_projects'?{projects:[{projectId:f.project,projectKind:'local',hostId:'local',path:value}]}:original(call);
    const adapter=isolatedAdapter(f,policy,{realpathSync(file){
      if(file===value){probes++;return role==='policy'?f.root:f.input.cwd;}
      return fs.realpathSync(file);
    }});
    const result=await adapter.ensureSuccessor(input,{app:f.app,codexHome:f.home});
    // A syntactically local path still needs to exist for the native bound
    // checkpoint reader. The lexical realpath stub cannot authorize fake Q:.
    if(unavailable){assert.equal(result.status,'fallback_required');assert.equal(f.creates(),0);assert.equal(f.navigations(),0);continue;}
    assert.equal(result.status,allowed?'successor_visible':'fallback_required',role+': '+value);
    if(allowed)assert.ok(probes>0);else assert.equal(probes,0,'rejected paths must not reach realpath');
    assert.equal(f.creates(),allowed?1:0);assert.equal(f.navigations(),allowed?1:0);
  }
});

test('global scope rejects a local path whose realpath resolves to a nonlocal target',async t=>{
  const f=fixture(t,{central:true,checkpointWorkspace:true});
  const adapter=isolatedAdapter(f,globalPolicy(f),{realpathSync(file){
    return file===f.input.cwd?'\\\\offline-remote\\share\\workspace':fs.realpathSync(file);
  }});
  const result=await adapter.ensureSuccessor(f.input,{app:f.app,codexHome:f.home});
  assert.equal(result.status,'fallback_required');assert.equal(f.creates(),0);assert.equal(f.navigations(),0);
});

test('global scope validates a unique current app project before reusing a known successor',async t=>{
  for(const mode of ['missing','ambiguous']){
    const f=fixture(t,{checkpointWorkspace:true}),adapter=isolatedAdapter(f,globalPolicy(f)),original=f.app.callAppTool;
    fs.writeFileSync(path.join(f.root,f.session+'-status.json'),JSON.stringify({origin_thread_id:f.session,successor_thread_id:f.child,app_project_id:f.project,project_id:'Fixture'}));
    f.threads.push({threadId:f.child,projectId:f.project});
    f.app.callAppTool=async call=>call.tool.name==='list_projects'?{projects:mode==='missing'?[]:[{projectId:f.project,projectKind:'local',hostId:'local',path:f.input.cwd},{projectId:crypto.randomUUID(),projectKind:'local',hostId:'local',path:f.input.cwd}]}:original(call);
    assert.equal((await adapter.ensureSuccessor(f.input,{app:f.app,codexHome:f.home})).status,'fallback_required');
    assert.equal(f.creates(),0);assert.equal(f.navigations(),0);
  }
});

test('global scope rejects a foreign journal app project before known or uncertain recovery',async t=>{
  for(const known of [true,false]){
    const f=fixture(t,{checkpointWorkspace:true}),adapter=isolatedAdapter(f,globalPolicy(f)),foreign=crypto.randomUUID();
    const title='Fixture – Fortsetzung '+f.session;
    fs.writeFileSync(path.join(f.root,f.session+'-status.json'),JSON.stringify({phase:known?'successor_created':'creation_intent',origin_thread_id:f.session,...(known?{successor_thread_id:f.child}:{}),app_project_id:foreign,project_id:'Fixture',checkpointId:f.cp.checkpoint_id,handoffFile:f.cp.file,repositoryPath:f.input.cwd}));
    f.threads.push({threadId:f.child,title,projectId:foreign});
    assert.equal((await adapter.ensureSuccessor(f.input,{app:f.app,codexHome:f.home})).status,'fallback_required');
    assert.equal(f.creates(),0);assert.equal(f.navigations(),0);assert.equal(f.catalogReads(),0);
  }
});


test('numbered successor notices preserve the original name and journal lineage',async t=>{
 const f=fixture(t,{checkpointWorkspace:true}),base=f.app.callAppTool,renames=[];
 f.app.listTools=async()=>['list_projects','list_threads','create_thread','navigate_to_codex_page','read_thread','set_thread_archived','set_thread_title'].map(name=>({name,namespace:'fixture'}));
 f.app.callAppTool=async call=>{if(call.tool.name==='set_thread_title'){renames.push(call.args);return {threadId:call.args.threadId,title:call.args.title};}const r=await base(call);if(call.tool.name==='read_thread')r.thread.title='Original fixture';return r;};
 const adapter=isolatedAdapter(f,{...conditionalPolicy(f),visible_notice:true});
 assert.equal((await adapter.ensureSuccessor(f.input,{app:f.app,codexHome:f.home})).status,'successor_visible');
 const j=JSON.parse(fs.readFileSync(path.join(f.root,f.session+'-status.json')));
 assert.equal(j.naming.base_title,'Original fixture');assert.equal(j.naming.sequence,1);
 assert.ok(renames.some(r=>r.threadId===f.child&&r.title==='[Hier weiter] Original fixture · 2'));
});


test('manual successor receives the inherited numbered original title',async t=>{
  const f=fixture(t,{checkpointWorkspace:true}),adapter=isolatedAdapter(f,conditionalPolicy(f));
  const base=f.app.callAppTool,renames=[];
  f.app.listTools=async()=>['list_projects','list_threads','read_thread','set_thread_archived','set_thread_title'].map(name=>({name,namespace:'fixture'}));
  f.app.callAppTool=async call=>{if(call.tool.name==='set_thread_title'){renames.push(call.args);return {threadId:call.args.threadId,title:call.args.title};}const r=await base(call);if(call.tool.name==='read_thread')r.thread.title='Original manual';return r;};
  appendUser(f);
  assert.equal((await adapter.ensureSuccessor(f.input,{app:f.app,codexHome:f.home})).reason_code,'new_user_message_after_snapshot');
  assert.equal(f.creates(),0);assert.equal(f.archives(),0);
  const manualFile=path.join(__dirname,'handoff-manual-start.cjs'),mod={exports:{}};
  /**
   * Return injected filesystem/app modules and delegate other dependencies while evaluating the isolated adapter.
   */
  const localRequire=name=>name==='./codex-app-pipe.cjs'?f.app:require(name);
  localRequire.main={};
  new Function('require','module','process',fs.readFileSync(manualFile,'utf8'))(localRequire,mod,{env:{CODEX_THREAD_ID:f.child,CODEX_HOME:f.home},cwd:()=>f.input.cwd});
  const offer=mod.exports.offerManualStart(f.input,{codexHome:f.home});
  f.threads.push({threadId:f.child,projectId:f.project});
  const accepted=await mod.exports.acceptManualStart({operation:'accept',offer_file:offer.manual_start_file.replace(/\.md$/,'.json'),turn_id:crypto.randomUUID(),human_requested:true});
  assert.equal(accepted.status,'manual_successor_bound');
  assert.ok(renames.some(r=>r.threadId===f.child&&r.title==='Original manual · 2'));
  assert.equal(accepted.naming.successor_title,'Original manual · 2');
  assert.deepEqual(fs.readFileSync(accepted.transcript_copy),fs.readFileSync(f.source));
  assert.ok(fs.statSync(accepted.transcript_copy).size>accepted.original_snapshot_bytes);
  const j=JSON.parse(fs.readFileSync(path.join(f.root,f.session+'-status.json')));
  assert.equal(j.automationCancelReason,'new_user_message_after_snapshot');
  const previousHome=process.env.CODEX_HOME;let loaded;
  try{process.env.CODEX_HOME=f.home;loaded=require('./handoff-store.cjs').resumeChatContinuation(f.root,{session_id:f.child,workspace:f.input.cwd,handoff_file:j.handoffFile});}
  finally{if(previousHome===undefined)delete process.env.CODEX_HOME;else process.env.CODEX_HOME=previousHome;}
  assert.equal(loaded.continuation.origin_session_id,f.session);
  saveCheckpoint(f.root,{format_version:1,project_id:'Fixture',session_id:f.child,expected_parent:f.cp.checkpoint_id,chat_task:{source_ref:'human',next_step:{text:'Finish authorized manual takeover',success_criterion:'Archive once after review'}},patch:{sources:{manual_context_review:{path:accepted.transcript_copy,sha256:accepted.sha256,summary:'Entire new user message retained and reviewed'}}}});
  const close={...f.input,operation:'confirm_takeover',successor_session_id:f.child,turn_id:crypto.randomUUID()};
  assert.equal((await adapter.ensureSuccessor(close,{app:f.app,codexHome:f.home})).status,'archived_after_takeover');
  assert.equal((await adapter.ensureSuccessor(close,{app:f.app,codexHome:f.home})).status,'archived_after_takeover');
  assert.equal(f.archives(),1);assert.equal(f.creates(),0);
});

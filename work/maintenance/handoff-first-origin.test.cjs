'use strict';
// New offline first-origin fixtures only; no live app, hooks or archive operations.
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),crypto=require('node:crypto');
const {saveCheckpoint}=require('./handoff-store.cjs');
const hash=bytes=>crypto.createHash('sha256').update(bytes).digest('hex');

function fixture(t,serial=false){
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'thehive-first-origin-'));
  t.after(()=>{assert.ok(path.resolve(dir).startsWith(path.resolve(os.tmpdir())+path.sep));fs.rmSync(dir,{recursive:true,force:true});});
  const cwd=path.join(dir,'workspace'),root=path.join(dir,'central','handoff'),home=path.join(dir,'codex');
  fs.mkdirSync(cwd,{recursive:true});
  const session=crypto.randomUUID(),other=crypto.randomUUID(),child=crypto.randomUUID(),project=crypto.randomUUID();
  const origin=saveCheckpoint(root,{format_version:1,project_id:'Fixture',session_id:session,expected_parent:null,
    chat_task:{source_ref:'human',next_step:{text:'Continue origin work',success_criterion:'Origin result'}},
    patch:{goal:'Offline first-origin fixture',status:'planned',last_section:'Origin',git:{workspace:cwd},sources:{human:{reference:'Synthetic offline request'}},next_step:{text:'Continue origin work',success_criterion:'Origin result'}}});
  const originEntry=JSON.parse(fs.readFileSync(path.join(root,'index.json'),'utf8')).projects.Fixture;
  const historicalFile=path.join(root,originEntry.history_file),originMarkdown=fs.readFileSync(origin.file);
  let current=saveCheckpoint(root,{format_version:1,project_id:'Fixture',session_id:other,expected_parent:origin.checkpoint_id,
    patch:{last_section:'Parallel work'}});
  const source=path.join(home,'sessions','rollout-'+session+'.jsonl');fs.mkdirSync(path.dirname(source),{recursive:true});
  fs.writeFileSync(source,JSON.stringify({type:'session_meta',payload:{id:session,source:'cli'}})+'\n'+JSON.stringify({type:'response_item',payload:{type:'message',role:'user',content:[{type:'input_text',text:'Synthetic request'}]}})+'\n');
  function snapshot(name='context-first',markdown=originMarkdown,checkpointId=origin.checkpoint_id){
    const snapshotPath=path.join(home,'handoff-snapshots',session,name);fs.mkdirSync(snapshotPath,{recursive:true});
    const transcript=fs.readFileSync(source);
    fs.writeFileSync(path.join(snapshotPath,'working.md'),markdown);fs.writeFileSync(path.join(snapshotPath,'transcript.jsonl'),transcript);
    fs.writeFileSync(path.join(snapshotPath,'manifest.json'),JSON.stringify({status:'PASS',session_id:session,project_id:'Fixture',checkpoint_id:checkpointId,trigger:'context_usage',context_usage:{used_tokens:800,limit_tokens:1000,threshold_percent:80},working_state:{file:'working.md',bytes:markdown.length,sha256:hash(markdown)},transcript:{source,file:'transcript.jsonl',bytes:transcript.length,sha256:hash(transcript)}}));
    return snapshotPath;
  }
  const input={session_id:session,turn_id:crypto.randomUUID(),cwd,snapshot_path:snapshot(),handoff_root:root};
  let creates=0,originStatus='active',navigations=0,archives=0,jobs=[],failNavigation=false,userOnTitle=false,hiddenReads=0;const titles=[],prompts=[],threads=[{threadId:session,projectId:project}];
  const app={async listTools(){return ['list_projects','list_threads','create_thread','read_thread','navigate_to_codex_page','set_thread_title','set_thread_archived'].map(name=>({name,namespace:'offline-fixture'}));},async callAppTool({tool,args}){
    if(tool.name==='read_thread')return {thread:{id:session,title:'Original fixture',status:{type:originStatus}}};
    if(tool.name==='set_thread_title'){titles.push(args);if(userOnTitle){userOnTitle=false;appendUser();}return {threadId:args.threadId,title:args.title};}
    if(tool.name==='set_thread_archived'){assert.equal(originStatus,'idle');archives++;return {threadId:args.threadId,archived:args.archived};}
    if(tool.name==='navigate_to_codex_page'){assert.equal(args.threadId,child);navigations++;if(failNavigation)throw Error('Synthetic navigation failure');return {};}
    if(tool.name==='list_projects')return {projects:[{projectId:project,projectKind:'local',hostId:'local',path:cwd}]};
    if(tool.name==='list_threads'){if(creates&&hiddenReads>0){hiddenReads--;return {threads:threads.filter(t=>t.threadId!==child)};}return {threads};}
    assert.equal(tool.name,'create_thread','No navigation, archival or other live operation belongs to this fixture');
    creates++;prompts.push(args.prompt);assert.deepEqual(args.target,{type:'project',projectId:project,environment:{type:'local'}});
    threads.push({threadId:child,projectId:project,title:args.title});return {threadId:child,hostId:'local'};
  },decodeToolResult:value=>value};
  const adapterFile=path.join(__dirname,'handoff-desktop.cjs'),policyFile=path.join(__dirname,'handoff-automation-policy.json');
  const policy={enabled:true,navigate:serial,wait_for_origin_idle:serial,visible_notice:serial,cancel_on_new_user_message:true,archive_after_takeover:true,scope:'all_local_projects',handoff_root:root};
  let afterIndexRead;
  const policyFs={...fs,readFileSync(file,options){if(path.resolve(file)===policyFile){const bytes=Buffer.from(JSON.stringify(policy));return options==='utf8'?bytes.toString('utf8'):bytes;}
    const bytes=fs.readFileSync(file,options);
    if(afterIndexRead&&path.resolve(file)===path.join(root,'index.json')){const change=afterIndexRead;afterIndexRead=null;change();}
    return bytes;}};
  const module={exports:{}};
  function localRequire(name){if(name==='node:fs')return policyFs;if(name==='./codex-app-pipe.cjs')throw Error('Live pipe forbidden in offline fixture');return require(name);}
  localRequire.main={};
  new Function('require','module','__dirname','process',fs.readFileSync(adapterFile,'utf8'))(localRequire,module,__dirname,{platform:process.platform,env:{CODEX_HOME:home}});
  const call=(value=input)=>module.exports.ensureSuccessor(value,{app,codexHome:home,schedulePending:serial?job=>jobs.push(job):undefined});
  const journal=()=>JSON.parse(fs.readFileSync(path.join(root,session+'-status.json'),'utf8'));
  const appendUser=()=>fs.appendFileSync(source,JSON.stringify({type:'response_item',payload:{type:'message',role:'user',content:[{type:'input_text',text:'Synthetic later message'}]}})+'\n');
  function advanceOwnWorking(){
    const own=saveCheckpoint(root,{format_version:1,project_id:'Fixture',session_id:session,expected_parent:current.checkpoint_id,patch:{last_section:'New own work'}});
    current=saveCheckpoint(root,{format_version:1,project_id:'Fixture',session_id:other,expected_parent:own.checkpoint_id,patch:{last_section:'New parallel work'}});
  }
  const returnToOwn=()=>current=saveCheckpoint(root,{format_version:1,project_id:'Fixture',session_id:session,expected_parent:current.checkpoint_id,patch:{last_section:'Own current after parallel update'}});
  const raceIndexUpdate=()=>{afterIndexRead=()=>{current=saveCheckpoint(root,{format_version:1,project_id:'Fixture',session_id:other,expected_parent:current.checkpoint_id,patch:{last_section:'Parallel save after index read'}});};};
  return {input,home,root,cwd,session,other,child,origin,historicalFile,originMarkdown,source,call,snapshot,journal,appendUser,advanceOwnWorking,returnToOwn,raceIndexUpdate,prompts,creates:()=>creates,jobs,titles,app,archives:()=>archives,navigations:()=>navigations,setOriginStatus:value=>originStatus=value,failNavigation:()=>failNavigation=true,userOnTitle:()=>userOnTitle=true,hideChild:reads=>hiddenReads=reads};
}

test('visible serial handoff cancels a message arriving during status title calls',async t=>{
  const f=fixture(t,true);f.setOriginStatus('idle');f.userOnTitle();
  const result=await f.call();assert.equal(result.reason_code,'new_user_message_after_snapshot');
  assert.equal(f.navigations(),0);assert.equal(f.archives(),0);assert.equal(f.creates(),1);
});

test('visible serial handoff follows delayed child visibility and navigates without creating twice',async t=>{
  const f=fixture(t,true);f.setOriginStatus('idle');f.hideChild(2);
  const worker=require('./handoff-archive-waiter.cjs');
  const result=await worker.completePending({...f.input,operation:'resume_creation'},
    {complete:input=>f.call(input),app:f.app,pause:async()=>{}});
  assert.equal(result.status,'successor_visible');assert.equal(f.creates(),1);assert.equal(f.navigations(),1);
});

test('visible serial handoff schedules visibility completion if source was already idle',async t=>{
  const f=fixture(t,true);f.setOriginStatus('idle');f.hideChild(1);
  assert.equal((await f.call()).status,'successor_created');
  assert.equal(f.jobs.length,1);assert.equal(f.jobs[0].operation,'resume_creation');
});

test('visible serial handoff reports failed navigation and never duplicates the child',async t=>{
  const f=fixture(t,true);f.setOriginStatus('idle');f.failNavigation();
  const result=await f.call();assert.equal(result.status,'fallback_required');
  assert.equal(result.reason_code,'navigation_failed');assert.equal(result.successor_thread_id,f.child);
  assert.equal(f.archives(),0);const again=await f.call();assert.equal(again.status,'fallback_required');
  assert.equal(f.creates(),1);assert.equal(f.navigations(),1);
  assert.ok(f.titles.some(x=>x.title.startsWith('[Wechsel fehlgeschlagen]')));
});

test('connected handoff: snapshot to source stop to start and visible switch to takeover and archive',async t=>{
  const f=fixture(t,true),worker=require('./handoff-archive-waiter.cjs');
  assert.equal((await f.call()).status,'waiting_for_origin');
  assert.equal(f.creates(),0);assert.equal(f.archives(),0);
  assert.match(f.titles[0].title,/Übergabe gesichert/);
  const app={...f.app,async callAppTool(value){
    if(value.tool.name==='wait_threads')throw Error('wait_threads cannot wait on the calling thread.');
    return f.app.callAppTool(value);
  },async listTools(){return [...await f.app.listTools(),{name:'wait_threads'}];}};
  const result=await worker.completePending(f.jobs[0],{app,complete:input=>f.call(input),pause:async()=>{f.setOriginStatus('idle');}});
  assert.equal(result.status,'successor_visible');assert.equal(f.creates(),1);assert.equal(f.navigations(),1);
  assert.equal(f.archives(),0,'Creation and navigation alone cannot archive source');
  assert.ok(f.titles.some(x=>x.threadId===f.child&&x.title.startsWith('[Hier weiter]')));
  const current=require('./handoff-store.cjs').resumeProject(f.root,'Fixture');
  saveCheckpoint(f.root,{format_version:1,project_id:'Fixture',session_id:f.child,expected_parent:current.checkpoint_id,
    patch:{events:{takeover:{origin_session_id:f.session,status:'source read and task accepted'}}}});
  const closed=await f.call({...f.input,operation:'confirm_takeover',successor_session_id:f.child});
  assert.equal(closed.status,'archived_after_takeover');assert.equal(f.archives(),1);
  const again=await f.call({...f.input,operation:'confirm_takeover',successor_session_id:f.child});
  assert.equal(again.status,'archived_after_takeover');assert.equal(f.archives(),1);
});

for(const allowed of [true,false])test('explicit recovery caller must share the exact app project: '+allowed,async t=>{
  const f=fixture(t,true);await f.call();f.setOriginStatus('idle');
  const original=f.app.callAppTool;
  f.app.callAppTool=async call=>{
    assert.equal(call.threadId,f.other);
    const result=await original(call);
    if(call.tool.name==='list_threads')result.threads.push({threadId:f.other,projectId:allowed?result.threads[0].projectId:crypto.randomUUID()});
    return result;
  };
  const result=await f.call({...f.input,operation:'resume_creation',caller_session_id:f.other});
  assert.equal(f.creates(),allowed?1:0);assert.equal(result.status,allowed?'successor_visible':'fallback_required');
});

test('visible serial handoff waits for source then creates and opens exactly one successor',async t=>{
  const f=fixture(t,true);
  assert.equal((await f.call()).status,'waiting_for_origin');
  assert.equal(f.creates(),0);assert.equal(f.navigations(),0);assert.equal(f.jobs.length,1);
  await f.call();assert.equal(f.jobs.length,1);
  f.setOriginStatus('idle');
  assert.equal((await f.call(f.jobs[0])).status,'successor_visible');
  assert.equal(f.creates(),1);assert.equal(f.navigations(),1);
  await f.call(f.jobs[0]);assert.equal(f.creates(),1);assert.equal(f.navigations(),1);
});

test('visible serial handoff cancels on new message during wait without starting child',async t=>{
  const f=fixture(t,true);await f.call();f.appendUser();f.setOriginStatus('idle');
  const result=await f.call(f.jobs[0]);assert.equal(result.reason_code,'new_user_message_after_snapshot');
  assert.equal(f.creates(),0);assert.equal(f.navigations(),0);
});

test('visible serial handoff does not create for unknown source state',async t=>{
  const f=fixture(t,true);f.setOriginStatus('unexpected');
  assert.equal((await f.call()).status,'fallback_required');assert.equal(f.creates(),0);
});

test('first origin snapshot survives a parallel project checkpoint and creates only one child',async t=>{
  const f=fixture(t),indexBefore=fs.readFileSync(path.join(f.root,'index.json')),currentBefore=fs.readFileSync(path.join(f.root,'Fixture','current.md'));
  const first=await f.call();
  assert.equal(first.status,'successor_visible');assert.equal(first.successor_thread_id,f.child);assert.equal(f.creates(),1);
  assert.deepEqual(f.prompts,['Projekt-ID: Fixture\nHandoff-Datei: '+f.historicalFile+'\nNaechster offener Arbeitsschritt: Continue origin work']);
  const baseline=f.journal().freshnessBaseline;
  const again=await f.call({...f.input,turn_id:crypto.randomUUID()});
  assert.equal(again.successor_thread_id,f.child);assert.equal(f.creates(),1);assert.deepEqual(f.journal().freshnessBaseline,baseline);
  assert.deepEqual(fs.readFileSync(path.join(f.root,'index.json')),indexBefore);assert.deepEqual(fs.readFileSync(path.join(f.root,'Fixture','current.md')),currentBefore);
});

test('first origin uses verified snapshot bytes after its working projection has advanced',async t=>{
  const f=fixture(t);f.advanceOwnWorking();
  assert.notDeepEqual(fs.readFileSync(path.join(f.root,f.session+'-working.md')),f.originMarkdown);
  const result=await f.call();
  assert.equal(result.status,'successor_visible');assert.equal(f.creates(),1);assert.ok(f.prompts[0].includes('Handoff-Datei: '+f.historicalFile+'\n'));
  assert.ok(f.prompts[0].endsWith('Continue origin work'));
});

test('first origin still binds its exact older snapshot after A to B to A',async t=>{
  const f=fixture(t);f.returnToOwn();
  const before=fs.readFileSync(path.join(f.root,'Fixture/current.md'));
  const result=await f.call();
  assert.equal(result.status,'successor_visible');assert.equal(f.creates(),1);
  assert.ok(f.prompts[0].includes('Handoff-Datei: '+f.historicalFile+'\n'));
  assert.deepEqual(fs.readFileSync(path.join(f.root,'Fixture/current.md')),before);
});

test('a project update immediately after index read cannot lose the bound first snapshot',async t=>{
  const f=fixture(t),own=f.returnToOwn(),entry=JSON.parse(fs.readFileSync(path.join(f.root,'index.json'),'utf8')).projects.Fixture;
  const boundFile=path.join(f.root,entry.history_file),snapshot=f.snapshot('context-current-own',fs.readFileSync(own.file),own.checkpoint_id);
  f.raceIndexUpdate();
  const result=await f.call({...f.input,snapshot_path:snapshot});
  assert.equal(result.status,'successor_visible');assert.equal(f.creates(),1);
  assert.ok(f.prompts[0].includes('Handoff-Datei: '+boundFile+'\n'));
  assert.equal(JSON.parse(fs.readFileSync(path.join(f.root,'index.json'),'utf8')).projects.Fixture.session_id,f.other);
});

test('context guard generated historical snapshot is accepted by the desktop first binding',async t=>{
  const f=fixture(t),hooks=path.join(f.home,'hooks');fs.mkdirSync(hooks,{recursive:true});
  fs.copyFileSync(path.join(os.homedir(),'.codex/hooks/pre-compaction-snapshot.py'),path.join(hooks,'pre-compaction-snapshot.py'));
  fs.appendFileSync(f.source,JSON.stringify({type:'event_msg',payload:{type:'token_count',info:{model_context_window:1000,last_token_usage:{total_tokens:850}}}})+'\n');
  const script=`import importlib.util,json,pathlib,sys
spec=importlib.util.spec_from_file_location('offline_guard',sys.argv[1])
guard=importlib.util.module_from_spec(spec);spec.loader.exec_module(guard)
original=guard._helpers
def offline_helpers(home):
    helpers=original(home)
    helpers._desktop_successor=lambda *args,**kwargs: {'status':'fallback_required','successor_thread_id':None}
    return helpers
guard._helpers=offline_helpers
event=json.loads(sys.stdin.read())
result=guard.handle_event(event,codex_home=sys.argv[2],handoff_root=sys.argv[3])
assert result.get('continue') is False and 'Sicherung bestaetigt' in result['stopReason'],result
manifest=json.loads((pathlib.Path(sys.argv[2])/'handoff-snapshots'/event['session_id']/'context-latest.json').read_text())
print(json.dumps({'snapshot_path':manifest['snapshot_path'],'checkpoint_id':manifest['checkpoint_id']}))
`;
  const python=path.join(os.homedir(),'.venv/Scripts/python.exe');
  const result=require('node:child_process').spawnSync(python,['-c',script,path.join(__dirname,'context-handoff-guard.py'),f.home,f.root],{
    input:JSON.stringify({hook_event_name:'PostToolUse',session_id:f.session,turn_id:f.input.turn_id,cwd:f.cwd,transcript_path:f.source}),encoding:'utf8',timeout:15000,windowsHide:true});
  assert.equal(result.status,0,result.stderr||String(result.error));
  const captured=JSON.parse(result.stdout);assert.equal(captured.checkpoint_id,f.origin.checkpoint_id);
  const accepted=await f.call({...f.input,snapshot_path:captured.snapshot_path});
  assert.equal(accepted.status,'successor_visible');assert.equal(f.creates(),1);
  assert.ok(f.prompts[0].includes('Handoff-Datei: '+f.historicalFile+'\n'));
});

test('new user input blocks a first historical origin and a later snapshot cannot reset that boundary',async t=>{
  const f=fixture(t);f.appendUser();
  const blocked=await f.call();
  assert.equal(blocked.status,'fallback_required');assert.equal(blocked.reason_code,'new_user_message_after_snapshot');assert.equal(f.creates(),0);
  const baseline=f.journal().freshnessBaseline;assert.equal(baseline.snapshot_path,f.input.snapshot_path);
  const later=f.snapshot('context-later');
  const again=await f.call({...f.input,snapshot_path:later,turn_id:crypto.randomUUID()});
  assert.equal(again.reason_code,'new_user_message_after_snapshot');assert.equal(f.creates(),0);assert.deepEqual(f.journal().freshnessBaseline,baseline);
});

test('foreign workspace cannot first-bind a historical origin',async t=>{
  const f=fixture(t),foreign=path.join(f.home,'foreign-workspace');fs.mkdirSync(foreign,{recursive:true});
  assert.equal((await f.call({...f.input,cwd:foreign})).status,'fallback_required');assert.equal(f.creates(),0);
  assert.equal(fs.existsSync(path.join(f.root,f.session+'-status.json')),false);
});

test('foreign snapshot session cannot first-bind despite a valid copy hash',async t=>{
  const f=fixture(t),foreignMarkdown=fs.readFileSync(path.join(f.root,'Fixture','current.md'));
  const snapshot=f.snapshot('context-foreign-session',foreignMarkdown);
  assert.equal((await f.call({...f.input,snapshot_path:snapshot})).status,'fallback_required');assert.equal(f.creates(),0);
  assert.equal(fs.existsSync(path.join(f.root,f.session+'-status.json')),false);
});

test('manifest checkpoint mismatch cannot first-bind a historical origin',async t=>{
  const f=fixture(t),snapshot=f.snapshot('context-foreign-checkpoint',f.originMarkdown,'f'.repeat(64));
  assert.equal((await f.call({...f.input,snapshot_path:snapshot})).status,'fallback_required');assert.equal(f.creates(),0);
  assert.equal(fs.existsSync(path.join(f.root,f.session+'-status.json')),false);
});

test('an existing first-origin journal with a foreign checkpoint is never overwritten',async t=>{
  const f=fixture(t),journalFile=path.join(f.root,f.session+'-status.json');
  const state={phase:'snapshot_ready',originThreadId:f.session,project_id:'Fixture',repositoryPath:f.cwd,handoffRoot:f.root,
    checkpointId:'f'.repeat(64),handoffFile:f.historicalFile,freshnessBaseline:{snapshot_path:f.input.snapshot_path,checkpoint_id:f.origin.checkpoint_id}};
  const before=Buffer.from(JSON.stringify(state));fs.writeFileSync(journalFile,before);
  assert.equal((await f.call()).status,'fallback_required');assert.equal(f.creates(),0);assert.deepEqual(fs.readFileSync(journalFile),before);
});

test('a historical origin snapshot alone cannot authorize takeover completion',async t=>{
  const f=fixture(t);
  const result=await f.call({...f.input,operation:'confirm_takeover',successor_session_id:f.child});
  assert.equal(result.status,'fallback_required');assert.equal(f.creates(),0);
  assert.equal(fs.existsSync(path.join(f.root,f.session+'-status.json')),false);
  assert.equal(fs.existsSync(path.join(f.input.snapshot_path,'takeover-proof.json')),false);
});

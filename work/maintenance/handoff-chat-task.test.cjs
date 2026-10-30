'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),os=require('node:os'),crypto=require('node:crypto');
const store=require('./handoff-store.cjs');
/**
 * Create an isolated workspace/store with two session UUIDs and guarded test cleanup; return both identities and local paths.
 */
function fixture(t){const dir=fs.mkdtempSync(path.join(os.tmpdir(),'hive-chat-task-'));t.after(()=>{assert.equal(path.dirname(dir),fs.realpathSync(os.tmpdir()));fs.rmSync(dir,{recursive:true,force:true});});const root=path.join(dir,'work','handoff'),a=crypto.randomUUID(),b=crypto.randomUUID();return {dir,root,a,b};}
/**
 * Return a synthetic next-step assignment with the supplied text and exact-work success criterion.
 */
const step=text=>({text,success_criterion:'Exact assigned work only'});
/**
 * Save a fixture checkpoint for one session and parent, optionally binding its own explicit task independently of the common project next action.
 */
function save(f,session,parent,task){return store.saveCheckpoint(f.root,{format_version:1,project_id:'Fixture',session_id:session,expected_parent:parent,...(task?{chat_task:{source_ref:'human_'+session,next_step:step(task)}}:{}),patch:{goal:'Shared project',status:'planned',last_section:'Progress',git:{workspace:f.dir},sources:{['human_'+session]:{session_ref:session}},next_step:step('COMMON PROJECT TASK MUST NOT BECOME A CHAT ORDER')}});}
test('A and B retain distinct orders after alternating writes in one project',t=>{
 const f=fixture(t),a=save(f,f.a,null,'Analyse costs'),b=save(f,f.b,a.checkpoint_id,'Fix hooks');
 const again=store.saveCheckpoint(f.root,{format_version:1,project_id:'Fixture',session_id:f.a,expected_parent:b.checkpoint_id,patch:{last_section:'A saves progress after B'}});
 assert.equal(store.chatTaskForCheckpoint(again,f.a).next_step.text,'Analyse costs');
 assert.equal(store.chatTaskForCheckpoint(b,f.b).next_step.text,'Fix hooks');
 assert.equal(again.state.next_step.text,'COMMON PROJECT TASK MUST NOT BECOME A CHAT ORDER');
 assert.match(fs.readFileSync(again.file,'utf8').split('# NEXT_ACTION')[1].split('# BLOCKERS')[0],/Analyse costs/);
 assert.equal(store.resumeChatContinuation(f.root,{session_id:f.b,workspace:f.dir}).continuation.next_step.text,'Fix hooks');
});
test('saving a foreign shared next action does not manufacture a chat order',t=>{
 const f=fixture(t),a=save(f,f.a,null,'Analyse costs'),b=save(f,f.b,a.checkpoint_id);
 assert.throws(()=>store.chatTaskForCheckpoint(b,f.b),/chat.*task|continuation/i);
 assert.throws(()=>store.resumeChatContinuation(f.root,{session_id:f.b,workspace:f.dir}),/chat.*task|continuation/i);
});
test('legacy records stay readable but cannot authorize automatic continuation',t=>{
 const f=fixture(t),a=save(f,f.a,null);assert.equal(store.resumeProject(f.root,'Fixture').checkpoint_id,a.checkpoint_id);
 assert.throws(()=>store.chatTaskForCheckpoint(a,f.a),/chat.*task|continuation/i);
});
test('missing source or direct writes to another chat binding are refused',t=>{
 const f=fixture(t),a=save(f,f.a,null,'Analyse costs');
 assert.throws(()=>store.saveCheckpoint(f.root,{format_version:1,project_id:'Fixture',session_id:f.b,expected_parent:a.checkpoint_id,chat_task:{source_ref:'missing',next_step:step('Foreign')},patch:{last_section:'Bad'}}));
 assert.throws(()=>store.saveCheckpoint(f.root,{format_version:1,project_id:'Fixture',session_id:f.b,expected_parent:a.checkpoint_id,patch:{chat_tasks:{[f.a]:{next_step:step('Stolen')}}}}));
 assert.throws(()=>store.chatTaskForCheckpoint(a,f.b));
});

test('connected two-chat flow preserves each assignment through starters, takeover and archive',async t=>{
 const f=fixture(t),home=path.join(f.dir,'codex'),project=crypto.randomUUID(),rows=[{threadId:f.a,projectId:project},{threadId:f.b,projectId:project}],prompts=[],archived=[];
 const a=save(f,f.a,null,'Analyse costs'),b=save(f,f.b,a.checkpoint_id,'Fix hooks');
 const policy={enabled:true,scope:'all_local_projects',handoff_root:f.root,navigate:true,wait_for_origin_idle:true,cancel_on_new_user_message:true,archive_after_takeover:true};
 const source=path.join(__dirname,'handoff-desktop.cjs'),policyFile=path.join(__dirname,'handoff-automation-policy.json'),m={exports:{}};
 const mockFs={...fs,statSync(p,...args){if(path.resolve(p)===policyFile)return {size:Buffer.byteLength(JSON.stringify(policy))};return fs.statSync(p,...args);},readFileSync(p,opts){if(path.resolve(p)===policyFile)return opts==='utf8'?JSON.stringify(policy):Buffer.from(JSON.stringify(policy));return fs.readFileSync(p,opts);}};
 /**
  * Substitute the fixture filesystem while delegating other module loads; policy reads use the controlled fixture.
  */
 const req=name=>name==='node:fs'?mockFs:require(name);req.main={};
 new Function('require','module','__dirname','process',fs.readFileSync(source,'utf8'))(req,m,__dirname,process);
 const app={listTools:async()=>['list_projects','list_threads','read_thread','create_thread','navigate_to_codex_page','set_thread_archived'].map(name=>({name,namespace:'fixture'})),decodeToolResult:x=>x,callAppTool:async({tool,args})=>{
   if(tool.name==='list_projects')return {projects:[{projectId:project,projectKind:'local',path:f.dir,hostId:'local'}]};
   if(tool.name==='list_threads')return {threads:rows};
   if(tool.name==='read_thread')return {thread:{id:args.threadId,status:{type:'idle'}}};
   if(tool.name==='create_thread'){const id=crypto.randomUUID();rows.push({threadId:id,projectId:project,title:args.title});prompts.push(args.prompt);return {threadId:id,hostId:'local'};}
   if(tool.name==='navigate_to_codex_page')return {};
   if(tool.name==='set_thread_archived'){archived.push(args.threadId);return {threadId:args.threadId,archived:true};}
   throw Error('Unsupported real-app contract');
 }};
 /**
  * Return the SHA-256 of synthetic snapshot bytes used by this regression fixture.
  */
 const digest=b=>crypto.createHash('sha256').update(b).digest('hex');
 for(const [session,expected]of [[f.a,'Analyse costs'],[f.b,'Fix hooks']]){
   const own=store.resumeChatContinuation(f.root,{session_id:session,workspace:f.dir}),dir=path.join(home,'handoff-snapshots',session,'bound');fs.mkdirSync(dir,{recursive:true});
   const transcript=Buffer.from(JSON.stringify({type:'session_meta',payload:{id:session,source:'cli'}})+'\n'),file=path.join(home,'sessions',session+'.jsonl');fs.mkdirSync(path.dirname(file),{recursive:true});fs.writeFileSync(file,transcript);
   const working=fs.readFileSync(own.checkpoint.file);fs.writeFileSync(path.join(dir,'working.md'),working);fs.writeFileSync(path.join(dir,'transcript.jsonl'),transcript);
   fs.writeFileSync(path.join(dir,'manifest.json'),JSON.stringify({status:'PASS',trigger:'manual',session_id:session,project_id:'Fixture',checkpoint_id:own.checkpoint.checkpoint_id,working_state:{file:'working.md',bytes:working.length,sha256:digest(working)},transcript:{source:file,file:'transcript.jsonl',bytes:transcript.length,sha256:digest(transcript)}}));
   const input={session_id:session,turn_id:crypto.randomUUID(),cwd:f.dir,handoff_root:f.root,snapshot_path:dir};
   const result=await m.exports.ensureSuccessor(input,{app,codexHome:home});assert.equal(result.status,'successor_visible');
   const lines=prompts.at(-1).split('\n');assert.equal(lines.length,3);assert.equal(lines[2],'Naechster offener Arbeitsschritt: '+expected);assert.ok(!prompts.at(-1).includes('COMMON PROJECT TASK'));
   assert.equal(lines[1],'Handoff-Datei: '+own.checkpoint.file);
   const current=store.resumeProject(f.root,'Fixture'),child=result.successor_thread_id;
   const adopted=store.resumeChatContinuation(f.root,{session_id:child,workspace:f.dir,handoff_file:own.checkpoint.file});
   assert.equal(adopted.continuation.next_step.text,expected);
   const cli=require('node:child_process').spawnSync(path.join(os.homedir(),'.bun','bin','bun.exe'),['run',path.join(__dirname,'handoff-resume.ts'),'--project','Fixture','--workspace',f.dir,'--vault',f.dir,'--handoff',own.checkpoint.file],{encoding:'utf8',env:{...process.env,CODEX_THREAD_ID:child}});
   assert.equal(cli.status,0,cli.stderr);const read=JSON.parse(cli.stdout);
   assert.equal(read.continuation.status,'loaded');assert.equal(read.continuation.next_step.text,expected);
   assert.throws(()=>store.resumeChatContinuation(f.root,{session_id:crypto.randomUUID(),workspace:f.dir,handoff_file:own.checkpoint.file}),/bound/);
   store.saveCheckpoint(f.root,{format_version:1,project_id:'Fixture',session_id:child,expected_parent:current.checkpoint_id,chat_task:{source_ref:'handoff_'+session,next_step:read.continuation.next_step},patch:{last_section:'Bound successor uptake',sources:{['handoff_'+session]:{path:own.checkpoint.file}}}});
   const closed=await m.exports.ensureSuccessor({...input,operation:'confirm_takeover',successor_session_id:child},{app,codexHome:home});assert.equal(closed.status,'archived_after_takeover');
 }
 assert.deepEqual(archived,[f.a,f.b]);assert.equal(prompts.length,2);
});

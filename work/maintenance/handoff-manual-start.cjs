'use strict';
// Native, user-operated chat link. Never creates a chat or changes hook trust.
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const UUID=/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i;
const digest=b=>crypto.createHash('sha256').update(b).digest('hex');
function read(p){if(fs.statSync(p).size>4*1024*1024)throw Error('Metadata too large');return JSON.parse(fs.readFileSync(p,'utf8').replace(/^\uFEFF/,''));}
function write(p,v){const tmp=p+'.'+crypto.randomUUID()+'.tmp';fs.writeFileSync(tmp,JSON.stringify(v,null,2)+'\n',{flag:'wx'});fs.renameSync(tmp,p);}
function real(p){if(typeof p!=='string'||!path.isAbsolute(p)||p.startsWith('\\\\')||p.startsWith('//'))throw Error('Local absolute path required');return fs.realpathSync(p);}
function within(p,root){const r=path.relative(root,p);return r===''||(!r.startsWith('..')&&!path.isAbsolute(r));}
function bound(input,home){
 if(!UUID.test(input.session_id||''))throw Error('Origin required');
 const root=real(input.handoff_root),cwd=real(input.cwd),dir=real(input.snapshot_path);
 if(!within(dir,path.join(real(home),'handoff-snapshots',input.session_id)))throw Error('Snapshot outside origin');
 const manifest=read(path.join(dir,'manifest.json'));
 if(manifest.status!=='PASS'||manifest.session_id!==input.session_id)throw Error('Unverified snapshot');
 const working=fs.readFileSync(path.join(dir,'working.md'));
 if(manifest.working_state?.file!=='working.md'||working.length!==manifest.working_state.bytes||digest(working)!==manifest.working_state.sha256)throw Error('Working copy mismatch');
 const cp=require('./handoff-store.cjs').resumeBoundCheckpoint(root,{session_id:input.session_id,workspace:cwd,markdown:working.toString('utf8')}).checkpoint;
 return {root,cwd,dir,manifest,cp,home:real(home)};
}
function offerManualStart(input,{codexHome=process.env.CODEX_HOME||path.join(require('node:os').homedir(),'.codex')}={}){
 const journalFile=path.join(real(input.handoff_root),input.session_id+'-status.json');
 if(fs.existsSync(journalFile)){
  const j=read(journalFile);
  if(j.freshnessBaseline?.snapshot_path)input={...input,snapshot_path:j.freshnessBaseline.snapshot_path};
 }
 const b=bound(input,codexHome),file=path.join(b.dir,'manual-start.json');
 const task=require('./handoff-store.cjs').chatTaskForCheckpoint(b.cp,input.session_id);
 const record={schema_version:1,session_id:input.session_id,cwd:b.cwd,handoff_root:b.root,snapshot_path:b.dir,handoff_file:b.cp.file,project_id:b.cp.project_id,checkpoint_id:b.cp.checkpoint_id};
 if(fs.existsSync(file)){if(JSON.stringify(read(file))!==JSON.stringify(record))throw Error('Manual offer changed');}else write(file,record);
 const guide=path.join(b.dir,'manual-start.md');
 const text=['# Manueller Chatstart durch den Nutzer','',
 'Der Nutzer hat diesen Startauftrag selbst abgesendet. Bestaetige sichtbar die Rolle als manueller Nachfolger.',
 'Keine Mitarbeit des alten Chats anfordern. Keine weiteren Chats erstellen. Die Automatiksperre bleibt erhalten.',
 'Angebot: '+file,'Ursprung: '+input.session_id,'Workspace: '+b.cwd,'Handoff: '+b.cp.file,'',
 '1. Ermittle die eigene echte aktuelle Turn-ID mit read_thread. Fuehre node C:\\TheHive\\work\\maintenance\\handoff-manual-start.cjs aus; JSON ueber stdin: '+JSON.stringify({operation:'accept',offer_file:file,turn_id:'<eigene aktuelle Turn-ID>',human_requested:true}),
 '2. Bei existing_successor nur den genannten Nachfolger oeffnen; eigenen neuen Auftrag erhalten, keine parallele Facharbeit. Bei origin_busy keine Facharbeit beginnen; Nutzer kann den alten Lauf stoppen und hier erneut senden. Bei Fehler keine Schutzpruefung umgehen.',
 '3. Bei manual_successor_bound den exakt genannten Handoff mit handoff-resume.ts --project '+b.cp.project_id+' --workspace '+JSON.stringify(b.cwd)+' --handoff '+JSON.stringify(b.cp.file)+' laden.',
 '4. Vor Facharbeit die in continuation.manual_context.transcript_source bezeichneten lokalen neueren Nutzernachrichten seit original_snapshot_bytes gezielt lesen. Neue Nachrichten haben Vorrang. Nichts verwerfen. Den aktualisierten eigenen Auftrag und eine knappe inhaltliche Zusammenfassung im eigenen Storecheckpoint sichern. Fuer diesen Zwischenstand nur zugelassene Patchfelder wie last_section und sources verwenden; status nicht auf completed setzen. chat_task steht neben patch und verweist auf einen vorhandenen sources-Eintrag. expected_parent frisch aus dem Store lesen. Unter sources.manual_context_review die zurueckgegebene transcript_copy als path und deren sha256 speichern; damit die gelesene Grenze binden.',
 '5. Erst danach die Uebernahme mit dem vorhandenen handoff-desktop.cjs operation confirm_takeover bestaetigen; snapshot_path bleibt die urspruengliche Snapshotreferenz. Archivierung nur ueber diesen kontrollierten Abschluss.',
 '', 'Bisheriger eigener naechster Schritt: '+task.next_step.text,''].join('\n');
 fs.writeFileSync(guide,text,'utf8');
 const prompt=['Projekt-ID: '+b.cp.project_id,'Handoff-Datei: '+guide,'Naechster offener Arbeitsschritt: Ich starte diesen Chat selbst als manuellen Nachfolger. Fuehre die gebundene manuelle Uebernahme aus dieser Datei aus und beruecksichtige meine neueren Nachrichten.'].join('\n');
 return {manual_start_url:'codex://threads/new?path='+encodeURIComponent(b.cwd)+'&prompt='+encodeURIComponent(prompt),manual_start_file:guide};
}
function manualContext(j,session,home){
 const m=j.manualAuthorization;
 if(!m||m.successor_session_id!==session||m.origin_session_id!==(j.originThreadId||j.origin_thread_id)||m.checkpoint_id!==j.checkpointId)throw Error('No manual successor authorization');
 const dir=real(m.snapshot_path);
 if(!within(dir,path.join(real(home),'handoff-snapshots',m.origin_session_id)))throw Error('Manual boundary outside origin');
 const receipt=read(path.join(dir,'manual-authorization.json'));
 if(JSON.stringify(receipt)!==JSON.stringify(m))throw Error('Manual receipt mismatch');
 const fresh=require('./handoff-freshness.cjs').checkSnapshotFreshness({snapshotPath:dir,codexHome:home,sessionId:m.origin_session_id});
 if(fresh.status!=='unchanged')throw Error('New origin message after manual authorization; retain both chats');
 return {transcript_source:fresh.source,transcript_copy:path.join(dir,'transcript.jsonl'),sha256:read(path.join(dir,'manifest.json')).transcript.sha256,original_snapshot_bytes:m.original_snapshot_bytes,snapshot_path:dir};
}
function manualProjectMatches(row,authorization,project,cwd){
 try{
  const p=authorization?.project_binding;
  return !!(row&&row.projectId==null&&row.kind==='codex'&&row.hostId==='local'&&
   (row.threadId||row.id)===authorization?.successor_session_id&&real(row.cwd)===real(cwd)&&
   p?.type==='app_move_acknowledgement'&&p.source==='codex'&&p.hostId==='local'&&
   p.threadId===authorization.successor_session_id&&p.projectId===project&&real(p.workspace)===real(cwd));
 }catch{return false;}
}
async function acceptManualStart(input){
 if(input.human_requested!==true||!UUID.test(process.env.CODEX_THREAD_ID||'')||!UUID.test(input.turn_id||''))throw Error('Explicit human start and actual successor turn required');
 const offer=read(real(input.offer_file)),home=process.env.CODEX_HOME||path.join(require('node:os').homedir(),'.codex'),b=bound(offer,home),child=process.env.CODEX_THREAD_ID;
 if(child===offer.session_id||real(process.cwd())!==b.cwd)throw Error('Actual successor workspace required');
 if(path.resolve(input.offer_file)!==path.join(b.dir,'manual-start.json'))throw Error('Offer location mismatch');
 const lock=path.join(b.root,offer.session_id+'-desktop.lock'),nonce=crypto.randomUUID();fs.writeFileSync(lock,nonce,{flag:'wx'});
 try{
  const journal=path.join(b.root,offer.session_id+'-status.json'),j=fs.existsSync(journal)?read(journal):{};
  if(j.originThreadId&&j.originThreadId!==offer.session_id)throw Error('Foreign journal');
  if(j.repositoryPath&&j.repositoryPath!==b.cwd)throw Error('Foreign workspace');
  if((j.checkpointId&&j.checkpointId!==b.cp.checkpoint_id)||(j.handoffFile&&j.handoffFile!==b.cp.file)||
     (j.project_id&&j.project_id!==b.cp.project_id)||(j.handoffRoot&&j.handoffRoot!==b.root))throw Error('Origin journal binding changed');
  const known=j.successorThreadId||j.successor_thread_id;
  if(known&&known!==child)return {status:'existing_successor',successor_thread_id:known};
  if(['creation_intent','creation_unknown','creation_pending'].includes(j.phase))throw Error('Creation outcome unresolved; do not duplicate');
  const app=require('./codex-app-pipe.cjs'),tools=await app.listTools({timeoutMs:5000});
  async function call(name,args){
   const tool=tools.find(t=>t.name===name);if(!tool)throw Error('App-Zugriff nicht verfuegbar: '+name);
   try{return app.decodeToolResult(await app.callAppTool({tool,args,threadId:child,turnId:input.turn_id,callId:crypto.randomUUID(),timeoutMs:5000}));}
   catch(e){throw Error('App-Zugriff fehlgeschlagen: '+name+' ('+(/^APP_[A-Z_]+$/.test(e.code||'')?e.code:'unbekannter Fehler')+')');}
  }
  const projects=(await call('list_projects',{})).projects||[];
  const matches=projects.filter(p=>{try{return p.projectKind==='local'&&p.hostId==='local'&&typeof p.path==='string'&&real(p.path)===b.cwd;}catch{return false;}});
  if(matches.length!==1)throw Error('Exact local app project required');
  const project=matches[0].projectId;
  const getChild=async()=>{const catalog=await call('list_threads',{limit:50});return [...(catalog.pinnedThreads||[]),...(catalog.threads||[])].find(t=>(t.threadId||t.id)===child);};
  let childRow=await getChild(),projectBinding=j.manualAuthorization?.project_binding||null;
  // A native path link sets the workspace, not project membership. Attach only
  // this actual caller, in the exact verified local directory and project.
  if(childRow?.projectId==null&&childRow?.kind==='codex'&&childRow?.hostId==='local'&&real(childRow.cwd)===b.cwd){
   const moved=await call('move_thread_to_project',{threadId:child,projectId:project,hostId:'local'});
   if(moved.source!=='codex'||moved.threadId!==child||moved.projectId!==project||moved.hostId!=='local')throw Error('Project assignment not acknowledged for exact caller');
   projectBinding={...moved,type:'app_move_acknowledgement',workspace:b.cwd};
   childRow=await getChild();
  }
  if(childRow?.projectId!==project&&!manualProjectMatches(childRow,{successor_session_id:child,project_binding:projectBinding},project,b.cwd))throw Error('Successor not in exact app project');
  const origin=await call('read_thread',{threadId:offer.session_id,turnLimit:1,includeOutputs:false,maxOutputCharsPerItem:200});
  if(origin.thread?.id!==offer.session_id)throw Error('Origin mismatch');
  if(!['idle','notLoaded'].includes(origin.thread.status?.type||origin.thread.status))return {status:'origin_busy'};
  if(known===child&&j.manualAuthorization){
   try{return {status:'manual_successor_bound',...manualContext(j,child,home)};}catch{/* A new explicit user start may capture a newer boundary; retain the previous receipt. */}
  }
  // Verify original prefix, then preserve a new, separate user-authorized boundary.
  const fresh=require('./handoff-freshness.cjs').checkSnapshotFreshness({snapshotPath:b.dir,codexHome:home,sessionId:offer.session_id});
  if(!['unchanged','new_user_message'].includes(fresh.status))throw Error('Original transcript cannot be verified');
  const transcript=fs.readFileSync(fresh.source);
  if(transcript.length>128*1024*1024||transcript.at(-1)!==10)throw Error('Incomplete or oversized transcript');
  if(digest(transcript.subarray(0,b.manifest.transcript.bytes))!==b.manifest.transcript.sha256)throw Error('Original prefix changed');
  const dir=path.join(b.dir,'manual-user-'+crypto.randomUUID());fs.mkdirSync(dir);
  const working=fs.readFileSync(path.join(b.dir,'working.md'));fs.writeFileSync(path.join(dir,'working.md'),working);fs.writeFileSync(path.join(dir,'transcript.jsonl'),transcript);
  write(path.join(dir,'manifest.json'),{...b.manifest,snapshot_path:dir,trigger:'manual',transcript:{...b.manifest.transcript,source:fresh.source,bytes:transcript.length,sha256:digest(transcript)}});
  if(require('./handoff-freshness.cjs').checkSnapshotFreshness({snapshotPath:dir,codexHome:home,sessionId:offer.session_id}).status!=='unchanged')throw Error('Transcript changed during manual start');
  const authorization={origin_session_id:offer.session_id,successor_session_id:child,checkpoint_id:b.cp.checkpoint_id,snapshot_path:dir,original_snapshot_bytes:b.manifest.transcript.bytes,requested_at:new Date().toISOString(),source_ref:input.offer_file,...(projectBinding?{project_binding:projectBinding}:{})};
  write(path.join(dir,'manual-authorization.json'),authorization);
  write(journal,{...j,originThreadId:offer.session_id,origin_thread_id:offer.session_id,successorThreadId:child,successor_thread_id:child,projectId:project,app_project_id:project,project_id:b.cp.project_id,repositoryPath:b.cwd,handoffRoot:b.root,checkpointId:b.cp.checkpoint_id,handoffFile:b.cp.file,phase:'successor_visible',freshnessBaseline:j.freshnessBaseline||{snapshot_path:b.dir,checkpoint_id:b.cp.checkpoint_id},automationCancelledAt:j.automationCancelledAt||new Date().toISOString(),automationCancelReason:j.automationCancelReason||'human_manual_start',manualAuthorization:authorization,updatedAt:new Date().toISOString()});
  return {status:'manual_successor_bound',...manualContext(read(journal),child,home)};
 }finally{if(fs.readFileSync(lock,'utf8')===nonce)fs.unlinkSync(lock);}
}
module.exports={offerManualStart,manualContext,manualProjectMatches,acceptManualStart};
if(require.main===module){let data='';process.stdin.setEncoding('utf8');process.stdin.on('data',c=>{data+=c;if(Buffer.byteLength(data)>65536)process.exit(1);});process.stdin.on('end',async()=>{try{const input=JSON.parse(data);if(input.operation!=='accept')throw Error('Manual accept only');process.stdout.write(JSON.stringify(await acceptManualStart(input))+'\n');}catch(e){process.stdout.write(JSON.stringify({status:'manual_start_blocked',reason:e.message})+'\n');process.exitCode=1;}});}

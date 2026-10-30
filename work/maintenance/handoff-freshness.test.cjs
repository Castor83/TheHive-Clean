'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),crypto=require('node:crypto');
const {checkSnapshotFreshness}=require('./handoff-freshness.cjs');
/**
 * Return the SHA-256 of fixture bytes for controlled integrity assertions.
 */
const hash=b=>crypto.createHash('sha256').update(b).digest('hex');
/**
 * Encode one synthetic JSONL row with its required newline boundary.
 */
const line=value=>Buffer.from(JSON.stringify(value)+'\n');
/**
 * Create a bound synthetic main-session transcript, snapshot copy and hash manifest with mutation helpers; register guarded temporary cleanup.
 */
function fixture(t){
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'thehive-freshness-'));
  t.after(()=>{assert.ok(path.resolve(dir).startsWith(path.resolve(os.tmpdir())+path.sep));assert.ok(path.basename(dir).startsWith('thehive-freshness-'));fs.rmSync(dir,{recursive:true,force:true});});
  const sessionId=crypto.randomUUID(),codexHome=path.join(dir,'codex'),source=path.join(codexHome,'sessions','2026','10','28','rollout-'+sessionId+'.jsonl');
  const snapshotPath=path.join(codexHome,'handoff-snapshots',sessionId,'capture'),copy=path.join(snapshotPath,'transcript.jsonl'),manifestFile=path.join(snapshotPath,'manifest.json');
  fs.mkdirSync(path.dirname(source),{recursive:true});fs.mkdirSync(snapshotPath,{recursive:true});fs.mkdirSync(path.join(codexHome,'archived_sessions'),{recursive:true});
  const manifest={status:'PASS',session_id:sessionId,transcript:{file:'transcript.jsonl',source,bytes:0,sha256:''}};
  /**
   * Persist the current synthetic transcript manifest after a deliberate fixture mutation.
   */
  const saveManifest=()=>fs.writeFileSync(manifestFile,JSON.stringify(manifest));
  /**
   * Replace fixture source and copy bytes together, update their byte count/hash and save the synthetic manifest.
   */
  const prefix=(bytes)=>{fs.writeFileSync(source,bytes);fs.writeFileSync(copy,bytes);manifest.transcript.bytes=bytes.length;manifest.transcript.sha256=hash(bytes);saveManifest();};
  prefix(Buffer.concat([line({type:'session_meta',payload:{id:sessionId,source:'cli'}}),line({type:'response_item',payload:{type:'message',role:'user',content:[{type:'input_text',text:'PRIVATE_SAVED_USER_TEXT'}]}})]));
  const args={snapshotPath,codexHome,sessionId};
  return {dir,args,source,copy,manifestFile,manifest,prefix,saveManifest,append:value=>fs.appendFileSync(source,line(value))};
}
/**
 * Assert the expected freshness status and bounded metadata shape, ensuring no private fixture text leaks into results.
 */
function inspect(result,status){
  assert.equal(result.status,status);assert.equal(typeof result.reason_code,'string');assert.ok(result.reason_code.length>0);
  assert.ok(Object.keys(result).every(key=>['status','reason_code','source','bytes'].includes(key)));
  assert.ok(!JSON.stringify(result).includes('PRIVATE_'));
}

test('a verified saved user message and no later input are unchanged',t=>{
  const f=fixture(t),result=checkSnapshotFreshness(f.args);inspect(result,'unchanged');
  assert.equal(result.source,fs.realpathSync(f.source));assert.equal(result.bytes,f.manifest.transcript.bytes);
});

test('assistant and tool suffix records alone are unchanged',t=>{
  const f=fixture(t);
  f.append({type:'response_item',payload:{type:'message',role:'assistant',content:'PRIVATE_ASSISTANT'}});
  f.append({type:'response_item',payload:{type:'function_call_output',call_id:'fixture',output:'PRIVATE_TOOL'}});
  f.append({type:'event_msg',payload:{type:'token_count',info:{}}});
  inspect(checkSnapshotFreshness(f.args),'unchanged');
});

test('either supported user record vetoes freshness without filtering client_authored',t=>{
  for(const row of [{type:'response_item',metadata:{client_authored:false},payload:{type:'message',role:'user',content:'PRIVATE_NEW_INPUT'}},{type:'event_msg',payload:{type:'user_message',message:'PRIVATE_NEW_INPUT'}}]){
    const f=fixture(t);f.append(row);inspect(checkSnapshotFreshness(f.args),'new_user_message');
  }
});

test('the exact archived basename is a hash-bound fallback only when the original is missing',t=>{
  const f=fixture(t),archived=path.join(f.args.codexHome,'archived_sessions',path.basename(f.source));
  fs.renameSync(f.source,archived);fs.appendFileSync(archived,line({type:'event_msg',payload:{type:'user_message',message:'PRIVATE_ARCHIVED_INPUT'}}));
  const result=checkSnapshotFreshness(f.args);inspect(result,'new_user_message');assert.equal(result.source,fs.realpathSync(archived));
});

test('an existing changed source never falls back to a matching archived copy',t=>{
  const f=fixture(t);fs.copyFileSync(f.source,path.join(f.args.codexHome,'archived_sessions',path.basename(f.source)));
  fs.writeFileSync(f.source,Buffer.alloc(f.manifest.transcript.bytes,0x78));inspect(checkSnapshotFreshness(f.args),'unverifiable');
});

test('the archive fallback cannot redirect to another allowed session file',t=>{
  const f=fixture(t),archive=path.join(f.args.codexHome,'archived_sessions',path.basename(f.source)),other=path.join(path.dirname(f.source),'other',path.basename(f.source));
  fs.mkdirSync(path.dirname(other));fs.copyFileSync(f.source,other);fs.unlinkSync(f.source);
  const module={exports:{}},observedFs={...fs,realpathSync(file){return path.resolve(file)===archive?other:fs.realpathSync(file);}};
  new Function('require','module',fs.readFileSync(path.join(__dirname,'handoff-freshness.cjs'),'utf8'))(name=>name==='node:fs'?observedFs:require(name),module);
  inspect(module.exports.checkSnapshotFreshness(f.args),'unverifiable');
});

test('missing, shrunk or changed transcript data are unverifiable',t=>{
  for(const damage of ['missing','source_shrunk','source_changed','copy_changed','copy_missing','bad_hash','bad_manifest']){
    const f=fixture(t);
    if(damage==='missing')fs.unlinkSync(f.source);
    if(damage==='source_shrunk')fs.truncateSync(f.source,f.manifest.transcript.bytes-1);
    if(damage==='source_changed')fs.writeFileSync(f.source,Buffer.alloc(f.manifest.transcript.bytes,0x78));
    if(damage==='copy_changed')fs.writeFileSync(f.copy,Buffer.alloc(f.manifest.transcript.bytes,0x78));
    if(damage==='copy_missing')fs.unlinkSync(f.copy);
    if(damage==='bad_hash'){f.manifest.transcript.sha256='0'.repeat(64);f.saveManifest();}
    if(damage==='bad_manifest')fs.writeFileSync(f.manifestFile,'{');
    inspect(checkSnapshotFreshness(f.args),'unverifiable');
  }
});

test('snapshot or source identities outside the bound main session are unverifiable',t=>{
  for(const damage of ['manifest_session','header_session','subagent','remote','outside','wrong_basename','foreign_snapshot']){
    const f=fixture(t);
    if(damage==='manifest_session')f.manifest.session_id=crypto.randomUUID();
    if(damage==='header_session')f.prefix(line({type:'session_meta',payload:{id:crypto.randomUUID(),source:'cli'}}));
    if(damage==='subagent')f.prefix(line({type:'session_meta',payload:{id:f.args.sessionId,source:{subagent:{parent_thread_id:crypto.randomUUID()}}}}));
    if(damage==='remote')f.manifest.transcript.source='\\\\server\\share\\rollout-'+f.args.sessionId+'.jsonl';
    if(damage==='outside'){const outside=path.join(f.dir,'rollout-'+f.args.sessionId+'.jsonl');fs.copyFileSync(f.source,outside);f.manifest.transcript.source=outside;}
    if(damage==='wrong_basename'){const other=path.join(path.dirname(f.source),'rollout-'+crypto.randomUUID()+'.jsonl');fs.copyFileSync(f.source,other);f.manifest.transcript.source=other;}
    if(damage==='foreign_snapshot')f.args.sessionId=crypto.randomUUID();
    f.saveManifest();inspect(checkSnapshotFreshness(f.args),'unverifiable');
  }
});

test('partial JSONL, invalid UTF8 and a saved boundary inside a row are unverifiable',t=>{
  for(const damage of ['partial_suffix','invalid_json','invalid_utf8','partial_prefix','invalid_saved_json']){
    const f=fixture(t);
    if(damage==='partial_suffix')fs.appendFileSync(f.source,'{"type":"response_item"');
    if(damage==='invalid_json')fs.appendFileSync(f.source,'not-json\n');
    if(damage==='invalid_utf8')fs.appendFileSync(f.source,Buffer.from([0xc3,0x28,0x0a]));
    if(damage==='partial_prefix')f.prefix(Buffer.concat([fs.readFileSync(f.copy),Buffer.from('{"type":')]));
    if(damage==='invalid_saved_json')f.prefix(Buffer.concat([fs.readFileSync(f.copy),Buffer.from('not-json\n')]));
    inspect(checkSnapshotFreshness(f.args),'unverifiable');
  }
});

test('a malformed suffix never becomes unchanged even if it also contains a user row',t=>{
  const f=fixture(t);f.append({type:'event_msg',payload:{type:'user_message',message:'PRIVATE_NEW_INPUT'}});fs.appendFileSync(f.source,'{');
  inspect(checkSnapshotFreshness(f.args),'unverifiable');
});

test('oversized saved prefixes or suffixes are refused before unbounded reads',t=>{
  const prefix=fixture(t);prefix.manifest.transcript.bytes=128*1024*1024+1;prefix.saveManifest();inspect(checkSnapshotFreshness(prefix.args),'unverifiable');
  const suffix=fixture(t);fs.truncateSync(suffix.source,suffix.manifest.transcript.bytes+4*1024*1024+1);inspect(checkSnapshotFreshness(suffix.args),'unverifiable');
});

test('null and invalid arguments fail closed',()=>{
  for(const args of [null,undefined,{},[],{snapshotPath:'.',codexHome:'.',sessionId:crypto.randomUUID()},{snapshotPath:'C:\\missing',codexHome:'C:\\missing',sessionId:'invalid'}])inspect(checkSnapshotFreshness(args),'unverifiable');
});

test('growth during a source read is unverifiable',t=>{
  const f=fixture(t),module={exports:{}},source=path.join(__dirname,'handoff-freshness.cjs');let sourceFd,grew=false;
  const observedFs={...fs,openSync(file,...rest){const fd=fs.openSync(file,...rest);if(path.resolve(file)===f.source)sourceFd=fd;return fd;},readSync(fd,...rest){
    const read=fs.readSync(fd,...rest);
    if(fd===sourceFd&&!grew){grew=true;f.append({type:'event_msg',payload:{type:'token_count',info:{}}});}
    return read;
  }};
  new Function('require','module',fs.readFileSync(source,'utf8'))(name=>name==='node:fs'?observedFs:require(name),module);
  inspect(module.exports.checkSnapshotFreshness(f.args),'unverifiable');
});

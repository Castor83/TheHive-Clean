'use strict';
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const {TextDecoder}=require('node:util');
const UUID=/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i;
const MAX_PREFIX=128*1024*1024,MAX_SUFFIX=4*1024*1024;
const hash=bytes=>crypto.createHash('sha256').update(bytes).digest('hex');
function fail(reason){const error=Error(reason);error.freshnessReason=reason;throw error;}
function local(file){
  if(typeof file!=='string'||!file||file.includes('\0'))fail('invalid_local_path');
  if(/^\\\\\?\\[a-z]:[\\/]/i.test(file))file=file.slice(4);
  if(!(/^[a-z]:[\\/]/i.test(file)||(process.platform!=='win32'&&file.startsWith('/')&&!file.startsWith('//')&&!file.startsWith('/\\'))))fail('invalid_local_path');
  return file;
}
function real(file){return local(fs.realpathSync(local(file)));}
function inside(file,root){const relative=path.relative(root,file);return relative===''||(!relative.startsWith('..'+path.sep)&&relative!=='..'&&!path.isAbsolute(relative));}
function sameStat(a,b){return a.size===b.size&&a.dev===b.dev&&a.ino===b.ino&&a.mtimeMs===b.mtimeMs&&a.ctimeMs===b.ctimeMs;}
function readExactly(fd,size,position=0){
  const bytes=Buffer.alloc(size);let offset=0;
  while(offset<size){const count=fs.readSync(fd,bytes,offset,size-offset,position+offset);if(!count)fail('short_read');offset+=count;}
  return bytes;
}
function readStable(file,limit){
  const fd=fs.openSync(file,'r');
  try{
    const before=fs.fstatSync(fd);if(!before.isFile()||before.size>limit)fail('file_size_or_type_invalid');
    const bytes=readExactly(fd,before.size);
    if(!sameStat(before,fs.fstatSync(fd))||!sameStat(before,fs.statSync(file)))fail('file_changed_during_read');
    return bytes;
  }finally{fs.closeSync(fd);}
}
function utf8(bytes){try{return new TextDecoder('utf-8',{fatal:true}).decode(bytes);}catch{fail('invalid_utf8');}}
function jsonl(bytes,sessionId){
  if(!bytes.length)return {first:null,user:false};
  if(bytes[bytes.length-1]!==0x0a)fail('incomplete_jsonl');
  const lines=utf8(bytes).split('\n');lines.pop();let first=null,user=false;
  for(const text of lines){
    let row;try{row=JSON.parse(text);}catch{fail('invalid_jsonl');}
    if(!row||typeof row!=='object'||Array.isArray(row)||typeof row.type!=='string')fail('invalid_jsonl');
    if(first===null)first=row;
    const payload=row.payload;
    if(row.type==='session_meta'){
      if(!payload||payload.id!==sessionId)fail('foreign_session');
      const source=payload.source;
      if(payload.subagent_id||payload.agent_id||source==='subagent'||(source&&typeof source==='object'&&(Object.hasOwn(source,'subagent')||source.type==='subagent')))fail('subagent_session');
    }
    if(row.type==='response_item'||row.type==='event_msg'){
      if(!payload||typeof payload!=='object'||Array.isArray(payload))fail('invalid_jsonl');
      if((row.type==='response_item'&&payload.role==='user')||(row.type==='event_msg'&&payload.type==='user_message'))user=true;
    }
  }
  return {first,user};
}
function checkSnapshotFreshness(args){
  try{
    if(!args||typeof args!=='object'||Array.isArray(args)||!UUID.test(args.sessionId||''))fail('invalid_arguments');
    const {sessionId}=args,home=real(args.codexHome),snapshot=real(args.snapshotPath);
    if(!fs.statSync(home).isDirectory()||!inside(snapshot,path.join(home,'handoff-snapshots',sessionId)))fail('snapshot_binding_invalid');
    const manifestFile=real(path.join(snapshot,'manifest.json')),copyFile=real(path.join(snapshot,'transcript.jsonl'));
    if(!inside(manifestFile,snapshot)||!inside(copyFile,snapshot))fail('snapshot_binding_invalid');
    let manifest;try{manifest=JSON.parse(utf8(readStable(manifestFile,4*1024*1024)).replace(/^\uFEFF/,''));}catch(error){if(error.freshnessReason)throw error;fail('invalid_manifest');}
    if(!manifest||manifest.status!=='PASS'||manifest.session_id!==sessionId)fail('manifest_binding_invalid');
    const entry=manifest.transcript;
    if(!entry||entry.file!=='transcript.jsonl'||!Number.isSafeInteger(entry.bytes)||entry.bytes<=0||entry.bytes>MAX_PREFIX||!(/^[a-f0-9]{64}$/i.test(entry.sha256||'')))fail('transcript_metadata_invalid');
    const saved=readStable(copyFile,MAX_PREFIX);
    if(saved.length!==entry.bytes||hash(saved)!==entry.sha256)fail('snapshot_hash_mismatch');
    const parsed=jsonl(saved,sessionId);
    if(parsed.first?.type!=='session_meta')fail('session_header_missing');
    const allowed=[path.join(home,'sessions'),path.join(home,'archived_sessions')];
    const declared=path.resolve(local(entry.source));
    if(!allowed.some(root=>inside(declared,root))||!path.basename(declared).endsWith(sessionId+'.jsonl'))fail('source_binding_invalid');
    let source;
    try{source=real(declared);}catch(error){
      if(error.code!=='ENOENT')throw error;
      const archived=path.join(home,'archived_sessions',path.basename(declared));source=real(archived);
      if(path.relative(archived,source)!=='')fail('archived_fallback_redirected');
    }
    if(!allowed.some(root=>inside(source,root))||!path.basename(source).endsWith(sessionId+'.jsonl'))fail('source_binding_invalid');
    const fd=fs.openSync(source,'r');let suffix;
    try{
      const before=fs.fstatSync(fd);
      if(!before.isFile()||before.size<entry.bytes)fail('source_shrunk_or_invalid');
      if(before.size-entry.bytes>MAX_SUFFIX)fail('suffix_too_large');
      const digest=crypto.createHash('sha256'),chunk=Buffer.alloc(Math.min(1024*1024,entry.bytes));let offset=0;
      while(offset<entry.bytes){const size=Math.min(chunk.length,entry.bytes-offset),count=fs.readSync(fd,chunk,0,size,offset);if(!count)fail('short_read');digest.update(chunk.subarray(0,count));offset+=count;}
      if(digest.digest('hex')!==entry.sha256)fail('source_prefix_changed');
      suffix=readExactly(fd,before.size-entry.bytes,entry.bytes);
      if(!sameStat(before,fs.fstatSync(fd))||!sameStat(before,fs.statSync(source))||path.relative(real(source),source)!=='')fail('source_changed_during_read');
    }finally{fs.closeSync(fd);}
    const result=jsonl(suffix,sessionId);
    return {status:result.user?'new_user_message':'unchanged',reason_code:result.user?'new_user_message':'no_new_user_message',source,bytes:entry.bytes};
  }catch(error){return {status:'unverifiable',reason_code:error.freshnessReason||'read_error'};}
}
module.exports={checkSnapshotFreshness};

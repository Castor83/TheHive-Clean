'use strict';
// Display names only. Existing session IDs and recovery titles remain identities.
const fs=require('node:fs'),path=require('node:path');
const UUID=/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i;
/**
 * Remove a recognized handoff status prefix from a display title and trim it; return empty text for non-strings.
 */
function cleanTitle(title){
 if(typeof title!=='string')return '';
 return title.replace(/^\[(?:Hier weiter|Übergabe[^\]]*|Weiterleitung[^\]]*|Wechsel fehlgeschlagen)\]\s*/,'').trim();
}
/**
 * Build a bounded display title from a base and positive safe sequence; preserve identities separately and throw when no base is available.
 */
function numberedTitle(base,sequence){
 if(!Number.isSafeInteger(sequence)||sequence<1)throw Error('Invalid chat sequence');
 const suffix=sequence===1?'':' · '+sequence;
 const title=cleanTitle(base);if(!title)throw Error('Original chat title unavailable');
 return Array.from(title).slice(0,230-suffix.length).join('')+suffix;
}
/**
 * Read bounded matching local journals to follow one naming ancestry; return root identity, sequence and titles, rejecting cycles or ambiguous parents.
 * @param {object} input Origin UUID, exact project/workspace/root binding, optional known sessions and title fallbacks.
 * @returns {object} Resolved naming metadata for current and successor display titles; journals are read only.
 */
function resolveNaming({root,session_id,project_id,workspace,title,sessions,titles={}}){
 if(!UUID.test(session_id||''))throw Error('Actual naming origin required');
 root=fs.realpathSync(root);workspace=fs.realpathSync(workspace);
 sessions??=fs.readdirSync(root).filter(name=>name.endsWith('-status.json')).map(name=>name.slice(0,-12));
 const records=new Map();
 for(const id of new Set([session_id,...sessions])){
  if(!UUID.test(id||''))continue;
  const file=path.join(root,id+'-status.json');
  if(!fs.existsSync(file))continue;
  const stat=fs.lstatSync(file);if(!stat.isFile()||stat.isSymbolicLink()||stat.size>4*1024*1024)continue;
  let j;try{j=JSON.parse(fs.readFileSync(file,'utf8'));}catch{continue;}
  const origin=j.originThreadId||j.origin_thread_id,child=j.successorThreadId||j.successor_thread_id;
  if(origin!==id||j.project_id!==project_id||
    (j.originThreadId&&j.origin_thread_id&&j.originThreadId!==j.origin_thread_id)||
    (j.successorThreadId&&j.successor_thread_id&&j.successorThreadId!==j.successor_thread_id))continue;
  try{if(path.relative(fs.realpathSync(j.handoffRoot),root)!==''||path.relative(fs.realpathSync(j.repositoryPath),workspace)!=='')continue;}catch{continue;}
  records.set(id,{...j,child});
 }
 let current=session_id,distance=0;const seen=new Set();
 for(let depth=0;depth<128;depth++){
  if(seen.has(current))throw Error('Chat naming chain cycle');seen.add(current);
  const own=records.get(current),n=own?.naming;
  if(n&&UUID.test(n.root_session_id||'')&&Number.isSafeInteger(n.sequence)&&n.sequence>=1&&cleanTitle(n.base_title)){
   const sequence=n.sequence+distance,base=cleanTitle(n.base_title);
   return {root_session_id:n.root_session_id,base_title:base,sequence,current_title:numberedTitle(base,sequence),successor_title:numberedTitle(base,sequence+1)};
  }
  const parents=[...records.entries()].filter(([,j])=>j.child===current);
  if(parents.length>1)throw Error('Ambiguous chat naming parent');
  if(parents.length===1){current=parents[0][0];distance++;continue;}
  const base=cleanTitle(own?.originTitle||titles[current]||(distance===0?title:''));
  if(!base){const error=Error('Original chat title unavailable');error.code='ORIGINAL_CHAT_TITLE_UNAVAILABLE';error.root_session_id=current;throw error;}
  const sequence=distance+1;
  return {root_session_id:current,base_title:base,sequence,current_title:numberedTitle(base,sequence),successor_title:numberedTitle(base,sequence+1)};
 }
 throw Error('Chat naming chain exceeds bound');
}
/**
 * Resolve local naming first; only when the root title is missing, call readTitle for that exact UUID and retry after identity validation.
 * @param {object} input Naming context accepted by resolveNaming.
 * @param {Function} readTitle Asynchronous reader returning the requested thread identity and title.
 * @returns {Promise<object>} Resolved naming metadata; other lookup failures propagate.
 */
async function resolveAppNaming(input,readTitle){
 try{return resolveNaming(input);}catch(error){
  if(error.code!=='ORIGINAL_CHAT_TITLE_UNAVAILABLE')throw error;
  const row=await readTitle(error.root_session_id);
  if(row?.id!==error.root_session_id||!cleanTitle(row.title))throw Error('Original naming identity unavailable');
  return resolveNaming({...input,titles:{[row.id]:row.title}});
 }
}
module.exports={cleanTitle,numberedTitle,resolveNaming,resolveAppNaming};

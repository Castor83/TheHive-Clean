'use strict';
// Thin client for the EXISTING desktop pipe used by bundled codex-app-tools.
// Source: installed server.mjs, NativePipeClient/encodeFrame, 26.1021.31345.
// No listener, app-server, model, network port, or plugin changes.
const net=require('node:net');
const crypto=require('node:crypto');
const MAX_FRAME=8*1024*1024;
const ALLOWED=new Set(['list_projects','list_threads','create_thread','read_thread','wait_threads',
  'navigate_to_codex_page','set_thread_archived','set_thread_title','move_thread_to_project']);
const UUID=/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i;
function failure(code,sent=false){const e=Error(code);e.code=code;e.requestMayHaveBeenSent=sent;return e;}
function request(method,params,{pipePath=process.env.CODEX_APP_TOOLS_PIPE_PATH,timeoutMs=20000}={}){
  if(typeof pipePath!=='string'||!pipePath.startsWith('\\\\.\\pipe\\'))return Promise.reject(failure('APP_LOCAL_PIPE_UNAVAILABLE'));
  if(!Number.isInteger(timeoutMs)||timeoutMs<1||timeoutMs>60000)return Promise.reject(failure('APP_INVALID_TIMEOUT'));
  const id=crypto.randomUUID(),body=Buffer.from(JSON.stringify({id,jsonrpc:'2.0',method,params}));
  if(body.length>MAX_FRAME)return Promise.reject(failure('APP_REQUEST_TOO_LARGE'));
  const header=Buffer.alloc(4);header.writeUInt32LE(body.length);
  return new Promise((resolve,reject)=>{
    let sent=false,done=false,buffer=Buffer.alloc(0);
    const socket=net.createConnection(pipePath);
    const finish=(error,result)=>{if(done)return;done=true;clearTimeout(timer);socket.destroy();error?reject(error):resolve(result);};
    const timer=setTimeout(()=>finish(failure('APP_TIMEOUT',sent)),timeoutMs);
    socket.once('connect',()=>{sent=true;socket.write(Buffer.concat([header,body]));});
    socket.on('error',()=>finish(failure('APP_CONNECTION_ERROR',sent)));
    socket.once('close',()=>finish(failure('APP_CONNECTION_CLOSED',sent)));
    socket.on('data',chunk=>{
      buffer=Buffer.concat([buffer,chunk]);
      if(buffer.length<4)return;
      const length=buffer.readUInt32LE(0);
      if(!length||length>MAX_FRAME)return finish(failure('APP_INVALID_RESPONSE',sent));
      if(buffer.length<4+length)return;
      try{
        const text=new TextDecoder('utf-8',{fatal:true}).decode(buffer.subarray(4,4+length));
        const value=JSON.parse(text);
        if(value.jsonrpc!=='2.0'||value.id!==id||(!Object.hasOwn(value,'result')&&!Object.hasOwn(value,'error')))
          return finish(failure('APP_INVALID_RESPONSE',sent));
        if(value.error)return finish(failure('APP_REMOTE_ERROR',sent));
        finish(null,value.result);
      }catch{return finish(failure('APP_INVALID_RESPONSE',sent));}
    });
  });
}
async function listTools(options={}){
  const result=await request('tools/list',{threadStartKind:'all'},options);
  if(!Array.isArray(result?.tools)||result.tools.some(t=>typeof t.name!=='string'||typeof t.namespace!=='string'||!t.inputSchema))
    throw failure('APP_INVALID_CATALOG',true);
  return result.tools;
}
async function callAppTool({tool,args,threadId,turnId,callId,...options}){
  if(!ALLOWED.has(tool?.name))throw Error('App tool not allowed by the handoff client');
  if(typeof tool.namespace!=='string'||!tool.namespace||!UUID.test(threadId||'')||!UUID.test(turnId||'')||
      typeof callId!=='string'||!callId||callId.length>160||!args||typeof args!=='object'||Array.isArray(args))
    throw failure('APP_INVALID_CONTEXT');
  const result=await request('tools/call',{arguments:args,callerSource:'codex',callId,
    namespace:tool.namespace,threadId,tool:tool.name,turnId},options);
  if(typeof result?.success!=='boolean'||!Array.isArray(result.contentItems))throw failure('APP_INVALID_TOOL_RESULT',true);
  if(!result.success)throw failure('APP_TOOL_FAILED',true);
  return result;
}
function decodeToolResult(result){
  const blocks=result.contentItems.filter(x=>x.type==='inputText'&&typeof x.text==='string');
  if(blocks.length!==1)throw failure('APP_UNSUPPORTED_RESULT_SHAPE',true);
  try{return JSON.parse(blocks[0].text);}catch{throw failure('APP_UNSUPPORTED_RESULT_SHAPE',true);}
}
module.exports={listTools,callAppTool,decodeToolResult};

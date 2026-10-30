'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const net=require('node:net');
const crypto=require('node:crypto');
const {listTools,callAppTool,decodeToolResult}=require('./codex-app-pipe.cjs');
const fixtureTool={name:'list_projects',namespace:'codex_app',inputSchema:{type:'object'}};
function frame(value){const b=Buffer.from(JSON.stringify(value));const h=Buffer.alloc(4);h.writeUInt32LE(b.length);return Buffer.concat([h,b]);}
async function fixture(t,handler){
  const pipe='\\\\.\\pipe\\thehive-offline-fixture-'+crypto.randomUUID();
  const server=net.createServer(socket=>{
    let bytes=Buffer.alloc(0);
    socket.on('error',()=>{});
    socket.on('data',data=>{
      bytes=Buffer.concat([bytes,data]);
      if(bytes.length>=4&&bytes.length>=4+bytes.readUInt32LE(0)){
        const req=JSON.parse(bytes.subarray(4,4+bytes.readUInt32LE(0)).toString());bytes=Buffer.alloc(0);handler(req,socket);
      }
    });
  });
  await new Promise((resolve,reject)=>server.once('error',reject).listen(pipe,resolve));
  t.after(()=>new Promise(resolve=>server.close(resolve)));
  return pipe;
}
test('reads existing app catalog with bounded fragmented native framing',async t=>{
  const pipePath=await fixture(t,(req,socket)=>{
    assert.equal(req.method,'tools/list');assert.deepEqual(req.params,{threadStartKind:'all'});
    const reply=frame({jsonrpc:'2.0',id:req.id,result:{tools:[fixtureTool]}});
    socket.write(reply.subarray(0,2));setImmediate(()=>socket.end(reply.subarray(2)));
  });
  assert.deepEqual(await listTools({pipePath}),[fixtureTool]);
});
test('forwards exact existing-thread context and only allowed tools',async t=>{
  const threadId=crypto.randomUUID(),turnId=crypto.randomUUID();
  const pipePath=await fixture(t,(req,socket)=>{
    assert.equal(req.method,'tools/call');assert.equal(req.params.threadId,threadId);
    assert.equal(req.params.turnId,turnId);assert.equal(req.params.tool,'list_projects');
    assert.equal(req.params.callerSource,'codex');assert.equal(req.params.callId,'fixture-call');
    socket.end(frame({jsonrpc:'2.0',id:req.id,result:{success:true,contentItems:[{type:'inputText',text:'{"projects":[]}' }]}}));
  });
  const result=await callAppTool({pipePath,tool:fixtureTool,args:{},threadId,turnId,callId:'fixture-call'});
  assert.equal(result.success,true);
  await assert.rejects(()=>callAppTool({pipePath,tool:{...fixtureTool,name:'send_message_to_thread'},args:{},threadId,turnId,callId:'x'}),/allowed/i);
});
test('a timeout after send has an explicitly unknown outcome and no retry',async t=>{
  let calls=0;
  const pipePath=await fixture(t,(_req,socket)=>{calls++;setTimeout(()=>socket.destroy(),80);});
  await assert.rejects(()=>listTools({pipePath,timeoutMs:20}),error=>error.code==='APP_TIMEOUT'&&error.requestMayHaveBeenSent===true);
  assert.equal(calls,1);
});
test('rejects oversized or invalid responses without interpreting success',async t=>{
  const pipePath=await fixture(t,(_req,socket)=>{const header=Buffer.alloc(4);header.writeUInt32LE(8*1024*1024+1);socket.end(header);});
  await assert.rejects(()=>listTools({pipePath}),error=>error.code==='APP_INVALID_RESPONSE');
});

test('malformed catalog entries preserve the sent-request error contract',async t=>{
  for(const entry of [null, 42, {}]){
    const pipePath=await fixture(t,(req,socket)=>socket.end(frame({jsonrpc:'2.0',id:req.id,result:{tools:[entry]}})));
    await assert.rejects(()=>listTools({pipePath}),e=>e.code==='APP_INVALID_CATALOG'&&e.requestMayHaveBeenSent===true);
  }
});
test('null tool-result blocks cannot lose the sent-request marker',()=>{
  assert.throws(()=>decodeToolResult({contentItems:[null]}),e=>e.code==='APP_UNSUPPORTED_RESULT_SHAPE'&&e.requestMayHaveBeenSent===true);
  assert.deepEqual(decodeToolResult({contentItems:[null,{type:'inputText',text:'{"ok":true}'}]}),{ok:true});
});

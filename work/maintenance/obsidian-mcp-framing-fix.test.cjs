'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),vm=require('node:vm');
const {patched,prepare}=require('./obsidian-mcp-framing-fix.cjs');
const source='this.server.post("/mcp",async(l,o)=>{let u=await this.mcpHandler.handleRequest(l.body);this.logger.debug("Sending response for:",l.method,l.id),o.code(200).header("Content-Type","application/json").send(u)}),this.port=this.current.serverPort()';
/**
 * Extract the route callback from fixture JavaScript and bind a simulated MCP handler.
 * @param text - Original or patched fixture source.
 * @param response - JSON-RPC result returned by the handler.
 * @returns Callable route in a VM context; no real server is started.
 */
function routeFrom(text,response){
  const start=text.indexOf('this.server.post("/mcp",');
  const end=text.indexOf('}),this.port=this.current.serverPort()',start);
  assert.ok(start>=0&&end>start,'Installed expected route found');
  const expression=text.slice(start+'this.server.post("/mcp",'.length,end+1);
  const factory=vm.runInNewContext('(function(){return '+expression+';})',{Buffer});
  return factory.call({logger:{debug(){},warn(){}},mcpHandler:{/** Return the supplied JSON-RPC fixture response without transport I/O. */ async handleRequest(){return response;}}});
}
// Exercises the real extracted route callback, using the HTTP reply boundary.
// A wrong/missing UTF-8 length or an altered JSON-RPC body breaks the contract.
test('prepared MCP reply is fixed-length UTF-8 JSON with unchanged protocol content',async()=>{
  const changed=patched(source);
  const response={jsonrpc:'2.0',id:7,result:{content:[{type:'text',text:'Prüfung: Straße ✓'}]}};
  const captured={headers:{}};
  const reply={/** Capture the HTTP status and preserve fluent reply chaining. @param status - Numeric HTTP status. */ code(status){captured.status=status;return this;},/** Capture a stringified response header. @param k - Header name. @param v - Header value. */ header(k,v){captured.headers[k]=String(v);return this;},/** Capture the exact outgoing body for byte-length and protocol assertions. @param body - Outgoing payload. */ send(body){captured.body=body;return this;}};
  await routeFrom(changed,response)({body:{jsonrpc:'2.0',id:7,method:'tools/call'}},reply);
  assert.equal(captured.status,200);
  assert.equal(typeof captured.body,'string');
  assert.equal(captured.headers['Content-Length'],String(Buffer.byteLength(captured.body,'utf8')));
  assert.ok(Number(captured.headers['Content-Length'])>captured.body.length);
  assert.deepEqual(JSON.parse(captured.body),response);
});
test('unexpected, repeated or already patched source cannot be rewritten',()=>{
  assert.throws(()=>patched('different installed source'),/refused/);
  assert.throws(()=>patched(source+source),/refused/);
  assert.throws(()=>patched(patched(source)),/refused/);
});

test('preparation creates its report directory in a fresh isolated vault',()=>{
  const os=require('node:os'),path=require('node:path');
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'thehive-obsidian-fixture-'));
  try{
    const plugin=path.join(root,'.obsidian/plugins/vault-as-mcp');fs.mkdirSync(plugin,{recursive:true});
    fs.writeFileSync(path.join(plugin,'manifest.json'),JSON.stringify({id:'vault-as-mcp',version:'1.2.1'}));
    fs.writeFileSync(path.join(plugin,'main.js'),source);
    const report=prepare(root);
    assert.equal(report.applied,false);
    assert.equal(fs.readFileSync(path.join(plugin,'main.js'),'utf8'),source);
    assert.equal(fs.existsSync(path.join(root,'work/verification/obsidian-mcp-framing-repair-plan-20261026.json')),true);
    assert.equal(fs.readFileSync(report.candidate,'utf8'),patched(source));
  }finally{assert.ok(path.resolve(root).startsWith(path.resolve(os.tmpdir())+path.sep));fs.rmSync(root,{recursive:true,force:true});}
});

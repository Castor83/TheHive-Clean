'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),vm=require('node:vm');
const {patched}=require('./obsidian-mcp-framing-fix.cjs');
const source=fs.readFileSync('C:/TheHive/.obsidian/plugins/vault-as-mcp/main.js','utf8');
function routeFrom(text,response){
  const start=text.indexOf('this.server.post("/mcp",');
  const end=text.indexOf('}),this.port=this.current.serverPort()',start);
  assert.ok(start>=0&&end>start,'Installed expected route found');
  const expression=text.slice(start+'this.server.post("/mcp",'.length,end+1);
  const factory=vm.runInNewContext('(function(){return '+expression+';})',{Buffer});
  return factory.call({logger:{debug(){},warn(){}},mcpHandler:{async handleRequest(){return response;}}});
}
// Exercises the real extracted route callback, using the HTTP reply boundary.
// A wrong/missing UTF-8 length or an altered JSON-RPC body breaks the contract.
test('prepared MCP reply is fixed-length UTF-8 JSON with unchanged protocol content',async()=>{
  const changed=patched(source);
  const response={jsonrpc:'2.0',id:7,result:{content:[{type:'text',text:'Prüfung: Straße ✓'}]}};
  const captured={headers:{}};
  const reply={code(status){captured.status=status;return this;},header(k,v){captured.headers[k]=String(v);return this;},send(body){captured.body=body;return this;}};
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

'use strict';
// Narrow, source-bound repair preparation. Does not alter or reload the plugin.
const fs=require('node:fs');
const path=require('node:path');
const crypto=require('node:crypto');
const before='this.logger.debug("Sending response for:",l.method,l.id),o.code(200).header("Content-Type","application/json").send(u)';
const after='this.logger.debug("Sending response for:",l.method,l.id);const responseBody=JSON.stringify(u);o.code(200).header("Content-Type","application/json").header("Content-Length",Buffer.byteLength(responseBody,"utf8")).send(responseBody)';
function patched(source){
  if(typeof source!=='string'||source.split(before).length!==2||source.includes(after))throw Error('Installed route differs or is ambiguous; repair refused');
  return source.replace(before,after);
}
function prepare(root='C:/TheHive'){
  const plugin=path.join(root,'.obsidian/plugins/vault-as-mcp');
  const manifest=JSON.parse(fs.readFileSync(path.join(plugin,'manifest.json'),'utf8'));
  if(manifest.id!=='vault-as-mcp'||manifest.version!=='1.2.1')throw Error('Unexpected plugin version; inspect first');
  const file=path.join(plugin,'main.js'),original=fs.readFileSync(file),candidate=Buffer.from(patched(original.toString('utf8')));
  const sha=bytes=>crypto.createHash('sha256').update(bytes).digest('hex');
  const originalHash=sha(original),candidateHash=sha(candidate);
  const dir=path.join(root,'work/maintenance/repairs',originalHash.slice(0,16)+'-fixed-length');
  fs.mkdirSync(dir,{recursive:true});
  const output=path.join(dir,'main.js');
  if(fs.existsSync(output)){if(sha(fs.readFileSync(output))!==candidateHash)throw Error('Existing repair candidate differs');}
  else fs.writeFileSync(output,candidate,{flag:'wx'});
  if(sha(fs.readFileSync(file))!==originalHash)throw Error('Installed source changed during preparation');
  const report={prepared_at:new Date().toISOString(),target:file,plugin_version:manifest.version,original_sha256:originalHash,
    candidate:output,candidate_sha256:candidateHash,change:{before,after},installed_file_changed:false,applied:false,reloaded:false,
    activation:'Back up installed bytes and verify hash before replacement; reload existing plugin only. Preserve token, ACL, host, port and vault.'};
  fs.writeFileSync(path.join(root,'work/verification/obsidian-mcp-framing-repair-plan-20261026.json'),JSON.stringify(report,null,2)+'\n');
  return report;
}
if(require.main===module){try{console.log(JSON.stringify(prepare(),null,2));}catch(error){console.error(error.message);process.exitCode=1;}}
module.exports={patched,prepare};

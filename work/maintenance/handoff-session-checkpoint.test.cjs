'use strict';
// Only the new historical-session selector; no desktop calls or host hooks.
const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path'),crypto=require('node:crypto');
const store=require('./handoff-store.cjs');
function fixture(t){
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'thehive-session-checkpoint-'));
  t.after(()=>{assert.equal(path.dirname(dir),fs.realpathSync(os.tmpdir()));fs.rmSync(dir,{recursive:true,force:true});});
  const root=path.join(dir,'handoff'),a=crypto.randomUUID(),b=crypto.randomUUID();
  const first=store.saveCheckpoint(root,{format_version:1,project_id:'Fixture',session_id:a,expected_parent:null,
    patch:{goal:'Synthetic selector fixture',status:'planned',last_section:'Own checkpoint',git:{workspace:dir},sources:{fixture:{reference:'Offline new regression'}},next_step:{text:'Continue own fixture',success_criterion:'Synthetic evidence'}}});
  const markdown=fs.readFileSync(first.file,'utf8');
  const second=store.saveCheckpoint(root,{format_version:1,project_id:'Fixture',session_id:b,expected_parent:first.checkpoint_id,patch:{last_section:'Parallel checkpoint'}});
  const files=['index.json','Fixture/current.md',a+'-working.md',b+'-working.md'];
  const before=files.map(file=>fs.readFileSync(path.join(root,file)));
  return {dir,root,a,b,first,second,markdown,unchanged:()=>files.forEach((file,i)=>assert.deepEqual(fs.readFileSync(path.join(root,file)),before[i]))};
}
test('own historical checkpoint survives another session advancing the same project',t=>{
  const f=fixture(t);assert.equal(typeof store.resumeBoundCheckpoint,'function','existing reader needs a bound historical selection');
  const r=store.resumeBoundCheckpoint(f.root,{session_id:f.a,workspace:f.dir});
  assert.equal(r.checkpoint.checkpoint_id,f.first.checkpoint_id);assert.equal(r.current.checkpoint_id,f.second.checkpoint_id);
  assert.match(r.checkpoint.file,/[/\\]Fixture[/\\]history[/\\].+\.md$/);
  assert.equal(fs.readFileSync(r.checkpoint.file,'utf8'),f.markdown);f.unchanged();
});
test('snapshot bytes select their exact ancestor after the own working projection advances',t=>{
  const f=fixture(t);store.saveCheckpoint(f.root,{format_version:1,project_id:'Fixture',session_id:f.a,expected_parent:f.second.checkpoint_id,patch:{last_section:'Own later checkpoint'}});
  const r=store.resumeBoundCheckpoint(f.root,{session_id:f.a,workspace:f.dir,markdown:f.markdown});
  assert.equal(r.checkpoint.checkpoint_id,f.first.checkpoint_id);assert.notEqual(r.current.checkpoint_id,f.first.checkpoint_id);
});
test('current own bound checkpoint pins immutable history before later saves',t=>{
  const f=fixture(t),r=store.resumeBoundCheckpoint(f.root,{session_id:f.b,workspace:f.dir});
  assert.notEqual(r.checkpoint.file,f.second.file);assert.match(r.checkpoint.file,/[/\\]history[/\\]/);
  const bytes=fs.readFileSync(r.checkpoint.file);f.unchanged();
  store.saveCheckpoint(f.root,{format_version:1,project_id:'Fixture',session_id:f.a,expected_parent:f.second.checkpoint_id,patch:{last_section:'Later concurrent update'}});
  assert.deepEqual(fs.readFileSync(r.checkpoint.file),bytes);assert.equal(r.checkpoint.checkpoint_id,f.second.checkpoint_id);
});
for(const kind of ['altered_working','wrong_session','wrong_workspace','altered_ancestor','missing_history','history_symlink','depth_bound']){
  test('bound historical selection refuses '+kind,t=>{
    const f=fixture(t);let session=f.a,workspace=f.dir;
    if(kind==='altered_working')fs.appendFileSync(path.join(f.root,f.a+'-working.md'),'\nUnverified appended bytes\n');
    if(kind==='wrong_session'){session=crypto.randomUUID();fs.copyFileSync(path.join(f.root,f.a+'-working.md'),path.join(f.root,session+'-working.md'));}
    if(kind==='wrong_workspace'){workspace=path.join(f.dir,'foreign');fs.mkdirSync(workspace);}
    const second=JSON.parse(fs.readFileSync(path.join(f.root,'index.json'),'utf8')).projects.Fixture;
    const record=JSON.parse(fs.readFileSync(path.join(f.root,second.state_file),'utf8'));
    const ancestor=path.join(f.root,record.parent_reference.file);
    if(kind==='altered_ancestor')fs.appendFileSync(ancestor,' ');
    if(kind==='missing_history')fs.unlinkSync(ancestor.replace(/\.json$/,'.md'));
    if(kind==='history_symlink'){
      const foreign=path.join(f.dir,'foreign-history');fs.mkdirSync(foreign);fs.copyFileSync(ancestor,path.join(foreign,path.basename(ancestor)));
      fs.renameSync(path.join(f.root,'Fixture/history'),path.join(f.root,'Fixture/saved-history'));
      fs.symlinkSync(foreign,path.join(f.root,'Fixture/history'),'junction');
    }
    if(kind==='depth_bound'){
      let parent=f.second.checkpoint_id;
      for(let i=0;i<126;i++)parent=store.saveCheckpoint(f.root,{format_version:1,project_id:'Fixture',session_id:f.b,expected_parent:parent,patch:{last_section:'Depth '+i}}).checkpoint_id;
      assert.equal(store.resumeBoundCheckpoint(f.root,{session_id:f.a,workspace:f.dir}).checkpoint.checkpoint_id,f.first.checkpoint_id);
      store.saveCheckpoint(f.root,{format_version:1,project_id:'Fixture',session_id:f.b,expected_parent:parent,patch:{last_section:'Beyond allowed ancestry'}});
    }
    assert.throws(()=>store.resumeBoundCheckpoint(f.root,{session_id:session,workspace}));
  });
}

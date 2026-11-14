import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';

test('local import, catalog, edit, and worker gate', async () => {
  const workspace=path.resolve(process.cwd());
  const root=path.resolve(workspace,`.queue-test-${process.pid}`);
  assert.ok(root.startsWith(workspace+path.sep));
  await fs.mkdir(root,{recursive:true});
  const port=44000+(process.pid%1000);
  const child=spawn(process.execPath,[path.join(workspace,'server.mjs')],{cwd:workspace,env:{...process.env,EMOJI_QUEUE_ROOT:root,EMOJI_QUEUE_PORT:String(port)},stdio:'ignore'});
  const base=`http://127.0.0.1:${port}`;
  try {
    let token;
    for(let i=0;i<50;i++){try{token=(await fs.readFile(path.join(root,'.upload-queue','token.txt'),'utf8')).trim();const response=await fetch(base+'/api/status',{headers:{'X-Queue-Token':token}});if(response.ok)break;}catch{}await new Promise(r=>setTimeout(r,100));}
    assert.ok(token,'test server did not start');
    const headers={'X-Queue-Token':token};
    const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aQb8AAAAASUVORK5CYII=','base64');
    const imported=await fetch(base+'/api/import?pack=Sample&filename=test-icon.png',{method:'POST',headers,body:png});
    assert.equal(imported.status,200,await imported.text().catch(()=>''));
    const catalog=await fetch(base+'/api/catalog?folder=Sample&limit=10',{headers}).then(r=>r.json());
    assert.equal(catalog.total,1);assert.equal(catalog.items[0].title,'Test Icon');
    const edited=await fetch(base+'/api/edit',{method:'POST',headers:{...headers,'Content-Type':'application/json'},body:JSON.stringify({folder:'Sample',filename:'test-icon.png',title:'Edited Icon',description:'Edited description.',tags:'emoji; test; cute'})});
    assert.equal(edited.status,200);
    const after=await fetch(base+'/api/catalog?folder=Sample&limit=10',{headers}).then(r=>r.json());
    assert.equal(after.items[0].title,'Edited Icon');
    const start=await fetch(base+'/api/start',{method:'POST',headers:{...headers,'Content-Type':'application/json'},body:JSON.stringify({limit:0,folder:'Sample'})});
    assert.equal(start.status,400,'outdated or absent worker must block submission');
    const enable=await fetch(base+'/api/enable-pairing',{method:'POST',headers:{...headers,'Content-Type':'application/json'},body:'{}'});
    assert.equal(enable.status,200);
    const paired=await fetch(base+'/api/pair',{headers:{'X-Queue-Pair':'local-userscript'}}).then(r=>r.json());
    assert.equal(paired.token,token);
    const secondPair=await fetch(base+'/api/pair',{headers:{'X-Queue-Pair':'local-userscript'}});
    assert.equal(secondPair.status,403,'pairing token is one-use');
    const hello=await fetch(base+'/api/hello',{method:'POST',headers:{...headers,'Content-Type':'application/json'},body:JSON.stringify({version:'0.3.0'})}).then(r=>r.json());
    assert.ok(hello.session);
    const queued=await fetch(base+'/api/start',{method:'POST',headers:{...headers,'Content-Type':'application/json'},body:JSON.stringify({limit:0,folder:'Sample'})}).then(r=>r.json());
    assert.equal(queued.queued,1);
    const workerHeaders={...headers,'X-Worker-Session':hello.session};
    const batch=await fetch(base+'/api/next',{headers:workerHeaders}).then(r=>r.json());
    assert.equal(batch.batch.items.length,1);
    const result=await fetch(base+'/api/result',{method:'POST',headers:{...workerHeaders,'Content-Type':'application/json'},body:JSON.stringify({id:batch.batch.id,outcomes:[{status:'submitted'}]})});
    assert.equal(result.status,200);
    assert.ok((await fs.stat(path.join(root,'.uploaded-Sample','upload_manifest.csv'))).isFile());
  } finally {
    child.kill();
    await new Promise(resolve=>child.once('exit',resolve));
    assert.ok(root.startsWith(workspace+path.sep));
    await fs.rm(root,{recursive:true,force:true});
  }
});

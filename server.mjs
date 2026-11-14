import http from 'node:http';
import fs from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {checkUpdate,applyUpdate} from './update.mjs';

const STUDIO_VERSION='0.4.5';

let localConfig={};
try { localConfig=JSON.parse(await fs.readFile(new URL('./config.local.json',import.meta.url),'utf8')); } catch { /* set root through environment instead */ }
const ROOT = path.resolve(process.env.EMOJI_QUEUE_ROOT || localConfig.root || '');
if(!process.env.EMOJI_QUEUE_ROOT&&!localConfig.root)throw new Error('Set EMOJI_QUEUE_ROOT or create config.local.json with a root folder');
const PORT = Number(process.env.EMOJI_QUEUE_PORT || 43861);
const DATA = path.join(ROOT, '.upload-queue');
const TOKEN_FILE = path.join(DATA, 'token.txt');
const STATE_FILE = path.join(DATA, 'state.json');
const QUEUE_FILE = path.join(DATA, 'queue.json');
const columns = ['filename','title','primary_emoji','secondary_emoji','category','category_value','license','tags','description','source','batch_number','batch_position','upload_status','upload_notes'];
await fs.mkdir(DATA, { recursive: true });
let token;
try { token = (await fs.readFile(TOKEN_FILE, 'utf8')).trim(); }
catch { token = crypto.randomBytes(24).toString('hex'); await fs.writeFile(TOKEN_FILE, token, { mode: 0o600 }); }
let state = { running: false, paused: true, limit: 0, queued: [], cursor: 0, leases: [], workers: 1, spawnPending: 0, done: 0, failed: 0, skipped: 0, message: '' };
const workers=new Map();
let pairingUntil=0;
let shuttingDown=false;
let checkingUpdate=false;
let updateMessage='';
let nextSpawnReconcileAt=0;
let mutation=Promise.resolve();
function serial(work){const task=mutation.then(work);mutation=task.catch(()=>{});return task;}
function isConnected(worker){return Date.now()-worker.seenAt<15000;}
function activeWorkers(){return [...workers.values()].filter(isConnected).length;}
function readyWorkers(){return [...workers.values()].filter(w=>isConnected(w)&&w.supportsHeartbeat).length;}
function workerSummaries(){return [...workers.entries()].filter(([id,w])=>isConnected(w)||state.leases.some(lease=>lease.owner===id)).map(([id,w])=>({id:id.slice(0,8),version:w.scriptVersion||'older',connected:isConnected(w),ready:!!w.supportsHeartbeat,inFlight:state.leases.find(lease=>lease.owner===id)?.items.length||0}));}
try { state = { ...state, ...JSON.parse(await fs.readFile(STATE_FILE, 'utf8')) }; }
catch { /* first run */ }
try { state.queued = JSON.parse(await fs.readFile(QUEUE_FILE,'utf8')); }
catch { state.queued=[]; }
state.leases ||= [];
// Recovery occurs after the manifest writer is defined below.

function parseCsv(text) {
  const records=[]; let row=[], value='', quoted=false;
  for(let i=0;i<text.length;i++) { const c=text[i]; if(quoted){if(c==='"'&&text[i+1]==='"'){value+='"';i++;}else if(c==='"')quoted=false;else value+=c;}else if(c==='"')quoted=true;else if(c===','){row.push(value);value='';}else if(c==='\n'){row.push(value.replace(/\r$/,''));records.push(row);row=[];value='';}else value+=c; }
  if(row.length||value){row.push(value);records.push(row);}
  const head=records.shift()?.map(x=>x.replace(/^\uFEFF/,''))||[];
  return records.filter(r=>r.length===head.length).map(r=>Object.fromEntries(head.map((key,i)=>[key,r[i]])));
}
function csv(rows) { const q=v=>`"${String(v??'').replaceAll('"','""')}"`; return [columns.map(q).join(','),...rows.map(r=>columns.map(k=>q(r[k])).join(','))].join('\r\n')+'\r\n'; }
async function save() { const temp=STATE_FILE+'.tmp'; const {queued,...small}=state; await fs.writeFile(temp,JSON.stringify({...small,queued:queued.length},null,2)); await fs.rename(temp,STATE_FILE); }
async function updateManifest(items, outcomes) {
  const byFolder=new Map();
  for(let i=0;i<items.length;i++){ const item=items[i]; const group=byFolder.get(item.folder)||[]; group.push([item,outcomes[i]]); byFolder.set(item.folder,group); }
  for(const [folder,group] of byFolder){
    const file=path.join(ROOT,folder,'upload_manifest.csv'); const rows=parseCsv(await fs.readFile(file,'utf8'));
    for(const [item,outcome] of group){ const row=rows.find(r=>r.filename===item.filename); if(!row)throw new Error(`Manifest row missing: ${folder}/${item.filename}`); row.upload_status=outcome.status; row.upload_notes=outcome.note||''; }
    const temp=file+'.queue-tmp'; await fs.writeFile(temp,csv(rows)); await fs.rename(temp,file);
    if(rows.length && rows.every(r=>r.upload_status==='submitted')){
      await fs.rename(path.join(ROOT,folder),path.join(ROOT,`.uploaded-${folder}`));
    }
  }
}
// A restart never silently repeats an in-flight submission.
if(state.leased){state.leases=[...(state.leases||[]),state.leased];state.cursor+=state.leased.items.length;delete state.leased;}
if(state.leases?.length){
  for(const lease of state.leases)await updateManifest(lease.items,lease.items.map(()=>({status:'uncertain',note:'Queue process stopped during submission; review before retry'})));
  state.failed+=state.leases.reduce((n,lease)=>n+lease.items.length,0);
  state.message=`${state.leases.length} in-flight batches need review`;
  state.leases=[];state.running=false;state.paused=true;
}
await save();
async function createQueue(limit, folderFilter='', workerCount=1) {
  if(!readyWorkers())throw new Error('Worker 0.4.3 or newer is required before uploading. Update Tampermonkey and reload the Emoji.gg tab.');
  if(!Number.isInteger(limit)||limit<0||limit>100000)throw new Error('Choose 0 (all) or 1–100000 images');
  if(!Number.isInteger(workerCount)||workerCount<1||workerCount>10)throw new Error('Choose 1–10 worker tabs');
  if(state.running && (state.cursor<state.queued.length||state.leases.length))throw new Error('Finish the current queue before starting another');
  if(state.leases.length)throw new Error('A batch is already in flight');
  const dirs=(await fs.readdir(ROOT,{withFileTypes:true})).filter(d=>d.isDirectory()&&!d.name.startsWith('.')&&(!folderFilter||d.name===folderFilter)).map(d=>d.name).sort();
  const items=[]; const skipped=[];
  for(const folder of dirs){
    let rows; try{ rows=parseCsv(await fs.readFile(path.join(ROOT,folder,'upload_manifest.csv'),'utf8')); }catch{continue;}
    for(const row of rows){if(row.upload_status!=='pending')continue; const file=path.join(ROOT,folder,row.filename);
      try{const stat=await fs.stat(file); if(stat.size>0&&stat.size<=256*1024&&/\.(png|gif)$/i.test(row.filename)){items.push({folder,filename:row.filename,title:row.title,category_value:row.category_value,license:row.license,tags:row.tags,description:row.description});}else skipped.push(`${folder}/${row.filename}: invalid type or size`);}catch{skipped.push(`${folder}/${row.filename}: missing`);}
      if(limit && items.length>=limit)break;
    }
    if(limit && items.length>=limit)break;
  }
  const temp=QUEUE_FILE+'.tmp';await fs.writeFile(temp,JSON.stringify(items));await fs.rename(temp,QUEUE_FILE);
  state={running:items.length>0,paused:false,limit,queued:items,cursor:0,leases:[],workers:workerCount,spawnPending:Math.max(0,workerCount-readyWorkers()),done:0,failed:0,skipped:skipped.length,message:skipped.slice(0,5).join('; ')};
  await save(); return state;
}
async function catalog(offset=0,limit=40,folderFilter='',status='pending'){
  const dirs=(await fs.readdir(ROOT,{withFileTypes:true})).filter(d=>d.isDirectory()&&!d.name.startsWith('.')&&(!folderFilter||d.name===folderFilter)).map(d=>d.name).sort();
  let total=0;const items=[];const folders=[];
  for(const folder of dirs){let rows;try{rows=parseCsv(await fs.readFile(path.join(ROOT,folder,'upload_manifest.csv'),'utf8'));}catch{continue;}folders.push(folder);
    for(const row of rows){if(status!=='all'&&row.upload_status!==status)continue;if(total>=offset&&items.length<limit)items.push({folder,...row});total++;}
  }
  return {total,offset,limit,items,folders};
}
function safeLeaf(value){return value&&!value.includes('..')&&!/[\\/]/.test(value);}
function uuid(value){return typeof value==='string'&&/^[0-9a-f-]{36}$/i.test(value);}
function workerOwner(req){return [...workers.entries()].find(([,worker])=>worker.session===req.headers['x-worker-session'])?.[0];}
async function editRow(input){
  if(state.running&&(state.cursor<state.queued.length||state.leases.length))throw new Error('Finish the current queue before editing');
  const folder=String(input.folder||''),filename=String(input.filename||'');if(!safeLeaf(folder)||!safeLeaf(filename))throw new Error('Invalid item path');
  const file=path.join(ROOT,folder,'upload_manifest.csv');const rows=parseCsv(await fs.readFile(file,'utf8'));
  const row=rows.find(r=>r.filename===filename);if(!row)throw new Error('Manifest row missing');
  for(const key of ['title','tags','description','category_value','license'])if(input[key]!==undefined)row[key]=String(input[key]).slice(0,key==='description'?2500:500);
  if(!row.title.trim()||!row.description.trim())throw new Error('Name and description are required');
  const temp=file+'.queue-tmp';await fs.writeFile(temp,csv(rows));await fs.rename(temp,file);return row;
}
function json(res,status,body){const data=JSON.stringify(body);res.writeHead(status,{'Content-Type':'application/json','Content-Length':Buffer.byteLength(data),'Cache-Control':'no-store'});res.end(data);}
async function body(req){let s='';for await(const part of req){s+=part;if(s.length>1000000)throw new Error('Request too large');}return s?JSON.parse(s):{};}
async function binary(req){const parts=[];let size=0;for await(const part of req){size+=part.length;if(size>256*1024)throw new Error('Image exceeds 256 KiB');parts.push(part);}return Buffer.concat(parts);}
async function importImage(req,u){
  const pack=String(u.searchParams.get('pack')||'').replace(/[<>:"/\\|?*\x00-\x1f]/g,'_').trim();
  const original=String(u.searchParams.get('filename')||'').replace(/[<>:"/\\|?*\x00-\x1f]/g,'_');
  if(!safeLeaf(pack)||pack.startsWith('.')||!safeLeaf(original)||!/\.(png|gif)$/i.test(original))throw new Error('Choose a pack name and PNG/GIF files');
  const bytes=await binary(req);if(!bytes.length)throw new Error('Empty file');
  const png=bytes.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10]));
  const gif=bytes.subarray(0,6).toString('ascii').startsWith('GIF8');
  if(!png&&!gif)throw new Error('File content is not PNG or GIF');
  const folder=path.join(ROOT,pack);await fs.mkdir(folder,{recursive:true});
  const ext=path.extname(original),base=path.basename(original,ext);let filename=original,n=2;
  while(true){try{await fs.access(path.join(folder,filename));filename=`${base}-${n++}${ext}`;}catch{break;}}
  const manifest=path.join(folder,'upload_manifest.csv');let rows=[];try{rows=parseCsv(await fs.readFile(manifest,'utf8'));}catch{ /* new pack */ }
  const title=base.replace(/[-_]+/g,' ').replace(/\s+/g,' ').trim().replace(/\b\w/g,c=>c.toUpperCase()).slice(0,80);
  const row={filename,title,primary_emoji:'',secondary_emoji:'',category:'Original Style',category_value:'1',license:'Basic',tags:'emoji; '+title.toLowerCase().split(' ').join('; '),description:`${title} emoji image.`,source:'',batch_number:'',batch_position:'',upload_status:'pending',upload_notes:''};
  await fs.writeFile(path.join(folder,filename),bytes,{flag:'wx'});
  const temp=manifest+'.queue-tmp';await fs.writeFile(temp,csv([...rows,row]));await fs.rename(temp,manifest);
  return {folder,filename};
}
const server=http.createServer(async(req,res)=>{
  try{
    const u=new URL(req.url,'http://localhost');
    if(req.method==='OPTIONS'){res.writeHead(204);return res.end();}
    if(u.pathname==='/'){res.writeHead(200,{'Content-Type':'text/html; charset=utf-8','X-Frame-Options':'DENY','Content-Security-Policy':"frame-ancestors 'none'"});return res.end((await fs.readFile(new URL('./dashboard.html',import.meta.url),'utf8')).replace('__QUEUE_TOKEN__',token));}
    if(u.pathname==='/studio.css'){res.writeHead(200,{'Content-Type':'text/css; charset=utf-8','Cache-Control':'no-cache'});return res.end(await fs.readFile(new URL('./studio.css',import.meta.url),'utf8'));}
    if(u.pathname==='/uploader.user.js'){const script=await fs.readFile(new URL('./uploader.user.js',import.meta.url),'utf8');res.writeHead(200,{'Content-Type':'text/javascript; charset=utf-8'});return res.end(script);}
    if(u.pathname==='/api/pair'&&req.headers['x-queue-pair']==='local-userscript'&&Date.now()<pairingUntil){pairingUntil=0;res.writeHead(200,{'Content-Type':'application/json','Cache-Control':'no-store'});return res.end(JSON.stringify({token}));}
    const auth=req.headers['x-queue-token']===token || u.searchParams.get('token')===token;
    if(!auth)return json(res,403,{error:'Invalid queue token'});
    if(u.pathname==='/api/status')return json(res,200,{...state,protocolVersion:'0.4.0',studioVersion:STUDIO_VERSION,updateMessage,root:ROOT,queued:state.queued.length-state.cursor,leased:state.leases.reduce((n,x)=>n+x.items.length,0),workerReady:readyWorkers()>0,activeWorkers:activeWorkers(),readyWorkers:readyWorkers(),workerTabs:workerSummaries()});
    if(u.pathname==='/api/enable-pairing'&&req.method==='POST'){pairingUntil=Date.now()+60000;return json(res,200,{ok:true,expiresInSeconds:60});}
    if(u.pathname==='/api/hello'&&req.method==='POST')return await serial(async()=>{const hello=await body(req);if(hello.version!=='0.4.0'||!uuid(hello.clientId))throw new Error('Worker update required');let worker=workers.get(hello.clientId);if(!worker){worker={session:crypto.randomBytes(24).toString('hex'),seenAt:0};workers.set(hello.clientId,worker);}worker.seenAt=Date.now();worker.scriptVersion=String(hello.scriptVersion||'older').slice(0,24);worker.supportsHeartbeat=hello.heartbeat===true;if(worker.supportsHeartbeat&&state.spawnPending===0&&Date.now()>=nextSpawnReconcileAt){state.spawnPending=Math.max(0,state.workers-readyWorkers());nextSpawnReconcileAt=Date.now()+20000;}const spawn=worker.supportsHeartbeat?state.spawnPending:0;if(spawn)state.spawnPending=0;return json(res,200,{ok:true,session:worker.session,spawn});});
    if(u.pathname==='/api/catalog')return json(res,200,await catalog(Math.max(0,Number(u.searchParams.get('offset')||0)),Math.min(100,Math.max(1,Number(u.searchParams.get('limit')||40))),u.searchParams.get('folder')||'',u.searchParams.get('status')||'pending'));
    if(u.pathname==='/api/import'&&req.method==='POST')return json(res,200,await serial(()=>importImage(req,u)));
    if(u.pathname==='/api/edit'&&req.method==='POST')return json(res,200,{item:await serial(async()=>editRow(await body(req)))});
    if(u.pathname==='/api/preview'){
      const folder=u.searchParams.get('folder')||'',filename=u.searchParams.get('filename')||'';if(!safeLeaf(folder)||!safeLeaf(filename))throw new Error('Invalid item path');
      const file=path.join(ROOT,folder,filename);const stat=await fs.stat(file);if(stat.size>256*1024)throw new Error('Preview too large');
      res.writeHead(200,{'Content-Type':/\.gif$/i.test(file)?'image/gif':'image/png','Content-Length':stat.size,'Cache-Control':'no-store'});return createReadStream(file).pipe(res);
    }
    if(u.pathname==='/api/start'&&req.method==='POST')return await serial(async()=>{if(shuttingDown)throw new Error('Studio is shutting down');const input=await body(req),job=await createQueue(Number(input.limit),String(input.folder||''),Number(input.workers||1));return json(res,200,{queued:job.queued.length,skipped:job.skipped});});
    if(u.pathname==='/api/workers'&&req.method==='POST')return await serial(async()=>{const input=await body(req),count=Number(input.workers);if(!Number.isInteger(count)||count<1||count>10)throw new Error('Choose 1–10 worker tabs');state.workers=count;state.spawnPending=Math.max(0,count-readyWorkers());nextSpawnReconcileAt=Date.now()+20000;await save();return json(res,200,{workers:count,spawnPending:state.spawnPending,openFirst:readyWorkers()===0});});
    if(u.pathname==='/api/pause'&&req.method==='POST')return await serial(async()=>{state.paused=true;await save();return json(res,200,{ok:true});});
    if(u.pathname==='/api/resume'&&req.method==='POST')return await serial(async()=>{if(shuttingDown)throw new Error('Studio is shutting down');if(!readyWorkers())throw new Error('Worker 0.4.3 or newer is required before resuming');state.paused=false;state.running=state.cursor<state.queued.length||state.leases.length>0;await save();return json(res,200,{ok:true});});
    if(u.pathname==='/api/shutdown'&&req.method==='POST')return await serial(async()=>{shuttingDown=true;state.paused=true;await save();json(res,200,{ok:true,draining:state.leases.length});const timer=setInterval(()=>{if(!state.leases.length){clearInterval(timer);server.close();}},500);});
    if(u.pathname==='/api/next')return await serial(async()=>{
      const owner=workerOwner(req);if(!owner||!workers.get(owner)?.supportsHeartbeat)return json(res,403,{error:'Worker 0.4.3 or newer required'});
      if(!state.running||state.paused)return json(res,200,{batch:null});
      if(state.leases.some(x=>x.owner===owner))return json(res,200,{batch:null,blocked:'This tab has an unresolved batch'});
      if(state.leases.length>=state.workers||state.cursor>=state.queued.length)return json(res,200,{batch:null});
      const lease={id:crypto.randomUUID(),owner,issuedAt:Date.now(),items:state.queued.slice(state.cursor,state.cursor+10)};state.cursor+=lease.items.length;state.leases.push(lease);await save();return json(res,200,{batch:lease});
    });
    if(u.pathname==='/api/file'){
      const owner=workerOwner(req);if(!owner)return json(res,403,{error:'Updated worker required'});
      const batch=state.leases.find(x=>x.id===u.searchParams.get('batch')&&x.owner===owner);const index=Number(u.searchParams.get('index'));const item=batch?.items[index];if(!item)return json(res,404,{error:'File not leased'});
      const file=path.join(ROOT,item.folder,item.filename);const stat=await fs.stat(file);if(stat.size>256*1024)throw new Error('File grew above 256 KB');
      res.writeHead(200,{'Content-Type':/\.gif$/i.test(file)?'image/gif':'image/png','Content-Length':stat.size,'Cache-Control':'no-store'});return createReadStream(file).pipe(res);
    }
    if(u.pathname==='/api/result'&&req.method==='POST')return await serial(async()=>{
      const owner=workerOwner(req);if(!owner)return json(res,403,{error:'Updated worker required'});
      const result=await body(req);const lease=state.leases.find(x=>x.id===result.id&&x.owner===owner);if(!lease)throw new Error('Unknown batch');
      if(!Array.isArray(result.outcomes)||result.outcomes.length!==lease.items.length)throw new Error('Outcome count mismatch');
      const outcomes=result.outcomes.map(o=>({status:o.status==='submitted'?'submitted':o.status==='retry'?'retry':'uncertain',note:o.status==='submitted'?'':String(o.note||'').slice(0,300)}));
      await updateManifest(lease.items,outcomes);
      state.done+=outcomes.filter(o=>o.status==='submitted').length;state.failed+=outcomes.filter(o=>o.status!=='submitted').length;
      state.leases=state.leases.filter(x=>x!==lease);state.message=`${state.done} submitted; ${state.failed} unresolved`;
      if(state.cursor>=state.queued.length&&!state.leases.length)state.running=false;await save();return json(res,200,{ok:true});
    });
    json(res,404,{error:'Not found'});
  }catch(error){json(res,400,{error:error.message});}
});
server.listen(PORT,'127.0.0.1',()=>console.log(`Queue dashboard: http://127.0.0.1:${PORT}/\nUserscript: http://127.0.0.1:${PORT}/uploader.user.js`));
// The local dashboard cannot be updated by Tampermonkey. Refresh its clean
// official Git checkout while idle or paused, then restart without touching
// the separate queue and manifest files.
async function checkStudioUpdate(){
  if(checkingUpdate||shuttingDown)return;
  checkingUpdate=true;
  try{
    const update=await checkUpdate();
    if(!update.available){updateMessage='';return;}
    if(!state.paused&&state.running||state.leases.length){updateMessage='Studio update ready; waiting for a pause between batches';return;}
    shuttingDown=true;
    await applyUpdate(update.remote);
    updateMessage='Applying Studio update';
    server.close(()=>{const child=spawn(process.execPath,[fileURLToPath(import.meta.url)],{cwd:path.dirname(fileURLToPath(import.meta.url)),env:process.env,detached:true,windowsHide:true,stdio:'inherit'});child.unref();});
  }catch(error){shuttingDown=false;updateMessage=`Update skipped: ${error.message}`;}
  finally{checkingUpdate=false;}
}
const updateTimer=setInterval(checkStudioUpdate,15*60*1000);
updateTimer.unref();
async function recoverDisconnectedBatches(){
  await serial(async()=>{
    const stale=state.leases.filter(lease=>{const worker=workers.get(lease.owner);return worker?.supportsHeartbeat&&Date.now()-worker.seenAt>120000;});
    if(!stale.length)return;
    for(const lease of stale)await updateManifest(lease.items,lease.items.map(()=>({status:'uncertain',note:'Worker tab disconnected during submission; review result before retry'})));
    state.leases=state.leases.filter(lease=>!stale.includes(lease));
    state.failed+=stale.reduce((sum,lease)=>sum+lease.items.length,0);
    state.message=`${state.failed} unresolved; ${stale.length} disconnected batches need review`;
    state.spawnPending=Math.max(state.spawnPending,Math.max(0,state.workers-readyWorkers()));
    nextSpawnReconcileAt=0;
    if(state.cursor>=state.queued.length&&!state.leases.length)state.running=false;
    await save();
  }).catch(error=>console.error('Could not recover disconnected batch:',error));
}
const recoveryTimer=setInterval(recoverDisconnectedBatches,30000);
recoveryTimer.unref();

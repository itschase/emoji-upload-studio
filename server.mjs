import http from 'node:http';
import fs from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

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
let state = { running: false, paused: true, limit: 0, queued: [], cursor: 0, leased: null, done: 0, failed: 0, skipped: 0, message: '' };
let workerSeenAt=0;
let pairingUntil=0;
const workerSession=crypto.randomBytes(24).toString('hex');
try { state = { ...state, ...JSON.parse(await fs.readFile(STATE_FILE, 'utf8')) }; }
catch { /* first run */ }
try { state.queued = JSON.parse(await fs.readFile(QUEUE_FILE,'utf8')); }
catch { state.queued=[]; }
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
if(state.leased){
  await updateManifest(state.leased.items,state.leased.items.map(()=>({status:'uncertain',note:'Queue process stopped during submission; review before retry'})));
  state.cursor+=state.leased.items.length;
  state.message=`Uncertain batch ${state.leased.id} needs review`;
  state.leased=null;state.running=false;state.paused=true;
}
await save();
async function createQueue(limit, folderFilter='') {
  if(Date.now()-workerSeenAt>15000)throw new Error('Updated Emoji.gg worker is not connected. Install the latest local userscript and leave its Emoji.gg tab open.');
  if(!Number.isInteger(limit)||limit<0||limit>100000)throw new Error('Choose 0 (all) or 1–100000 images');
  if(state.running && state.cursor<state.queued.length)throw new Error('Finish the current queue before starting another');
  if(state.leased)throw new Error('A batch is already in flight');
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
  state={running:items.length>0,paused:false,limit,queued:items,cursor:0,leased:null,done:0,failed:0,skipped:skipped.length,message:skipped.slice(0,5).join('; ')};
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
async function editRow(input){
  if(state.running&&state.cursor<state.queued.length)throw new Error('Finish the current queue before editing');
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
    if(u.pathname==='/uploader.user.js'){const script=await fs.readFile(new URL('./uploader.user.js',import.meta.url),'utf8');res.writeHead(200,{'Content-Type':'text/javascript; charset=utf-8'});return res.end(script);}
    if(u.pathname==='/api/pair'&&req.headers['x-queue-pair']==='local-userscript'&&Date.now()<pairingUntil){pairingUntil=0;res.writeHead(200,{'Content-Type':'application/json','Cache-Control':'no-store'});return res.end(JSON.stringify({token}));}
    const auth=req.headers['x-queue-token']===token || u.searchParams.get('token')===token;
    if(!auth)return json(res,403,{error:'Invalid queue token'});
    if(u.pathname==='/api/status')return json(res,200,{...state,queued:state.queued.length-state.cursor,leased:state.leased?.items.length||0,workerReady:Date.now()-workerSeenAt<15000});
    if(u.pathname==='/api/enable-pairing'&&req.method==='POST'){pairingUntil=Date.now()+60000;return json(res,200,{ok:true,expiresInSeconds:60});}
    if(u.pathname==='/api/hello'&&req.method==='POST'){const hello=await body(req);if(hello.version!=='0.3.0')throw new Error('Worker update required');workerSeenAt=Date.now();return json(res,200,{ok:true,session:workerSession});}
    if(u.pathname==='/api/catalog')return json(res,200,await catalog(Math.max(0,Number(u.searchParams.get('offset')||0)),Math.min(100,Math.max(1,Number(u.searchParams.get('limit')||40))),u.searchParams.get('folder')||'',u.searchParams.get('status')||'pending'));
    if(u.pathname==='/api/import'&&req.method==='POST')return json(res,200,await importImage(req,u));
    if(u.pathname==='/api/edit'&&req.method==='POST')return json(res,200,{item:await editRow(await body(req))});
    if(u.pathname==='/api/preview'){
      const folder=u.searchParams.get('folder')||'',filename=u.searchParams.get('filename')||'';if(!safeLeaf(folder)||!safeLeaf(filename))throw new Error('Invalid item path');
      const file=path.join(ROOT,folder,filename);const stat=await fs.stat(file);if(stat.size>256*1024)throw new Error('Preview too large');
      res.writeHead(200,{'Content-Type':/\.gif$/i.test(file)?'image/gif':'image/png','Content-Length':stat.size,'Cache-Control':'no-store'});return createReadStream(file).pipe(res);
    }
    if(u.pathname==='/api/start'&&req.method==='POST'){const input=await body(req),job=await createQueue(Number(input.limit),String(input.folder||''));return json(res,200,{queued:job.queued.length,skipped:job.skipped});}
    if(u.pathname==='/api/pause'&&req.method==='POST'){state.paused=true;await save();return json(res,200,{ok:true});}
    if(u.pathname==='/api/resume'&&req.method==='POST'){if(Date.now()-workerSeenAt>15000)throw new Error('Updated worker is not connected');state.paused=false;state.running=state.cursor<state.queued.length;await save();return json(res,200,{ok:true});}
    if(u.pathname==='/api/next'){
      if(req.headers['x-worker-session']!==workerSession)return json(res,403,{error:'Updated worker required'});
      if(!state.running||state.paused)return json(res,200,{batch:null});
      if(state.leased)return json(res,200,{batch:state.leased});
      if(state.cursor>=state.queued.length){state.running=false;await save();return json(res,200,{batch:null});}
      state.leased={id:crypto.randomUUID(),items:state.queued.slice(state.cursor,state.cursor+10)};await save();return json(res,200,{batch:state.leased});
    }
    if(u.pathname==='/api/file'){
      if(req.headers['x-worker-session']!==workerSession)return json(res,403,{error:'Updated worker required'});
      const batch=state.leased;const index=Number(u.searchParams.get('index'));const item=batch?.items[index];if(!item)return json(res,404,{error:'File not leased'});
      const file=path.join(ROOT,item.folder,item.filename);const stat=await fs.stat(file);if(stat.size>256*1024)throw new Error('File grew above 256 KB');
      res.writeHead(200,{'Content-Type':/\.gif$/i.test(file)?'image/gif':'image/png','Content-Length':stat.size,'Cache-Control':'no-store'});return createReadStream(file).pipe(res);
    }
    if(u.pathname==='/api/result'&&req.method==='POST'){
      if(req.headers['x-worker-session']!==workerSession)return json(res,403,{error:'Updated worker required'});
      const result=await body(req);const lease=state.leased;if(!lease||result.id!==lease.id)throw new Error('Unknown batch');
      if(!Array.isArray(result.outcomes)||result.outcomes.length!==lease.items.length)throw new Error('Outcome count mismatch');
      const outcomes=result.outcomes.map(o=>({status:o.status==='submitted'?'submitted':o.status==='retry'?'retry':'uncertain',note:o.status==='submitted'?'':String(o.note||'').slice(0,300)}));
      await updateManifest(lease.items,outcomes);
      state.done+=outcomes.filter(o=>o.status==='submitted').length;state.failed+=outcomes.filter(o=>o.status!=='submitted').length;
      state.cursor+=lease.items.length;state.leased=null;state.message=`${state.done} submitted; ${state.failed} unresolved`;
      if(state.cursor>=state.queued.length)state.running=false;await save();return json(res,200,{ok:true});
    }
    json(res,404,{error:'Not found'});
  }catch(error){json(res,400,{error:error.message});}
});
server.listen(PORT,'127.0.0.1',()=>console.log(`Queue dashboard: http://127.0.0.1:${PORT}/\nUserscript: http://127.0.0.1:${PORT}/uploader.user.js\nToken: ${token}`));

import http from 'node:http';
import fs from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {checkUpdate,applyUpdate} from './update.mjs';

const STUDIO_VERSION='0.6.2';
const MAX_AUTOMATIC_RETRIES=3;
const MAX_UNCERTAIN_BEFORE_PAUSE=10;

let localConfig={};
try { localConfig=JSON.parse(await fs.readFile(new URL('./config.local.json',import.meta.url),'utf8')); } catch { /* set root through environment instead */ }
const ROOT = path.resolve(process.env.EMOJI_QUEUE_ROOT || localConfig.root || '');
if(!process.env.EMOJI_QUEUE_ROOT&&!localConfig.root)throw new Error('Set EMOJI_QUEUE_ROOT or create config.local.json with a root folder');
const PORT = Number(process.env.EMOJI_QUEUE_PORT || 43861);
const DATA = path.join(ROOT, '.upload-queue');
const TOKEN_FILE = path.join(DATA, 'token.txt');
const STATE_FILE = path.join(DATA, 'state.json');
const QUEUE_FILE = path.join(DATA, 'queue.json');
const IMPORT_DATA = path.join(DATA,'imports');
const columns = ['filename','title','primary_emoji','secondary_emoji','category','category_value','license','tags','description','source','batch_number','batch_position','upload_status','upload_notes'];
await fs.mkdir(DATA, { recursive: true });
if(!IMPORT_DATA.startsWith(DATA+path.sep))throw new Error('Invalid import staging path');
await fs.rm(IMPORT_DATA,{recursive:true,force:true});
let token;
try { token = (await fs.readFile(TOKEN_FILE, 'utf8')).trim(); }
catch { token = crypto.randomBytes(24).toString('hex'); await fs.writeFile(TOKEN_FILE, token, { mode: 0o600 }); }
let state = { running: false, paused: true, limit: 0, queued: [], cursor: 0, leases: [], workers: 1, spawnPending: 0, done: 0, failed: 0, skipped: 0, uncertainThisRun: 0, message: '' };
const workers=new Map();
const expectedWorkers=new Map();
const completedLeases=new Map();
const importSessions=new Map();
let manifestCountsCache={at:0,value:null};
let pairingUntil=0;
let shuttingDown=false;
let checkingUpdate=false;
let updateMessage='';
let nextSpawnReconcileAt=0;
let mutation=Promise.resolve();
function serial(work){const task=mutation.then(work);mutation=task.catch(()=>{});return task;}
function isConnected(worker){return Date.now()-worker.seenAt<30000;}
function versionAtLeast(value,minimum='0.6.2'){const a=String(value||'0').split('.').map(Number),b=minimum.split('.').map(Number);for(let i=0;i<3;i++){if((a[i]||0)!==(b[i]||0))return (a[i]||0)>(b[i]||0);}return true;}
function isReady(worker){return isConnected(worker)&&worker.supportsHeartbeat&&versionAtLeast(worker.scriptVersion);}
function activeWorkers(){return [...workers.values()].filter(isConnected).length;}
function readyWorkers(){return [...workers.values()].filter(isReady).length;}
function workerSummaries(){return [...workers.entries()].filter(([id,w])=>isConnected(w)||state.leases.some(lease=>lease.owner===id)).map(([id,w])=>({id:id.slice(0,8),installationId:String(w.installationId||'legacy').slice(0,8),version:w.scriptVersion||'older',connected:isConnected(w),ready:isReady(w),inFlight:state.leases.find(lease=>lease.owner===id)?.items.length||0,stage:w.stage||'idle',progressAt:w.progressAt||w.seenAt}));}
function expireWorkerReservations(){const now=Date.now();for(const [id,reservation] of expectedWorkers)if(reservation.expiresAt<=now)expectedWorkers.delete(id);state.spawnPending=expectedWorkers.size;}
function reserveMissingWorkers(){expireWorkerReservations();const deficit=Math.max(0,state.workers-activeWorkers()-expectedWorkers.size);for(let i=0;i<deficit;i++)expectedWorkers.set(crypto.randomUUID(),{expiresAt:Date.now()+60000,dispatched:false});state.spawnPending=expectedWorkers.size;return deficit;}
function dispatchWorkerReservations(){reserveMissingWorkers();const ids=[];for(const [id,reservation] of expectedWorkers)if(!reservation.dispatched){reservation.dispatched=true;ids.push(id);}return ids;}
try { state = { ...state, ...JSON.parse(await fs.readFile(STATE_FILE, 'utf8')) }; }
catch { /* first run */ }
try { state.queued = JSON.parse(await fs.readFile(QUEUE_FILE,'utf8')); }
catch { state.queued=[]; }
state.leases ||= [];state.spawnPending=0;
// Recovery occurs after the manifest writer is defined below.

function parseCsv(text) {
  const records=[]; let row=[], value='', quoted=false;
  for(let i=0;i<text.length;i++) { const c=text[i]; if(quoted){if(c==='"'&&text[i+1]==='"'){value+='"';i++;}else if(c==='"')quoted=false;else value+=c;}else if(c==='"')quoted=true;else if(c===','){row.push(value);value='';}else if(c==='\n'){row.push(value.replace(/\r$/,''));records.push(row);row=[];value='';}else value+=c; }
  if(row.length||value){row.push(value);records.push(row);}
  const head=records.shift()?.map(x=>x.replace(/^\uFEFF/,''))||[];
  return records.filter(r=>r.length===head.length).map(r=>Object.fromEntries(head.map((key,i)=>[key,r[i]])));
}
async function manifestStatusCounts(force=false){if(!force&&manifestCountsCache.value&&Date.now()-manifestCountsCache.at<10000)return manifestCountsCache.value;const counts={pending:0,retry:0,uncertain:0,submitted:0,other:0};const dirs=(await fs.readdir(ROOT,{withFileTypes:true})).filter(entry=>entry.isDirectory()&&!entry.name.startsWith('.'));for(const dir of dirs){let rows;try{rows=parseCsv(await fs.readFile(path.join(ROOT,dir.name,'upload_manifest.csv'),'utf8'));}catch{continue;}for(const row of rows){const status=String(row.upload_status||'other');counts[status]=(counts[status]||0)+1;}}counts.unresolved=(counts.retry||0)+(counts.uncertain||0);manifestCountsCache={at:Date.now(),value:counts};return counts;}
function invalidateManifestCounts(){manifestCountsCache.at=0;manifestCountsCache.value=null;}
function csv(rows) { const q=v=>`"${String(v??'').replaceAll('"','""')}"`; return [columns.map(q).join(','),...rows.map(r=>columns.map(k=>q(r[k])).join(','))].join('\r\n')+'\r\n'; }
async function save() { const temp=STATE_FILE+'.tmp'; const {queued,...small}=state; await fs.writeFile(temp,JSON.stringify({...small,queued:queued.length},null,2)); await fs.rename(temp,STATE_FILE); }
async function saveQueue(){const temp=QUEUE_FILE+'.tmp';await fs.writeFile(temp,JSON.stringify(state.queued));await fs.rename(temp,QUEUE_FILE);}
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
  invalidateManifestCounts();
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
  const retryItems=[];const pendingItems=[];const skipped=[];
  for(const folder of dirs){
    let rows; try{ rows=parseCsv(await fs.readFile(path.join(ROOT,folder,'upload_manifest.csv'),'utf8')); }catch{continue;}
    for(const row of rows){if(row.upload_status!=='pending'&&row.upload_status!=='retry')continue; const file=path.join(ROOT,folder,row.filename);
      try{const stat=await fs.stat(file);if(stat.size>0&&stat.size<=256*1024&&/\.(png|gif)$/i.test(row.filename)){const item={folder,filename:row.filename,title:row.title,category_value:row.category_value,license:row.license,tags:row.tags,description:row.description,attempt:0};(row.upload_status==='retry'?retryItems:pendingItems).push(item);}else skipped.push(`${folder}/${row.filename}: invalid type or size`);}catch{skipped.push(`${folder}/${row.filename}: missing`);}
    }
  }
  const candidates=[...retryItems,...pendingItems],items=limit?candidates.slice(0,limit):candidates;
  const temp=QUEUE_FILE+'.tmp';await fs.writeFile(temp,JSON.stringify(items));await fs.rename(temp,QUEUE_FILE);
  state={running:items.length>0,paused:false,limit,queued:items,cursor:0,leases:[],workers:workerCount,spawnPending:Math.max(0,workerCount-readyWorkers()),done:0,failed:0,skipped:skipped.length,uncertainThisRun:0,message:skipped.slice(0,5).join('; ')};
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
async function requeueUncertain(input){if(state.running&&(state.cursor<state.queued.length||state.leases.length))throw new Error('Pause and finish active batches before requeueing uncertain items');if(state.leases.length)throw new Error('An upload batch is still in flight');const folderFilter=String(input.folder||''),filename=String(input.filename||'');if(folderFilter&&!safeLeaf(folderFilter)||filename&&!safeLeaf(filename))throw new Error('Invalid item path');const dirs=(await fs.readdir(ROOT,{withFileTypes:true})).filter(entry=>entry.isDirectory()&&!entry.name.startsWith('.')&&(!folderFilter||entry.name===folderFilter));let changed=0,files=0;for(const dir of dirs){const manifest=path.join(ROOT,dir.name,'upload_manifest.csv');let content,rows;try{content=await fs.readFile(manifest,'utf8');rows=parseCsv(content);}catch{continue;}let fileChanged=0;for(const row of rows){if(row.upload_status!=='uncertain'||filename&&row.filename!==filename)continue;const previous=String(row.upload_notes||'').trim();row.upload_status='retry';row.upload_notes=`Manually returned to retry queue${previous?`; previous: ${previous}`:''}`.slice(0,500);fileChanged++;changed++;}if(!fileChanged)continue;const backup=path.join(ROOT,dir.name,'upload_manifest.before-uncertain-requeue.csv');try{await fs.writeFile(backup,content,{flag:'wx'});}catch(error){if(error.code!=='EEXIST')throw error;}const temp=manifest+'.requeue-tmp';await fs.writeFile(temp,csv(rows));await fs.rename(temp,manifest);files++;if(filename)break;}if(!changed)throw new Error('No matching uncertain entries were found');invalidateManifestCounts();return {changed,files};}
function json(res,status,body){if(res.headersSent||res.writableEnded)return;const data=JSON.stringify(body);res.writeHead(status,{'Content-Type':'application/json','Content-Length':Buffer.byteLength(data),'Cache-Control':'no-store'});res.end(data);}
async function body(req){let s='';for await(const part of req){s+=part;if(s.length>5*1024*1024)throw new Error('Request too large');}return s?JSON.parse(s):{};}
async function binary(req){const parts=[];let size=0;for await(const part of req){size+=part.length;if(size>256*1024)throw new Error('Image exceeds 256 KiB');parts.push(part);}return Buffer.concat(parts);}
function validImageBytes(bytes){return bytes.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10]))||bytes.subarray(0,6).toString('ascii').startsWith('GIF8');}
function validWindowsLeaf(value){return safeLeaf(value)&&value===value.trim()&&!/[<>:"/\\|?*\x00-\x1f]/.test(value)&&!/[. ]$/.test(value)&&! /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(value);}
function validatePackName(value){const pack=String(value||'').trim();if(!pack||pack.startsWith('.')||!validWindowsLeaf(pack))throw new Error('Pack name contains invalid Windows filename characters');return pack;}
function normalizeImportRows(input){if(!Array.isArray(input)||!input.length||input.length>500)throw new Error('CSV must contain 1–500 image rows');const seen=new Set(),allowedLicenses=new Set(['CC BY 4.0','Basic','WTFPL','Streamer']);return input.map((value,index)=>{const filename=String(value.filename||'').trim(),title=String(value.title||'').trim(),tags=String(value.tags||'').trim(),description=String(value.description||'').trim(),category_value=String(value.category_value||'').trim(),license=String(value.license||'').trim();if(!validWindowsLeaf(filename)||!/\.(?:png|gif)$/i.test(filename))throw new Error(`Row ${index+2}: invalid PNG/GIF filename`);if(seen.has(filename.toLowerCase()))throw new Error(`Row ${index+2}: duplicate filename ${filename}`);seen.add(filename.toLowerCase());if(!title||title.length>100)throw new Error(`Row ${index+2}: title is required and must be 100 characters or less`);if(!tags||tags.length>500)throw new Error(`Row ${index+2}: prioritized tags are required`);if(!description||description.length>2500)throw new Error(`Row ${index+2}: description is required and must be 2500 characters or less`);if(!/^(?:[1-9]|1\d|2[0-3])$/.test(category_value))throw new Error(`Row ${index+2}: category_value must be 1–23`);if(!allowedLicenses.has(license))throw new Error(`Row ${index+2}: unsupported license`);return {filename,title,tags,description,category_value,license};});}
async function beginManifestImport(input){const pack=validatePackName(input.pack),rows=normalizeImportRows(input.rows),files=Array.isArray(input.files)?input.files:[];if(files.length!==rows.length)throw new Error('Selected image count does not match the CSV');const names=new Map(files.map(file=>[String(file.name||''),file]));if(names.size!==files.length)throw new Error('Selected images contain duplicate filenames');for(const row of rows){const file=names.get(row.filename);if(!file)throw new Error(`No selected image exactly matches ${row.filename}`);if(!Number.isInteger(file.size)||file.size<1||file.size>256*1024)throw new Error(`${row.filename} must be 1–256 KiB`);}try{await fs.access(path.join(ROOT,pack));throw new Error('That pack folder already exists; choose a new pack name');}catch(error){if(error.code!=='ENOENT')throw error;}const id=crypto.randomUUID(),stage=path.join(IMPORT_DATA,id);await fs.mkdir(stage,{recursive:true});importSessions.set(id,{pack,rows,files:names,uploaded:new Set(),stage,expiresAt:Date.now()+30*60*1000});return {id,count:rows.length};}
async function stageManifestFile(req,u){const id=String(u.searchParams.get('id')||''),filename=String(u.searchParams.get('filename')||''),session=importSessions.get(id);if(!session||session.expiresAt<Date.now())throw new Error('Import session expired; start the import again');const expected=session.files.get(filename);if(!expected||!safeLeaf(filename))throw new Error('File is not listed in this import');if(session.uploaded.has(filename))throw new Error('File was already received');const bytes=await binary(req);if(bytes.length!==expected.size)throw new Error('File size changed during import');if(!validImageBytes(bytes))throw new Error('File content is not PNG or GIF');await fs.writeFile(path.join(session.stage,filename),bytes,{flag:'wx'});session.uploaded.add(filename);return {received:session.uploaded.size,total:session.rows.length};}
async function commitManifestImport(id){const session=importSessions.get(String(id||''));if(!session||session.expiresAt<Date.now())throw new Error('Import session expired; start the import again');if(session.uploaded.size!==session.rows.length)throw new Error(`Import is incomplete: ${session.uploaded.size}/${session.rows.length} images received`);const rows=session.rows.map(row=>({...row,primary_emoji:'',secondary_emoji:'',category:'',source:'',batch_number:'',batch_position:'',upload_status:'pending',upload_notes:''}));await fs.writeFile(path.join(session.stage,'upload_manifest.csv'),csv(rows));const target=path.join(ROOT,session.pack);try{await fs.access(target);throw new Error('That pack folder was created during import; choose a new pack name');}catch(error){if(error.code!=='ENOENT')throw error;}await fs.rename(session.stage,target);importSessions.delete(String(id));invalidateManifestCounts();return {folder:session.pack,count:rows.length};}
async function importImage(req,u){
  const pack=validatePackName(u.searchParams.get('pack'));
  const original=String(u.searchParams.get('filename')||'').replace(/[<>:"/\\|?*\x00-\x1f]/g,'_');
  if(!safeLeaf(pack)||pack.startsWith('.')||!safeLeaf(original)||!/\.(png|gif)$/i.test(original))throw new Error('Choose a pack name and PNG/GIF files');
  const bytes=await binary(req);if(!bytes.length)throw new Error('Empty file');
  if(!validImageBytes(bytes))throw new Error('File content is not PNG or GIF');
  const folder=path.join(ROOT,pack);await fs.mkdir(folder,{recursive:true});
  const ext=path.extname(original),base=path.basename(original,ext);let filename=original,n=2;
  while(true){try{await fs.access(path.join(folder,filename));filename=`${base}-${n++}${ext}`;}catch{break;}}
  const manifest=path.join(folder,'upload_manifest.csv');let rows=[];try{rows=parseCsv(await fs.readFile(manifest,'utf8'));}catch{ /* new pack */ }
  const title=base.replace(/[-_]+/g,' ').replace(/\s+/g,' ').trim().replace(/\b\w/g,c=>c.toUpperCase()).slice(0,80);
  const row={filename,title,primary_emoji:'',secondary_emoji:'',category:'Original Style',category_value:'1',license:'Basic',tags:'emoji; '+title.toLowerCase().split(' ').join('; '),description:`${title} emoji image.`,source:'',batch_number:'',batch_position:'',upload_status:'pending',upload_notes:''};
  await fs.writeFile(path.join(folder,filename),bytes,{flag:'wx'});
  const temp=manifest+'.queue-tmp';await fs.writeFile(temp,csv([...rows,row]));await fs.rename(temp,manifest);
  invalidateManifestCounts();
  return {folder,filename};
}
const server=http.createServer(async(req,res)=>{
  try{
    const u=new URL(req.url,'http://localhost');
    if(req.method==='OPTIONS'){res.writeHead(204);return res.end();}
    if(u.pathname==='/'){res.writeHead(200,{'Content-Type':'text/html; charset=utf-8','X-Frame-Options':'DENY','Content-Security-Policy':"frame-ancestors 'none'"});return res.end((await fs.readFile(new URL('./dashboard.html',import.meta.url),'utf8')).replace('__QUEUE_TOKEN__',token));}
    if(u.pathname==='/vendor/bootswatch-cyborg.min.css'){res.writeHead(200,{'Content-Type':'text/css; charset=utf-8','Cache-Control':'public, max-age=86400'});return res.end(await fs.readFile(new URL('./vendor/bootswatch-cyborg.min.css',import.meta.url),'utf8'));}
    if(u.pathname==='/studio.css'){res.writeHead(200,{'Content-Type':'text/css; charset=utf-8','Cache-Control':'no-cache'});return res.end(await fs.readFile(new URL('./studio.css',import.meta.url),'utf8'));}
    if(u.pathname==='/upload_manifest.template.csv'){res.writeHead(200,{'Content-Type':'text/csv; charset=utf-8','Content-Disposition':'attachment; filename="upload_manifest.template.csv"','Cache-Control':'no-cache'});return res.end(await fs.readFile(new URL('./upload_manifest.template.csv',import.meta.url),'utf8'));}
    if(u.pathname==='/uploader.user.js'){const script=await fs.readFile(new URL('./uploader.user.js',import.meta.url),'utf8');res.writeHead(200,{'Content-Type':'text/javascript; charset=utf-8'});return res.end(script);}
    if(u.pathname==='/api/pair'&&req.headers['x-queue-pair']==='local-userscript'&&Date.now()<pairingUntil){pairingUntil=0;res.writeHead(200,{'Content-Type':'application/json','Cache-Control':'no-store'});return res.end(JSON.stringify({token}));}
    const auth=req.headers['x-queue-token']===token || u.searchParams.get('token')===token;
    if(!auth)return json(res,403,{error:'Invalid queue token'});
    if(u.pathname==='/api/status'){expireWorkerReservations();const manifestCounts=await manifestStatusCounts();return json(res,200,{...state,protocolVersion:'0.4.0',studioVersion:STUDIO_VERSION,updateMessage,root:ROOT,queued:state.queued.length-state.cursor,leased:state.leases.reduce((n,x)=>n+x.items.length,0),unresolved:manifestCounts.unresolved,manifestCounts,workerReady:readyWorkers()>0,activeWorkers:activeWorkers(),readyWorkers:readyWorkers(),expectedWorkers:expectedWorkers.size,workerTabs:workerSummaries()});}
    if(u.pathname==='/api/enable-pairing'&&req.method==='POST'){pairingUntil=Date.now()+60000;return json(res,200,{ok:true,expiresInSeconds:60});}
    if(u.pathname==='/api/hello'&&req.method==='POST')return await serial(async()=>{const hello=await body(req);if(hello.version!=='0.4.0'||!uuid(hello.clientId))throw new Error('Worker update required');const installationId=uuid(hello.installationId)?hello.installationId:`legacy-${hello.clientId}`,pageInstanceId=uuid(hello.pageInstanceId)?hello.pageInstanceId:`legacy-page-${hello.clientId}`,scriptVersion=String(hello.scriptVersion||'older').slice(0,24),reloadRequired=!versionAtLeast(scriptVersion);expectedWorkers.delete(hello.clientId);let worker=workers.get(hello.clientId),activeLease=state.leases.find(lease=>lease.owner===hello.clientId),differentInstance=worker?.pageInstanceId&&worker.pageInstanceId!==pageInstanceId;if(worker?.installationId&&worker.installationId!==installationId&&isConnected(worker))return json(res,200,{ok:true,duplicate:true,reloadRequired,minimumVersion:STUDIO_VERSION,spawnIds:[]});if(differentInstance&&activeLease&&isConnected(worker))return json(res,200,{ok:true,duplicate:true,activeLease:true,retryAfterMs:5000,reloadRequired,minimumVersion:STUDIO_VERSION,spawnIds:[]});if(!worker||worker.installationId!==installationId||differentInstance){worker={session:crypto.randomBytes(24).toString('hex'),seenAt:0,installationId,pageInstanceId};workers.set(hello.clientId,worker);}worker.seenAt=Date.now();worker.scriptVersion=scriptVersion;worker.supportsHeartbeat=hello.heartbeat===true;worker.stage=String(hello.stage||'idle').slice(0,80);worker.progressAt=Number(hello.progressAt)||worker.seenAt;while(expectedWorkers.size&&activeWorkers()+expectedWorkers.size>state.workers)expectedWorkers.delete(expectedWorkers.keys().next().value);let spawnIds=[];if(isReady(worker)&&Date.now()>=nextSpawnReconcileAt){spawnIds=dispatchWorkerReservations();nextSpawnReconcileAt=Date.now()+5000;}state.spawnPending=expectedWorkers.size;return json(res,200,{ok:true,session:worker.session,spawnIds,reloadRequired,minimumVersion:STUDIO_VERSION});});
    if(u.pathname==='/api/catalog')return json(res,200,await catalog(Math.max(0,Number(u.searchParams.get('offset')||0)),Math.min(100,Math.max(1,Number(u.searchParams.get('limit')||40))),u.searchParams.get('folder')||'',u.searchParams.get('status')||'pending'));
    if(u.pathname==='/api/import-session'&&req.method==='POST')return json(res,200,await serial(async()=>beginManifestImport(await body(req))));
    if(u.pathname==='/api/import-session/file'&&req.method==='POST')return json(res,200,await serial(()=>stageManifestFile(req,u)));
    if(u.pathname==='/api/import-session/commit'&&req.method==='POST')return json(res,200,await serial(async()=>commitManifestImport((await body(req)).id)));
    if(u.pathname==='/api/import'&&req.method==='POST')return json(res,200,await serial(()=>importImage(req,u)));
    if(u.pathname==='/api/edit'&&req.method==='POST')return json(res,200,{item:await serial(async()=>editRow(await body(req)))});
    if(u.pathname==='/api/requeue-uncertain'&&req.method==='POST')return json(res,200,await serial(async()=>requeueUncertain(await body(req))));
    if(u.pathname==='/api/preview'){
      const folder=u.searchParams.get('folder')||'',filename=u.searchParams.get('filename')||'';if(!safeLeaf(folder)||!safeLeaf(filename))throw new Error('Invalid item path');
      const file=path.join(ROOT,folder,filename);const stat=await fs.stat(file);if(stat.size>256*1024)throw new Error('Preview too large');
      res.writeHead(200,{'Content-Type':/\.gif$/i.test(file)?'image/gif':'image/png','Content-Length':stat.size,'Cache-Control':'no-store'});return createReadStream(file).pipe(res);
    }
    if(u.pathname==='/api/start'&&req.method==='POST')return await serial(async()=>{if(shuttingDown)throw new Error('Studio is shutting down');const input=await body(req),job=await createQueue(Number(input.limit),String(input.folder||''),Number(input.workers||1));return json(res,200,{queued:job.queued.length,skipped:job.skipped});});
    if(u.pathname==='/api/workers'&&req.method==='POST')return await serial(async()=>{const input=await body(req),count=Number(input.workers);if(!Number.isInteger(count)||count<1||count>10)throw new Error('Choose 1–10 worker tabs');state.workers=count;expireWorkerReservations();const connected=activeWorkers(),openFirst=connected===0,targetReservations=Math.max(0,count-connected-(openFirst?1:0));while(expectedWorkers.size>targetReservations)expectedWorkers.delete(expectedWorkers.keys().next().value);while(expectedWorkers.size<targetReservations)expectedWorkers.set(crypto.randomUUID(),{expiresAt:Date.now()+60000,dispatched:false});state.spawnPending=expectedWorkers.size;nextSpawnReconcileAt=0;await save();return json(res,200,{workers:count,spawnPending:expectedWorkers.size,openFirst,reusing:Math.min(count,connected)});});
    if(u.pathname==='/api/pause'&&req.method==='POST')return await serial(async()=>{state.paused=true;await save();return json(res,200,{ok:true});});
    if(u.pathname==='/api/resume'&&req.method==='POST')return await serial(async()=>{if(shuttingDown)throw new Error('Studio is shutting down');if(!readyWorkers())throw new Error('Worker 0.4.3 or newer is required before resuming');state.paused=false;state.running=state.cursor<state.queued.length||state.leases.length>0;await save();return json(res,200,{ok:true});});
    if(u.pathname==='/api/shutdown'&&req.method==='POST')return await serial(async()=>{shuttingDown=true;state.paused=true;await save();json(res,200,{ok:true,draining:state.leases.length});const timer=setInterval(()=>{if(!state.leases.length){clearInterval(timer);server.close();}},500);});
    if(u.pathname==='/api/next')return await serial(async()=>{
      const owner=workerOwner(req);if(!owner||!workers.get(owner)?.supportsHeartbeat)return json(res,403,{error:'Worker 0.4.3 or newer required'});
      if(!state.running||state.paused)return json(res,200,{batch:null});
      const existing=state.leases.find(x=>x.owner===owner);if(existing)return json(res,200,{batch:null,blocked:{id:existing.id,itemCount:existing.items.length,issuedAt:existing.issuedAt}});
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
      const result=await body(req);const lease=state.leases.find(x=>x.id===result.id&&x.owner===owner);if(!lease){const completed=completedLeases.get(result.id);if(completed?.owner===owner)return json(res,200,{ok:true,duplicate:true});throw new Error('Unknown batch');}
      if(!Array.isArray(result.outcomes)||result.outcomes.length!==lease.items.length)throw new Error('Outcome count mismatch');
      const outcomes=result.outcomes.map(o=>({status:o.status==='submitted'?'submitted':o.status==='retry'?'retry':'uncertain',note:o.status==='submitted'?'':String(o.note||'').slice(0,300)}));
      await updateManifest(lease.items,outcomes);
      const automaticRetries=[];let doneDelta=0,failedDelta=0,uncertainDelta=0;
      for(let i=0;i<outcomes.length;i++){const outcome=outcomes[i],item=lease.items[i],attempt=Number(item.attempt||0);if(outcome.status==='submitted'){doneDelta++;if(attempt>0)failedDelta--;}else{if(attempt===0)failedDelta++;if(outcome.status==='uncertain')uncertainDelta++;if(outcome.status==='retry'&&attempt<MAX_AUTOMATIC_RETRIES)automaticRetries.push({...item,attempt:attempt+1});}}
      state.done+=doneDelta;state.failed=Math.max(0,state.failed+failedDelta);state.leases=state.leases.filter(x=>x!==lease);
      state.uncertainThisRun=(state.uncertainThisRun||0)+uncertainDelta;if(state.uncertainThisRun>=MAX_UNCERTAIN_BEFORE_PAUSE)state.paused=true;
      completedLeases.set(lease.id,{owner,completedAt:Date.now()});
      if(automaticRetries.length){state.queued.splice(state.cursor,0,...automaticRetries);await saveQueue();}
      state.message=state.paused&&state.uncertainThisRun>=MAX_UNCERTAIN_BEFORE_PAUSE?`Safety pause: ${state.uncertainThisRun} ambiguous items need reconciliation`:`${state.done} submitted; ${state.failed} unresolved${automaticRetries.length?`; ${automaticRetries.length} returned to the front of the queue for retry`:''}`;
      if(state.cursor>=state.queued.length&&!state.leases.length)state.running=false;await save();return json(res,200,{ok:true});
    });
    json(res,404,{error:'Not found'});
  }catch(error){console.error(`${req.method} ${req.url}:`,error);json(res,400,{error:error.message});}
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
    state.uncertainThisRun=(state.uncertainThisRun||0)+stale.reduce((sum,lease)=>sum+lease.items.length,0);if(state.uncertainThisRun>=MAX_UNCERTAIN_BEFORE_PAUSE)state.paused=true;
    state.message=`${state.failed} unresolved; ${stale.length} disconnected batches need review`;
    reserveMissingWorkers();
    nextSpawnReconcileAt=0;
    if(state.cursor>=state.queued.length&&!state.leases.length)state.running=false;
    await save();
  }).catch(error=>console.error('Could not recover disconnected batch:',error));
}
const recoveryTimer=setInterval(recoverDisconnectedBatches,30000);
recoveryTimer.unref();
const workerPruneTimer=setInterval(()=>{for(const [id,worker] of workers){if(Date.now()-worker.seenAt>10*60*1000&&!state.leases.some(lease=>lease.owner===id))workers.delete(id);}},60000);
workerPruneTimer.unref();
const completedLeasePruneTimer=setInterval(()=>{for(const [id,value] of completedLeases)if(Date.now()-value.completedAt>10*60*1000)completedLeases.delete(id);},60000);
completedLeasePruneTimer.unref();
const importCleanupTimer=setInterval(async()=>{for(const [id,session] of importSessions)if(session.expiresAt<Date.now()){importSessions.delete(id);await fs.rm(session.stage,{recursive:true,force:true}).catch(()=>{});}},60000);
importCleanupTimer.unref();

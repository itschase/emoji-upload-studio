import fs from 'node:fs/promises';
import {openSync,closeSync} from 'node:fs';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {checkUpdate,applyUpdate} from './update.mjs';

const here=path.dirname(fileURLToPath(import.meta.url));
let config={};try{config=JSON.parse(await fs.readFile(path.join(here,'config.local.json'),'utf8'));}catch{}
let root=process.env.EMOJI_QUEUE_ROOT||config.root;
if(!root){root=path.join(here,'upload-packs');await fs.mkdir(root,{recursive:true});await fs.writeFile(path.join(here,'config.local.json'),JSON.stringify({root},null,2)+'\n');console.log(`First run: created local pack folder at ${root}`);}
const data=path.join(path.resolve(root),'.upload-queue');
const port=Number(process.env.EMOJI_QUEUE_PORT||43861);
const base=`http://127.0.0.1:${port}`;
const command=process.argv[2]||'start';
async function readToken(){return fs.readFile(path.join(data,'token.txt'),'utf8').then(x=>x.trim()).catch(()=>null);}
async function status(){try{const token=await readToken();const response=await fetch(base+'/api/status',{headers:token?{'X-Queue-Token':token}:{},signal:AbortSignal.timeout(2000)});if(!response.ok)throw new Error(`Port ${port} is in use by a different or incompatible server`);const result=await response.json();if(result.protocolVersion!=='0.4.0')throw new Error(`Port ${port} has an older Upload Studio server. Stop it before launching this version.`);return result;}catch(error){if(error.message.includes('Port '))throw error;return null;}}
async function waitFor(wanted,timeout=30000){const end=Date.now()+timeout;while(Date.now()<end){const current=await status();if(Boolean(current)===wanted)return current;await new Promise(r=>setTimeout(r,500));}throw new Error(wanted?'Studio did not start':'Studio is still finishing active batches');}
function openBrowser(){if(process.env.EMOJI_STUDIO_NO_BROWSER==='1')return;const executable=process.platform==='win32'?'explorer.exe':process.platform==='darwin'?'open':'xdg-open';const child=spawn(executable,[base],{detached:true,stdio:'ignore',windowsHide:false});child.unref();}
async function syncSource(){try{const update=await checkUpdate();if(!update.available)return false;console.log('New Studio version found; finishing active batches before updating.');if(await status())await stop(true);await applyUpdate(update.remote);console.log('Studio updated from GitHub.');return true;}catch(error){console.log(`Studio update skipped: ${error.message}`);return false;}}
async function start(){await syncSource();if(await status()){console.log('Studio is already running.');openBrowser();return;}await fs.mkdir(data,{recursive:true});const log=path.join(data,'studio-server.log'),fd=openSync(log,'a');const child=spawn(process.execPath,[path.join(here,'server.mjs')],{cwd:here,env:process.env,detached:true,windowsHide:true,stdio:['ignore',fd,fd]});child.unref();closeSync(fd);await waitFor(true);console.log(`Studio started at ${base}`);openBrowser();}
async function stop(wait=false){const current=await status();if(!current){console.log('Studio is already stopped.');return;}const token=await readToken();const response=await fetch(base+'/api/shutdown',{method:'POST',headers:{'X-Queue-Token':token,'Content-Type':'application/json'},body:'{}'});if(!response.ok)throw new Error(`Could not stop Studio: ${response.status}`);const result=await response.json();console.log(result.draining?`Finishing ${result.draining} active batch(es) before stopping.`:'Stopping Studio.');if(wait)await waitFor(false,300000);}
try{
  if(command==='start')await start();
  else if(command==='stop')await stop(false);
  else if(command==='restart'){await stop(true);await start();}
  else if(command==='status'){const current=await status();console.log(current?`Running: ${current.done} submitted, ${current.queued} waiting, ${current.leased} in flight`:'Stopped');}
  else throw new Error('Use start, stop, restart, or status');
}catch(error){console.error(error.message);process.exitCode=1;}

// Watches one large pending queue and performs one bounded retry pass for explicit failures.
import fs from 'node:fs/promises';
import path from 'node:path';
let config={};try{config=JSON.parse(await fs.readFile(new URL('./config.local.json',import.meta.url),'utf8'));}catch{/* environment variable may supply the root */}
if(!process.env.EMOJI_QUEUE_ROOT&&!config.root)throw new Error('Set EMOJI_QUEUE_ROOT or config.local.json root');
const root=path.resolve(process.env.EMOJI_QUEUE_ROOT||config.root);
const data=path.join(root,'.upload-queue');
const token=(await fs.readFile(path.join(data,'token.txt'),'utf8')).trim();
const report=path.join(data,'auto-finish-report.json');
const columns=['filename','title','primary_emoji','secondary_emoji','category','category_value','license','tags','description','source','batch_number','batch_position','upload_status','upload_notes'];
function parse(text){const rows=[];let row=[],value='',quoted=false;for(let i=0;i<text.length;i++){const c=text[i];if(quoted){if(c==='"'&&text[i+1]==='"'){value+='"';i++;}else if(c==='"')quoted=false;else value+=c;}else if(c==='"')quoted=true;else if(c===','){row.push(value);value='';}else if(c==='\n'){row.push(value.replace(/\r$/,''));rows.push(row);row=[];value='';}else value+=c;}if(row.length||value){row.push(value);rows.push(row);}const h=rows.shift()?.map(x=>x.replace(/^\uFEFF/,''))||[];return rows.filter(r=>r.length===h.length).map(r=>Object.fromEntries(h.map((k,i)=>[k,r[i]])));}
function csv(rows){const q=v=>`"${String(v??'').replaceAll('"','""')}"`;return [columns.map(q).join(','),...rows.map(r=>columns.map(k=>q(r[k])).join(','))].join('\r\n')+'\r\n';}
async function api(route,body){const r=await fetch(`http://127.0.0.1:43861/api/${route}`,{method:body?'POST':'GET',headers:{'X-Queue-Token':token,'Content-Type':'application/json'},body:body?JSON.stringify(body):undefined});const v=await r.json();if(!r.ok)throw Error(v.error);return v;}
async function scan(convert=false){const counts={pending:0,submitted:0,retry:0,uncertain:0,failed:0};const dirs=(await fs.readdir(root,{withFileTypes:true})).filter(d=>d.isDirectory()&&!d.name.startsWith('.'));
  for(const dir of dirs){const file=path.join(root,dir.name,'upload_manifest.csv');let content,rows;try{content=await fs.readFile(file,'utf8');rows=parse(content);}catch{continue;}
    let changed=false;for(const row of rows){if(convert&&row.upload_status==='retry'){row.upload_status='pending';changed=true;}counts[row.upload_status]=(counts[row.upload_status]||0)+1;}
    if(changed){try{await fs.writeFile(file+'.before-auto-retry.csv',content,{flag:'wx'});}catch(error){if(error.code!=='EEXIST')throw error;}const temp=file+'.retry-tmp';await fs.writeFile(temp,csv(rows));await fs.rename(temp,file);}
  }return counts;}
let stage='primary';
while(true){
  try{const status=await api('status');
    if(status.failed>500&&status.done>100&&stage==='primary'){await api('pause',{});await fs.writeFile(report,JSON.stringify({stage:'paused-for-high-failure-rate',status,counts:await scan(),at:new Date().toISOString()},null,2));break;}
    if(!status.running&&status.queued===0){
      if(stage==='primary'){
        const counts=await scan();
        if(!counts.retry){await fs.writeFile(report,JSON.stringify({stage:'complete',counts,at:new Date().toISOString()},null,2));break;}
        if(counts.retry>500){await fs.writeFile(report,JSON.stringify({stage:'retry-review-needed',counts,at:new Date().toISOString()},null,2));break;}
        if(status.workerReady){await scan(true);await api('start',{limit:0,folder:''});stage='retry';await fs.writeFile(report,JSON.stringify({stage:'retry-running',previousRetryCount:counts.retry,at:new Date().toISOString()},null,2));}
      }else{await fs.writeFile(report,JSON.stringify({stage:'complete-after-retry',counts:await scan(),at:new Date().toISOString()},null,2));break;}
    }
  }catch(error){await fs.writeFile(report,JSON.stringify({stage:'watching',lastError:error.message,at:new Date().toISOString()},null,2));}
  await new Promise(resolve=>setTimeout(resolve,15000));
}

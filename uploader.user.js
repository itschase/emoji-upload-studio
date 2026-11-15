// ==UserScript==
// @name         Emoji.gg Upload Studio Worker
// @namespace    local.emoji.upload.queue
// @version      0.6.12
// @description  Works with the local Upload Studio to stage and submit Emoji.gg images in batches of ten.
// @license      MIT
// @homepageURL  https://github.com/itschase/emoji-upload-studio
// @match        https://emoji.gg/submit*
// @grant        GM_xmlhttpRequest
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_deleteValue
// @grant        GM_openInTab
// @connect      127.0.0.1
// @updateURL    https://raw.githubusercontent.com/itschase/emoji-upload-studio/main/uploader.user.js
// @downloadURL  https://raw.githubusercontent.com/itschase/emoji-upload-studio/main/uploader.user.js
// @run-at       document-idle
// ==/UserScript==
(() => {
  'use strict';
  if(!['/submit','/submit/sticker'].includes(location.pathname))return;
  if(document.documentElement.dataset.emojiUploadStudioWorker)return;
  document.documentElement.dataset.emojiUploadStudioWorker='0.6.12';
  const base = 'http://127.0.0.1:43861';
  let token = GM_getValue('queueToken','');
  let installationId=GM_getValue('installationId','');if(!/^[0-9a-f-]{36}$/i.test(installationId)){installationId=crypto.randomUUID();GM_setValue('installationId',installationId);}
  const workerParams=new URLSearchParams(location.search),openedByStudio=workerParams.has('upload_studio_worker');
  const clientId=workerParams.get('upload_studio_worker')||crypto.randomUUID();
  const pageInstanceId=crypto.randomUUID();
  const journalKey=`workerJournal:${clientId}`;
  const workerUrl=pathname=>`${pathname}?upload_studio_worker=${encodeURIComponent(clientId)}`;
  let workerSession='';
  let workerStage='idle',progressAt=Date.now();
  function setStage(value){workerStage=value;progressAt=Date.now();say(value);}
  function readJournal(){const value=GM_getValue(journalKey,null);return value&&value.batchId?value:null;}
  function writeJournal(value){GM_setValue(journalKey,{...value,updatedAt:Date.now()});}
  function clearJournal(){GM_deleteValue(journalKey);}
  const badge = document.createElement('div');
  badge.style.cssText = 'position:fixed;z-index:2147483647;bottom:12px;left:12px;background:#111;color:#eee;border:1px solid #555;padding:7px 10px;border-radius:7px;font:12px system-ui;max-width:360px';
  const statusText=document.createElement('span');statusText.textContent='Local upload queue: checking';
  const studioLink=document.createElement('a');studioLink.textContent='Open Upload Studio ↗';studioLink.href=base;studioLink.target='_blank';studioLink.rel='noopener noreferrer';studioLink.style.cssText='display:inline-block;margin-left:9px;background:#333;color:#eee;border:1px solid #666;border-radius:5px;padding:3px 6px;text-decoration:none;white-space:nowrap';studioLink.title='Open the local Upload Studio dashboard in a new tab';
  const queueText=document.createElement('div');queueText.style.cssText='margin-top:5px;color:#bbb';
  const queueButton=document.createElement('button');queueButton.type='button';queueButton.style.cssText='display:none;margin-top:5px;background:#333;color:#eee;border:1px solid #666;border-radius:5px;padding:3px 6px;cursor:pointer';
  queueButton.addEventListener('click',async()=>{try{await request(queueButton.dataset.action,{});say(queueButton.dataset.action==='pause'?'pausing after this batch':'resuming queue');}catch(error){say(error.message);}});
  badge.append(statusText,studioLink,queueText,queueButton);document.body.append(badge);
  function say(message) { statusText.textContent = `Local upload queue: ${message}`; }
  function showQueue(status){queueText.textContent=`${status.activeWorkers}/${status.workers} tabs · ${status.done} submitted · ${status.queued} queued${status.leased?` · ${status.leased} processing`:''} · ${status.unresolved??status.failed} unresolved`;queueButton.dataset.action=status.paused?'resume':'pause';queueButton.textContent=status.paused?'Resume queue':'Pause after batch';queueButton.style.display=status.running||status.paused&&status.queued?'inline-block':'none';}
  function pair() { return new Promise((resolve,reject)=>GM_xmlhttpRequest({method:'GET',url:`${base}/api/pair`,responseType:'json',headers:{'X-Queue-Pair':'local-userscript'},timeout:10000,onload:r=>r.status===200&&r.response?.token?resolve(r.response.token):reject(new Error(r.status===404?'Older Upload Studio server active':'Waiting for local worker pairing')),onerror:()=>reject(new Error('Local studio unavailable')),ontimeout:()=>reject(new Error('Pairing timed out'))})); }
  function legacyWorker(){return [...document.querySelectorAll('div')].find(el=>el!==badge&&el.childNodes.length===1&&el.firstChild?.nodeType===Node.TEXT_NODE&&el.textContent?.startsWith('Local upload queue:'));}
  function request(route, data, responseType = 'json', timeout = 15000) {
    return new Promise((resolve, reject) => GM_xmlhttpRequest({
      method: data === undefined ? 'GET' : 'POST', url: `${base}/api/${route}`, responseType,
      headers: { 'X-Queue-Token': token, ...(workerSession ? {'X-Worker-Session':workerSession} : {}), ...(data === undefined ? {} : { 'Content-Type': 'application/json' }) },
      data: data === undefined ? undefined : JSON.stringify(data), timeout,
      onload: r => r.status >= 200 && r.status < 300 ? resolve(r.response) : reject(new Error(`${route}: ${r.status} ${typeof r.response === 'string' ? r.response.slice(0,120) : ''}`)),
      onerror: () => reject(new Error(`${route}: local server unavailable`)), ontimeout: () => reject(new Error(`${route}: timed out`))
    }));
  }
  function wait(check, timeout = 30000) { return new Promise((resolve, reject) => { const end = Date.now() + timeout; const timer = setInterval(() => { const value = check(); if (value) { clearInterval(timer); resolve(value); } else if (Date.now() > end) { clearInterval(timer); reject(new Error('Site did not advance in time')); } }, 150); }); }
  function setValue(el, value) { const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype; Object.getOwnPropertyDescriptor(proto,'value').set.call(el,value); el.dispatchEvent(new Event('input',{bubbles:true})); el.dispatchEvent(new Event('change',{bubbles:true})); }
  async function digest(blob) { const bytes = await crypto.subtle.digest('SHA-256',await blob.arrayBuffer()); return Array.from(new Uint8Array(bytes),b=>b.toString(16).padStart(2,'0')).join(''); }
  async function addTags(form, tags) {
    const input = form.querySelector('.tag-input'); if(!input) throw new Error('Tag field missing');
    const accepted=[];
    const candidates=[...new Set([...tags.split(';').map(x=>x.trim()).filter(Boolean),'emoji','cute','reaction','fun','discord'])];
    for(const tag of candidates) {
      if(accepted.length>=10)break;
      const before=form.querySelectorAll('.tag-container .tag').length;
      setValue(input,tag); input.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',code:'Enter',keyCode:13,which:13,bubbles:true,cancelable:true}));
      input.dispatchEvent(new KeyboardEvent('keyup',{key:'Enter',code:'Enter',keyCode:13,which:13,bubbles:true,cancelable:true}));
      const after=form.querySelectorAll('.tag-container .tag').length;
      if(after>before)accepted.push(tag);
    }
    if(accepted.length<3)throw new Error(`Only ${accepted.length} accepted tags for ${form.querySelector('input[name="names[]"]')?.value||'item'}`);
    console.info('[Emoji queue] accepted tags:',accepted);
    return accepted;
  }
  async function upload(batch) {
    setStage(`fetching ${batch.items.length} files`);
    const files=[];const byHash=new Map();
    for(let i=0;i<batch.items.length;i++) { const item=batch.items[i]; const blob=await request(`file?batch=${encodeURIComponent(batch.id)}&index=${i}` ,undefined,'blob'); const file=new File([blob],item.filename,{type:/\.gif$/i.test(item.filename)?'image/gif':'image/png'}); files.push(file); byHash.set(await digest(file),item); }
    setStage('loading upload form');const input=await wait(()=>document.querySelector('#media-upload'));
    const transfer=new DataTransfer(); files.forEach(file=>transfer.items.add(file)); input.files=transfer.files; input.dispatchEvent(new Event('change',{bubbles:true}));
    setStage('waiting for previews');await wait(()=>document.querySelectorAll('.emojis-form').length===files.length && [...document.querySelectorAll('.emojis-form img[src^="blob:"]')].length===files.length,30000);
    const forms=[...document.querySelectorAll('.emojis-form')];
    const ordered=[];
    for(const form of forms){const src=form.querySelector('img[src^="blob:"]')?.src;if(!src)throw new Error('Missing preview image');const preview=await fetch(src).then(r=>r.blob());const item=byHash.get(await digest(preview));if(!item)throw new Error('Preview could not be matched to local image');ordered.push(item);}
    if(new Set(ordered).size!==files.length)throw new Error('Duplicate preview mapping');
    for(let i=0;i<forms.length;i++){
      const form=forms[i],item=ordered[i];
      setStage(`filling item ${i+1}/${forms.length}`);
      setValue(form.querySelector('input[name="names[]"]'),item.title);
      form.querySelector('select[name="categories[]"]').value=item.category_value;form.querySelector('select[name="categories[]"]').dispatchEvent(new Event('change',{bubbles:true}));
      const license=form.querySelector('select[name="licenses[]"]');license.value=item.license==='CC BY 4.0'?'1':'0';license.dispatchEvent(new Event('change',{bubbles:true}));
      setValue(form.querySelector('textarea[name="descriptions[]"]'),item.description);
      const accepted=await addTags(form,item.tags||'');
      say(`item ${i+1}/${forms.length}: ${accepted.length} accepted tags`);
      if(i<forms.length-1){const next=[...form.querySelectorAll('button')].find(x=>x.textContent.trim()==='Next');if(!next)throw new Error(`Next button missing at item ${i+1}`);next.click();}
    }
    setStage('finishing metadata');const finish=document.querySelector('.finish-forms');if(!finish)throw new Error('Finish button missing');finish.click();
    await wait(()=>{const x=document.querySelector('#final-submit');return x&&x.offsetParent!==null&&x},15000);
    setStage('submitting batch');
    writeJournal({batchId:batch.id,itemCount:batch.items.length,phase:'submitting'});
    document.querySelector('#final-submit').click();
    batch.submittedToSite = true;
    setStage('waiting for submission results');
    await wait(()=>document.querySelectorAll('.list-group-item strong').length===files.length || document.querySelector('.upload-error:not([style*="display: none"])'),120000);
    const results=[...document.querySelectorAll('.list-group-item')].filter(e=>e.querySelector('strong'));
    if(results.length!==files.length)throw new Error(`Submission outcome uncertain: ${results.length}/${files.length} rows`);
    // Result order follows the site's displayed form order, which was mapped by preview hash.
    const resultByItem=new Map(results.map((el,i)=>[ordered[i],{status:el.querySelector('.badge.bg-success')?'submitted':'retry',note:el.innerText.slice(-180)}]));
    const outcomes=batch.items.map(item=>resultByItem.get(item));
    writeJournal({batchId:batch.id,itemCount:batch.items.length,phase:'outcomes',outcomes});
    return outcomes;
  }
  function withTimeout(promise,timeout){return new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(new Error(`Worker watchdog stopped a stalled batch after ${Math.round(timeout/1000)} seconds`)),timeout);promise.then(value=>{clearTimeout(timer);resolve(value)},error=>{clearTimeout(timer);reject(error)})})}
  async function reportResult(id,outcomes){let lastError;for(let attempt=0;attempt<3;attempt++){try{return await request('result',{id,outcomes},'json',60000)}catch(error){lastError=error;if(attempt<2)await new Promise(resolve=>setTimeout(resolve,1000*(attempt+1)))}}throw lastError;}
  let busy=false,legacyMode=false,duplicateMode=false,helloPromise=null;
  async function announce(){
    if(helloPromise)return helloPromise;
    helloPromise=(async()=>{
      const hello=await request('hello',{version:'0.4.0',scriptVersion:'0.6.12',heartbeat:true,clientId,installationId,pageInstanceId,pageStartedAt:performance.timeOrigin,stage:workerStage,progressAt});
      if(hello.reloadRequired){const key=`uploadStudioReloaded:${hello.minimumVersion}`;if(!sessionStorage.getItem(key)){sessionStorage.setItem(key,'1');setStage(`updating worker to ${hello.minimumVersion}`);location.reload();await new Promise(()=>{});}throw new Error(`Worker ${hello.minimumVersion} is required; update Tampermonkey and reload`);}
      if(hello.retire||hello.duplicate){duplicateMode=true;workerSession='';setStage(hello.retire?'surplus worker closing':hello.activeLease?'waiting for active page instance':'duplicate worker closing');if(hello.closeAllowed&&openedByStudio)setTimeout(()=>window.close(),300);return hello;}
      duplicateMode=false;
      workerSession=hello.session;
      for(const id of hello.spawnIds||[])GM_openInTab(`https://emoji.gg/submit?upload_studio_worker=${encodeURIComponent(id)}`,{active:false,insert:true});
      return hello;
    })();
    try{return await helloPromise}finally{helloPromise=null}
  }
  async function tick() {
    if(busy||legacyMode)return;busy=true;
    try{
      if(!token){token=await pair();GM_setValue('queueToken',token);say('paired with local studio');}
      await announce();
      if(duplicateMode)return;
      const status=await request('status');showQueue(status);if(!status.running||status.paused&&!status.leased){say(status.paused?'paused':'idle');if(openedByStudio&&!status.running&&!status.queued&&!status.leased)setTimeout(()=>window.close(),500);return;}
      if(location.pathname==='/submit/sticker'){location.href=workerUrl('/submit');return;}
      if(location.pathname!=='/submit')return;
      const next=await request('next');if(next.blocked){const journal=readJournal();if(journal?.batchId===next.blocked.id&&journal.phase==='outcomes'&&Array.isArray(journal.outcomes)){setStage('restoring saved submission results');await reportResult(journal.batchId,journal.outcomes);clearJournal();location.href=workerUrl('/submit/sticker');return;}if(journal?.batchId===next.blocked.id&&journal.phase==='leased'){setStage('returning interrupted pre-submit batch');await reportResult(journal.batchId,Array.from({length:next.blocked.itemCount},()=>({status:'retry',note:'Worker reloaded before site submission'})));clearJournal();location.href=workerUrl('/submit/sticker');return;}setStage('returning unowned batch to retry');await reportResult(next.blocked.id,Array.from({length:next.blocked.itemCount},()=>({status:'retry',note:'Replacement page had no matching batch journal; returned for automatic retry'})));clearJournal();return;}const {batch}=next;if(!batch){setStage('ready for next batch');return;}
      writeJournal({batchId:batch.id,itemCount:batch.items.length,phase:'leased'});
      setStage(`uploading ${batch.items.length}; ${status.queued} queued`);
      try{const outcomes=await withTimeout(upload(batch),180000);await reportResult(batch.id,outcomes);clearJournal();setStage(`${outcomes.filter(x=>x.status==='submitted').length}/${outcomes.length} submitted`);location.href=workerUrl('/submit/sticker');}
      catch(error){
        const saved=readJournal();if(saved?.batchId===batch.id&&saved.phase==='outcomes'&&Array.isArray(saved.outcomes)){setStage(`result acknowledgement pending: ${error.message}`);console.error('[Emoji queue]',error);return;}
        const status=batch.submittedToSite?'uncertain':'retry';
        setStage(`batch ${status}: ${error.message}`);
        const outcomes=batch.items.map(()=>({status,note:error.message}));writeJournal({batchId:batch.id,itemCount:batch.items.length,phase:'outcomes',outcomes});await reportResult(batch.id,outcomes);clearJournal();
        console.error('[Emoji queue]',error);
        location.href=workerUrl('/submit/sticker');
      }
    }catch(error){const old=legacyWorker();if(old){old.append(studioLink);legacyMode=true;badge.remove();setInterval(()=>{const current=legacyWorker();if(current)current.append(studioLink);},1000);return;}if(/Invalid queue token/.test(error.message)){token='';GM_setValue('queueToken','');workerSession='';}queueText.textContent='';queueButton.style.display='none';say(error.message);}finally{busy=false;}
  }
  setInterval(()=>{if(token&&!legacyMode&&(busy||duplicateMode))announce().catch(()=>{});},5000);
  setInterval(tick,2500);tick();
})();

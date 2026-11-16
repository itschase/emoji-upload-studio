export type BrowserAsset={
  id:string;pack:string;filename:string;title:string;tags:string;description:string;
  category_value:string;license:string;status:'pending'|'inflight'|'submitted'|'retry'|'uncertain';
  attempts:number;note:string;file:Blob;createdAt:number;updatedAt:number;
}

const DB_NAME='emote-forge-upload-studio',DB_VERSION=1
const openDb=()=>new Promise<IDBDatabase>((resolve,reject)=>{const request=indexedDB.open(DB_NAME,DB_VERSION);request.onupgradeneeded=()=>{const db=request.result;if(!db.objectStoreNames.contains('assets')){const store=db.createObjectStore('assets',{keyPath:'id'});store.createIndex('pack','pack');store.createIndex('status','status')}};request.onsuccess=()=>resolve(request.result);request.onerror=()=>reject(request.error)})
const transaction=async<T>(mode:IDBTransactionMode,work:(store:IDBObjectStore,done:(value:T)=>void,fail:(error:unknown)=>void)=>void)=>{const db=await openDb();return new Promise<T>((resolve,reject)=>{const tx=db.transaction('assets',mode),store=tx.objectStore('assets');let value:T,settled=false;work(store,result=>{value=result;settled=true},reject);tx.oncomplete=()=>{db.close();if(settled)resolve(value)};tx.onerror=()=>{db.close();reject(tx.error)};tx.onabort=()=>{db.close();reject(tx.error)}})}
export const listAssets=()=>transaction<BrowserAsset[]>('readonly',(store,done,fail)=>{const request=store.getAll();request.onsuccess=()=>done(request.result);request.onerror=()=>fail(request.error)})
export const saveAssets=(assets:BrowserAsset[])=>transaction<number>('readwrite',(store,done)=>{assets.forEach(asset=>store.put(asset));done(assets.length)})
export const saveAsset=(asset:BrowserAsset)=>saveAssets([{...asset,updatedAt:Date.now()}])
export const removeAsset=(id:string)=>transaction<number>('readwrite',(store,done)=>{store.delete(id);done(1)})
export const recoverInflight=async()=>{const assets=await listAssets(),changed=assets.filter(asset=>asset.status==='inflight').map(asset=>({...asset,status:'uncertain' as const,note:'The Studio closed while this item was in flight; review before retrying',updatedAt:Date.now()}));if(changed.length)await saveAssets(changed);return changed.length}

export function parseCsv(text:string){const records:string[][]=[];let row:string[]=[],value='',quoted=false;for(let i=0;i<text.length;i++){const char=text[i];if(quoted){if(char==='"'&&text[i+1]==='"'){value+='"';i++}else if(char==='"')quoted=false;else value+=char}else if(char==='"')quoted=true;else if(char===','){row.push(value);value=''}else if(char==='\n'){row.push(value.replace(/\r$/,''));records.push(row);row=[];value=''}else value+=char}if(row.length||value){row.push(value);records.push(row)}const headers=records.shift()?.map(header=>header.replace(/^\uFEFF/,''))||[];return records.filter(record=>record.length===headers.length).map(record=>Object.fromEntries(headers.map((header,index)=>[header,record[index]])))}
export const titleFromFilename=(filename:string)=>filename.replace(/\.[^.]+$/,'').replace(/[_-]+/g,' ').replace(/\b\w/g,letter=>letter.toUpperCase()).slice(0,80)
export const sanitizeEmojiName=(value:string)=>value.replace(/[^A-Za-z0-9 ]+/g,' ').replace(/\s+/g,' ').trimStart().slice(0,100)
export function makeAsset(pack:string,file:File,row:Record<string,string>={}):BrowserAsset{const title=sanitizeEmojiName(String(row.title||titleFromFilename(file.name))).trim();return {id:`${pack}/${file.name}`,pack,filename:file.name,title,tags:String(row.tags||`emoji; ${title.toLowerCase().replace(/\s+/g,'; ')}`),description:String(row.description||`${title} emoji image.`).slice(0,2500),category_value:String(row.category_value||'1'),license:String(row.license||'CC BY 4.0'),status:'pending',attempts:0,note:'',file,createdAt:Date.now(),updatedAt:Date.now()}}

import { clsx, type ClassValue } from 'clsx'
import { twMerge } from 'tailwind-merge'

declare global { interface Window { __QUEUE_TOKEN__?: string } }
const hashParameters=new URLSearchParams(location.hash.replace(/^#/,''))
export const pendingDiscordReceipt=hashParameters.get('discord_entitlement')||''
if(pendingDiscordReceipt)history.replaceState(null,'',location.pathname+location.search)
export const cn = (...inputs: ClassValue[]) => twMerge(clsx(inputs))
export const categories=['Original Style','TV / Movie','Meme','Anime','Celebrity','Blobs','Thinking','Animated','NSFW','Gaming','Letters','Other','Pepe','Logos','Cute','Utility','Animals','Recolors','Flags','Hearts','Pixel Art','Reactions','Aesthetic']
export const licenses=['CC BY 4.0','Basic','WTFPL','Streamer']
export const sanitizeEmojiName=(value:string)=>value.replace(/[^A-Za-z0-9 ]+/g,' ').replace(/\s+/g,' ').trimStart().slice(0,100)
export async function api<T=any>(route:string,data?:unknown):Promise<T>{
  const response=await fetch(`/api/${route}`,{method:data===undefined?'GET':'POST',headers:{'X-Queue-Token':window.__QUEUE_TOKEN__||'','Content-Type':'application/json'},body:data===undefined?undefined:JSON.stringify(data)})
  const result=await response.json().catch(()=>({error:`HTTP ${response.status}`}))
  if(!response.ok)throw new Error(result.error||`HTTP ${response.status}`)
  return result
}
export const fmt=(value:number|undefined)=>Number(value||0).toLocaleString()
export const relative=(value:number|undefined)=>{if(!value)return 'never';const seconds=Math.max(0,Math.round((Date.now()-value)/1000));if(seconds<5)return 'now';if(seconds<60)return `${seconds}s ago`;return `${Math.round(seconds/60)}m ago`}

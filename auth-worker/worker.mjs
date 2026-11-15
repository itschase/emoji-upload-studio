const encoder=new TextEncoder()
const SESSION_SECONDS=7*24*60*60
const json=(value,status=200,headers={})=>new Response(JSON.stringify(value),{status,headers:{'Content-Type':'application/json','Cache-Control':'no-store',...headers}})
const b64=value=>{const bytes=typeof value==='string'?encoder.encode(value):value;let binary='';for(const byte of bytes)binary+=String.fromCharCode(byte);return btoa(binary).replaceAll('+','-').replaceAll('/','_').replace(/=+$/,'')}
const unb64=value=>{const normalized=value.replaceAll('-','+').replaceAll('_','/').padEnd(Math.ceil(value.length/4)*4,'=');return Uint8Array.from(atob(normalized),char=>char.charCodeAt(0))}
const parse=value=>JSON.parse(new TextDecoder().decode(unb64(value)))
const allowedOrigins=env=>String(env.ALLOWED_RETURN_ORIGINS||'').split(',').map(value=>value.trim()).filter(Boolean)
const cors=(request,env)=>{const origin=request.headers.get('Origin')||'';return allowedOrigins(env).includes(origin)?{'Access-Control-Allow-Origin':origin,'Access-Control-Allow-Credentials':'true','Vary':'Origin','Access-Control-Allow-Headers':'Authorization, Content-Type','Access-Control-Allow-Methods':'GET, OPTIONS'}:{}}
async function hmac(value,secret){const key=await crypto.subtle.importKey('raw',encoder.encode(secret),{name:'HMAC',hash:'SHA-256'},false,['sign']);return b64(new Uint8Array(await crypto.subtle.sign('HMAC',key,encoder.encode(value))))}
async function signedState(payload,env){const body=b64(JSON.stringify(payload));return `${body}.${await hmac(body,env.STATE_SECRET)}`}
async function verifyState(value,env){const [body,signature]=String(value||'').split('.');if(!body||!signature||await hmac(body,env.STATE_SECRET)!==signature)throw new Error('OAuth state is invalid');const payload=parse(body);if(Number(payload.exp)<Date.now())throw new Error('OAuth state expired');const url=new URL(payload.returnTo);if(!allowedOrigins(env).includes(url.origin))throw new Error('Return URL is not allowed');return payload}
function normalizedEd25519Jwk(value){const jwk=JSON.parse(value);delete jwk.alg;return jwk}
async function signingKey(env){return crypto.subtle.importKey('jwk',normalizedEd25519Jwk(env.SIGNING_PRIVATE_JWK),{name:'Ed25519'},false,['sign'])}
async function verifyKey(env){return crypto.subtle.importKey('jwk',normalizedEd25519Jwk(env.SIGNING_PUBLIC_JWK),{name:'Ed25519'},false,['verify'])}
async function entitlement(payload,env){const header=b64(JSON.stringify({alg:'EdDSA',typ:'JWT'})),body=b64(JSON.stringify(payload)),signature=await crypto.subtle.sign('Ed25519',await signingKey(env),encoder.encode(`${header}.${body}`));return `${header}.${body}.${b64(new Uint8Array(signature))}`}
async function verifyEntitlement(value,env){const [header,body,signature]=String(value||'').split('.');if(!header||!body||!signature||parse(header).alg!=='EdDSA')throw new Error('Invalid access receipt');if(!await crypto.subtle.verify('Ed25519',await verifyKey(env),unb64(signature),encoder.encode(`${header}.${body}`)))throw new Error('Invalid access receipt signature');const payload=parse(body);if(payload.aud!=='emote-forge-upload-studio'||Number(payload.exp)<=Math.floor(Date.now()/1000)||payload.guild_id!==env.DISCORD_GUILD_ID||!payload.member)throw new Error('Access receipt expired or invalid');return payload}
async function discord(path,env,init={}){return fetch(`https://discord.com/api/v10${path}`,{...init,headers:{Authorization:`Bot ${env.DISCORD_BOT_TOKEN}`,'Content-Type':'application/json',...(init.headers||{})}})}

export default {async fetch(request,env){
  const url=new URL(request.url),headers=cors(request,env)
  if(request.method==='OPTIONS')return new Response(null,{status:204,headers})
  try{
    if(url.pathname==='/health')return json({ok:true,service:'Emote Forge access'},200,headers)
    if(url.pathname==='/oauth/start'){
      const returnTo=new URL(url.searchParams.get('return_to')||'');if(!allowedOrigins(env).includes(returnTo.origin))return json({error:'Return URL is not allowed'},400,headers)
      const state=await signedState({returnTo:returnTo.href,exp:Date.now()+10*60*1000,nonce:crypto.randomUUID()},env),redirectUri=`${url.origin}/oauth/callback`,authorize=new URL('https://discord.com/oauth2/authorize');authorize.search=new URLSearchParams({client_id:env.DISCORD_CLIENT_ID,response_type:'code',redirect_uri:redirectUri,scope:'identify guilds.join',state,prompt:'consent'});return Response.redirect(authorize,302)
    }
    if(url.pathname==='/oauth/callback'){
      const state=await verifyState(url.searchParams.get('state'),env),code=url.searchParams.get('code');if(!code)throw new Error('Discord did not return an authorization code')
      const redirectUri=`${url.origin}/oauth/callback`,tokenResponse=await fetch('https://discord.com/api/v10/oauth2/token',{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},body:new URLSearchParams({client_id:env.DISCORD_CLIENT_ID,client_secret:env.DISCORD_CLIENT_SECRET,grant_type:'authorization_code',code,redirect_uri:redirectUri})}),tokens=await tokenResponse.json();if(!tokenResponse.ok)throw new Error(tokens.error_description||'Discord token exchange failed')
      const userResponse=await fetch('https://discord.com/api/v10/users/@me',{headers:{Authorization:`Bearer ${tokens.access_token}`}}),user=await userResponse.json();if(!userResponse.ok||!user.id)throw new Error('Discord identity lookup failed')
      const join=await discord(`/guilds/${env.DISCORD_GUILD_ID}/members/${user.id}`,env,{method:'PUT',body:JSON.stringify({access_token:tokens.access_token})});if(![201,204].includes(join.status))throw new Error(`Could not join Emote Forge (${join.status})`)
      const now=Math.floor(Date.now()/1000),receipt=await entitlement({sub:user.id,username:user.global_name||user.username,avatar:user.avatar||'',guild_id:env.DISCORD_GUILD_ID,aud:'emote-forge-upload-studio',member:true,iat:now,exp:now+SESSION_SECONDS},env),returnUrl=new URL(state.returnTo);return new Response(null,{status:302,headers:{Location:returnUrl.href,'Set-Cookie':`emote_forge_session=${receipt}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${SESSION_SECONDS}`}})
    }
    if(url.pathname==='/access/verify'){
      const cookie=Object.fromEntries(String(request.headers.get('Cookie')||'').split(';').map(value=>value.trim().split(/=(.*)/s).slice(0,2))),receipt=(request.headers.get('Authorization')||'').replace(/^Bearer\s+/i,'')||cookie.emote_forge_session||'';if(!receipt)return json({allowed:false,state:'signed-out',serverName:'Emote Forge'},200,headers)
      const payload=await verifyEntitlement(receipt,env),member=await discord(`/guilds/${env.DISCORD_GUILD_ID}/members/${payload.sub}`,env);if(member.status===404)return json({allowed:false,state:'membership-required',serverName:'Emote Forge'},200,headers);if(!member.ok)throw new Error(`Discord membership check failed (${member.status})`)
      const now=Math.floor(Date.now()/1000),refreshed=await entitlement({...payload,iat:now,exp:now+SESSION_SECONDS},env);return json({allowed:true,state:'verified',serverName:'Emote Forge',user:{id:payload.sub,username:payload.username,avatar:payload.avatar},expiresAt:(now+SESSION_SECONDS)*1000},200,{...headers,'Set-Cookie':`emote_forge_session=${refreshed}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${SESSION_SECONDS}`})
    }
    if(url.pathname==='/access/logout')return new Response(null,{status:204,headers:{...headers,'Set-Cookie':'emote_forge_session=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0'}})
    if(url.pathname==='/stats/profile'){
      const cookie=Object.fromEntries(String(request.headers.get('Cookie')||'').split(';').map(value=>value.trim().split(/=(.*)/s).slice(0,2))),receipt=(request.headers.get('Authorization')||'').replace(/^Bearer\s+/i,'')||cookie.emote_forge_session||'';if(!receipt)return json({error:'Sign in to sync profile stats'},401,headers);await verifyEntitlement(receipt,env)
      let profile;try{profile=new URL(url.searchParams.get('url')||'')}catch{return json({error:'Enter a valid Emoji.gg profile URL'},400,headers)}
      const match=profile.pathname.match(/^\/user\/([A-Za-z0-9_]+)\/?$/);if(profile.origin!=='https://emoji.gg'||!match)return json({error:'Use a profile URL such as https://emoji.gg/user/username'},400,headers)
      const profileUrl=`https://emoji.gg/user/${match[1]}`,response=await fetch(profileUrl,{headers:{'User-Agent':'Emote Forge Upload Studio/0.9'}});if(!response.ok)return json({error:`Emoji.gg profile request failed (${response.status})`},502,headers);const html=await response.text(),number=value=>Number(String(value||'').replace(/[^0-9]/g,''))||0,find=pattern=>(html.match(pattern)||[])[1]||'',counts={emojis:number(find(/Emojis\s*<span[^>]*>([\d,]+)/i)),stickers:number(find(/Stickers\s*<span[^>]*>([\d,]+)/i)),packs:number(find(/Packs\s*<span[^>]*>([\d,]+)/i))},downloads=number(find(/([\d,]+)\s+Downloads/i)),rank=find(/(Ranked\s+#[\d,]+)/i)
      return json({username:match[1],profileUrl,counts,downloads,rank,observedAt:Date.now()},200,headers)
    }
    if(env.ASSETS)return env.ASSETS.fetch(request)
    return json({error:'Not found'},404,headers)
  }catch(error){return json({error:String(error.message||error)},400,headers)}
}}

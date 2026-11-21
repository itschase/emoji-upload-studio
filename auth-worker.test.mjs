import test from 'node:test'
import assert from 'node:assert/strict'
import {readAccessReceipt} from './auth-worker/worker.mjs'

test('valid cookie session takes precedence over stale bearer receipt',()=>{
  const request=new Request('https://auth.example/access/verify',{headers:{Cookie:'other=x; emote_forge_session=fresh-cookie',Authorization:'Bearer stale-local-storage'}})
  assert.equal(readAccessReceipt(request),'fresh-cookie')
})

test('bearer receipt remains a compatibility fallback when no cookie exists',()=>{
  const request=new Request('https://auth.example/access/verify',{headers:{Authorization:'Bearer compatibility-receipt'}})
  assert.equal(readAccessReceipt(request),'compatibility-receipt')
})

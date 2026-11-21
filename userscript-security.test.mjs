import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import vm from 'node:vm'

const source=await fs.readFile(new URL('./uploader.user.js',import.meta.url),'utf8')
const helper=source.match(/const productionStudioOrigin=.*?function authorizedStudioOrigin\(value\).*?catch\{return ''\}\}/s)?.[0]
assert.ok(helper,'origin authorization helper exists')
const context={URL}
vm.runInNewContext(`${helper};this.authorizedStudioOrigin=authorizedStudioOrigin`,context)

test('bridge probes only answer explicitly authorized Studio origins',()=>{
  assert.equal(context.authorizedStudioOrigin('https://evil.example'),'')
  assert.equal(context.authorizedStudioOrigin('https://emote-forge.itschase.workers.dev/path'),'https://emote-forge.itschase.workers.dev')
  assert.equal(context.authorizedStudioOrigin('http://127.0.0.1:5173'),'http://127.0.0.1:5173')
  assert.equal(context.authorizedStudioOrigin('https://127.0.0.1:5173'),'')
})

import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'

test('hosted Studio and userscript release versions stay synchronized',async()=>{
  const [studio,script]=await Promise.all([
    fs.readFile(new URL('./web/HostedApp.tsx',import.meta.url),'utf8'),
    fs.readFile(new URL('./uploader.user.js',import.meta.url),'utf8'),
  ])
  const studioVersion=studio.match(/const studioVersion = "([^"]+)"/)?.[1]
  const metadataVersion=script.match(/\/\/ @version\s+([^\s]+)/)?.[1]
  const runtimeVersions=[
    ...[...script.matchAll(/EMOTE_FORGE_BRIDGE_STATUS[^;\n]+version:'([^']+)'/g)].map(match=>match[1]),
    ...[...script.matchAll(/scriptVersion:'([^']+)'/g)].map(match=>match[1]),
    ...[...script.matchAll(/dataset\.emojiUploadStudioWorker='([^']+)'/g)].map(match=>match[1]),
  ]
  assert.ok(studioVersion)
  assert.equal(metadataVersion,studioVersion)
  assert.ok(runtimeVersions.length>=3)
  assert.deepEqual([...new Set(runtimeVersions)],[studioVersion])
})

import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import ts from 'typescript'

const source=await fs.readFile(new URL('./web/browser-store.ts',import.meta.url),'utf8')
const compiled=ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.ESNext,target:ts.ScriptTarget.ES2022}}).outputText
const store=await import(`data:text/javascript;base64,${Buffer.from(compiled).toString('base64')}`)

test('CSV parsing reports malformed rows and supports multiline quoted fields',()=>{
  assert.deepEqual(store.parseCsv('filename,description\nicon.png,"line one\nline two"'),[{filename:'icon.png',description:'line one\nline two'}])
  assert.throws(()=>store.parseCsv('filename,title\nicon.png'),/row 2.*expected 2 columns/i)
  assert.throws(()=>store.parseCsv('filename,filename\nicon.png,other.png'),/duplicate header/i)
  assert.throws(()=>store.parseCsv('filename,title\nicon.png,"broken'),/unclosed quoted field/i)
})

test('file and metadata validation reject unsafe upload inputs',async()=>{
  const png=new File([Uint8Array.from([137,80,78,71,13,10,26,10,0])],'safe.png',{type:'image/png'})
  await assert.doesNotReject(()=>store.validateImportFile(png))
  await assert.rejects(()=>store.validateImportFile(new File(['not an image'],'fake.png',{type:'image/png'})),/not a valid PNG or GIF signature/i)
  assert.throws(()=>store.validateAssetMetadata({filename:'x.png',title:'X',tags:'emoji',description:'x',category_value:'1',license:'Unknown'}),/unsupported license/i)
})

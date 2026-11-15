import fs from 'node:fs/promises'
await fs.mkdir(new URL('../dist/',import.meta.url),{recursive:true})
for(const name of ['uploader.user.js','upload_manifest.template.csv'])await fs.copyFile(new URL(`../${name}`,import.meta.url),new URL(`../dist/${name}`,import.meta.url))

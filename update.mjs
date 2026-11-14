import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {fileURLToPath} from 'node:url';
import path from 'node:path';

const exec=promisify(execFile);
const here=path.dirname(fileURLToPath(import.meta.url));
const official='https://github.com/itschase/emoji-upload-studio.git';
async function git(...args){const {stdout}=await exec('git',args,{cwd:here,timeout:30000,maxBuffer:1024*1024,windowsHide:true});return stdout.trim();}

// Only update an unchanged checkout of the official repository. Local configuration
// and the upload queue live outside tracked files and are never part of the merge.
export async function checkUpdate(){
  if(await git('remote','get-url','origin')!==official)return {available:false,reason:'Not the official GitHub checkout'};
  if(await git('branch','--show-current')!=='main')return {available:false,reason:'Not on the main branch'};
  if(await git('status','--porcelain','--untracked-files=no'))return {available:false,reason:'Local source edits present'};
  await git('fetch','--quiet','origin','main');
  const local=await git('rev-parse','HEAD'),remote=await git('rev-parse','origin/main');
  if(local===remote)return {available:false,reason:'Current'};
  await git('merge-base','--is-ancestor',local,remote);
  return {available:true,local,remote};
}

export async function applyUpdate(expectedRemote){
  if(await git('status','--porcelain','--untracked-files=no'))throw new Error('Local source edits present');
  if(await git('rev-parse','origin/main')!==expectedRemote)throw new Error('Remote changed during update check');
  await git('merge','--ff-only',expectedRemote);
}

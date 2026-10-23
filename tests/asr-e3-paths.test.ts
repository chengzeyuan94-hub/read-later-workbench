import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash,randomUUID } from 'node:crypto';
import { existsSync,realpathSync } from 'node:fs';
import { chmod,mkdir,readFile,readdir,rename,stat,symlink,writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { AsrMediaError,DEFAULT_ASR_PREPARATION_CONFIG,DEFAULT_FFMPEG_PATH,asrFileSha256,inspectPreparedWav,isAsrPreparationNamespacePath,prepareMediaChunks,probeMedia } from '../src/main/asr-media.js';
import { qaToolPath } from '../src/main/media-tools.js';

// Synthetic PCM and installed local tools only. No provider or network is used.
const project=realpathSync(path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..'));
const root=path.join(project,'.acceptance-data/editor-e3-fix',`asr-paths-${Date.now()}-${randomUUID().slice(0,8)}`);
const ffprobePath=qaToolPath('ffprobe');
const config={...DEFAULT_ASR_PREPARATION_CONFIG,chunkDurationMs:200};
const sha256=(bytes:Buffer)=>createHash('sha256').update(bytes).digest('hex');
function pcm(frames=8001):Buffer{
 const bytes=Buffer.alloc(44+frames*2);bytes.write('RIFF',0);bytes.writeUInt32LE(bytes.length-8,4);bytes.write('WAVEfmt ',8);bytes.writeUInt32LE(16,16);bytes.writeUInt16LE(1,20);bytes.writeUInt16LE(1,22);bytes.writeUInt32LE(16000,24);bytes.writeUInt32LE(32000,28);bytes.writeUInt16LE(2,32);bytes.writeUInt16LE(16,34);bytes.write('data',36);bytes.writeUInt32LE(frames*2,40);
 for(let frame=0;frame<frames;frame++)bytes.writeInt16LE(Math.round(3000*Math.sin(frame*Math.PI*2*440/16000)),44+frame*2);
 return bytes;
}
async function fixture(name:string){const dir=path.join(root,name);await mkdir(dir,{recursive:true});const originalPath=path.join(dir,'synthetic-tone.wav'),bytes=pcm();await writeFile(originalPath,bytes);const probe=await probeMedia({originalPath,expectedSha256:sha256(bytes),expectedBytes:bytes.length,ffmpegPath:DEFAULT_FFMPEG_PATH,ffprobePath});return{dir,originalPath,bytes,probe};}
async function code(promise:Promise<unknown>,expected:string){await assert.rejects(promise,error=>error instanceof AsrMediaError&&error.code===expected);}

test('ASR preparation accepts only exact E2/E3/E3-fix namespaces with absolute normalized paths',()=>{
 for(const namespace of ['editor-e2','editor-e3','editor-e3-fix'])assert.equal(isAsrPreparationNamespacePath(path.join(project,'.acceptance-data',namespace,'synthetic-copy','asr-prepared')),true,namespace);
 for(const namespace of ['formal','editor-e4','editor-e30','editor-e3-other','editor-e3-fix-other','editor-e2-fix'])assert.equal(isAsrPreparationNamespacePath(path.join(project,'.acceptance-data',namespace,'synthetic-copy','asr-prepared')),false,namespace);
 const valid=path.join(project,'.acceptance-data/editor-e3-fix','synthetic-copy','asr-prepared');
 for(const invalid of ['.acceptance-data/editor-e3/copy',path.join(project,'formal-data','asr-prepared'),path.join(project,'.acceptance-data/editor-e3'),`${valid}${path.sep}..${path.sep}alias`,valid.replace(`${path.sep}.acceptance-data${path.sep}`,`${path.sep}${path.sep}.acceptance-data${path.sep}`),`${valid}\n`,`${valid}\0`])assert.equal(isAsrPreparationNamespacePath(invalid),false,JSON.stringify(invalid));
});

test('installed FFmpeg prepares and reuses validated PCM chunks in all three allowed namespaces inside a fresh E3-fix fixture',async(t)=>{
 const f=await fixture('prepare-cache');
 for(const namespace of ['editor-e2','editor-e3','editor-e3-fix']){
  // The nested namespace keeps every byte of this test under the new outer E3-fix root.
  const outputDir=path.join(f.dir,'.acceptance-data',namespace,'synthetic-copy','asr-prepared'),chunks=await prepareMediaChunks({probe:f.probe,outputDir,config});
  assert.ok(chunks.length>=2);assert.equal(chunks[0].startSampleFrame,0);assert.equal(chunks.at(-1)!.endSampleFrame,8001);assert.equal(chunks.at(-1)!.endMs,500);assert.equal(chunks.reduce((sum,chunk)=>sum+chunk.durationMs,0),500.0625);
  for(const [index,chunk]of chunks.entries()){
   assert.ok(chunk.localPath.startsWith(outputDir+path.sep));assert.equal(chunk.originalSha256,f.probe.sha256);assert.equal(chunk.sampleRate,16000);assert.equal(chunk.channels,1);assert.equal(chunk.sampleFrames,chunk.endSampleFrame-chunk.startSampleFrame);assert.deepEqual(chunk.inputRange,{startMs:chunk.startMs,endMs:chunk.endMs});assert.equal(await asrFileSha256(chunk.localPath),chunk.sha256);assert.equal((await stat(chunk.localPath)).size,chunk.bytes);assert.equal((await inspectPreparedWav(chunk.localPath)).sampleFrames,chunk.sampleFrames);
   if(index){assert.equal(chunk.startSampleFrame,chunks[index-1].endSampleFrame);assert.equal(chunk.startMs,chunks[index-1].endMs);}
  }
  const manifest=path.join(path.dirname(chunks[0].localPath),'manifest.json'),before=await stat(manifest),entries=await readdir(outputDir);
  assert.deepEqual(await prepareMediaChunks({probe:f.probe,outputDir,config}),chunks);assert.equal((await stat(manifest)).mtimeMs,before.mtimeMs);assert.deepEqual(await readdir(outputDir),entries);
  t.diagnostic(JSON.stringify({namespace,chunks:chunks.length,frames:8001,cacheRevalidated:true,outputDir}));
 }
 assert.deepEqual(await readFile(f.originalPath),f.bytes);t.diagnostic(JSON.stringify({fixtureRoot:root,realHttp:0,realSpeech:false}));
});

test('ASR prepare refuses other namespaces and lexical aliases before creating output directories',async()=>{
 const f=await fixture('namespace-refusal'),outside=path.join(project,`asr-outside-must-not-create-${randomUUID()}`);
 const invalid=[outside,path.join(f.dir,'.acceptance-data/editor-e4/copy/prepared'),path.join(f.dir,'.acceptance-data/editor-e3-other/copy/prepared'),path.join(f.dir,'.acceptance-data/editor-e3'),`${f.dir}/.acceptance-data/editor-e3/copy/../alias`,`${f.dir}//.acceptance-data/editor-e3/copy/prepared`];
 for(const outputDir of invalid){assert.equal(existsSync(outputDir),false);await code(prepareMediaChunks({probe:f.probe,outputDir,config}),'permission-denied');assert.equal(existsSync(outputDir),false);}
 assert.equal(existsSync(path.join(f.dir,'.acceptance-data')),false,'rejected lexical paths must not create even their missing ancestors');
});

// Unprivileged Windows links are junctions (directories only); file links may be impossible there.
async function linkOrReport(t:test.TestContext,target:string,alias:string):Promise<boolean>{
 const kind=(await stat(target)).isDirectory()?'junction':'file';
 try{await symlink(target,alias,process.platform==='win32'?kind:undefined);return true;}
 catch(error){if(process.platform==='win32'&&(error as NodeJS.ErrnoException).code==='EPERM'){t.diagnostic(`skipping link case: symlink creation needs privilege on Windows (${(error as NodeJS.ErrnoException).code})`);return false;}throw error;}
}
test('ASR E3-fix preparation still rejects symlink ancestors, symlink leaves, and unwritable directories',async(t)=>{
 const f=await fixture('filesystem-refusal'),target=path.join(f.dir,'ordinary-target'),alias=path.join(f.dir,'linked-parent');await mkdir(target);
 if(await linkOrReport(t,target,alias)){
  await code(prepareMediaChunks({probe:f.probe,outputDir:path.join(alias,'prepared'),config}),'permission-denied');assert.deepEqual(await readdir(target),[]);
  await code(prepareMediaChunks({probe:f.probe,outputDir:alias,config}),'permission-denied');assert.deepEqual(await readdir(target),[]);
 }
 const readonly=path.join(f.dir,'read-only');await mkdir(readonly);await chmod(readonly,0o555);try{await code(prepareMediaChunks({probe:f.probe,outputDir:readonly,config}),'permission-denied');assert.deepEqual(await readdir(readonly),[]);}finally{await chmod(readonly,0o700);}
});

test('expanded ASR namespaces retain frozen original byte/hash and input-link checks',async(t)=>{
 const f=await fixture('frozen-input'),outputDir=path.join(f.dir,'must-not-create'),linkedInput=path.join(f.dir,'linked-input.wav');
 if(await linkOrReport(t,f.originalPath,linkedInput))await code(prepareMediaChunks({probe:{...f.probe,originalPath:linkedInput},outputDir,config}),'file-unavailable');
 await code(prepareMediaChunks({probe:{...f.probe,bytes:f.probe.bytes+1},outputDir,config}),'input-mismatch');
 await code(prepareMediaChunks({probe:{...f.probe,sha256:'a'.repeat(64)},outputDir,config}),'input-mismatch');
 const changed=Buffer.from(f.bytes);changed[changed.length-1]^=1;await writeFile(f.originalPath,changed);await code(prepareMediaChunks({probe:f.probe,outputDir,config}),'input-mismatch');assert.equal(existsSync(outputDir),false);
});

test('E3-fix cached preparation still rejects chunk hash, sample-range, and publication-symlink tampering',async(t)=>{
 const f=await fixture('cache-refusal');
 const hashOutput=path.join(f.dir,'hash-cache'),hashChunks=await prepareMediaChunks({probe:f.probe,outputDir:hashOutput,config}),changed=await readFile(hashChunks[0].localPath);changed[changed.length-1]^=1;await writeFile(hashChunks[0].localPath,changed);await code(prepareMediaChunks({probe:f.probe,outputDir:hashOutput,config}),'input-mismatch');
 const rangeOutput=path.join(f.dir,'range-cache'),rangeChunks=await prepareMediaChunks({probe:f.probe,outputDir:rangeOutput,config}),manifestPath=path.join(path.dirname(rangeChunks[0].localPath),'manifest.json'),manifest=JSON.parse(await readFile(manifestPath,'utf8'));manifest.chunks[0].inputRange.endMs++;await writeFile(manifestPath,JSON.stringify(manifest));await code(prepareMediaChunks({probe:f.probe,outputDir:rangeOutput,config}),'input-mismatch');
 const linkOutput=path.join(f.dir,'link-cache'),linkChunks=await prepareMediaChunks({probe:f.probe,outputDir:linkOutput,config}),published=path.dirname(linkChunks[0].localPath),held=path.join(f.dir,'held-cache');await rename(published,held);if(await linkOrReport(t,held,published))await code(prepareMediaChunks({probe:f.probe,outputDir:linkOutput,config}),'input-mismatch');
});

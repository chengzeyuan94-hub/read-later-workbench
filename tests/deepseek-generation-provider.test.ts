import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdirSync,realpathSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath,pathToFileURL } from 'node:url';
import type { GeneratedMap,GenerationFrozenInput,OrganizedDocument } from '../src/shared/generation-contracts.js';
import { DeepSeekGenerationProvider,DEEPSEEK_GENERATION_MODEL_POLICY as policy } from '../src/main/deepseek-generation-provider.js';
import { GENERATION_MODEL_POLICY,GenerationProviderError,SiliconFlowGenerationProvider } from '../src/main/generation-provider.js';
import { freezeGenerationPlan,generationSha256 } from '../src/main/generation-validation.js';

// All keys and responses in this file are synthetic. No service request is made.
const project=realpathSync(path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..'));
const root=path.join(project,'.acceptance-data/editor-e3-fix',`deepseek-provider-${Date.now()}-${randomUUID().slice(0,8)}`);
const dummyKey='dummy-deepseek-mechanism-secret';
const json=(value:unknown,status=200,headers:Record<string,string>={})=>new Response(JSON.stringify(value),{status,headers:{'content-type':'application/json',...headers}});
const accountModels=(ids=['deepseek-flash'])=>json({object:'list',data:ids.map(id=>({id,object:'model',owned_by:'deepseek',context_window:1048576,max_output_tokens:393216,input_modalities:['text'],output_modalities:['text']}))});
const completion=(value:unknown,model='deepseek-flash',finish='stop')=>json({object:'chat.completion',model,choices:[{index:0,finish_reason:finish,message:{role:'assistant',content:JSON.stringify(value)}}],usage:{prompt_tokens:100,completion_tokens:50,total_tokens:150}});
async function code(promise:Promise<unknown>,expected:string,submitted=false){await assert.rejects(promise,error=>error instanceof GenerationProviderError&&error.code===expected&&error.submitted===submitted);}
function fixture(text='只有满足条件时才可使用25mg，不超过30天。'){
 const input:GenerationFrozenInput={sourceRevisionId:'deepseek-source-v1',title:'合成资料',units:[{id:'unit-0',kind:'capturedSource',text,reference:{kind:'capturedSource',sourceId:'synthetic-source',sourceRevisionId:'deepseek-source-v1',blockId:'body-0'},versionIdentity:'deepseek-source-v1/body-0',coverage:'complete',warnings:[]}]};
 const citation={unitId:'unit-0',start:0,end:Array.from(text).length,excerpt:text};
 const document:OrganizedDocument={schemaVersion:1,sourceRevisionId:input.sourceRevisionId,title:'合成整理正文',lead:'',blocks:[{id:'paragraph-0',type:'paragraph',text,role:'fact',citations:[citation]}],coverage:[{unitId:'unit-0',start:0,end:citation.end,disposition:'included'}]};
 const map:GeneratedMap={schemaVersion:1,sourceRevisionId:input.sourceRevisionId,organizedSha256:generationSha256(document),rootId:'root',nodes:[{id:'root',parentId:null,children:['fact'],title:'主题',notes:'',role:'structure',citations:[]},{id:'fact',parentId:'root',children:[],title:'有条件采用',notes:text,role:'fact',citations:[citation]}]};
 return{input,document,map,chunk:freezeGenerationPlan(input).chunks[0]};
}

test('DeepSeek defaults use only their own credential and fixed official origin in an isolated synthetic environment',()=>{
 mkdirSync(root,{recursive:true});
 const providerUrl=pathToFileURL(path.join(project,'src/main/deepseek-generation-provider.ts')).href;
 const loader=pathToFileURL(path.join(project,'node_modules/tsx/dist/loader.mjs')).href;
 const source=`import assert from 'node:assert/strict';import {DeepSeekGenerationProvider} from ${JSON.stringify(providerUrl)};let calls=0;const provider=new DeepSeekGenerationProvider({networkAllowed:true,fetchImpl:async(url,init)=>{calls++;assert.equal(url,'https://api.deepseek.com/models');assert.equal(init.headers.Authorization,'Bearer dummy-ds-env');return new Response(JSON.stringify({object:'list',data:[{id:'deepseek-flash'}]}),{headers:{'content-type':'application/json'}});}});if(process.env.DEEPSEEK_API_KEY){await provider.discoverModel();assert.equal(calls,1);}else{assert.equal(provider.configured(),false);await assert.rejects(provider.discoverModel(),e=>e.code==='waiting-configuration');assert.equal(calls,0);}`;
 for(const configured of [false,true])execFileSync(process.execPath,['--import',loader,'--input-type=module','-e',source],{cwd:project,env:process.platform==='win32'?{PATH:process.env.PATH??'',SystemRoot:process.env.SystemRoot,TEMP:root,TMP:root,SILICONFLOW_API_KEY:'dummy-sf-env',...(configured?{DEEPSEEK_API_KEY:'dummy-ds-env'}:{})}:{PATH:'/usr/bin:/bin',TMPDIR:root,SILICONFLOW_API_KEY:'dummy-sf-env',...(configured?{DEEPSEEK_API_KEY:'dummy-ds-env'}:{})},stdio:'pipe'});
});

test('DeepSeek discovers only exact reviewed account IDs with conservative budgets and no source upload',async()=>{
 let calls=0;const offline=new DeepSeekGenerationProvider({apiKey:()=>dummyKey,fetchImpl:(async()=>{calls++;return accountModels();}) as typeof fetch});await code(offline.discoverModel(),'waiting-network');assert.equal(calls,0);
 for(const id of ['deepseek-chat','deepseek-reasoner','deepseek-v4-flash','DeepSeek-V4.1-Flash-1017','Qwen/Qwen3-235B-A22B-Instruct-2507']){const p=new DeepSeekGenerationProvider({networkAllowed:true,apiKey:()=>dummyKey,fetchImpl:(async()=>accountModels([id])) as typeof fetch});await code(p.discoverModel(),'waiting-model');assert.equal(p.status().model,null);}
 const p=new DeepSeekGenerationProvider({networkAllowed:true,apiKey:()=>dummyKey,fetchImpl:(async(url,init)=>{calls++;assert.equal(url,'https://api.deepseek.com/models');assert.equal(init?.method,'GET');assert.equal(init?.body,undefined);return accountModels(['deepseek-v4-pro','deepseek-flash']);}) as typeof fetch}),model=await p.discoverModel();
 assert.equal(model.provider,'deepseek');assert.equal(model.model,'deepseek-flash');assert.equal(model.publishedContextTokens,1048576);assert.equal(model.providerOutputLimitTokens,393216);assert.equal(model.inputBudgetUtf8Bytes,32000);assert.equal(model.maxOutputTokens,16384);assert.equal(model.applicationContextBudgetTokens,65536);assert.deepEqual(model.capabilitySources,policy.sources);assert.match(model.configurationSha256,/^[a-f0-9]{64}$/);assert.equal(calls,1);
 const tooSmall=new DeepSeekGenerationProvider({networkAllowed:true,apiKey:()=>dummyKey,fetchImpl:(async()=>json({object:'list',data:[{id:'deepseek-flash',context_window:32768}]})) as typeof fetch});await code(tooSmall.discoverModel(),'waiting-model');
});

test('DeepSeek organize and map send fixed JSON/non-thinking parameters only after the durable submission fence',async()=>{
 const f=fixture(),events:string[]=[],bodies:Record<string,any>[]=[];
 const provider=new DeepSeekGenerationProvider({networkAllowed:true,apiKey:()=>dummyKey,fetchImpl:(async(url,init)=>{assert.equal(init?.redirect,'error');assert.equal(init?.credentials,'omit');assert.equal(init?.cache,'no-store');assert.equal((init?.headers as Record<string,string>).Authorization,`Bearer ${dummyKey}`);if(init?.method==='GET'){assert.equal(url,'https://api.deepseek.com/models');return accountModels();}assert.equal(url,'https://api.deepseek.com/chat/completions');events.push('POST');const body=JSON.parse(String(init?.body));bodies.push(body);return completion(bodies.length===1?f.document:f.map);}) as typeof fetch}),model=await provider.discoverModel();
 const first=await provider.organize({input:f.input,chunk:f.chunk,model,onSubmit:async()=>{events.push('fence');await new Promise<void>(resolve=>setImmediate(resolve));events.push('persisted');}});assert.deepEqual(first.value,f.document);assert.deepEqual(events,['fence','persisted','POST']);
 const mapped=await provider.map({input:f.input,organized:f.document,chunk:f.chunk,model,onSubmit:()=>{events.push('map-fence');}});assert.deepEqual(mapped.value,f.map);
 for(const body of bodies){assert.deepEqual(Object.keys(body).sort(),['max_tokens','messages','model','response_format','stream','temperature','thinking']);assert.equal(body.model,model.model);assert.equal(body.stream,false);assert.equal(body.max_tokens,16384);assert.deepEqual(body.thinking,{type:'disabled'});assert.deepEqual(body.response_format,{type:'json_object'});assert.match(body.messages[0].content,/JSON/);assert.equal(JSON.stringify(body).includes(dummyKey),false);}
 const wire=JSON.parse(bodies[0].messages[1].content);assert.equal(wire.slices[0].text,f.input.units[0].text);assert.equal('reference' in wire.slices[0],false);assert.deepEqual(mapped.usage,{promptTokens:100,completionTokens:50,totalTokens:150});
});

test('DeepSeek preserves a frozen exact model through restart and never migrates a SiliconFlow retry or response alias',async()=>{
 const original=new DeepSeekGenerationProvider({networkAllowed:true,apiKey:()=>dummyKey,fetchImpl:(async()=>accountModels(['deepseek-v4-pro'])) as typeof fetch}),frozen=await original.discoverModel(),f=fixture();let gets=0,posts=0;
 const restarted=new DeepSeekGenerationProvider({networkAllowed:true,apiKey:()=>dummyKey,fetchImpl:(async(_url,init)=>{if(init?.method==='GET'){gets++;return accountModels(['deepseek-flash','deepseek-v4-pro']);}posts++;return completion(f.document,'deepseek-v4-pro');}) as typeof fetch});
 assert.equal(frozen.model,'deepseek-v4-pro');assert.deepEqual(await restarted.ensureModel(frozen),frozen);assert.deepEqual(await restarted.ensureModel(frozen),frozen);assert.equal(gets,1);await restarted.organize({input:f.input,chunk:f.chunk,model:frozen,onSubmit:()=>{}});assert.equal(posts,1);
 await code(restarted.ensureModel({...frozen,provider:'siliconflow'}),'waiting-model');assert.equal(gets,1);assert.equal(posts,1);assert.equal(frozen.provider,'deepseek');
 const incompatible=new DeepSeekGenerationProvider({networkAllowed:true,apiKey:()=>dummyKey,fetchImpl:(async()=>accountModels(['deepseek-v4-pro'])) as typeof fetch});await code(incompatible.ensureModel({...frozen,configurationSha256:'a'.repeat(64)}),'waiting-model');assert.equal(incompatible.status().model,null);
 const alias=new DeepSeekGenerationProvider({networkAllowed:true,apiKey:()=>dummyKey,fetchImpl:(async(_url,init)=>init?.method==='GET'?accountModels():completion(f.document,'DeepSeek-V4.1-Flash-1017')) as typeof fetch}),model=await alias.discoverModel();await code(alias.organize({input:f.input,chunk:f.chunk,model,onSubmit:()=>{}}),'invalid-response',true);
});

test('DeepSeek rejects incomplete JSON, truncation, tools and HTTP faults after exactly one submitted request',async()=>{
 const f=fixture();
 const factories:[()=>Response,string][]=[
  [()=>completion(f.document,'deepseek-flash','length'),'truncated'],
  [()=>json({object:'chat.completion',model:'deepseek-flash',choices:[{finish_reason:'stop',message:{role:'assistant',content:''}}]}),'invalid-response'],
  [()=>json({object:'chat.completion',model:'deepseek-flash',choices:[{finish_reason:'stop',message:{role:'assistant',content:'{broken'}}]}),'invalid-response'],
  [()=>json({object:'chat.completion',model:'deepseek-flash',choices:[{finish_reason:'tool_calls',message:{role:'assistant',content:'{}',tool_calls:[{}]}}]}),'invalid-response'],
  [()=>json({},401),'unauthorized'],[()=>json({},429,{'retry-after':'2'}),'rate-limit'],[()=>json({},503),'provider-error'],
 ];
 for(const [factory,expected]of factories){let posts=0;const p=new DeepSeekGenerationProvider({networkAllowed:true,apiKey:()=>dummyKey,fetchImpl:(async(_url,init)=>init?.method==='GET'?accountModels():(posts++,factory())) as typeof fetch}),model=await p.discoverModel();await code(p.organize({input:f.input,chunk:f.chunk,model,onSubmit:()=>{}}),expected,true);assert.equal(posts,1);}
});

test('DeepSeek cancellation, timeout and network exceptions preserve submitted uncertainty without retrying',async()=>{
 const f=fixture();
 for(const kind of ['timeout','cancel','network'] as const){let posts=0;const controller=new AbortController(),p=new DeepSeekGenerationProvider({networkAllowed:true,apiKey:()=>dummyKey,timeoutMs:20,fetchImpl:(async(_url,init)=>{if(init?.method==='GET')return accountModels();posts++;if(kind==='network')throw Error('synthetic connection failure');if(kind==='cancel')setTimeout(()=>controller.abort(),2);return new Promise<Response>((_resolve,reject)=>init?.signal?.addEventListener('abort',()=>reject(Error('synthetic aborted response')),{once:true}));}) as typeof fetch}),model=await p.discoverModel();await code(p.organize({input:f.input,chunk:f.chunk,model,signal:controller.signal,onSubmit:()=>{}}),kind==='cancel'?'cancelled':'result-unknown',true);assert.equal(posts,1);}
});

test('DeepSeek submission fences cannot send after cancellation, network revocation or a credential change',async()=>{
 const f=fixture();
 for(const kind of ['cancel','offline','credential'] as const){let posts=0,key=dummyKey;const controller=new AbortController(),p=new DeepSeekGenerationProvider({networkAllowed:true,apiKey:()=>key,fetchImpl:(async(_url,init)=>init?.method==='GET'?accountModels():(posts++,completion(f.document))) as typeof fetch}),model=await p.discoverModel();await code(p.organize({input:f.input,chunk:f.chunk,model,signal:controller.signal,onSubmit:async()=>{await Promise.resolve();if(kind==='cancel')controller.abort();else if(kind==='offline')p.setNetworkAllowed(false);else key='changed-dummy-deepseek-key';}}),kind==='cancel'?'cancelled':kind==='offline'?'waiting-network':'waiting-model');assert.equal(posts,0);}
});

test('DeepSeek rejects outbound and both decoded JSON-layer credential echoes, including raw reasoning fields',async()=>{
 const f=fixture();let posts=0;
 for(const layer of ['outer','inner','reasoning'] as const){const p=new DeepSeekGenerationProvider({networkAllowed:true,apiKey:()=>dummyKey,fetchImpl:(async(_url,init)=>{if(init?.method==='GET')return accountModels();posts++;if(layer==='outer')return json({secret:dummyKey});const content=JSON.stringify({text:dummyKey}).replaceAll(dummyKey,'\\u0064'+dummyKey.slice(1));return json({object:'chat.completion',model:'deepseek-flash',choices:[{finish_reason:'stop',message:{role:'assistant',content:layer==='inner'?content:JSON.stringify(f.document),...(layer==='reasoning'?{reasoning_content:dummyKey}:{})}}]});}) as typeof fetch}),model=await p.discoverModel();await code(p.organize({input:f.input,chunk:f.chunk,model,onSubmit:()=>{}}),'credential-echo',true);}
 const p=new DeepSeekGenerationProvider({networkAllowed:true,apiKey:()=>dummyKey,fetchImpl:(async(_url,init)=>init?.method==='GET'?accountModels():(posts++,completion(f.document))) as typeof fetch}),model=await p.discoverModel(),dangerous=fixture(dummyKey);let submitted=0;await code(p.organize({input:dangerous.input,chunk:dangerous.chunk,model,onSubmit:()=>{submitted++;}}),'credential-echo');assert.equal(posts,3);assert.equal(submitted,0);
});

test('DeepSeek rejects oversized source payloads and bounded response bodies before adopting output',async()=>{
 const f=fixture();let posts=0,submitted=0;
 const p=new DeepSeekGenerationProvider({networkAllowed:true,apiKey:()=>dummyKey,fetchImpl:(async(_url,init)=>init?.method==='GET'?accountModels():(posts++,new Response('{}',{headers:{'content-type':'application/json','content-length':String(4*1024**2+1)}}))) as typeof fetch}),model=await p.discoverModel();
 f.input.units[0].warnings=Array.from({length:20},()=> '合成警告'.repeat(250));await code(p.organize({input:f.input,chunk:freezeGenerationPlan(f.input).chunks[0],model,onSubmit:()=>{submitted++;}}),'input-limit');assert.equal(submitted,0);assert.equal(posts,0);
 const clean=fixture();await code(p.organize({input:clean.input,chunk:clean.chunk,model,onSubmit:()=>{submitted++;}}),'output-limit',true);assert.equal(submitted,1);assert.equal(posts,1);
});

test('fragmented OCR shares repeated wire metadata without dropping text, references or changing its frozen plan',async()=>{
 const f=fixture(),asset={assetId:'frozen-image-'+ 'a'.repeat(96),version:'b'.repeat(64)},warning='图片文字可能有识别疑点；保留原图和原始版本供校对';
 f.input.units=Array.from({length:150},(_,index)=>({id:`source-${index}-${'c'.repeat(12)}`,kind:'ocr' as const,text:`原识别${index}🙂e\u0301`,reference:{kind:'ocr' as const,resultId:'synthetic-ocr',revision:1,blockId:`block-${index}`},versionIdentity:`synthetic-ocr/1/block-${index}`,coverage:'complete' as const,warnings:[warning],assetRefs:[{...asset}]}));
 const plan=freezeGenerationPlan(f.input),before=JSON.stringify({input:f.input,plan});assert.equal(plan.chunks.length,1);
 let posts=0,submitted=0;let body:any;
 const p=new DeepSeekGenerationProvider({networkAllowed:true,apiKey:()=>dummyKey,fetchImpl:(async(_url,init)=>{if(init?.method==='GET')return accountModels();posts++;body=JSON.parse(String(init?.body));return completion({fixture:'transport only'});}) as typeof fetch}),model=await p.discoverModel();
 await p.organize({input:f.input,chunk:plan.chunks[0],model,onSubmit:()=>{submitted++;}});
 assert.equal(posts,1);assert.equal(submitted,1);assert.ok(Buffer.byteLength(JSON.stringify(body.messages))<=model.inputBudgetUtf8Bytes);
 const wire=JSON.parse(body.messages[1].content);assert.equal(wire.slices.length,150);assert.equal(Object.keys(wire.sharedSourceMetadata).length,1);
 for(const [index,slice]of wire.slices.entries()){const source=f.input.units[index];assert.equal(slice.unitId,source.id);assert.equal(slice.kind,source.kind);assert.equal(slice.text,source.text);assert.equal(slice.start,0);assert.equal(slice.end,Array.from(source.text).length);assert.deepEqual(wire.sharedSourceMetadata[slice.sourceMetadataId],{assetRefs:source.assetRefs,warnings:source.warnings});}
 assert.equal(JSON.stringify({input:f.input,plan}),before);assert.equal(model.inputBudgetUtf8Bytes,32000);assert.equal(plan.maxAttemptsPerStagePerChunk,2);
 // Oversized distinct metadata is still rejected before the durable fence;
 // compaction cannot silently omit or truncate an expensive source fragment.
 f.input.units.forEach((unit,index)=>{unit.warnings=[`${index}:`+'不同原始提示'.repeat(100)];});
 await code(p.organize({input:f.input,chunk:freezeGenerationPlan(f.input).chunks[0],model,onSubmit:()=>{submitted++;}}),'input-limit');assert.equal(posts,1);assert.equal(submitted,1);
});

test('DeepSeek model discovery cannot bind a key changed in flight and SiliconFlow remains a separate legacy provider',async(t)=>{
 let key=dummyKey,release!:(response:Response)=>void;const p=new DeepSeekGenerationProvider({networkAllowed:true,apiKey:()=>key,fetchImpl:(async()=>new Promise<Response>(resolve=>{release=resolve;})) as typeof fetch}),pending=p.discoverModel();await new Promise<void>(resolve=>setImmediate(resolve));key='another-dummy-deepseek-key';release(accountModels());await code(pending,'waiting-model');assert.equal(p.status().model,null);
 const sf=new SiliconFlowGenerationProvider({networkAllowed:true,apiKey:()=> 'dummy-siliconflow-only',fetchImpl:(async(url)=>{assert.equal(url,'https://api.siliconflow.cn/v1/models?sub_type=chat');return json({object:'list',data:[{id:GENERATION_MODEL_POLICY.candidates[0].id}]});}) as typeof fetch}),legacy=await sf.discoverModel();assert.equal(legacy.provider,'siliconflow');assert.equal(legacy.providerOutputLimitTokens,null);assert.notEqual(legacy.configurationSha256,(await new DeepSeekGenerationProvider({networkAllowed:true,apiKey:()=>dummyKey,fetchImpl:(async()=>accountModels()) as typeof fetch}).discoverModel()).configurationSha256);
 t.diagnostic(JSON.stringify({realHttp:0,fixtureRoot:root,legacyConfigurationSha256:legacy.configurationSha256,officialEndpoints:['https://api.deepseek.com/models','https://api.deepseek.com/chat/completions']}));
});

test('actual wire sizing refines many short Unicode OCR units without source loss or network during planning',async()=>{
 const f=fixture();f.input.units=Array.from({length:900},(_,index)=>({id:`source-${index}-fixedreference`,kind:'ocr' as const,text:`第${index}段👩‍💻图片正文内容`,reference:{kind:'ocr' as const,resultId:`ocr-image-${Math.floor(index/30)}`,revision:1,blockId:`block-${index}`},versionIdentity:`fixed-${index}`,coverage:'complete' as const,warnings:['图片文字可能有识别疑点；保留原图和原始版本供校对'],assetRefs:[{assetId:`workspace-fixture-media-${Math.floor(index/30)}`,version:'a'.repeat(64)}]}));
 let http=0,fences=0;const wireBytes:number[]=[];
 const provider=new DeepSeekGenerationProvider({apiKey:()=>dummyKey,networkAllowed:true,fetchImpl:async(_url,init)=>{http++;if(init?.method==='GET')return accountModels();const body=JSON.parse(String(init?.body));wireBytes.push(Buffer.byteLength(JSON.stringify(body.messages)));return completion({});}}),model=await provider.discoverModel();
 const before=JSON.stringify(f.input),old=freezeGenerationPlan(f.input),plan=freezeGenerationPlan(f.input,{chunkFits:chunk=>provider.organizeInputBytes(f.input,chunk,model)<=model.inputBudgetUtf8Bytes});
 assert.equal(http,1);assert.equal(fences,0);assert.ok(plan.chunks.length>old.chunks.length);assert.ok(plan.chunks.length<=24);assert.equal(JSON.stringify(f.input),before);
 for(const unit of f.input.units){const slices=plan.chunks.flatMap(c=>c.slices).filter(s=>s.unitId===unit.id);let end=0;for(const s of slices){assert.equal(s.start,end);end=s.end;}assert.equal(end,Array.from(unit.text).length);assert.equal(slices.map(s=>Array.from(unit.text).slice(s.start,s.end).join('')).join(''),unit.text);}
 for(const chunk of plan.chunks){const expected=provider.organizeInputBytes(f.input,chunk,model);assert.ok(expected<=32000);await provider.organize({input:f.input,chunk,model,onSubmit:()=>{fences++;}});assert.equal(wireBytes.at(-1),expected);}
 assert.equal(fences,plan.chunks.length);assert.equal(http,plan.chunks.length+1);
 const offline=new DeepSeekGenerationProvider({apiKey:()=>{throw Error('sizing must not read credentials');},networkAllowed:false,fetchImpl:async()=>{throw Error('sizing must not request');}});
 assert.equal(offline.organizeInputBytes(f.input,plan.chunks[0],model),provider.organizeInputBytes(f.input,plan.chunks[0],model));
 assert.throws(()=>freezeGenerationPlan(f.input,{chunkFits:()=>false}),/input-limit/);
 assert.throws(()=>freezeGenerationPlan(f.input,{maxChunks:1,chunkFits:chunk=>provider.organizeInputBytes(f.input,chunk,model)<=32000}),/input-limit/);
});

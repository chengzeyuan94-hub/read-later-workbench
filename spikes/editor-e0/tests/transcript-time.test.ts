import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { createFixtureBundle, createTextOnlySliceFixture, createZeroTimingFixture } from '../fixtures.js';
import { assertTranscriptReference, clone, markdown, normalizeTranscript, plainText, pointLength, referenceDescription, transcriptTimeDescription, transcriptTrace, validateSourceReference, validateTranscript, type LegacyTranscriptSegment, type SourceReference, type TranscriptSegment, type WorkspaceBundle } from '../model.js';
import { EditorStore } from '../store.js';
const binding=path.resolve('.runtime/node24.node');
const wid='e0-a-workspace';
function reference(segment:TranscriptSegment):Extract<SourceReference,{kind:'transcript'}>{return{kind:'transcript',transcriptId:segment.transcriptId,revision:segment.revision,segmentId:segment.segmentId,mediaId:segment.mediaId,partId:segment.partId,timeContractVersion:2};}
function legacyFixture(which:'unknown'|'timed'):LegacyTranscriptSegment {return{workspaceId:wid,transcriptId:'e0-a-transcript',revision:1,segmentId:`e0-a-segment-${which}`,runs:[{text:which==='unknown'?'合成转录：这一段没有可靠时间，时间字段保持缺省。':'合成已知时间段，仅验证结构。'}],mediaId:'synthetic-media',partId:which==='unknown'?'p2':'p1',...(which==='timed'?{startMs:1000,endMs:3500}:{})};}
function trusted(source:'platform-subtitle'|'independent-alignment'):TranscriptSegment {
  const segment=createZeroTimingFixture();segment.inputSource!.kind=source==='platform-subtitle'?'platform-subtitle':'plain-text-response';segment.inputSource!.responseFormat=source==='platform-subtitle'?'caption-records':'text-only';segment.timing={state:'known',source,granularity:source==='platform-subtitle'?'caption':'sentence',coordinate:'media-part',mediaId:segment.mediaId!,partId:segment.partId!,startMs:0,endMs:500,evidence:{sourceId:source==='platform-subtitle'?segment.inputSource!.sourceId:'separate-alignment-result',revision:1,inputSourceId:segment.inputSource!.sourceId,inputSourceRevision:segment.inputSource!.revision}};return segment;
}
function withStore(fn:(store:EditorStore,root:string)=>void):void {const root=mkdtempSync(path.join(tmpdir(),'rlw-e01-time-')),store=new EditorStore(path.join(root,'editor.sqlite'),{nativeBinding:binding});try{store.seed(createFixtureBundle());fn(store,root);}finally{store.close();rmSync(root,{recursive:true,force:true});}}

test('P2 text-only 60000–120000 slice retains uncleaned common input and two distinct text ranges, both sentence times unknown',()=>{
  const segments=createTextOnlySliceFixture();assert.equal(segments.length,2);for(const segment of segments){validateTranscript(segment);assert.equal(segment.inputSource!.kind,'synthetic');assert.equal(segment.inputSource!.responseFormat,'text-only');assert.deepEqual(segment.timing,{state:'unknown',reason:'not-provided'});assert.equal(segment.startMs,undefined);assert.equal(segment.endMs,undefined);assert.equal(segment.inputRange!.startMs,60000);assert.equal(segment.inputRange!.endMs,120000);assert.equal(segment.partId,'p2');assert.match(transcriptTimeDescription(transcriptTrace(segment)),/来源范围 60000–120000ms（输入分片，非逐句时间）/);assert.match(transcriptTimeDescription(transcriptTrace(segment)),/句子时间 未知/);}
  assert.deepEqual(segments[0].inputSource,segments[1].inputSource);assert.deepEqual(segments[0].inputRange,segments[1].inputRange);assert.equal(segments.map(s=>plainText(s.runs)).join(''),segments[0].inputSource!.rawText);assert.notDeepEqual(segments[0].sourceTextRange,segments[1].sourceTextRange);
});

test('trusted platform caption and independent sentence alignment legitimately begin at zero; synthetic remains explicitly synthetic',()=>{
  for(const source of ['platform-subtitle','independent-alignment'] as const){const segment=trusted(source);validateTranscript(segment);const trace=transcriptTrace(segment);assert.equal(trace.timing.state,'known');assert.match(transcriptTimeDescription(trace),/时间 0–500ms/);assert.match(transcriptTimeDescription(trace),new RegExp(source));assert.doesNotMatch(transcriptTimeDescription(trace),/句子时间 未知/);}
  const synthetic=transcriptTrace(createZeroTimingFixture());assert.equal(synthetic.inputSource.kind,'synthetic');assert.equal(synthetic.timing.state==='known'&&synthetic.timing.source,'synthetic');assert.match(transcriptTimeDescription(synthetic),/来源 synthetic/);
});

test('time runtime validation rejects negative, reversed, missing, nonfinite and fractional range bounds',()=>{
  for(const key of ['inputRange','timing'] as const)for(const [startMs,endMs] of [[-1,100],[100,99],[NaN,100],[0,Infinity],[0.5,100],[0,undefined]]){const segment=trusted('platform-subtitle') as any;segment[key].startMs=startMs;segment[key].endMs=endMs;assert.throws(()=>validateTranscript(segment),`${key} ${startMs}:${endMs}`);}
  const unbounded=trusted('platform-subtitle');delete unbounded.inputRange!.startMs;delete unbounded.inputRange!.endMs;validateTranscript(unbounded);
});

test('time runtime rejects mismatched media/part/evidence, source and granularity combinations or slice-relative coordinates',()=>{
  const mutations:((s:any)=>void)[]=[s=>s.mediaId='other',s=>s.partId='p8',s=>s.inputSource.mediaId='other',s=>s.inputRange.partId='p8',s=>s.timing.mediaId='other',s=>s.timing.partId='p8',s=>s.inputRange.coordinate='slice',s=>s.timing.coordinate='slice',s=>s.timing.evidence.inputSourceId='wrong',s=>s.timing.evidence.inputSourceRevision=2,s=>s.timing.evidence.sourceId='wrong',s=>s.timing.evidence.revision=2,s=>s.timing.granularity='sentence',s=>s.timing.granularity='word',s=>s.timing.startMs=10001,s=>s.inputSource.kind='plain-text-response',s=>s.inputSource.responseFormat='text-only'];
  for(const mutate of mutations){const segment=trusted('platform-subtitle');mutate(segment);assert.throws(()=>validateTranscript(segment));}
  const aligned=trusted('independent-alignment');if(aligned.timing?.state==='known')aligned.timing.evidence.sourceId=aligned.inputSource!.sourceId;assert.throws(()=>validateTranscript(aligned),/independent/);
  const synthetic=createZeroTimingFixture();if(synthetic.timing?.state==='known')synthetic.timing.source='platform-subtitle';assert.throws(()=>validateTranscript(synthetic));
});

test('unknown has no numeric fields; text-only response cannot invent timestamps, default zero or per-slice sentence times',()=>{
  for(const alter of [(s:any)=>s.timing.startMs=0,(s:any)=>s.timing.endMs=120000,(s:any)=>s.startMs=0,(s:any)=>s.endMs=120000]){const segment=createTextOnlySliceFixture()[0];alter(segment);assert.throws(()=>validateTranscript(segment));}
  const segment=createTextOnlySliceFixture()[0];segment.timing={state:'known',source:'synthetic',granularity:'sentence',coordinate:'media-part',mediaId:segment.mediaId!,partId:segment.partId!,startMs:60000,endMs:120000,evidence:{sourceId:segment.inputSource!.sourceId,revision:1,inputSourceId:segment.inputSource!.sourceId,inputSourceRevision:1}};assert.throws(()=>validateTranscript(segment),/text-only/);
});

test('recognition raw text, Unicode segment boundaries and source revision are validated without cleaning or invented text',()=>{
  const segment=createTextOnlySliceFixture()[0];segment.inputSource!.rawText='  中📚文\n  ';segment.runs=[{text:'中📚文'}];segment.sourceTextRange={start:2,end:5,unit:'unicode-code-point'};validateTranscript(segment);assert.equal(transcriptTrace(segment).inputSource.rawText,'  中📚文\n  ');
  for(const mutate of [(s:any)=>s.sourceTextRange.end=4,(s:any)=>s.sourceTextRange.start=-1,(s:any)=>s.sourceTextRange.unit='utf16',(s:any)=>s.inputSource.revision=0,(s:any)=>s.runs=[{text:'虚构清洗稿'}]]){const changed=clone(segment);mutate(changed);assert.throws(()=>validateTranscript(changed));}
});

test('legacy exact fixture compatibility is idempotent, preserves synthetic identity, original numbers and unknown sentence time regardless of JSON key order',()=>{
  for(const kind of ['unknown','timed'] as const){const legacy=legacyFixture(kind),before=JSON.stringify(legacy),normalized=normalizeTranscript(legacy);assert.equal(JSON.stringify(legacy),before);assert.equal(normalized.inputSource.kind,'synthetic');assert.equal(normalized.legacy!.identity,'exact-synthetic-fixture');assert.deepEqual(normalized.legacy!.original,legacy);assert.deepEqual(normalized.timing,{state:'unknown',reason:'legacy-unverified'});assert.equal(normalized.inputRange,undefined);assert.equal(normalized.startMs,undefined);validateTranscript(normalized);assert.deepEqual(normalizeTranscript(normalized),normalized);const reversed=Object.fromEntries(Object.entries(legacy).reverse()) as unknown as TranscriptSegment;assert.equal(normalizeTranscript(reversed).inputSource.kind,'synthetic');}
});

test('unattributed legacy times including an end-only field retain evidence and never become trusted or input ranges',()=>{
  for(const times of [{startMs:0,endMs:0},{endMs:5000},{}]){const legacy={workspaceId:wid,transcriptId:'old-t',revision:1,segmentId:'old-s',runs:[{text:'旧原文保留'}],...times},normalized=normalizeTranscript(legacy);assert.equal(normalized.inputSource.kind,'legacy-unknown');assert.equal(normalized.legacy!.identity,'unattributed');assert.deepEqual(normalized.legacy!.original,legacy);assert.equal(normalized.timing.state,'unknown');assert.equal(normalized.inputRange,undefined);assert.equal(normalized.mediaId,undefined);assert.deepEqual(normalizeTranscript(normalized),normalized);}
  const forged=normalizeTranscript(legacyFixture('timed'));forged.legacy!.identity='unattributed';assert.throws(()=>validateTranscript(forged),/evidence/);
});

test('exact reference helper rejects wrong target/revision, upgraded timing/source/granularity and fabricated slice bounds',()=>{
  const segment=createTextOnlySliceFixture()[0],ref=reference(segment),trace=transcriptTrace(segment);assert.deepEqual(assertTranscriptReference(ref,segment),trace);
  for(const key of ['transcriptId','segmentId','revision'] as const){const wrong=clone(ref) as any;wrong[key]=key==='revision'?2:'other';assert.throws(()=>assertTranscriptReference(wrong,segment),/identity/);}
  const assertions={...ref,inputSource:clone(trace.inputSource),inputRange:clone(trace.inputRange),timing:clone(trace.timing)};assert.deepEqual(assertTranscriptReference(assertions,segment),trace);
  for(const mutate of [(r:any)=>r.timing={...createZeroTimingFixture().timing,partId:'p2'},(r:any)=>r.inputRange.startMs=0,(r:any)=>r.inputSource.rawText+=' changed',(r:any)=>r.inputSource.kind='plain-text-response']){const forged=clone(assertions);mutate(forged);assert.throws(()=>assertTranscriptReference(forged,segment));}
  const original=trusted('platform-subtitle'),knownRef={...reference(original),timing:clone(original.timing)};assertTranscriptReference(knownRef,original);if(knownRef.timing?.state==='known')knownRef.timing.granularity='sentence';assert.throws(()=>assertTranscriptReference(knownRef,original));
});

test('SQLite source version raw recognition and input range stay immutable across split segments; new input revision permits a new result',()=>withStore(store=>{
  const original=createTextOnlySliceFixture()[0],changed=clone(original);changed.segmentId='different-segment';changed.inputSource!.rawText=plainText(changed.runs);changed.sourceTextRange={start:0,end:pointLength(plainText(changed.runs)),unit:'unicode-code-point'};assert.throws(()=>store.addTranscriptSegment(changed),/input source version/);
  const range=clone(original);range.segmentId='different-range';range.inputRange!.endMs=130000;assert.throws(()=>store.addTranscriptSegment(range),/input source version/);
  changed.inputSource!.revision=2;changed.revision=2;store.addTranscriptSegment(changed);assert.equal(store.loadWorkspace(wid).transcripts.filter(s=>s.revision===2).length,1);
}));

test('SQLite exact references retain historical unknown timing after a newer revision gains independently evidenced times',()=>withStore(store=>{
  const bundle=store.loadWorkspace(wid),unknown=bundle.transcripts.find(s=>s.segmentId==='e0-a-segment-unknown')!,oldRef=reference(unknown),later=clone(unknown);later.revision=2;later.inputSource!.revision=2;later.inputSource!.kind='plain-text-response';later.timing={state:'known',source:'independent-alignment',granularity:'sentence',coordinate:'media-part',mediaId:later.mediaId!,partId:later.partId!,startMs:60000,endMs:65000,evidence:{sourceId:'alignment-result-2',revision:1,inputSourceId:later.inputSource!.sourceId,inputSourceRevision:2}};store.addTranscriptSegment(later);
  assert.equal(store.resolveReference(oldRef,wid).transcript!.timing.state,'unknown');const nextRef={...oldRef,revision:2};assert.equal(store.resolveReference(nextRef,wid).transcript!.timing.state,'known');assert.throws(()=>store.resolveReference({...oldRef,timing:later.timing},wid),/exact-version/);
  const map=clone(bundle.map);map.nodes['e0-a-n12'].sourceRefs=[{...oldRef,timing:later.timing}];const outcome=store.save({workspaceId:wid,documentId:map.documentId,sessionId:'timing-test',requestId:'forged',expectedRevision:map.revision,document:map});assert.equal(outcome.status,'failed');assert.equal(store.loadWorkspace(wid).map.revision,1);
}));

test('new synthetic SQLite reload resolves the full input/timing contract, with no time precision gain after close/reopen',()=>{
  const root=mkdtempSync(path.join(tmpdir(),'rlw-e01-time-reopen-')),file=path.join(root,'editor.sqlite');let store=new EditorStore(file,{nativeBinding:binding});try{store.seed(createFixtureBundle());const before=store.loadWorkspace(wid),ref=before.map.nodes['e0-a-n12'].sourceRefs[0],resolved=store.resolveReference(ref,wid);store.close();store=new EditorStore(file,{nativeBinding:binding});assert.deepEqual(store.loadWorkspace(wid),before);assert.deepEqual(store.resolveReference(ref,wid),resolved);assert.equal(resolved.transcript!.inputRange!.startMs,60000);assert.equal(resolved.transcript!.timing.state,'unknown');assert.equal(store.db.pragma('quick_check',{simple:true}),'ok');}finally{store.close();rmSync(root,{recursive:true,force:true});}
});

test('legacy SQLite read is pure and repeatable: original JSON bytes remain, exact fixture times stay synthetic and unverified',()=>withStore(store=>{
  const originals=[legacyFixture('unknown'),legacyFixture('timed')];store.db.prepare('DELETE FROM e0_transcripts').run();for(const original of originals)store.db.prepare('INSERT INTO e0_transcripts VALUES(?,?,?,?,?)').run(original.transcriptId,original.revision,original.segmentId,wid,JSON.stringify(original));const before=store.db.prepare('SELECT json FROM e0_transcripts ORDER BY segment_id').all();for(let n=0;n<3;n++){const loaded=store.loadWorkspace(wid);assert.equal(loaded.transcripts.length,2);for(const transcript of loaded.transcripts){assert.equal(transcript.inputSource!.kind,'synthetic');assert.equal(transcript.timing!.state,'unknown');validateTranscript(transcript);}const resolved=store.resolveReference({kind:'transcript',transcriptId:'e0-a-transcript',revision:1,segmentId:'e0-a-segment-timed',startMs:1000,endMs:3500},wid);assert.equal(resolved.transcript!.timing.state,'unknown');assert.equal(resolved.transcript!.legacy!.original.startMs,1000);}assert.deepEqual(store.db.prepare('SELECT json FROM e0_transcripts ORDER BY segment_id').all(),before);
}));

test('Markdown and reference notes degrade exact time semantics readably and do not claim native executable time links',()=>{
  const bundle=createFixtureBundle(),before=JSON.stringify(bundle),md=markdown(bundle.draft,bundle);assert.match(md,/来源引用（可读降级；非原生时间链接）/);assert.match(md,/来源范围 60000–120000ms（输入分片，非逐句时间）/);assert.match(md,/句子时间 未知/);assert.match(md,/来源 synthetic \/ 粒度 sentence/);assert.match(md,/时间 0–3500ms/);assert.match(md,/引用文本：第一段纯文本/);assert.equal(JSON.stringify(bundle),before);assert.doesNotMatch(markdown(bundle.draft),/来源引用/);
  const missing=clone(bundle);missing.transcripts=[];assert.throws(()=>markdown(missing.draft,missing),/unresolved transcript/);assert.throws(()=>markdown(bundle.draft,createFixtureBundle('b')),/ownership/);
  const ref=reference(bundle.transcripts[0]);assert.match(referenceDescription(ref),/尚未解析精确版本/);validateSourceReference(ref);
});

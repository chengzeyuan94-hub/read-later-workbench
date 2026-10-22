import type { BatchRunnerHooks } from '../shared/batch-contracts.js';
import type { AsrCapability,AsrProviderConfiguration } from '../shared/asr-contracts.js';
import { AsrRepository,type AsrPreparationToken,type AsrPreparedChunk,type AsrResponse,type AsrUploadToken } from './asr-store.js';

/** Interfaces keep provider credentials exclusively inside the injected main-process adapter. */
export interface AsrMediaAdapter {
 probe(input:{originalPath:string;expectedSha256:string;expectedBytes:number;signal:AbortSignal}):Promise<Record<string,unknown>>;
 prepare(input:{probe:Record<string,unknown>;outputDir:string;config:Record<string,unknown>;signal:AbortSignal}):Promise<AsrPreparedChunk[]>;
}
export interface AsrProviderAdapter {
 configured():boolean;
 transcribe(input:{chunk:AsrPreparedChunk;signal:AbortSignal;onUploadStart:()=>void|Promise<void>}):Promise<AsrResponse>;
}
export class AsrRunner {
 private stopped=true;private draining=false;private pending=false;
 private active:{kind:'prepare';token:AsrPreparationToken;controller:AbortController}|{kind:'upload';token:AsrUploadToken;controller:AbortController}|null=null;
 private networkAllowed:boolean;
 constructor(readonly repository:AsrRepository,readonly media:AsrMediaAdapter,readonly provider:AsrProviderAdapter,readonly providerConfig:AsrProviderConfiguration,options:{networkAllowed?:boolean;changed?:()=>void;batch?:BatchRunnerHooks}={}){this.batch=options.batch;this.networkAllowed=options.networkAllowed??false;this.changed=options.changed;this.updateCapability();}
 private changed?:()=>void;
 private batch?:BatchRunnerHooks;
 private updateCapability():void{const configured=this.provider.configured(),value:AsrCapability={available:configured,configured,networkAllowed:this.networkAllowed,provider:this.providerConfig,...(!configured?{reason:'等待转录配置'}:!this.networkAllowed?{reason:'等待转录服务联网'}:{})};this.repository.setCapability(value,this.batch?.allowRequest);}
 start():void{this.stopped=false;this.kick();}
 kick():void{if(this.stopped)return;this.updateCapability();this.pending=true;if(!this.draining)void this.drain();}
 setNetworkAllowed(allowed:boolean):void{this.networkAllowed=allowed;this.updateCapability();if(!allowed&&this.active?.kind==='upload'){this.repository.interruptUpload(this.active.token);this.active.controller.abort();}this.kick();}
 prepareRenewal(contentId:number,preserveTerminal=true):void{this.repository.cancel(contentId,preserveTerminal);if(this.active?.token.contentId===contentId)this.active.controller.abort();this.changed?.();this.kick();}
 cancel(contentId:number):void{this.repository.cancel(contentId);if(this.active?.token.contentId===contentId)this.active.controller.abort();this.changed?.();this.kick();}
 stop():void{this.stopped=true;this.pending=false;if(this.active){if(this.active.kind==='prepare')this.repository.interruptPreparation(this.active.token);else this.repository.interruptUpload(this.active.token);this.active.controller.abort();}}
 private async drain():Promise<void>{this.draining=true;try{do{this.pending=false;while(!this.stopped){const preparation=this.repository.nextPreparation(this.batch?.allowRequest);if(preparation){const controller=new AbortController();this.active={kind:'prepare',token:preparation,controller};try{const probe=await this.media.probe({originalPath:preparation.originalPath,expectedSha256:preparation.frozen.media.sha256!,expectedBytes:preparation.frozen.media.bytes,signal:controller.signal});if(this.stopped||controller.signal.aborted)continue;const chunks=await this.media.prepare({probe,outputDir:preparation.outputDir,config:preparation.preparation,signal:controller.signal});if(!this.stopped&&!controller.signal.aborted)this.repository.acceptPreparation(preparation,probe,chunks);}catch(e){if(!this.stopped&&!controller.signal.aborted){const code=typeof(e as any)?.code==='string'?(e as any).code:'decode-failed';this.repository.failPreparation(preparation,code);this.batch?.settled?.(preparation.requestId,code);}}finally{this.active=null;this.changed?.();}continue;}
   const upload=this.repository.nextUpload(this.batch?.allowRequest);if(!upload)break;const controller=new AbortController();this.active={kind:'upload',token:upload,controller};let submissionFailure:string|undefined;try{const response=await this.provider.transcribe({chunk:upload.chunk,signal:controller.signal,onUploadStart:()=>{const commit=()=>this.repository.markSubmitted(upload);if(this.batch){try{this.batch.submit({requestId:upload.requestId,runId:upload.runId,durationMs:upload.chunk.durationMs},commit);}catch(error){submissionFailure=(error as any)?.code;throw error;}}else commit();}});if(!this.stopped&&!controller.signal.aborted){this.repository.accept(upload,response);this.batch?.settled?.(upload.requestId,this.repository.list(upload.contentId).jobs.find(job=>job.id===upload.id)?.errorCode);}}catch(e){if(!this.stopped&&!controller.signal.aborted){const code=submissionFailure??(typeof(e as any)?.code==='string'?(e as any).code:'waiting-network');this.repository.fail(upload,code==='batch-paused'?'waiting-network':code,!!(e as any)?.submitted,Number((e as any)?.retryAfterMs??0));if(code!=='batch-paused')this.batch?.settled?.(upload.requestId,code);}}finally{this.active=null;this.changed?.();}}
  }while(this.pending&&!this.stopped);}finally{this.draining=false;}}
}

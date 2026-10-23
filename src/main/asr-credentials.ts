/** Main-process only. The key enters through an in-app modal and never leaves this process. */
import { createRequire } from 'node:module';
import { assertCredentialStorage, CREDENTIAL_PROFILES, readProviderCredential, storeProviderCredential, type CredentialEncryption, type CredentialProvider } from './credential-store.js';
const electronSafeStorage = (): CredentialEncryption => (createRequire(import.meta.url)('electron') as { safeStorage: CredentialEncryption }).safeStorage;
/** Asks the renderer to open the credential modal for this provider. */
export interface CredentialPromptRequest { provider: CredentialProvider; label: string; purpose: string }
export class AsrCredentials {
  private memory:string|undefined;
  private prompt:Promise<{configured:boolean}>|null=null;
  private pending:{resolve:(value:{configured:boolean})=>void;timer:NodeJS.Timeout}|null=null;
  private requestHandler:((request:CredentialPromptRequest)=>void)|undefined;
  private disposed=false;
  private readonly encryption?:CredentialEncryption;
  /** The legacy one-argument constructor remains SiliconFlow/ASR only. */
  constructor(readonly userDataDir:string, readonly provider:CredentialProvider='siliconflow', readonly fallbackDirs:readonly string[]=[],encryption?:CredentialEncryption){this.encryption=encryption;}
  private safe():CredentialEncryption{return this.encryption??electronSafeStorage();}
  /** main.ts wires this to the renderer modal once the window exists. */
  setRequestHandler(handler:(request:CredentialPromptRequest)=>void):void{this.requestHandler=handler;}
  read():string|undefined{
    if(this.disposed)return;
    const current=readProviderCredential(this.userDataDir,this.provider,process.env,this.safe(),this.memory);
    if(current)return current;
    // A new isolated runtime may reuse an existing encrypted credential without
    // copying profiles or modifying the source. Configuration still writes here.
    for(const directory of this.fallbackDirs){const value=readProviderCredential(directory,this.provider,{},this.safe());if(value)return value;}
  }
  status():{configured:boolean}{return{configured:!!this.read()};}
  /** Plain paste path used by the settings fields. The key never leaves this process. */
  store(key:string):{configured:boolean}{
    if(this.disposed)throw Error('安全配置已关闭，现有密钥保持');
    if(typeof key!=='string')throw Error('密钥格式不正确，未保存');
    const trimmed=key.trim();
    if(!trimmed)throw Error('密钥为空，未保存');
    if(trimmed.length>1024||/[\r\n]/.test(trimmed))throw Error('密钥格式不正确，未保存');
    assertCredentialStorage(this.safe(),this.provider);
    storeProviderCredential(this.userDataDir,this.provider,trimmed,this.safe());this.memory=trimmed;
    this.finishPrompt(true);
    return{configured:true};
  }
  cancelConfigure():void{this.finishPrompt(this.status().configured);}
  dispose():void{this.disposed=true;this.finishPrompt(this.status().configured);this.memory=undefined;}
  configure():Promise<{configured:boolean}>{
    if(this.disposed)return Promise.resolve({configured:false});
    if(this.prompt)return this.prompt;
    const profile=CREDENTIAL_PROFILES[this.provider];
    // Gate before any UI: secure storage must exist on every platform.
    assertCredentialStorage(this.safe(),this.provider);
    this.prompt=new Promise<{configured:boolean}>(resolve=>{
      const timer=setTimeout(()=>this.finishPrompt(this.status().configured),300_000);timer.unref();
      this.pending={resolve,timer};
      if(!this.requestHandler){this.finishPrompt(this.status().configured);return;}
      this.requestHandler({provider:this.provider,label:profile.label,purpose:profile.purpose});
    }).finally(()=>{this.prompt=null;});
    return this.prompt;
  }
  private finishPrompt(configured:boolean):void{const pending=this.pending;this.pending=null;if(pending){clearTimeout(pending.timer);pending.resolve({configured});}}
}

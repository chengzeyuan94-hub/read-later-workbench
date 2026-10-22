/** Main-process only. Neither key nor native prompt output crosses renderer IPC. */
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import { CREDENTIAL_PROFILES, readProviderCredential, storeProviderCredential, type CredentialEncryption, type CredentialProvider } from './credential-store.js';
const electronSafeStorage = (): CredentialEncryption => (createRequire(import.meta.url)('electron') as { safeStorage: CredentialEncryption }).safeStorage;
export class AsrCredentials {
  private memory:string|undefined;
  private prompt:Promise<{configured:boolean}>|null=null;
  private child:ReturnType<typeof spawn>|null=null;
  private disposed=false;
  private readonly encryption?:CredentialEncryption;
  /** The legacy one-argument constructor remains SiliconFlow/ASR only. */
  constructor(readonly userDataDir:string, readonly provider:CredentialProvider='siliconflow', readonly fallbackDirs:readonly string[]=[],encryption?:CredentialEncryption){this.encryption=encryption;}
  private safe():CredentialEncryption{return this.encryption??electronSafeStorage();}
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
    storeProviderCredential(this.userDataDir,this.provider,trimmed,this.safe());this.memory=trimmed;
    return{configured:true};
  }
  dispose():void{this.disposed=true;this.child?.kill('SIGTERM');this.child=null;this.memory=undefined;}
  configure():Promise<{configured:boolean}>{if(this.disposed)return Promise.resolve({configured:false});if(this.prompt)return this.prompt;this.prompt=this.configureNative().finally(()=>{this.prompt=null;});return this.prompt;}
  private async configureNative():Promise<{configured:boolean}>{
    const profile=CREDENTIAL_PROFILES[this.provider];
    if(process.platform!=='darwin'||!this.safe().isEncryptionAvailable())throw Error(`安全凭据存储不可用；请通过主进程环境配置 ${profile.environment}`);
    const key=await new Promise<string|null>((resolve,reject)=>{
      const child=spawn('/usr/bin/osascript',['-e',`text returned of (display dialog "配置 ${profile.label} 密钥（${profile.purpose}；只保存在本机安全存储，不会显示或导出）" default answer "" with hidden answer buttons {"取消", "保存"} default button "保存" cancel button "取消" with title "收藏阅读工作台 · ${profile.label}")`],{shell:false,stdio:['ignore','pipe','ignore']});
      this.child=child;
      const chunks:Buffer[]=[];let bytes=0,closed=false;const timer=setTimeout(()=>{child.kill('SIGTERM');resolve(null);},300_000);timer.unref();
      child.stdout.on('data',(data:Buffer)=>{bytes+=data.length;if(bytes>4096){child.kill('SIGTERM');return;}chunks.push(data);});
      child.on('error',()=>{clearTimeout(timer);if(!closed){closed=true;reject(Error('安全配置窗口未能打开，现有密钥和资料保持'));}});
      child.on('close',code=>{clearTimeout(timer);if(this.child===child)this.child=null;if(closed)return;closed=true;if(code!==0||bytes>4096||this.disposed)return resolve(null);resolve(Buffer.concat(chunks).toString('utf8').trim());});
    });
    if(!key||this.disposed)return this.status();if(key.length>1024||/[\r\n]/.test(key))throw Error('密钥格式不正确，未保存');
    storeProviderCredential(this.userDataDir,this.provider,key,this.safe());this.memory=key;
    return{configured:true};
  }
}

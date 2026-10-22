import {resolveBatchPaths} from '../src/main/batch-isolation.js';
const paths=resolveBatchPaths(process.env.RLW_BATCH_DIR,{mustExist:true});
console.log(JSON.stringify({prepared:true,root:paths.root,sessionMode:'isolated-five-platforms',sessionDataDir:paths.sourceSessionDataDir,loginPlatforms:Object.keys(paths.sourcePartitions),profilesCopied:false,credentialsCopied:false,oldLoginProfileUsed:false}));

import { build } from 'esbuild';
await build({entryPoints:['src/main/preload.ts'],outfile:'dist/main/preload.cjs',bundle:true,platform:'node',format:'cjs',external:['electron']});

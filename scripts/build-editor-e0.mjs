import { build } from 'esbuild';
await build({ entryPoints: ['spikes/editor-e0/main.ts'], outfile: 'dist/editor-e0/main.cjs', bundle: true, platform: 'node', format: 'cjs', target: 'node24', external: ['electron', 'better-sqlite3'] });
await build({ entryPoints: ['spikes/editor-e0/preload.ts'], outfile: 'dist/editor-e0/preload.cjs', bundle: true, platform: 'node', format: 'cjs', target: 'node24', external: ['electron'] });

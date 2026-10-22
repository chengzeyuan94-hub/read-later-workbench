/**
 * Read-only Chrome Bridge probe. Does not open the app database or save media.
 * Run: RLW_BRIDGE_PROFILE=<profile> node --import tsx scripts/source-probe.ts
 * Successful discovery is not evidence of local saving or offline playback.
 */
import { createBridgeSources } from '../src/main/source-bridge.js';
import { sanitizeSourceError } from '../src/main/source-core.js';
import type { Platform } from '../src/shared/contracts.js';

const profile = process.env.RLW_BRIDGE_PROFILE;
if (!profile || !/^[a-zA-Z0-9_-]+$/.test(profile)) {
  console.error(JSON.stringify({ platform: 'probe', connected: false, discovered: 0, complete: false, error: '请设置有效的 RLW_BRIDGE_PROFILE，选择已连接的 Chrome Browser Bridge profile' }));
  process.exitCode = 1;
} else {
  const sources = createBridgeSources(profile);
  const timeoutMilliseconds = 5 * 60 * 1000;
  // Individual OpenCLI requests also have their own 90-second timeout.
  // The watchdog bounds the probe process; child requests retain their own timeout.
  const watchdog = setTimeout(() => {
    console.error(JSON.stringify({ platform: 'probe', connected: false, discovered: 0, complete: false, error: '来源复检超时；没有写入应用数据库或媒体目录' }));
    sources.dispose();
    process.exit(124);
  }, timeoutMilliseconds);
  watchdog.unref();
  try {
    for (const platform of ['xiaohongshu', 'bilibili'] as Platform[]) {
      const adapter = sources.adapters.find(adapter => adapter.platform === platform)!;
      try {
        const snapshot = await adapter.collect();
        const connection = sources.connections().find(connection => connection.platform === platform);
        console.log(JSON.stringify({ platform, connected: connection?.state === 'connected', discovered: snapshot.items.length, complete: snapshot.complete, error: snapshot.warning ? sanitizeSourceError(snapshot.warning) : null }));
      } catch (error) {
        console.log(JSON.stringify({ platform, connected: false, discovered: 0, complete: false, error: sanitizeSourceError(error) }));
        process.exitCode = 1;
      }
    }
  } finally {
    clearTimeout(watchdog);
    sources.dispose();
  }
}

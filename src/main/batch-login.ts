import { BrowserWindow, type Session } from 'electron';
import type { Platform } from '../shared/contracts.js';
import { allowedPlatformUrl, PLATFORM_HOME, PLATFORM_NAMES } from '../shared/platforms.js';

/** A separate visible window per source lets the user sign in concurrently.
 * Opening/closing a window never marks an account verified; adapters do that. */
export function createBatchLogin(sessionFor: (platform: Platform) => Session) {
  const windows = new Map<Platform, BrowserWindow>();
  return {
    open(platform: Platform): void {
      const previous = windows.get(platform);
      if (previous && !previous.isDestroyed()) { previous.show(); previous.focus(); return; }
      const win = new BrowserWindow({ width: 1100, height: 820, show: true, title: `${PLATFORM_NAMES[platform]} · 测试版独立登录`, webPreferences: { session: sessionFor(platform), nodeIntegration: false, contextIsolation: true, sandbox: true, webSecurity: true } });
      windows.set(platform, win);
      win.webContents.setUserAgent(win.webContents.getUserAgent().replace(/\sElectron\/\S+/g, '').replace(/\sread-later-workbench\/\S+/g, ''));
      win.webContents.setWindowOpenHandler(({ url }) => { if (allowedPlatformUrl(platform, url)) void win.loadURL(url).catch(() => undefined); return { action: 'deny' }; });
      win.webContents.on('will-navigate', (event, url) => { if (!allowedPlatformUrl(platform, url)) event.preventDefault(); });
      win.webContents.on('will-redirect', (event, url) => { if (!allowedPlatformUrl(platform, url)) event.preventDefault(); });
      win.on('closed', () => { windows.delete(platform); });
      void win.loadURL(PLATFORM_HOME[platform]).catch(() => { if (!win.isDestroyed()) win.setTitle(`${PLATFORM_NAMES[platform]} · 页面加载失败，可重新打开`); });
    },
    dispose(): void { for (const win of windows.values()) if (!win.isDestroyed()) win.destroy(); windows.clear(); },
  };
}

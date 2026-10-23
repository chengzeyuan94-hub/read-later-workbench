// Renders the L叔 avatar SVG into build/icon.png (1024²) for electron-builder.
// Run: electron scripts/icon.cjs
const { app, BrowserWindow } = require('electron');
const { mkdirSync, readFileSync, writeFileSync } = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const svg = readFileSync(path.join(root, 'src', 'renderer', 'assets', 'avatar', 'lshu-avatar.svg'), 'utf8');
const sized = svg.includes('width=') ? svg.replace(/<svg\b/, '<svg width="1024" height="1024" style="width:1024px;height:1024px"') : svg;
const html = `data:text/html;charset=utf-8,${encodeURIComponent(`<!doctype html><html><body style="margin:0;width:1024px;height:1024px;overflow:hidden">${sized}</body></html>`)}`;

app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: false, width: 1024, height: 1024, webPreferences: { offscreen: true } });
  await win.loadURL(html);
  await new Promise(resolve => setTimeout(resolve, 500));
  const image = await win.webContents.capturePage();
  const png = image.toPNG();
  if (png.length < 1000) { console.error('icon render produced a suspiciously small PNG'); app.exit(1); }
  mkdirSync(path.join(root, 'build'), { recursive: true });
  writeFileSync(path.join(root, 'build', 'icon.png'), png);
  console.log(`build/icon.png written (${png.length} bytes, ${image.getSize().width}x${image.getSize().height})`);
  app.exit(0);
});

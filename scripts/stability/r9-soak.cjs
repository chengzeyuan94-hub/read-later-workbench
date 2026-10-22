// R9: 30-minute offline soak on a scratch real-data copy.
// Every 60s sample main-process RSS + renderer JS heap (precise via CDP
// Runtime.getHeapUsage — performance.memory is bucket-quantized). In parallel,
// cycle the UI 50 times: reader open/close, note workspace open/back, sync
// popover, view switch. Pass: no console errors, renderer heap trend flat
// (<=+20% minute 5 -> minute 30), main RSS growth <=+25% (minute-5 baseline,
// post-warmup; growth from t0 is also reported).
// Usage: RLW_BATCH_DIR=... RLW_BATCH_BUILD=... SOAK_MINUTES=30 node scripts/stability/r9-soak.cjs
const fs = require('node:fs');
const { launch } = require('./app-lib.cjs');

const ROUND = 'round-09';
const SOAK_MINUTES = Number(process.env.SOAK_MINUTES || 30);
const CYCLES = Number(process.env.SOAK_CYCLES || 50);
const report = { samples: [], cycles: 0, failures: [], consoleErrors: [] };

(async () => {
  const app = await launch({ build: process.env.RLW_BATCH_BUILD, root: process.env.RLW_BATCH_DIR, round: ROUND, args: ['--js-flags=--expose-gc'] });
  const end = Date.now() + SOAK_MINUTES * 60_000;

  const sample = async () => {
    try {
      const m = await app.memory(); // memory action now forces a real GC via CDP
      // Census retained structures so a growth step can be attributed.
      const census = await app.evalJs(`(()=>{try{const s=window.__state||null;return {cards:document.querySelectorAll('.content-card').length,nodes:document.querySelectorAll('*').length,ls:JSON.stringify(Object.keys(localStorage).reduce((o,k)=>(o[k]=localStorage.getItem(k).length,o),{})),media:performance.getEntriesByType('resource').length}}catch(e){return {err:String(e)}}})()`);
      report.samples.push({ at: Date.now(), rss: m.mainRss, heap: m.heap && m.heap.used, heapTotal: m.heap && m.heap.total, heapPrecise: !!(m.heap && m.heap.precise), dom: m.dom, census });
    } catch (e) { report.failures.push('sample: ' + e.message); }
  };
  const sampler = (async () => { while (Date.now() < end) { await sample(); await new Promise(r => setTimeout(r, 30_000)); } })();

  // UI cycling
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const click = expr => app.evalJs(`(()=>{const e=(${expr}); if(!e)return false; e.click(); return true})()`).catch(() => false);
  const firstCard = sel => `(()=>{const c=${sel}; if(c)c.scrollIntoView(); return c})()`;
  try {
    for (let i = 0; i < CYCLES && Date.now() < end; i++) {
      await app.nav('我的收藏夹');
      // reader open/close
      await click(`(()=>{const c=document.querySelector('.content-card[data-content-id]'); if(!c)return null; c.click(); return c})()`);
      await sleep(700);
      await click(`document.querySelector('dialog.reader button[aria-label=关闭阅读卡片]')`);
      await sleep(400);
      // note workspace open/back (消化库 first digest action)
      await app.nav('消化库');
      const opened = await click(`document.querySelector('[data-card-digest]')`);
      if (opened) {
        await sleep(2500);
        const ws = await app.evalJs(`!!(document.querySelector('.e1-workspace,.e3-creation-workspace'))`).catch(() => false);
        if (ws) await click(`[...document.querySelectorAll('button')].find(b=>b.textContent.startsWith('← 返回'))`);
        await sleep(600);
      }
      // sync popover
      await click(`document.querySelector('button.chip')`);
      await sleep(500);
      await click(`document.querySelector('button.chip-close')`);
      await sleep(300);
      // view switch
      await app.nav('设置'); await sleep(400);
      await app.nav('首页'); await sleep(400);
      report.cycles = i + 1;
      if (report.cycles % 10 === 0) console.log(`soak cycle ${report.cycles}/${CYCLES} @ ${((Date.now() - (end - SOAK_MINUTES * 60_000)) / 60000).toFixed(1)}min`);
    }
  } catch (e) { report.failures.push('cycling: ' + e.message); }

  // wait for the remaining soak time
  while (Date.now() < end) await sleep(5000);
  await sample();
  await sampler.catch(() => {});

  // analysis. Heap samples oscillate ~±2MB: a sample landing mid state-refresh
  // (1.5s poll) transiently retains the next ~2MB state object while the old one
  // is still rooted. Endpoint comparison of two noisy samples is not a trend
  // measure — use the median of the first 5 minutes after warmup vs the median
  // of the last 5 minutes. Report endpoint figures too for transparency.
  const s = report.samples;
  const min5 = s[0].at + 5 * 60_000;
  const first = s.filter(p => p.at >= min5 && p.at <= min5 + 5 * 60_000);
  const lastStart = s[s.length - 1].at - 5 * 60_000;
  const last = s.filter(p => p.at >= lastStart);
  const med = a => { const v = a.map(p => p.heap).filter(x => x != null).sort((x, y) => x - y); return v.length ? v[v.length >> 1] : null; };
  const medRss = a => { const v = a.map(p => p.rss).filter(x => x != null).sort((x, y) => x - y); return v.length ? v[v.length >> 1] : null; };
  const m5 = s.filter(p => p.at >= min5)[0], mEnd = s[s.length - 1];
  if (s.length >= 10 && first.length >= 3 && last.length >= 3) {
    const f = med(first), l = med(last);
    const heapGrowth = (l - f) / f;
    const rssGrowth = (medRss(last) - medRss(first)) / medRss(first);
    // point-to-point figures kept for the report (not the pass criterion)
    report.heapGrowthEndpointPct = +(((mEnd.heap - m5.heap) / m5.heap) * 100).toFixed(1);
    report.rssGrowthFromStartPct = +(((mEnd.rss - s[0].rss) / s[0].rss) * 100).toFixed(1);
    report.heapGrowthPct = +(heapGrowth * 100).toFixed(1);
    report.rssGrowthPct = +(rssGrowth * 100).toFixed(1);
    report.heapPrecise = s.every(p => p.heapPrecise);
    if (!report.heapPrecise) report.failures.push('heap sampling was not precise (quantized performance.memory)');
    if (heapGrowth > 0.20) report.failures.push(`renderer heap grew ${(heapGrowth * 100).toFixed(1)}% (median m5-10 -> last 5min)`);
    if (rssGrowth > 0.25) report.failures.push(`main RSS grew ${(rssGrowth * 100).toFixed(1)}% (median m5-10 -> last 5min)`);
  } else report.failures.push('insufficient samples');

  report.consoleErrors = await app.consoleErrors();
  report.ok = !report.failures.length && !report.consoleErrors.length;
  fs.writeFileSync('/tmp/stability/round-09/r9-report.json', JSON.stringify(report, null, 2));
  console.log(`R9 ${report.ok ? 'clean' : 'FAILED'} cycles=${report.cycles} samples=${s.length} heapGrowth=${report.heapGrowthPct}% rssGrowth=${report.rssGrowthPct}% consoleErrors=${report.consoleErrors.length}`);
  if (report.failures.length) console.log(report.failures.join('\n'));
  if (report.consoleErrors.length) console.log('console errors:', report.consoleErrors.slice(0, 10).join('\n---\n'));
  await app.quit(); app.restore();
  process.exit(report.ok ? 0 : 1);
})().catch(async e => {
  console.error('R9 harness error:', e);
  fs.writeFileSync('/tmp/stability/round-09/r9-report.json', JSON.stringify({ ...report, harnessError: e.message }, null, 2));
  process.exit(2);
});

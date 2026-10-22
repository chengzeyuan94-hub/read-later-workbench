// R10: scripted UI flow regression — every view and dialog on a scratch
// real-data copy, one screenshot per step, zero console errors.
// Usage:
//   RLW_BATCH_DIR=<scratch root> RLW_BATCH_BUILD=<scratch build> \
//   STABILITY_DIGESTED_ID=16 STABILITY_BLOCKED_ID=317 STABILITY_READ_ID=1 \
//   node scripts/stability/r10-ui-flow.cjs
const fs = require('node:fs'), path = require('node:path');
const { launch } = require('./app-lib.cjs');

const ROUND = 'round-10';
const DIG = process.env.STABILITY_DIGESTED_ID;
const BLK = process.env.STABILITY_BLOCKED_ID;
const READ = process.env.STABILITY_READ_ID;
const report = { steps: [], failures: [], consoleErrors: [] };
let n = 0;

const sel = s => `document.querySelector(${JSON.stringify(s)})`;
const btnByText = l => `[...document.querySelectorAll('button')].find(b=>b.textContent.trim().startsWith(${JSON.stringify(l)}))`;
const segBtn = (aria, l) => `[...document.querySelectorAll('div.segmented[aria-label=${JSON.stringify(aria)}] button')].find(b=>b.textContent.trim()===${JSON.stringify(l)})`;

(async () => {
  const app = await launch({ build: process.env.RLW_BATCH_BUILD, root: process.env.RLW_BATCH_DIR, round: ROUND });
  const t0 = Date.now();
  const capture = async name => { n += 1; const file = `${String(n).padStart(2, '0')}-${name}`; await app.shot(file); report.steps.push(file); };
  const check = async (label, expr, detail) => {
    const v = await app.evalJs(`!!(${expr})`);
    if (!v) { report.failures.push(`${label}: ${detail || 'missing'}`); console.log('FAIL', label); }
    return v;
  };
  const click = async (label, el) => {
    const v = await app.evalJs(`(()=>{const e=(${el}); if(!e)return false; e.click(); return true})()`);
    if (!v) { report.failures.push(`${label}: click target missing`); console.log('MISS', label); return false; }
    await new Promise(r => setTimeout(r, 500));
    return true;
  };

  try {
    // ---- home ----
    await app.nav('首页');
    await check('home groups', `document.querySelectorAll('main h2').length>=2`, 'expected home groups');
    await capture('home');

    // ---- library ----
    await app.nav('我的收藏夹');
    await check('library cards', `${sel('.content-card[data-content-id]')}`, 'no cards');
    await capture('library');

    await click('platform filter xhs', segBtn('平台筛选', '小红书'));
    await capture('library-filter-xhs');
    await click('platform filter all', segBtn('平台筛选', '全部来源'));

    await click('status pending', `(()=>{const s=${sel('select[aria-label=消化状态筛选]')}; return s})()`).then(async ok => {
      if (ok) await app.evalJs(`(()=>{const s=${sel('select[aria-label=消化状态筛选]')}; s.value='pending'; s.dispatchEvent(new Event('change',{bubbles:true}))})()`);
    });
    await capture('library-status-pending');
    await app.evalJs(`(()=>{const s=${sel('select[aria-label=消化状态筛选]')}; if(s){s.value='all'; s.dispatchEvent(new Event('change',{bubbles:true}))}})()`);
    await new Promise(r => setTimeout(r, 400));

    await app.evalJs(`(()=>{const s=${sel('select[aria-label=排序]')}; if(s){s.value='oldest'; s.dispatchEvent(new Event('change',{bubbles:true}))}})()`);
    await new Promise(r => setTimeout(r, 500));
    await capture('library-sort-oldest');
    await app.evalJs(`(()=>{const s=${sel('select[aria-label=排序]')}; if(s){s.value='newest'; s.dispatchEvent(new Event('change',{bubbles:true}))}})()`);
    await new Promise(r => setTimeout(r, 400));

    await app.evalJs(`(()=>{const i=${sel('input[aria-label=搜索标题]')}; if(!i)return; const set=Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set; set.call(i,'测试'); i.dispatchEvent(new Event('input',{bubbles:true}))})()`);
    await new Promise(r => setTimeout(r, 400));
    await capture('library-search');
    await app.evalJs(`(()=>{const i=${sel('input[aria-label=搜索标题]')}; const set=Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set; set.call(i,''); i.dispatchEvent(new Event('input',{bubbles:true}))})()`);
    await new Promise(r => setTimeout(r, 400));

    // ---- selection mode + delete confirm ----
    await click('select mode', btnByText('批量选择'));
    await click('select card', `${sel('.content-card-wrap .card-check')}`);
    await capture('library-select-mode');
    if (await click('open delete confirm', sel('[data-testid=batch-delete-selected]'))) {
      await check('delete dialog', sel('dialog.delete-confirm'), 'DeleteConfirm missing');
      await capture('delete-confirm');
      await click('cancel delete', btnByText('取消'));
    } else {
      report.failures.push('batch-delete-selected missing (no selection?)');
    }
    await app.evalJs(`(()=>{const b=${btnByText('退出选择')}; if(b)b.click()})()`);
    await new Promise(r => setTimeout(r, 300));

    // ---- settings ----
    await app.nav('设置');
    await capture('settings');
    await click('range 30', segBtn('同步范围', '最近 30 条'));
    await capture('settings-range-30');
    await click('range all', segBtn('同步范围', '全部'));
    await check('range-all confirm', sel('dialog.delete-confirm'), 'SyncRangeConfirm missing');
    await capture('settings-all-confirm');
    await click('cancel all', btnByText('取消'));
    await click('restore 100', segBtn('同步范围', '最近 100 条'));
    await new Promise(r => setTimeout(r, 600));

    // auto-sync off then back on
    const before = await app.evalJs(`${sel('button[aria-label=自动同步]')}.getAttribute('aria-checked')`);
    await click('autosync toggle off', sel('button[aria-label=自动同步]'));
    await new Promise(r => setTimeout(r, 800));
    const off = await app.evalJs(`${sel('button[aria-label=自动同步]')}.getAttribute('aria-checked')`);
    await click('autosync toggle on', sel('button[aria-label=自动同步]'));
    await new Promise(r => setTimeout(r, 800));
    const on = await app.evalJs(`${sel('button[aria-label=自动同步]')}.getAttribute('aria-checked')`);
    if (!(before === 'true' && off === 'false' && on === 'true')) report.failures.push(`autosync aria-checked ${before}->${off}->${on}`);
    await capture('settings-autosync');

    // dev-info toggle
    await click('devinfo on', sel('button[aria-label=显示开发者信息]'));
    await capture('settings-devinfo');
    await click('devinfo off', sel('button[aria-label=显示开发者信息]'));

    // deleted list
    await click('deleted list', `[...document.querySelectorAll('button')].find(b=>b.textContent.trim()==='查看'&&b.closest('.settings-block')&&b.closest('.settings-block').textContent.includes('已删除的收藏'))`);
    await check('deleted list', sel('dialog.deleted-list'), 'DeletedList missing');
    await capture('settings-deleted-list');
    await click('close deleted list', btnByText('关闭'));

    // ---- sync popover + queue drawer ----
    await click('sync chip', sel('button.chip'));
    await check('sync popover', sel('.chip-popover'), 'popover missing');
    await capture('sync-popover');
    await app.evalJs(`(()=>{const b=${sel('button.chip-close')}; if(b)b.click()})()`);
    const hasQueue = await app.evalJs(`!![...document.querySelectorAll('button.chip')].find(b=>b.textContent.includes('处理队列'))`);
    if (hasQueue) {
      await click('queue chip', btnByText('处理队列'));
      await check('queue drawer', sel('.queue-drawer'), 'drawer missing');
      await capture('queue-drawer');
      await click('close queue', sel('button[aria-label=关闭处理队列]'));
    } else report.steps.push('queue-drawer skipped (empty queue)');

    // ---- reader ----
    await app.nav('我的收藏夹');
    if (READ) {
      let opened = await app.evalJs(`(()=>{const c=${sel(`.content-card[data-content-id="${READ}"]`)}; if(c){c.click();return true} return false})()`);
      if (!opened) {
        // item may be filtered off; open first available card
        opened = await app.evalJs(`(()=>{const c=${sel('.content-card[data-content-id]')}; if(c){c.click();return true} return false})()`);
      }
      await new Promise(r => setTimeout(r, 700));
      await check('reader', sel('dialog.reader'), 'reader missing');
      await capture('reader');
      await click('reader more menu', sel('.reader-menu summary'));
      await capture('reader-menu');
      await click('close reader', sel('button[aria-label=关闭阅读卡片]'));
    }

    // ---- note workspace for a digested item ----
    if (DIG) {
      await app.nav('消化库');
      await capture('digest-library');
      await click('open digested workspace', sel(`.digest-open[data-content-id="${DIG}"]`));
      await app.until(sel('.e1-workspace, .e3-creation-workspace'), 'workspace', 20000).catch(() => report.failures.push('note workspace did not open'));
      await check('note workspace', sel('.e1-workspace, .e3-creation-workspace'), 'missing');
      await capture('note-workspace');
      await click('export menu', sel('.e1-export-toggle'));
      await capture('workspace-export-menu');
      await app.evalJs(`document.querySelectorAll('details[open]').forEach(d=>d.removeAttribute('open'))`);
      await click('back', btnByText('← 返回'));
      await new Promise(r => setTimeout(r, 600));
    }

    // ---- blocked-state workspace (detail succeeded, body incomplete) ----
    if (BLK) {
      await app.nav('我的收藏夹');
      await click('platform X', segBtn('平台筛选', 'X / 推特'));
      const digestBtn = await app.evalJs(`(()=>{const b=${sel(`[data-card-digest="${BLK}"]`)}; if(!b)return 'missing'; if(b.disabled)return 'disabled'; b.click(); return 'clicked'})()`);
      if (digestBtn === 'clicked') {
        await new Promise(r => setTimeout(r, 800));
        // precheck may intercept — start through it if possible
        if (await app.evalJs(`!!${sel('[data-testid=digest-precheck-start]')}`)) {
          await capture('blocked-precheck');
          await click('precheck start', sel('[data-testid=digest-precheck-start]'));
        }
        for (let i = 0; i < 30; i++) {
          await new Promise(r => setTimeout(r, 500));
          if (await app.evalJs(`!!(${sel('.e3-creation-workspace')}||${sel('.e1-workspace')}||document.body.textContent.includes('暂时不能消化'))`)) break;
        }
        const blocked = await app.evalJs(`document.body.textContent.includes('暂时不能消化')`);
        const ws = await app.evalJs(`!!(${sel('.e3-creation-workspace')}||${sel('.e1-workspace')})`);
        if (!blocked && !ws) report.failures.push('blocked workspace neither shown nor reached');
        await capture('blocked-workspace');
        await click('back', btnByText('← 返回'));
      } else report.failures.push(`blocked card digest button: ${digestBtn}`);
    }

    // ---- dark mode ----
    const themeClicked = await app.evalJs(`(()=>{const b=${sel('button[aria-label*=主题]')}||${sel('button[aria-label*=浅色]')}||${sel('button[aria-label*=深色]')}; if(b){b.click();return true} return false})()`);
    if (!themeClicked) await app.evalJs(`localStorage.setItem('rlw-theme','dark'); document.documentElement.dataset.theme='dark'`);
    await new Promise(r => setTimeout(r, 500));
    await capture('dark-mode');
    await app.evalJs(`localStorage.setItem('rlw-theme','light'); if(document.documentElement.dataset.theme==='dark')document.documentElement.dataset.theme='light'; const b=${sel('button[aria-label*=主题]')}||${sel('button[aria-label*=浅色]')}; if(b&&document.documentElement.dataset.theme!=='light')b.click()`);
    await new Promise(r => setTimeout(r, 300));

    // ---- collect errors ----
    report.consoleErrors = await app.consoleErrors();
    report.ms = Date.now() - t0;
    report.ok = !report.failures.length && !report.consoleErrors.length;
    fs.writeFileSync('/tmp/stability/round-10/r10-report.json', JSON.stringify(report, null, 2));
    console.log(`R10 ${report.ok ? 'clean' : 'FAILED'} steps=${report.steps.length} failures=${report.failures.length} consoleErrors=${report.consoleErrors.length}`);
    if (report.failures.length) console.log(report.failures.join('\n'));
    if (report.consoleErrors.length) console.log('console errors:', report.consoleErrors.slice(0, 10).join('\n---\n'));
    await app.quit();
    app.restore();
    process.exit(report.ok ? 0 : 1);
  } catch (e) {
    report.failures.push(`harness: ${e.message}`);
    try { fs.writeFileSync('/tmp/stability/round-10/r10-report.json', JSON.stringify(report, null, 2)); } catch {}
    console.error('R10 harness error:', e.message);
    try { await app.quit(); app.restore(); } catch {}
    process.exit(2);
  }
})();

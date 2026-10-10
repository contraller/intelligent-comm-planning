const { chromium } = require('../.browser-tools/node_modules/playwright');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

(async () => {
  const root = path.resolve(__dirname, '..');
  const target = path.join(root, 'data/results/current_dem');
  const browser = await chromium.launch({channel: 'msedge', headless: true});
  const page = await browser.newPage({viewport: {width: 1920, height: 1080}});
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  await page.goto(pathToFileURL(path.join(root, 'W1-W3算法演示.html')).href);
  await page.waitForFunction(() => document.querySelector('#hdr-check').textContent.includes('/3'), {timeout: 30000});
  const selfcheck = await page.evaluate(() => ({badge: document.querySelector('#hdr-check').textContent, results: SelfCheck.results}));
  const views = [];
  for (const id of await page.evaluate(() => Object.keys(App.mods))) {
    await page.evaluate(id => {
      App.go(id);
      if (id === 'deploy') { Deploy.revealed.p1 = true; Deploy.tab = 'p1'; App.refresh(); }
      if (id === 'cov') { Cov.revealed = true; App.refresh(); }
    }, id);
    await page.waitForTimeout(100);
    views.push({id, text: (await page.locator('#panel').innerText()).slice(0, 1200)});
    if (['overview', 'cov', 'param', 'w4'].includes(id))
      await page.screenshot({path: path.join(target, `desktop-${id}.png`)});
  }
  const canvas = await page.evaluate(() => {
    const ctx = M.ctx, data = ctx.getImageData(0, 0, M.cv.width, M.cv.height).data;
    const colors = new Set();
    for (let i = 0; i < data.length; i += 160) colors.add(`${data[i]},${data[i+1]},${data[i+2]}`);
    return {width: M.cv.width, height: M.cv.height, colors: colors.size,
      assets: Object.fromEntries(Object.entries(M.img).map(([k, v]) => [k, v.naturalWidth]))};
  });
  for (const tab of ['pre', 'p1', 'fixed', 'multi']) {
    await page.evaluate(tab => {
      App.go('deploy');
      Deploy.tab = tab;
      Deploy.revealed = {p1: true, fixed: Deploy.p, multi: true};
      if (tab === 'multi') Deploy.planIdx = 2;
      App.refresh();
    }, tab);
    views.push({id: `deploy-${tab}`, text: (await page.locator('#panel').innerText()).slice(0, 1200)});
  }
  await page.screenshot({path: path.join(target, 'desktop-p2.png')});
  await page.evaluate(() => { App.go('cov'); Cov.tab = 'hf'; App.refresh(); });
  await page.screenshot({path: path.join(target, 'desktop-hf.png')});
  await page.setViewportSize({width: 390, height: 844});
  await page.evaluate(() => App.go('overview'));
  await page.waitForTimeout(200);
  await page.screenshot({path: path.join(target, 'mobile-overview.png'), fullPage: true});
  const mobile = await page.evaluate(() => ({scrollWidth: document.documentElement.scrollWidth, width: innerWidth}));
  const report = {selfcheck, views, errors, canvas, mobile};
  fs.writeFileSync(path.join(target, 'browser_validation.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify({selfcheck, errors, canvas, mobile}, null, 2));
  await browser.close();
  if (errors.length || !selfcheck.badge.includes('3/3') || Object.values(selfcheck.results).some(r => !r.ok)
      || canvas.colors < 100 || Object.values(canvas.assets).some(w => !w) || mobile.scrollWidth > mobile.width)
    process.exitCode = 1;
})().catch(e => { console.error(e); process.exitCode = 1; });

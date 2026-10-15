const path = require('path');
const { pathToFileURL } = require('url');
const { chromium } = require(path.join(__dirname, '..', '.browser-tools', 'node_modules', 'playwright-core'));

(async () => {
  const errors = [];
  const browser = await chromium.launch({ channel: 'msedge', headless: true });
  const page = await browser.newPage({ viewport: { width: 1600, height: 1000 }, deviceScaleFactor: 1 });
  page.on('pageerror', error => errors.push(String(error)));
  page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
  await page.goto(pathToFileURL(path.join(__dirname, '..', 'W1-W3算法演示.html')).href);
  await page.locator('[data-id="w4"]').click();
  await page.locator('#j-add').waitFor();
  const presetCount = await page.locator('[data-jam]').count();
  if (presetCount !== 16) throw new Error(`expected 16 preset sources, got ${presetCount}`);
  const initialAffected = await page.locator('section.card').filter({ hasText: '当前受扰链路' }).locator('h2').textContent();
  if (initialAffected !== '当前受扰链路（20）') throw new Error(`preset view is not using the backend baseline: ${initialAffected}`);

  await page.locator('#j-add').click();
  const box = await page.locator('#map').boundingBox();
  await page.mouse.click(box.x + box.width * 0.68, box.y + box.height * 0.45);
  await page.locator('[data-jam]').nth(16).waitFor();
  if (await page.locator('[data-jam]').count() !== 17) throw new Error('map placement did not add a source');
  if (await page.locator('#j-power').inputValue() !== '50') throw new Error('new source defaults were not loaded');

  await page.locator('#j-power').fill('65');
  await page.locator('#j-power').press('Enter');
  await page.locator('#j-power').blur();
  if (await page.locator('#j-power').inputValue() !== '65') throw new Error('source parameter edit was not retained');
  const affected = await page.locator('section.card').filter({ hasText: '当前受扰链路' }).locator('h2').textContent();
  const routeCard = page.locator('section.card').filter({ hasText: '路由联动重构' });
  const reroutedCount = await routeCard.locator('[data-reroute]').count();
  if (!reroutedCount) throw new Error('interference changes did not produce a route proposal');
  await routeCard.locator('[data-reroute]').first().click();
  await page.locator('#j-apply-routes').click();
  if (!(await page.locator('section.card').first().textContent()).includes('已应用重构路由')) throw new Error('route proposal was not applied to the current plan');
  await page.screenshot({ path: path.join(__dirname, '..', 'data', 'results', 'current_dem', 'w4-interference-edit.png'), fullPage: true });

  await page.locator('#j-undo-routes').click();
  if ((await page.locator('section.card').first().textContent()).includes('已应用重构路由')) throw new Error('route rollback did not restore the baseline');

  await page.locator('#j-delete').click();
  if (await page.locator('[data-jam]').count() !== 16) throw new Error('source deletion did not restore the preset count');
  await page.setViewportSize({ width: 390, height: 844 });
  await page.reload();
  await page.locator('[data-id="w4"]').click();
  await page.locator('#j-add').waitFor();
  const mobileAffected = await page.locator('section.card').filter({ hasText: '当前受扰链路' }).locator('h2').textContent();
  if (mobileAffected !== initialAffected) throw new Error(`mobile baseline changed: ${mobileAffected}`);
  const mobileOverflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  if (mobileOverflow > 1) throw new Error(`mobile horizontal overflow: ${mobileOverflow}px`);
  await page.screenshot({ path: path.join(__dirname, '..', 'data', 'results', 'current_dem', 'w4-interference-mobile.png'), fullPage: true });
  if (errors.length) throw new Error(`browser errors: ${errors.join(' | ')}`);
  console.log(JSON.stringify({ presetCount, initialAffected, placedCount: 17, editedPowerDbm: 65, affected, reroutedCount, routeApplyAndUndo: true, mobileOverflow, browserErrors: 0 }));
  await browser.close();
})().catch(error => {
  console.error(error.stack || error);
  process.exitCode = 1;
});

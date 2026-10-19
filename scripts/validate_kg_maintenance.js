const path = require('path');
const { pathToFileURL } = require('url');
const { chromium } = require(path.join(__dirname, '..', '.browser-tools', 'node_modules', 'playwright-core'));

(async () => {
  const errors = [];
  const browser = await chromium.launch({ channel: 'msedge', headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 960 }, deviceScaleFactor: 1 });
  page.on('pageerror', error => errors.push(String(error)));
  page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
  const url = pathToFileURL(path.join(__dirname, '..', 'W1-W3算法演示.html')).href;
  await page.goto(url);
  await page.evaluate(() => localStorage.removeItem('intelligent-planning.manual-fault-cases.v1'));
  await page.reload();
  await page.locator('[data-id="sr6"]').click();
  await page.locator('[data-sr6tab="maintain"]').click();
  await page.locator('#kgm-symptoms').fill('接收音频间歇性啸叫\n重新插接后短暂恢复');
  await page.locator('#kgm-component').fill('音频处理模块');
  await page.locator('#kgm-cause').fill('音频板连接器接触不良');
  await page.locator('#kgm-steps').fill('复现音频异常\n检查连接器\n重新插接并复测');
  await page.locator('#kgm-solution').fill('清洁并重新固定音频板连接器');
  await page.locator('#kgm-source').fill('现场维修单#UI-TEST-001');
  await page.locator('#kgm-save').click();
  await page.getByText('FC-U0001 已保存').waitFor();
  const stored = await page.evaluate(() => JSON.parse(localStorage.getItem('intelligent-planning.manual-fault-cases.v1')));
  if (stored.length !== 1 || stored[0].symptoms.length !== 2) throw new Error('manual case was not persisted');
  await page.locator('[data-kgm-test="FC-U0001"]').click();
  await page.getByText('FC-U0001', { exact: true }).first().waitFor();
  const candidateText = await page.locator('[data-kgcase="FC-U0001"]').textContent();
  if (!candidateText.includes('音频板连接器接触不良')) throw new Error('manual case did not enter inference candidates');
  const tripleCount = await page.locator('section.card').filter({ hasText: '可溯源三元组' }).locator('tbody tr').count();
  if (tripleCount !== 8) throw new Error(`expected 8 displayed inference triples, got ${tripleCount}`);
  await page.reload();
  await page.locator('[data-id="sr6"]').click();
  await page.locator('[data-sr6tab="maintain"]').click();
  if (await page.locator('[data-kgm-test="FC-U0001"]').count() !== 1) throw new Error('manual case was not restored after reload');
  await page.setViewportSize({ width: 390, height: 844 });
  const mobileOverflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  if (mobileOverflow > 1) throw new Error(`mobile horizontal overflow: ${mobileOverflow}px`);
  if (errors.length) throw new Error(`browser errors: ${errors.join(' | ')}`);
  console.log(JSON.stringify({ savedCase: 'FC-U0001', symptoms: 2, displayedTriples: tripleCount,
    persistedAfterReload: true, enteredInference: true, mobileOverflow, browserErrors: 0 }));
  await browser.close();
})().catch(error => {
  console.error(error.stack || error);
  process.exitCode = 1;
});

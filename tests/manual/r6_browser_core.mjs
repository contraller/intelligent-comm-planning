// 资源/GIS/身份的真实控件验收；不借浏览器调用隐藏状态或业务写接口。
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';

const origin = 'http://127.0.0.24:5324';
const escaped = value => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const button = (scope, name) => scope.getByRole('button').filter({ hasText: new RegExp(`^\\s*${escaped(name)}\\s*$`) });
const drawer = (page, title) => page.locator('.p-drawer:visible').filter({ has: page.locator('.p-drawer-title').filter({ hasText: new RegExp(`^${escaped(title)}$`) }) });
const until = async (check, message, timeout = 60000) => {
  const end = Date.now() + timeout;
  while (Date.now() < end) { if (await check()) return; await new Promise(resolve => setTimeout(resolve, 100)); }
  throw new Error(message);
};
const response = (page, endpoint, action, method = 'GET', query = {}) => Promise.all([
  page.waitForResponse(value => {
    const url = new URL(value.url());
    return url.origin === origin && url.pathname === endpoint && value.request().method() === method
      && Object.entries(query).every(([key, item]) => url.searchParams.get(key) === String(item));
  }, { timeout: 60000 }), action(),
]).then(async ([value]) => {
  assert.equal(value.status(), 200, endpoint);
  const body = await value.json(); assert.equal(body.code, 0);
  return body.data;
});
async function close(page, title) {
  const panel = drawer(page, title);
  await panel.locator('.p-drawer-close-button').click();
  await panel.waitFor({ state: 'hidden' });
}
async function go(page, route) {
  await page.goto(`${origin}/#/${route}`, { waitUntil: 'domcontentloaded', timeout: 90000 });
  await page.getByRole('heading', { name: route === 'resources' ? '资源管理' : 'GIS 态势', exact: true }).waitFor({ timeout: 60000 });
}

export async function runCore(h) {
  const { page, evidence, login, download } = h;
  // 独立入口可只续跑尚未完成的无写用例，已通过用例不重复计数。
  const record = (id, action) => !h.caseNames?.length || h.caseNames.includes(id) ? h.record(id, action) : undefined;
  await login('editor');
  await record('CORE-RESOURCE-LIST', async () => {
    const data = await response(page, '/api/v1/resource/devices', () => go(page, 'resources'));
    assert.equal(data.total, 414);
    await page.getByText('匹配 414 台设备', { exact: true }).waitFor();
    const count = await page.locator('tbody tr').count();
    assert(count > 0 && count <= 20);
    return { total: data.total, visible_rows: count, revision: data.revision ?? null };
  });
  await record('CORE-RESOURCE-SEARCH', async () => {
    const found = await response(page, '/api/v1/resource/devices', () => page.getByLabel('搜索设备', { exact: true }).fill('DV-0001'), 'GET', { search: 'DV-0001' });
    assert.equal(found.total, 1);
    await page.getByText('匹配 1 台设备', { exact: true }).waitFor();
    const empty = await response(page, '/api/v1/resource/devices', () => page.getByLabel('搜索设备', { exact: true }).fill('R6-NO-MATCH'), 'GET', { search: 'R6-NO-MATCH' });
    assert.equal(empty.total, 0);
    await page.getByText('暂无符合条件的数据', { exact: true }).waitFor();
    await response(page, '/api/v1/resource/devices', () => button(page, '重置').click());
    await page.getByText('匹配 414 台设备', { exact: true }).waitFor();
    return { one: found.total, empty: empty.total, restored: 414 };
  });
  await record('CORE-RESOURCE-RANGE-FAIL', async () => {
    await button(page, '更多筛选').click();
    await page.getByLabel('频率下限（kHz）', { exact: true }).fill('30000');
    await page.getByLabel('频率上限（kHz）', { exact: true }).fill('1500');
    await button(page, '应用频率条件').click();
    await until(async () => /上限|下限|范围/.test(await page.locator('.filter-error').innerText()), '反向范围没有可见错误');
    assert((await page.locator('tbody').innerText()).includes('DV-0001'));
    const message = await page.locator('.filter-error').innerText();
    await response(page, '/api/v1/resource/devices', () => button(page, '重置').click());
    return { message, retained_device: 'DV-0001' };
  });
  await record('CORE-RESOURCE-DETAIL', async () => {
    const row = page.locator('tbody tr').filter({ has: page.getByText('DV-0001', { exact: true }) });
    await button(row, '查看详情').click();
    const panel = drawer(page, '设备实例详情');
    await panel.waitFor({ state: 'visible' });
    await until(async () => (await panel.innerText()).includes('DV-0001'), '详情没有绑定设备编号');
    const text = await panel.innerText();
    assert(text.includes('Barrett'));
    await close(page, '设备实例详情');
    return { device: 'DV-0001', detail_has_model: true };
  });
  await record('CORE-RESOURCE-EXPORT', async () => {
    await button(page, '导出').click();
    const panel = drawer(page, '导出资源');
    await panel.waitFor({ state: 'visible' });
    await panel.locator('label').filter({ hasText: /^\s*格式/ }).locator('select').selectOption('csv');
    const csv = await download(() => button(panel, '导出').click(), 'resource-devices');
    const bytes = await fs.readFile(csv.file, 'utf8');
    assert(bytes.includes('DV-0001'));
    await panel.locator('label').filter({ hasText: /^\s*格式/ }).locator('select').selectOption('xlsx');
    const xlsx = await download(() => button(panel, '导出').click(), 'resource-workbook');
    assert.equal((await fs.readFile(xlsx.file)).subarray(0, 2).toString(), 'PK');
    await close(page, '导出资源');
    return { csv, xlsx };
  });
  await record('CORE-RESOURCE-IMPORT-FAIL', async () => {
    await button(page, '导入').click();
    const panel = drawer(page, '导入资源');
    await panel.waitFor({ state: 'visible' });
    const csv = await download(() => button(panel, 'CSV 模板').click(), 'import-template');
    const xlsx = await download(() => button(panel, 'XLSX 三表模板').click(), 'import-template-workbook');
    const bad = path.join(evidence, 'invalid-device.csv');
    await fs.writeFile(bad, 'invalid_column\nR6-invalid\n', { flag: 'wx' });
    await panel.getByLabel('选择资源文件', { exact: true }).setInputFiles(bad);
    await until(async () => (await panel.innerText()).includes('错误') || await panel.getByRole('alert').count() > 0, '非法文件未展示预检失败');
    await panel.getByText('正在读取并预检…', { exact: true }).waitFor({ state: 'hidden' });
    assert.equal(await button(panel, '确认整批保存').isEnabled(), false);
    await button(panel, '关闭').click();
    // 关闭保护先决策再等待抽屉消失，不能等待隐藏而错过确认框。
    const dialog = page.getByRole('dialog').filter({ hasText: '导入尚未确认' });
    await until(async () => !await panel.isVisible() || await dialog.isVisible(), '导入关闭未给出反馈');
    if (await dialog.isVisible()) await button(dialog, '放弃本次导入').click();
    await panel.waitFor({ state: 'hidden' });
    return { template_csv: csv, template_xlsx: xlsx, invalid_commit_disabled: true };
  });
  await record('CORE-GIS-LAYERS', async () => {
    await go(page, 'situation');
    await page.getByText('DEM 地形', { exact: true }).waitFor({ timeout: 60000 });
    await button(page, '图层管理').click();
    const roads = page.getByLabel('本地道路', { exact: true });
    await roads.setChecked(false); await roads.setChecked(true);
    await page.getByLabel('显示HF设备', { exact: true }).setChecked(false);
    await page.getByLabel('显示HF设备', { exact: true }).setChecked(true);
    const readCanvases = () => page.locator('.ol-viewport canvas').evaluateAll(values => values.map(value => {
      const bounds = value.getBoundingClientRect(), context = value.getContext('2d');
      if (!context || bounds.width < 1 || bounds.height < 1) return null;
      let visible = 0; const colors = new Set();
      for (let y = 0; y < value.height; y += Math.max(1, Math.floor(value.height / 25)))
        for (let x = 0; x < value.width; x += Math.max(1, Math.floor(value.width / 25))) {
          const color = context.getImageData(x, y, 1, 1).data;
          if (color[3]) { visible++; colors.add([...color].join(',')); }
        }
      return { width: bounds.width, height: bounds.height, visible, colors: colors.size };
    }).filter(Boolean));
    let canvases;
    await until(async () => {
      canvases = await readCanvases();
      return canvases.some(value => value.visible > 0 && value.colors > 10);
    }, '地形画布为空或仅单色');
    return { layers_toggled: ['道路', 'HF设备'], canvases };
  });
  await record('CORE-READONLY-PERMISSION', async () => {
    await login('reviewer');
    await go(page, 'resources');
    await button(page, '新增设备').waitFor({ state: 'visible' });
    assert.equal(await button(page, '新增设备').isEnabled(), false);
    assert.equal(await button(page, '导入').isEnabled(), false);
    await page.goto(`${origin}/#/system`, { waitUntil: 'domcontentloaded' });
    await until(async () => !page.url().endsWith('#/system'), '审核者直达系统管理未受权限保护');
    return { create_disabled: true, import_disabled: true, system_redirected: page.url() };
  });
}

export default runCore;

export async function inspectResourceButton({ page, login, record }) {
  await login('editor');
  await record('CORE-DETAIL-SELECTOR-DIAGNOSTIC', async () => {
    await response(page, '/api/v1/resource/devices', () => go(page, 'resources'));
    await page.getByText('匹配 414 台设备', { exact: true }).waitFor();
    const row = page.locator('tbody tr').filter({ has: page.getByText('DV-0001', { exact: true }) });
    return { rows: await row.count(), css_buttons: await row.locator('button').count(),
      role_buttons: await row.getByRole('button').count(), text_buttons: await button(row, '查看详情').count(),
      snapshot: await row.ariaSnapshot(), html: await row.evaluate(value => value.outerHTML) };
  });
}

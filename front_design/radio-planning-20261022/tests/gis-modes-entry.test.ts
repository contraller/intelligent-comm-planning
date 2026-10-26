import { describe, expect, it } from 'vitest';
import { createSSRApp } from 'vue';
import { renderToString } from '@vue/server-renderer';
import GisResourceTree from '../src/components/GisResourceTree.vue';
import { initialResources } from '../src/mocks/resource-presets';
import { gisResourceIndex, projectGisTree } from '../src/services/gis-workspace';

const resources = gisResourceIndex(initialResources());
const classification = { mobility: '', role: '', relay: '' } as const;
const tree = projectGisTree(resources, [], '', '全部', false, 'devices', classification);
const common = { resources, tree, query: '', filter: '全部', selectedId: '', selectedDeviceId: '', selectedLinkId: '', selectedInterferenceId: '', totalNodes: 132, totalDevices: 414, disabled: false };
describe('两种来源共用 GIS 资源目录', () => {
  it('默认设备分类按频段和部署分层，同时保留站点浏览与固定干扰入口', async () => {
    const html = await renderToString(createSSRApp(GisResourceTree, common));
    expect(html).toContain('按设备分类'); expect(html).toContain('按站点浏览');
    expect(html).toContain('固定部署（32 台）'); expect(html).toContain('车载／移动部署（118 台）'); expect(html).toContain('背负／便携部署（24 台）');
    expect(html).toContain('短波设备（174 台）'); expect(html).toContain('超短波设备（240 台）');
    const navigation = html.slice(html.indexOf('aria-label="资源类型"'), html.indexOf('tree-scroll'));
    expect(navigation).toContain('干扰源'); expect(navigation).toContain('规划后链路'); expect(navigation).toContain('候选链路');
    expect(html).not.toContain('终端站');
    expect(html).not.toContain('部署方式未提供');
    expect(html).not.toMatch(/部署（0 台）/);
  });
  // 默认展开仅作用于频段一级，部署子组与其他资源仍按原有默认状态展示。
  it('短波与超短波默认展开，部署子组保持收起', async () => {
    const html = await renderToString(createSSRApp(GisResourceTree, common));
    const tags = [...html.matchAll(/<details\b[^>]*>/g)].map(match => match[0]);
    const frequency = tags.filter(tag => tag.includes('class="device-group"'));
    expect(frequency).toHaveLength(2);
    for (const tag of frequency) expect(tag).toMatch(/\bopen(?:[\s=>])/);
    const deployment = tags.filter(tag => !tag.includes('class='));
    expect(deployment.length).toBeGreaterThan(0);
    for (const tag of deployment) expect(tag).not.toMatch(/\bopen(?:[\s=>])/);
  });
  // 只验证目录展开规则，条目选择与业务事件继续由既有入口回归覆盖。
  it('全部类型的三类资源默认折叠，明确选择类型时展开对应分组', async () => {
    const groupTag = (html: string, id: string) => html.match(new RegExp('<details\\b[^>]*data-group="' + id + '"[^>]*>'))?.[0];
    const html = await renderToString(createSSRApp(GisResourceTree, common));
    for (const id of ['links', 'candidates', 'interferences']) {
      expect(groupTag(html, id)).toBeDefined();
      expect(groupTag(html, id)).not.toMatch(/\bopen(?:[\s=>])/);
      const selected = await renderToString(createSSRApp(GisResourceTree, { ...common, category: id }));
      expect(groupTag(selected, id)).toMatch(/\bopen(?:[\s=>])/);
    }
  });
  it('搜索仅展开有命中的资源组，站点浏览保持普通列表', async () => {
    const query = 'IF-0001';
    const result = projectGisTree(resources, [], query, '全部', false, 'devices', classification);
    const html = await renderToString(createSSRApp(GisResourceTree, { ...common, query, tree: result }));
    expect(html).toMatch(/<details[^>]*data-group="interferences"[^>]*\bopen(?:[\s=>])/);
    expect(html).not.toMatch(/<details[^>]*data-group="links"[^>]*\bopen(?:[\s=>])/);
    const stations = await renderToString(createSSRApp(GisResourceTree, { ...common, browse: 'stations' }));
    expect(stations).toMatch(/<section[^>]*data-group="links"/);
    expect(stations).not.toMatch(/<details[^>]*data-group="(?:links|candidates|interferences)"/);
  });
  it('真实缺失部署方式的设备仍显示未知分组，不伪造固定或车载分类', async () => {
    const missing = initialResources();
    Reflect.deleteProperty(missing.stations[0]!, 'mobility');
    Reflect.set(missing.devices[0]!, 'availability', null);
    const expected = missing.devices.filter(device => device.stationId === missing.stations[0]!.id).length;
    const missingTree = projectGisTree(missing, [], '', '全部', false, 'devices', classification);
    const html = await renderToString(createSSRApp(GisResourceTree, { ...common, resources: missing, tree: missingTree }));
    expect(html).toContain(`部署方式未提供（${expected} 台）`);
    expect(html).not.toContain('部署方式未提供（0 台）');
    expect(html).toContain('上下架未提供');
  });
  it('完整轻目录直接包含末尾设备，不再显示整树分页或设备加载更多', async () => {
    const html = await renderToString(createSSRApp(GisResourceTree, common));
    expect((html.match(/aria-label="选择设备 /g) ?? [])).toHaveLength(resources.devices.length);
    expect(html).toContain('选择设备 DV-0033'); expect(html).toContain('选择设备 DV-0414');
    expect(html).not.toContain('项 · 第'); expect(html).not.toContain('加载更多'); expect(html).not.toContain('，本页');
  });
});

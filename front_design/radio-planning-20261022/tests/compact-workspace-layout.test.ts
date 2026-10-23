import { readFileSync } from 'node:fs';
import { compileStyle, compileTemplate, parse } from '@vue/compiler-sfc';
import { describe, expect, it } from 'vitest';

const pages = ['SituationView', 'KnowledgeView'] as const;
function page(name: typeof pages[number]) {
  const filename = new URL(`../src/views/${name}.vue`, import.meta.url).pathname;
  const source = readFileSync(new URL(`../src/views/${name}.vue`, import.meta.url), 'utf8');
  const parsed = parse(source, { filename });
  const styles = parsed.descriptor.styles.map(style => compileStyle({ source: style.content, filename, id: 'compact-layout', scoped: false }));
  return { filename, source, parsed, styles };
}
// 只核对声明级布局契约，不模拟浏览器排版、像素、滚动或 canvas 绘制。
function declarations(name: typeof pages[number], selector: string, width: number) {
  const values: Record<string, string> = {};
  for (const style of page(name).styles) style.rawResult!.root.walkRules(rule => {
    if (!rule.selectors.includes(selector)) return;
    const parent = rule.parent;
    if (parent && 'params' in parent) {
      const max = /^\(max-width:\s*(\d+)px\)$/.exec(String(parent.params));
      if (!max || width > Number(max[1])) return;
    }
    rule.walkDecls(declaration => { values[declaration.prop] = declaration.value; });
  });
  return values;
}

describe('紧凑工作区 CSS/SFC 布局契约（非浏览器验收）', () => {
  it.each(pages)('%s 样式及模板可编译，新增规则只在600px及以下启用', name => {
    const { filename, parsed, styles } = page(name);
    expect(parsed.errors).toEqual([]);
    for (const style of styles) expect(style.errors).toEqual([]);
    expect(compileTemplate({ source: parsed.descriptor.template!.content, filename, id: 'compact-layout' }).errors).toEqual([]);
    const compact = styles.flatMap(style => style.rawResult!.root.nodes.filter(node => node.type === 'atrule' && node.name === 'media' && node.params === '(max-width: 600px)'));
    expect(compact).toHaveLength(1);
  });

  it.each([320, 390, 600])('%ipx GIS地图独占整行，资源与详情仍有界滚动', width => {
    expect(declarations('SituationView', '.situation-page', width)).toMatchObject({ height: 'auto', 'min-height': '100%' });
    expect(declarations('SituationView', '.situation-main', width)).toMatchObject({ display: 'grid', 'grid-template-columns': 'repeat(2, minmax(0, 1fr))', flex: 'none' });
    expect(declarations('SituationView', '.situation-center', width)).toMatchObject({ 'grid-column': '1 / -1', order: '1', width: '100%', 'min-width': '0' });
    expect(declarations('SituationView', '.map-frame', width)).toMatchObject({ height: '420px', 'min-height': '420px', flex: 'none' });
    for (const selector of ['.situation-left', '.situation-right']) {
      expect(declarations('SituationView', selector, width)).toMatchObject({ 'grid-column': '1 / -1', width: '100%', height: '360px', overflow: 'auto' });
    }
  });

  it('GIS既有折叠状态及窄屏互切仍保留，把手回到正常布局而非遮住手机地图', () => {
    const { source } = page('SituationView');
    expect(source).toContain('v-show="leftOpen"');
    expect(source).toContain('@click="leftOpen = false"');
    expect(source).toContain('@click="showResourcePanel"');
    expect(declarations('SituationView', '.panel-restore', 390)).toMatchObject({ position: 'static', transform: 'none', 'flex-direction': 'row', 'min-height': '36px' });
    expect(declarations('SituationView', '.details-open .situation-left', 390).display).toBe('none');
  });

  it.each([320, 390, 600])('%ipx KG过滤/图谱/详情单列，实际canvas具有独立非零高度', width => {
    expect(declarations('KnowledgeView', '.kg-workspace', width)).toMatchObject({ 'grid-template-columns': 'minmax(0, 1fr)', 'min-height': '0' });
    expect(declarations('KnowledgeView', '.kg-filters', width)).toMatchObject({ 'max-height': '360px', 'overflow-y': 'auto', 'border-right': '0' });
    expect(declarations('KnowledgeView', '.kg-detail', width)).toMatchObject({ 'grid-column': 'auto', 'max-height': 'none', 'overflow-y': 'visible' });
    expect(declarations('KnowledgeView', '.kg-stage > .knowledge-canvas', width)).toMatchObject({ flex: 'none', height: 'auto' });
    expect(declarations('KnowledgeView', '.kg-stage > .knowledge-canvas :deep(.canvas)', width)).toMatchObject({ flex: '0 0 360px', height: '360px', 'min-height': '360px' });
  });

  it.each([601, 960, 1440, 1600])('%ipx不应用新增手机布局，GIS原有横向分栏保持', width => {
    expect(declarations('SituationView', '.situation-page', width).height).toBe('100%');
    expect(declarations('SituationView', '.situation-main', width).display).toBe('flex');
    expect(declarations('SituationView', '.map-frame', width).height).toBeUndefined();
    expect(declarations('SituationView', '.situation-left', width)['flex-basis']).toBe(width <= 1450 ? '300px' : undefined);
    expect(declarations('KnowledgeView', '.kg-workspace', width)['grid-template-columns']).toBe(width <= 950 ? '210px minmax(0, 1fr)' : width <= 1250 ? '225px minmax(0, 1fr) 265px' : '265px minmax(0, 1fr) 310px');
    expect(declarations('KnowledgeView', '.kg-stage > .knowledge-canvas :deep(.canvas)', width)).toEqual({});
  });
});

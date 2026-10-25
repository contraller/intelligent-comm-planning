import { readFileSync } from 'node:fs';
import { compileStyle, compileTemplate, parse } from '@vue/compiler-sfc';
import { describe, expect, it } from 'vitest';

const names = ['DiagnosisView', 'SystemView'] as const;
type Page = typeof names[number];
const pages = new Map(names.map(name => {
  const url = new URL(`../src/views/${name}.vue`, import.meta.url), filename = url.pathname;
  const parsed = parse(readFileSync(url, 'utf8'), { filename });
  const styles = parsed.descriptor.styles.map(style => compileStyle({ source: style.content, filename, id: 'compact-diagnosis-system', scoped: false }));
  return [name, { filename, parsed, styles }] as const;
}));

// Declaration checks only; real layout, clipping and scrolling still require browser evidence.
function declarations(name: Page, selector: string, width: number) {
  const values: Record<string, string> = {};
  for (const style of pages.get(name)!.styles) style.rawResult!.root.walkRules(rule => {
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

describe('compact diagnosis/system CSS and SFC contracts, not browser acceptance', () => {
  it.each(names)('%s template/styles compile and use the approved compact breakpoints', name => {
    const { filename, parsed, styles } = pages.get(name)!;
    expect(parsed.errors).toEqual([]);
    for (const style of styles) expect(style.errors).toEqual([]);
    expect(compileTemplate({ source: parsed.descriptor.template!.content, filename, id: 'compact-diagnosis-system' }).errors).toEqual([]);
    const media = styles.flatMap(style => style.rawResult!.root.nodes.filter(node => node.type === 'atrule' && node.name === 'media'));
    for (const breakpoint of ['(max-width: 760px)', '(max-width: 600px)'])
      expect(media.filter(node => 'params' in node && node.params === breakpoint)).toHaveLength(1);
  });

  it.each([320, 390, 600, 760])('%ipx diagnosis gives the main content a full column and bounds its scene list', width => {
    for (const selector of ['.diagnosis-workspace', '.diagnosis-workspace.result-collapsed'])
      expect(declarations('DiagnosisView', selector, width)).toMatchObject({ 'grid-template-columns': 'minmax(0, 1fr)', 'min-width': '0', flex: 'none' });
    expect(declarations('DiagnosisView', '.diagnosis-page', width)).toMatchObject({ height: 'auto', 'min-height': '0', 'min-width': '0', overflow: 'visible' });
    expect(declarations('DiagnosisView', '.scenario-list', width)).toMatchObject({ 'min-width': '0', 'max-height': width <= 600 ? '220px' : '240px', overflow: 'auto' });
    expect(declarations('DiagnosisView', '.diagnosis-main', width)).toMatchObject({ 'min-width': '0', 'min-height': '0', 'overflow-y': 'visible', 'scrollbar-gutter': 'auto' });
    expect(declarations('DiagnosisView', '.page-heading', width)).toMatchObject({ 'flex-direction': 'column', 'align-items': 'stretch' });
    expect(declarations('DiagnosisView', '.scene-actions', width)['flex-wrap']).toBe('wrap');
  });

  it.each([390, 760])('%ipx diagnosis result/restore remains in normal flow instead of covering the main content', width => {
    expect(declarations('DiagnosisView', '.result-workspace', width)).toMatchObject({ 'grid-column': 'auto', 'max-height': 'none', 'min-width': '0', overflow: 'visible' });
    expect(declarations('DiagnosisView', '.diagnosis-workspace.result-collapsed .result-workspace', width)).toMatchObject({ position: 'static', transform: 'none' });
    expect(declarations('DiagnosisView', '.result-restore', width)).toMatchObject({ width: 'auto', 'min-height': '36px', 'flex-direction': 'row' });
    expect(declarations('DiagnosisView', '.result-restore span', width)).toMatchObject({ 'writing-mode': 'horizontal-tb', 'letter-spacing': '0' });
  });

  it.each([320, 390, 600, 760])('%ipx system moves management navigation above full-width content and keeps internal table scrolling', width => {
    expect(declarations('SystemView', '.split', width)['grid-template-columns']).toBe('minmax(0, 1fr)');
    for (const selector of ['.split > aside', '.split > section'])
      expect(declarations('SystemView', selector, width)).toMatchObject({ 'min-width': '0', 'max-width': '100%' });
    expect(declarations('SystemView', '.side-list', width)).toMatchObject({ display: 'grid', 'grid-template-columns': 'repeat(2, minmax(0, 1fr))' });
    expect(declarations('SystemView', '.side-list button', width)).toMatchObject({ 'min-width': '0', 'white-space': 'normal' });
    expect(declarations('SystemView', '.split > section > .panel-head', width)).toMatchObject({ 'flex-direction': 'column', 'align-items': 'stretch' });
    expect(declarations('SystemView', '.system-table :deep(.p-datatable-table-container)', width)).toMatchObject({ width: '100%', 'max-width': '100%', 'overflow-x': 'auto' });
    for (const [selector, min] of [['.accounts-table', '760px'], ['.roles-table', '650px'], ['.parameters-table', '650px'], ['.logs-table', '900px']])
      expect(declarations('SystemView', `${selector} :deep(.p-datatable-table)`, width)['min-width']).toBe(min);
  });

  it.each([320, 390, 600])('%ipx buttons and filters wrap without collapsing labels into a narrow sidebar', width => {
    expect(declarations('DiagnosisView', '.diagnosis-page .btn', width)).toMatchObject({ 'max-width': '100%', 'white-space': 'normal' });
    expect(declarations('DiagnosisView', '.page-actions', width)).toMatchObject({ width: '100%', 'flex-wrap': 'wrap', 'justify-content': 'flex-start' });
    expect(declarations('SystemView', '.filters', width)).toMatchObject({ display: 'grid', 'grid-template-columns': 'minmax(0, 1fr)' });
    for (const selector of [".filters input:not([type='checkbox'])", '.filters select'])
      expect(declarations('SystemView', selector, width)).toMatchObject({ width: '100%', 'max-width': '100%', 'min-width': '0' });
    expect(declarations('SystemView', '.toolbar .btn', width)).toMatchObject({ 'max-width': '100%', 'white-space': 'normal' });
  });

  it.each([761, 960, 1440, 1600])('%ipx desktop and existing tablet columns remain unchanged', width => {
    const columns = width <= 1100 ? '210px minmax(0, 1fr)' : width <= 1450 ? '210px minmax(360px, 1fr) 310px' : '235px minmax(440px, 1fr) 350px';
    const collapsed = width <= 1100 ? '210px minmax(0, 1fr)' : width <= 1450 ? '210px minmax(360px, 1fr)' : '235px minmax(440px, 1fr)';
    expect(declarations('DiagnosisView', '.diagnosis-workspace', width)['grid-template-columns']).toBe(columns);
    expect(declarations('DiagnosisView', '.diagnosis-workspace.result-collapsed', width)['grid-template-columns']).toBe(collapsed);
    expect(declarations('DiagnosisView', '.diagnosis-main', width)['min-height']).toBe(width <= 1100 ? '650px' : '0');
    expect(declarations('DiagnosisView', '.diagnosis-workspace.result-collapsed .result-workspace', width).position).toBe('absolute');
    expect(declarations('DiagnosisView', '.result-restore span', width)['writing-mode']).toBe('vertical-rl');
    expect(declarations('SystemView', '.split', width)['grid-template-columns']).toBe('210px minmax(0, 1fr)');
    expect(declarations('SystemView', '.side-list', width)).toEqual({});
    expect(declarations('SystemView', '.toolbar .btn', width)).toEqual({});
  });

  it('601px does not enable phone-only filter or button rules', () => {
    expect(declarations('SystemView', '.filters', 601).display).toBeUndefined();
    expect(declarations('SystemView', '.filters select', 601)).toEqual({});
    expect(declarations('DiagnosisView', '.diagnosis-page .btn', 601)).toEqual({});
  });
});

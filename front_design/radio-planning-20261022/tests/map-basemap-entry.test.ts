import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

// 模板边界回归与浏览器实际渲染检查分别记录。
describe('新版页面地形与道路入口', () => {
  it.each(['views/PlanningApiView.vue', 'components/DiagnosisNetworkPanel.vue'])('%s 不默认覆盖道路层', path => {
    const source = readFileSync('src/' + path, 'utf8');
    expect(source).toContain(':show-roads="false"');
    expect(source).toContain(':terrain-basemap=');
  });
  it('GIS 道路默认关闭、仍可由原图层开关选择', () => {
    const source = readFileSync('src/views/SituationView.vue', 'utf8');
    expect(source).toMatch(/roads\s*=\s*ref\(false\)/);
    expect(source).toContain(':show-roads="roads"');
    expect(source).toContain("gis.scene.network.state !== 'ready' ? null");
  });
  it('公共地图限制道路可见边界并消除重复视口事件', () => {
    const source = readFileSync('src/components/MapCanvas.vue', 'utf8');
    expect(source).toContain("roads.on('change:extent'");expect(source).toContain('updateRoadClip()');
    expect(source).toContain('lastViewportKey');expect(source).toContain('unByKey(roadClipListener)');
  });
});

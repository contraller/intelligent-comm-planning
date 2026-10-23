import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
const view = readFileSync(new URL('../src/views/SituationView.vue', import.meta.url), 'utf8');
const map = readFileSync(new URL('../src/components/MapCanvas.vue', import.meta.url), 'utf8');
describe('冻结GIS宿主边界', () => {
  it('目录明确HTTP入口，与当前资源编辑视图分开', () => {
    expect(view).toContain('httpMode && auth.can(\'planning.view\')');
    expect(view).toContain('<GisFrozenPlanPanel v-if="frozenView"'); expect(view).toContain('<template v-if="!frozenView">');
    expect(view).toContain('resources.workspace.edit'); expect(view).toContain('await configurationAction(() => gis.leave())');
  });
  it('冻结点线单独事件不映射当前资源详情', () => {
    expect(map).toContain("emit('selectFrozenNode', id)"); expect(map).toContain("emit('selectFrozenLink', id)");
    expect(map).toContain("feature.get('snapshot') !== props.frozenNetwork?.identity.snapshot_id");
  });
});

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
  it('任务内方案入口沿用冻结网络及离开保护，不直接加载参与节点冒充结果', () => {
    expect(view).toContain('@open-plan="openTaskPlan"');
    expect(view).toContain('target.taskId !== task.taskId');
    expect(view).toContain('await toggleFrozenPlans()');
    expect(view).toContain('await frozenPanel.value?.openIdentity(target)');
    expect(view).toContain("previewService.getPlanningPlan({ ...input, context: 'planning' })");
  });
});

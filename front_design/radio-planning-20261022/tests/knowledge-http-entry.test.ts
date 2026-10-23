import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
const view = readFileSync(new URL('../src/views/KnowledgeView.vue', import.meta.url), 'utf8');

// 仅校验正式页面入口边界，不替代后端权限、图谱发布或浏览器测试。
describe('SR6正式页面动作边界', () => {
  it('HTTP身份不显示未实现的物理重置，不以本地身份当作教学开关', () => {
    expect(view).toContain("env.mode === 'mock' && env.sampleData");
    expect(view).toContain('v-if="demoResetEnabled && auth.can(\'knowledge.reset\')"');
    expect(view).not.toContain("knowledge.reset') && !auth.identity?.integrationMode");
  });
  it('保留知识新增、版本回看与回滚入口', () => {
    expect(view).toContain("auth.can('knowledge.edit')");
    expect(view).toContain("auth.can('knowledge.rollback')");
    expect(view).toContain('<KnowledgeVersionDrawer');
  });
});

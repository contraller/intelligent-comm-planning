import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
const view = readFileSync(new URL('../src/views/DiagnosisView.vue', import.meta.url), 'utf8');
describe('SR5正式身份页面入口', () => {
  it('知识反馈依权限和诊断就绪，不排除非联调身份', () => {
    const button = view.match(/<button[^>]+@click="feedbackDrawer=true"[^>]*>/)?.[0];
    expect(button).toContain("auth.can('knowledge.edit')"); expect(button).toContain('diagnosis.view?.diagnosisReady');
    expect(button).not.toContain('integrationMode'); expect(button).toContain(':disabled="diagnosis.locked"');
  });
  it('演示重置必须明确许可，不能在正式工作流暴露物理清空入口', () => {
    expect(view).toContain('v-if="diagnosis.demoEnabled && auth.can(\'diagnosis.reset\')"');
  });
});

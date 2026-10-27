import { afterEach, describe, expect, it, vi } from 'vitest';
import { createSSRApp, h } from 'vue';
import { renderToString } from '@vue/server-renderer';
import { createMemoryHistory, createRouter } from 'vue-router';
import { disposePinia } from 'pinia';
import PlanningApiView from '../src/views/PlanningApiView.vue';
import { usePlanningApiStore } from '../src/stores/planning-api';
import { apiJob, apiPlan, storeFixture } from './fixtures/planning-api';

vi.mock('vue-router', async original => {
  const module = await original<typeof import('vue-router')>();
  return { ...module, createWebHashHistory: module.createMemoryHistory };
});
// 保留真实页面、进度组件与状态层，仅隔离与进度无关的重型展示。
vi.mock('../src/components/MapCanvas.vue', () => ({ default: { render: () => null } }));
vi.mock('../src/components/ResourceReadStatus.vue', () => ({ default: { render: () => null } }));
vi.mock('../src/components/TaskApiPanel.vue', () => ({ default: { render: () => null } }));
vi.mock('../src/components/PlanningApiResultPanel.vue', () => ({ default: { render: () => null } }));
vi.mock('../src/components/PlanningApiVersionsPanel.vue', () => ({ default: { render: () => null } }));
vi.mock('../src/components/AppDrawer.vue', () => ({ default: { render: () => null } }));
vi.mock('../src/components/FrozenCoveragePanel.vue', () => ({ default: { render: () => null } }));
vi.mock('../src/components/PlanningHistoryDrawer.vue', () => ({ default: { render: () => null } }));

const fixtures: Awaited<ReturnType<typeof storeFixture>>[] = [];
afterEach(() => {
  for (const fixture of fixtures.splice(0)) {
    usePlanningApiStore(fixture.pinia).clearForSession();
    fixture.task.clearForSession();
    disposePinia(fixture.pinia);
  }
  vi.restoreAllMocks();
});

describe('规划页面的运行进度可见性', () => {
  it.each(['PENDING', 'RUNNING'] as const)('已有保存方案时，%s 新作业仍展示真实百分比和阶段', async state => {
    const fixture = await storeFixture(); fixtures.push(fixture);
    const planning = usePlanningApiStore(fixture.pinia);
    planning.selectedPlan = apiPlan();
    planning.job = { ...apiJob(), state, progress: 37, result: null, outcome: null,
      phases: [{ name: '任务与资源加载', state: 'done' }, { name: '电台部署', state: 'running' }, { name: '路由与频率规划', state: 'waiting' }] };
    planning.step = 2;
    const router = createRouter({ history: createMemoryHistory(), routes: [{ path: '/planning', component: { render: () => null } }] });
    await router.push('/planning');
    const html = await renderToString(createSSRApp({ render: () => h(PlanningApiView) }).use(fixture.pinia).use(router));
    expect(planning.selectedPlan?.id).toBe('P-1');
    expect(html).toContain('规划进度与阶段');
    expect(html).toContain('aria-label="规划任务进度"');
    expect(html).toContain('value="37"');
    expect(html).toContain('任务与资源加载'); expect(html).toContain('电台部署'); expect(html).toContain('路由与频率规划');
    expect(html).toContain(state === 'RUNNING' ? '规划进行中' : '等待开始');
  });
});

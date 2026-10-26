import { afterEach, expect, it, vi } from 'vitest';
import { createSSRApp, h } from 'vue';
import { renderToString } from '@vue/server-renderer';
import { createMemoryHistory, createRouter, RouterView } from 'vue-router';
import { disposePinia } from 'pinia';
import PrimeVue from 'primevue/config';
import PlanningPage from '../src/views/PlanningApiView.vue';
import { usePlanningApiStore } from '../src/stores/planning-api';
import { storeFixture, apiJob } from './fixtures/planning-api';

const mode = vi.hoisted(() => ({ value: 'mock' }));
vi.mock('../src/config/env', async original => ({ ...await original<object>(), env: { get mode() { return mode.value; }, apiBaseUrl: '/api/v1' } }));
afterEach(() => { vi.restoreAllMocks(); });

// 同一份业务响应经过同一页面模板，来源切换不能改变表单、结果和操作入口。
it('Mock 与 HTTP 绑定相同数据时渲染相同规划页面', async () => {
  const outputs: string[] = [];
  for (const source of ['mock', 'http']) {
    mode.value = source;
    const state = await storeFixture(), planning = usePlanningApiStore(state.pinia);
    planning.job = apiJob(); planning.step = 2;
    const router = createRouter({ history: createMemoryHistory(), routes: [{ path: '/planning', component: PlanningPage }] });
    await router.push('/planning?taskId=T1');
    const app = createSSRApp({ render: () => h(RouterView) }).use(state.pinia).use(router).use(PrimeVue, { unstyled: true });
    outputs.push(await renderToString(app));
    planning.clearForSession(); state.task.clearForSession(); disposePinia(state.pinia);
  }
  expect(outputs[0]).toBe(outputs[1]);
  for (const label of ['任务与约束输入', '规划计算与结果', '方案调整与对比', '规划历史', '查看完整配置']) expect(outputs[0]).toContain(label);
  expect(outputs[0]).not.toContain('接口任务与方案');
});

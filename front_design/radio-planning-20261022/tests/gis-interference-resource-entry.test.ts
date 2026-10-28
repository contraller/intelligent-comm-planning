import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as Vue from 'vue';
import { computed, defineComponent, nextTick, reactive, ref, type App } from 'vue';
import { compileTemplate, parse } from 'vue/compiler-sfc';
import * as ts from 'typescript';
import InterferenceSourceDrawer from '../src/components/InterferenceSourceDrawer.vue';
import { initialInterferences } from '../src/mocks/resource-presets';
import { all, clientTemplate, find, node, renderer, textOf, type HostNode } from './helpers/vue-client';

const stores = vi.hoisted(() => ({ editor: undefined as unknown, gis: undefined as unknown }));
vi.mock('../src/stores/resource-edit', () => ({ useResourceEditStore: () => stores.editor }));
vi.mock('../src/stores/gis-workspace', () => ({ useGisWorkspaceStore: () => stores.gis }));
// 仅替换弹层外壳，实际详情、编辑按钮及表单模板继续运行。
vi.mock('../src/components/AppDrawer.vue', async () => {
  const { defineComponent, h } = await import('vue');
  return { default: defineComponent({ props: ['visible', 'title'], setup: (props, { slots }) => () =>
    props.visible ? h('section', { 'data-drawer-title': props.title }, [slots.default?.(), slots.footer?.()]) : null,
  }) };
});

const filename = 'src/views/SituationView.vue';
const source = readFileSync(filename, 'utf8');
const descriptor = parse(source, { filename }).descriptor;
const script = ts.createSourceFile(filename + '.ts', descriptor.scriptSetup!.content, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
function declaration(name: string) {
  for (const statement of script.statements) {
    if (ts.isFunctionDeclaration(statement) && statement.name?.text === name) return statement.getText(script);
    if (ts.isVariableStatement(statement)) {
      const entry = statement.declarationList.declarations.find(row => ts.isIdentifier(row.name) && row.name.text === name);
      if (entry?.initializer) return `const ${name} = ${entry.initializer.getText(script)};`;
    }
  }
  throw new Error('未找到实际入口声明：' + name);
}
// 直接执行生产声明与实际模板片段，不另写一份入口判断，也不启动整个地图或轮询。
const logic = ts.transpileModule(declaration('canOpenInterferenceParameters') + '\n' + declaration('openSelectedInterferenceParameters'), {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
}).outputText;
const buttonTemplate = descriptor.template!.content.match(/<button\b(?=[^>]*data-testid="gis-resource-interference-parameters")[\s\S]*?<\/button\s*>/)?.[0];
const drawerTemplate = descriptor.template!.content.match(/<InterferenceSourceDrawer\b[\s\S]*?\/>/)?.[0];
if (!buttonTemplate || !drawerTemplate) throw new Error('未找到实际参数入口或原抽屉接线');
const compiled = compileTemplate({ source: buttonTemplate + drawerTemplate, filename, id: 'interference-entry', compilerOptions: { mode: 'function' } });
if (compiled.errors.length) throw new Error(compiled.errors.map(String).join('\n'));
const render = new Function('Vue', compiled.code)(Vue);
await clientTemplate(InterferenceSourceDrawer, 'src/components/InterferenceSourceDrawer.vue', 'interference-source-render.ts');

let app: App<HostNode> | undefined;
afterEach(() => { app?.unmount(); app = undefined; vi.restoreAllMocks(); vi.unstubAllGlobals(); });

async function mountEntry() {
  vi.stubGlobal('document', { activeElement: null });
  const selectedInterference = ref(initialInterferences()[0]);
  expect(selectedInterference.value?.id).toBeTruthy();
  const selectedInterferenceId = ref(selectedInterference.value.id), interferenceOpen = ref(false);
  const permissions = reactive(new Set(['situation.view']));
  const auth = reactive({ generation: 1, blocked: false, can: (permission: string) => permissions.has(permission) });
  const frozenView = ref(false), taskViewing = ref(false), diagnosisMode = ref(false), monitorMode = ref(false);
  const fault = { active: ref(false) }, gis = reactive({ mapMode: 'resource', saveState: 'idle', busy: false });
  const workspace = reactive({ read: { frozen: false, workspace: { revision: 'R1' } } });
  const editor = reactive({ context: null as string | null, canEdit: false, busy: false, picking: false,
    form: null as null | { kind: string; id: string; fields: Record<string, string> },
    error: '', issues: [], message: '', issueFocus: null, pickNotice: '', portsEditing: false,
    closeForm: vi.fn(async (): Promise<boolean> => { editor.form = null; return true; }),
    openForm: vi.fn(async (kind: string, id: string): Promise<boolean> => {
      editor.form = { kind, id, fields: { name: selectedInterference.value.name } }; return true;
    }),
  });
  const configurationAction = vi.fn(async (action: () => unknown | Promise<unknown>) => (await action()) !== false);
  const bindings = { computed, auth, frozenView, fault, taskViewing, diagnosisMode, monitorMode, gis,
    workspace, editor, selectedInterference, selectedInterferenceId, interferenceOpen, configurationAction };
  const entry = new Function(...Object.keys(bindings), logic + '\nreturn { canOpenInterferenceParameters, openSelectedInterferenceParameters };')(...Object.values(bindings)) as {
    canOpenInterferenceParameters: Vue.ComputedRef<boolean>; openSelectedInterferenceParameters: () => Promise<boolean>;
  };
  stores.editor = editor; stores.gis = gis;
  app = renderer.createApp(defineComponent({ components: { InterferenceSourceDrawer }, setup: () => ({ ...bindings, ...entry }), render }));
  // 实际 SFC 的模块登记需要上下文，保持与其他客户端内存宿主一致。
  app.provide(Vue.ssrContextKey, {});
  const root = node('root'); app.mount(root); await nextTick();
  return { ...bindings, ...entry, permissions, root,
    button: () => find(root, row => row.props['data-testid'] === 'gis-resource-interference-parameters'),
  };
}

async function click(target: HostNode) {
  expect(target.props.disabled).not.toBe(true);
  await (target.props.onClick as () => unknown)(); await nextTick();
}

describe('GIS 已选干扰源参数入口', () => {
  it('真实表单标明增益必填、合法空值来源，并按方向图控制方位角', async () => {
    const f = await mountEntry(); f.editor.context = 'gis'; f.editor.canEdit = true;
    f.editor.form = { kind: 'interference', id: f.selectedInterferenceId.value,
      fields: { name: '手工源', antennaGainDbi: '', patternType: 'OMNI', azimuthDeg: '' } };
    await nextTick();
    expect(find(f.root, row => row.props.id === 'interference-antennaGainDbi')?.props.required).toBe(true);
    expect(textOf(f.root)).toContain('系统没有可代用的统一默认增益');
    expect(textOf(f.root)).toContain('资源高程不参与当前传播计算');
    expect(textOf(f.root)).toContain('占空比按连续发射 1');
    expect(find(f.root, row => row.props.id === 'interference-azimuthDeg')?.props.disabled).toBe(true);
    f.editor.form.fields.patternType = 'DIRECTIONAL'; await nextTick();
    const azimuth = find(f.root, row => row.props.id === 'interference-azimuthDeg');
    expect(azimuth?.props.required).toBe(true); expect(azimuth?.props.disabled).toBe(false);
  });

  it('历史缺增益详情指向编辑，不把缺失值展示为零', async () => {
    const f = await mountEntry(); f.selectedInterference.value.antennaGainDbi = null;
    await click(f.button()!);
    expect(textOf(f.root)).toContain('此历史干扰源缺少天线增益');
    expect(textOf(f.root)).toContain('请编辑资源补充有效增益');
  });

  it('普通资源模式可查看同一原源，只读权限不出现编辑参数', async () => {
    const f = await mountEntry(); expect(textOf(f.button()!)).toBe('查看/编辑参数');
    await click(f.button()!);
    const drawer = find(f.root, row => row.props['data-drawer-title'] === '干扰源详情');
    expect(drawer).toBeDefined(); expect(textOf(drawer!)).toContain(f.selectedInterferenceId.value);
    expect(textOf(drawer!)).toContain(f.selectedInterference.value.name);
    expect(textOf(drawer!)).not.toContain('编辑参数');
    expect(f.configurationAction).toHaveBeenCalledTimes(1); expect(f.editor.closeForm).toHaveBeenCalledTimes(1);
    expect(f.editor.openForm).not.toHaveBeenCalled();
  });

  it('已进入 GIS 编辑时复用原编辑按钮，保持源 ID 并展示原字段', async () => {
    const f = await mountEntry(); f.editor.context = 'gis'; f.editor.canEdit = true;
    await click(f.button()!);
    const edit = all(f.root, row => row.tag === 'button' && textOf(row) === '编辑参数');
    expect(edit).toHaveLength(1); await click(edit[0]!);
    expect(f.editor.openForm).toHaveBeenCalledWith('interference', f.selectedInterferenceId.value);
    expect(find(f.root, row => row.props['data-drawer-title'] === '编辑干扰源')).toBeDefined();
    // v-model 将值写到实际输入元素，不写入虚拟节点的 value 属性。
    expect(find(f.root, row => row.props.id === 'interference-name')?.value).toBe(f.selectedInterference.value.name);
  });

  it('GIS 上下文无原编辑权限时仍只能查看', async () => {
    const f = await mountEntry(); f.editor.context = 'gis'; await click(f.button()!);
    const edit = find(f.root, row => row.tag === 'button' && textOf(row) === '编辑参数');
    expect(edit?.props.disabled).toBe(true); expect(f.editor.openForm).not.toHaveBeenCalled();
  });

  it.each(['frozen', 'readFrozen', 'planning', 'task', 'diagnosis', 'monitor', 'fault', 'blocked', 'denied', 'missing'])(
    '%s 视图或会话不开放入口，旧回调也不能打开', async mode => {
      const f = await mountEntry(), callback = f.openSelectedInterferenceParameters;
      if (mode === 'frozen') f.frozenView.value = true;
      if (mode === 'readFrozen') f.workspace.read.frozen = true;
      if (mode === 'planning') f.gis.mapMode = 'planning';
      if (mode === 'task') f.taskViewing.value = true;
      if (mode === 'diagnosis') f.diagnosisMode.value = true;
      if (mode === 'monitor') f.monitorMode.value = true;
      if (mode === 'fault') f.fault.active.value = true;
      if (mode === 'blocked') f.auth.blocked = true;
      if (mode === 'denied') f.permissions.clear();
      if (mode === 'missing') f.selectedInterference.value = undefined as never;
      await nextTick(); expect(f.button()).toBeUndefined(); expect(await callback()).toBe(false);
      expect(f.interferenceOpen.value).toBe(false); expect(f.editor.closeForm).not.toHaveBeenCalled();
    },
  );

  it.each(['busy', 'picking'] as const)('%s 时禁用入口并拒绝旧回调', async flag => {
    const f = await mountEntry(); f.editor[flag] = true; await nextTick();
    expect(f.button()?.props.disabled).toBe(true); expect(await f.openSelectedInterferenceParameters()).toBe(false);
    expect(f.editor.closeForm).not.toHaveBeenCalled(); expect(f.interferenceOpen.value).toBe(false);
  });

  it('原配置离开保护拒绝时不关闭表单、不打开抽屉', async () => {
    const f = await mountEntry(); f.configurationAction.mockResolvedValueOnce(false);
    expect(await f.openSelectedInterferenceParameters()).toBe(false);
    expect(f.editor.closeForm).not.toHaveBeenCalled(); expect(f.interferenceOpen.value).toBe(false);
  });

  it('原表单有未提交输入且用户取消离开时保留输入', async () => {
    const f = await mountEntry(); const form = { kind: 'device', id: 'EXISTING', fields: { name: '待保留输入' } };
    f.editor.form = form; f.editor.closeForm.mockResolvedValueOnce(false);
    expect(await f.openSelectedInterferenceParameters()).toBe(false);
    expect(f.editor.form).toEqual(form); expect(f.interferenceOpen.value).toBe(false);
  });

  it.each(['session', 'selection', 'revision', 'frozen', 'permission'])(
    '等待离开决定后 %s 改变时不打开迟到详情', async change => {
      const f = await mountEntry(); let finish!: (value: boolean) => void;
      f.editor.closeForm.mockImplementationOnce(() => new Promise<boolean>(resolve => { finish = resolve; }));
      const opening = f.openSelectedInterferenceParameters(); await nextTick();
      if (change === 'session') f.auth.generation++;
      if (change === 'selection') f.selectedInterferenceId.value = 'ANOTHER';
      if (change === 'revision') f.workspace.read.workspace.revision = 'R2';
      if (change === 'frozen') f.frozenView.value = true;
      if (change === 'permission') f.permissions.clear();
      finish(true); expect(await opening).toBe(false); expect(f.interferenceOpen.value).toBe(false);
    },
  );
});

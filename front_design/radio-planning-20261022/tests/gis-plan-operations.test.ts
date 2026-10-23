import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
const component = readFileSync(
  new URL('../src/components/GisPlanOperations.vue', import.meta.url),
  'utf8',
);
const host = readFileSync(
  new URL('../src/components/GisFrozenPlanPanel.vue', import.meta.url),
  'utf8',
);
const situation = readFileSync(new URL('../src/views/SituationView.vue', import.meta.url), 'utf8');
const legacyMonitoring = readFileSync(
  new URL('../src/components/SituationMonitoringDrawer.vue', import.meta.url),
  'utf8',
);
const map = readFileSync(new URL('../src/components/MapCanvas.vue', import.meta.url), 'utf8');
// 静态接线门禁不替代子组实际组件、共享类型或真实页面验收。
describe('GIS跨组宿主静态边界', () => {
  it('只消费冻结网络和P06读取投影，不造监控帧或状态', () => {
    expect(component).toContain(':frozen-network="network"');
    expect(component).toContain(
      'status.project(device.id, props.network.identity.resource_revision)',
    );
    expect(component).not.toContain('loadMonitoringContext');
    expect(component).not.toContain('loadMonitoringFrame');
    expect(component).toContain('if (value) result[device.id] = value');
  });
  it('历史版本和专项权限共同限制写入，不借宽资源权限', () => {
    expect(component).toContain(':allow-import="sameResource && canImportStatus"');
    expect(component).toContain("can('resources.device.status.import')");
    expect(component).toContain("can('resources.device.edit')");
    expect(component).not.toContain("can('resources.edit')");
  });
  it('未核实写入/脏频谱保护贯穿方案切换和离页', () => {
    expect(component).toMatch(
      /configurationVisible\.value\s*&&\s*\(config\.pending\s*\|\|\s*config\.busy\)/,
    );
    expect(component).toMatch(/auth\.registerLeave\(\s*requestLeave/);
    expect(host).toContain('if (await requestLeave()) await model.openPlan(row)');
    expect(host).toContain('if (await requestLeave()) model.closeNetwork()');
    expect(situation).toContain('await frozenPanel.value.requestLeave()');
  });
  it('HTTP禁用旧自动观测宿主，频谱显式进入后挂载', () => {
    expect(situation).toContain('<SituationMonitoringDrawer v-if="!httpMode');
    expect(situation).toContain("() => !httpMode && auth.can('situation.view')");
    expect(component).toMatch(/<SpectrumMonitoringPanel\s+v-if="tab === 'spectrum'"/);
  });
  it('状态原始输入和配置抽屉接最终离开保护，未知提交不静默关闭', () => {
    expect(component).toContain('statusPanel.value.requestLeave()');
    expect(component).toContain('configurationPanel.value.requestLeave()');
    expect(component).toContain('@dirty="statusDirty = $event"');
    expect(component).toContain(':resource-revision="network.identity.resource_revision"');
    expect(situation).toContain('httpConfigurationPanel.value.requestLeave()');
  });
  it('干扰使用原始冻结投影和真实版本，采纳结果只有成功才可打开', () => {
    expect(component).toContain(':source-editable="false"');
    expect(component).toContain(':interference-projection="analysis.mapProjection"');
    expect(component).toContain("row.state === 'SUCCESS'");
    expect(component).not.toContain("planVersion: 'V1'");
    expect(situation).toContain('frozenPanel.value?.openIdentity({ taskId, planId })');
    expect(situation).not.toContain('analysis.selected.run.network');
  });
  it('频谱只接显式成员引用，查看历史引用使用P06真实查询且可取消', () => {
    expect(component).toContain(':device-status-ref="observationStatusRef"');
    expect(component).toContain('@select-status-ref="viewObservationStatus"');
    expect(component).toContain('@select-dataset="cancelStatusRefRead"');
    expect(component).toContain('v-model="statusRefMembers"');
    expect(component).toContain('status.select(header)');
    expect(component).toMatch(/readObservationStatusHeader\(\s*props\.services\.deviceStatuses/);
    expect(component).not.toContain('deviceIds: props.network.devices.map');
  });
  it('按下来源用原生捕获和对称释放，故障快照仍保留真实站点转换', () => {
    expect(map).not.toContain("map.on('pointerdown'");
    expect(map).toContain("addEventListener('pointerdown', captureReadPress, true)");
    expect(map).toContain("removeEventListener('pointerdown', captureReadPress, true)");
    expect(situation).toContain("import { planStations } from '../services/planning-snapshot'");
    expect(situation).toContain('planStations(fault.network.value)');
  });
  it('独立分析保留显示控件，地图回调捕获投影身份，冻结入口可返回规划', () => {
    for (const label of [
      '显示干扰分析影响区域',
      '干扰分析影响区域透明度',
      '显示规划后链路',
      '拓扑透明度',
    ])
      expect(component).toContain(`aria-label="${label}"`);
    expect(component).toContain('@select-frozen-link="mapSelection.link"');
    expect(component).toContain('guardedAnalysisMapSelection(');
    expect(situation).toContain('v-if="frozenView && analysisReturn"');
  });
  it('刷新保护保留本地输入，明确保留原号关闭后不永远封锁离页', () => {
    expect(component).toContain("window.addEventListener('beforeunload', beforeUnload)");
    expect(component).toContain("window.removeEventListener('beforeunload', beforeUnload)");
    expect(component).toContain('auth.registerLeave(requestLeave, hasPending)');
    expect(situation).toContain('additionalPending: () => httpMode');
  });
  it('旧监控包装不再裸挂需要HTTP服务的新组件，也不创建第二个客户端', () => {
    expect(legacyMonitoring).not.toContain('<SpectrumMonitoringPanel v-else />');
    expect(legacyMonitoring).toContain('v-else-if="observations"');
    expect(legacyMonitoring).toContain(':services="observations.services"');
    expect(legacyMonitoring).not.toContain('createHttpClient');
  });
});

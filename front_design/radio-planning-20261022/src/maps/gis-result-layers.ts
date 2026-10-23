import type { MapRegion } from '../types/domain';

// GIS 显示配置独立于业务结果，不向接口或保存快照增加字段。
export type GisResultLayerId = 'coverage' | 'interference' | 'illustration' | 'diagnosis';
export interface GisResultLayerSetting { visible: boolean; opacity: number }
export type GisResultLayerSettings = Record<GisResultLayerId, GisResultLayerSetting>;
export interface GisResultLayerRow extends GisResultLayerSetting {
  id: GisResultLayerId; label: string; hint: string; available: boolean; reason: string;
}
export interface GisResultLayerContext {
  mode: 'resource' | 'analysis' | 'monitoring' | 'diagnosis';
  readable: boolean;
  paused: boolean;
  regions: readonly MapRegion[];
  deviceMode: boolean;
  deviceCoverageAvailable: boolean;
  interferenceAvailable: boolean;
  interferenceFilteredOut: boolean;
  // 同一对象 ID 可出现在不同冻结报告，代次用于隔离旧控件事件。
  contextId?: string | number;
  diagnosisAvailable?: boolean;
  diagnosisFilteredOut?: boolean;
}
export const GIS_RESULT_LAYERS: { id: GisResultLayerId; label: string; hint: string }[] = [
  { id: 'coverage', label: '信号覆盖', hint: '覆盖、对应盲区和未计算区域一起显示。' },
  { id: 'interference', label: '干扰分析影响区域', hint: '控制区域面，受扰对象高亮和统计保留。' },
  { id: 'illustration', label: '原有影响示意区域', hint: '当前快照已有示意，不代表本次诊断结果。' },
  { id: 'diagnosis', label: '诊断影响区域', hint: '控制所选完整报告的区域面，场景注入、对象高亮和统计保留。' },
];
export function defaultGisResultLayers(): GisResultLayerSettings {
  return { coverage: { visible: true, opacity: 0.8 }, interference: { visible: true, opacity: 0.8 }, illustration: { visible: true, opacity: 0.8 }, diagnosis: { visible: true, opacity: 0.8 } };
}
export function splitGisRegions(regions: readonly MapRegion[]) {
  // 只依据明确 kind 分类，不从名称、位置或图形推测故障/干扰来源。
  return {
    coverage: regions.filter(row => ['coverage', 'blind', 'uncalculated'].includes(row.kind)),
    illustration: regions.filter(row => row.kind === 'impact'),
  };
}
export function gisResultLayerRows(context: GisResultLayerContext, settings: GisResultLayerSettings): GisResultLayerRow[] {
  const groups = splitGisRegions(context.regions);
  const blocked = !context.readable ? '当前没有 GIS 查看权限。'
    : context.mode === 'monitoring' ? '监控网络不提供此类区域。'
      : context.mode === 'resource' && context.paused ? '资源已有修改，旧区域暂停显示。' : '';
  return GIS_RESULT_LAYERS.map(item => {
    let reason = blocked, available = false;
    if (!blocked) {
      if (item.id === 'diagnosis') {
        available = context.mode === 'diagnosis' && !!context.diagnosisAvailable;
        reason = context.mode !== 'diagnosis' ? '进入诊断快照后查看完整报告的影响区域。'
          : !available ? '当前诊断报告未提供影响区域。'
            : context.diagnosisFilteredOut ? '当前等级筛选未显示诊断影响区域。' : '';
      } else if (context.mode === 'diagnosis') {
        // 独立诊断快照不叠加资源、教学覆盖或干扰分析的其他上下文结果。
        reason = '诊断快照仅显示该报告的诊断影响区域。';
      } else if (item.id === 'coverage') {
        available = context.mode === 'resource' && context.deviceMode ? context.deviceCoverageAvailable : groups.coverage.length > 0;
        if (!available) reason = context.mode === 'resource' && context.deviceMode ? '所选设备暂无可显示的覆盖结果。' : '当前快照未提供覆盖区域。';
      } else if (item.id === 'illustration') {
        available = groups.illustration.length > 0;
        if (!available) reason = '当前快照未提供原有影响示意区域。';
      } else {
        available = context.mode === 'analysis' && context.interferenceAvailable;
        reason = context.mode !== 'analysis' ? '进入干扰分析地图后查看已有结果。'
          : !available ? '当前分析未提供影响区域。'
            : context.interferenceFilteredOut ? '当前等级筛选未显示影响区域。' : '';
      }
    }
    return { ...item, ...settings[item.id], available, reason };
  });
}

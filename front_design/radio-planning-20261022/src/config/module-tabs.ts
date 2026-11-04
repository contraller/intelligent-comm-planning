/** Stable public tab values used by individual module links. */
export const moduleTabValues = {
  // 保留旧资源深链，路由层将三个频谱值迁移到独立频谱页面。
  resources: ['ledger', 'frequencies', 'spectrum-config', 'spectrum-monitor'],
  spectrum: ['frequencies', 'spectrum-config', 'spectrum-monitor'],
  knowledge: ['browse', 'changes', 'versions'],
  system: ['accounts', 'roles', 'logs', 'parameters'],
} as const;
export type TabbedModule = keyof typeof moduleTabValues;
export function isModuleTab<M extends TabbedModule>(module: M, value: unknown): value is typeof moduleTabValues[M][number] {
  return typeof value === 'string' && (moduleTabValues[module] as readonly string[]).includes(value);
}
export const resourceTabLabels = {
  ledger: '设备台账', frequencies: '规划频点', 'spectrum-config': '频谱接口配置', 'spectrum-monitor': '频谱观测',
} as const;
export function resourceTabLabel(value: unknown): string {
  return isModuleTab('resources', value) ? resourceTabLabels[value] : resourceTabLabels.ledger;
}
export function spectrumTabLabel(value: unknown): string {
  return isModuleTab('spectrum', value) ? resourceTabLabels[value] : resourceTabLabels.frequencies;
}

/** Compatibility labels for resource URLs retained before the spectrum route split. */
export function resourceEmbeddedTitle(value: unknown): string {
  const label = resourceTabLabel(value);
  if (label === '设备台账') return '短波／超短波设备';
  return label === '频谱接口配置' ? '频谱接口管理' : label;
}

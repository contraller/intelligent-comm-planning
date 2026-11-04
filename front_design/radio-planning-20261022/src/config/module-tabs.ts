/** Stable public tab values used by individual module links. */
export const moduleTabValues = {
  resources: ['ledger', 'frequencies', 'spectrum-config', 'spectrum-monitor'],
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

/** The host owns navigation; a resource embed presents the selected function alone. */
export function resourceEmbeddedTitle(value: unknown): string {
  const label = resourceTabLabel(value);
  if (label === '设备台账') return '短波／超短波设备';
  return label === '频谱接口配置' ? '频谱接口管理' : label;
}

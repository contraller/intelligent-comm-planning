// 仅供设备信息展示，不写入资源、知识版本或业务结果快照。
export type DeviceKnowledgeSummaryStatus = 'forbidden' | 'workspace-error' | 'loading' | 'error' | 'ready';
export type SummaryRelationType = 'hasComponent' | 'hasInterface' | 'hasFunction';
export interface SummaryRoot {
  entityId: string; name: string; description: string; entitySource: string;
}
export interface SummaryBinding {
  rootId: string; rootName: string; rootSource: string;
  relationId: string; relationType: SummaryRelationType; relationSource: string;
}
export interface SummaryItem {
  entityId: string; name: string; description: string; entitySource: string; bindings: SummaryBinding[];
}
export interface DeviceModelKnowledgeSummary {
  modelId: string; versionId: string; roots: SummaryRoot[];
  components: SummaryItem[]; interfaces: SummaryItem[]; functions: SummaryItem[];
}

import type { KnowledgeData, NetworkLink } from './domain';

export type KnowledgeCategory = '设备知识' | '网络态势知识' | '故障运维知识';
export type KnowledgeState = 'DRAFT' | 'PENDING' | 'APPROVED' | 'REJECTED' | 'PUBLISHED';
export interface KnowledgeActor { id: string; name: string; role: 'EDITOR' | 'REVIEWER' }
// 快照独立于当前账号角色；改名、停用或系统重置不能改写历史身份。
export interface KnowledgeIdentitySnapshot extends KnowledgeActor { key: string; roleId: string; roleName: string }
// 数组顺序就是展示顺序；仅描述工作原理，不表达分支或执行规则。
export interface KnowledgePrincipleStep { title: string; description: string }
export interface KnowledgePrincipleFlow { steps: KnowledgePrincipleStep[] }
// 条件和变化说明只是知识文本，不是浏览器可执行的判级规则。
export interface KnowledgeNetworkRule {
  scope: string; source: string;
  criteria: { state: NetworkLink['state']; condition: string; meaning: string }[];
  transitions: { from: NetworkLink['state']; to: NetworkLink['state']; description: string }[];
}
export interface KnowledgeEntity {
  id: string; name: string; category: KnowledgeCategory; type: string; description: string;
  keywords: string[]; source: string; attributes: { name: string; value: string; unit: string | null }[]; modelIds: string[];
  // 缺失兼容旧记录；null 表示用户明确移除流程，不再采用教学示例。
  principleFlow?: KnowledgePrincipleFlow | null;
  // undefined 兼容旧实体，null 明确移除独立教学补充。
  networkRule?: KnowledgeNetworkRule | null;
}
export interface KnowledgeRelation { id: string; head: string; type: string; tail: string; weight: number | null; source: string }
export interface KnowledgeSnapshot { entities: KnowledgeEntity[]; relations: KnowledgeRelation[] }
export interface KnowledgeDraft extends KnowledgeSnapshot { summary: string; baseVersionId: string }
export interface KnowledgeSubmission {
  number: number; revision: number; actorId: string; time: string; content: KnowledgeDraft;
  outcome: 'PENDING' | 'APPROVED' | 'REJECTED' | 'WITHDRAWN';
  review: { actorId: string; time: string; opinion: string } | null;
}
export interface KnowledgeChange {
  id: string; authorId: string; state: KnowledgeState; revision: number; content: KnowledgeDraft;
  createdAt: string; updatedAt: string; submissions: KnowledgeSubmission[]; publishedVersionId: string | null;
}
export interface KnowledgeVersion extends KnowledgeSnapshot {
  id: string; number: number; parentId: string | null; restoredFromVersionId: string | null;
  kind: 'BASELINE' | 'PUBLISH' | 'ROLLBACK'; actorId: string; time: string; summary: string; changeId: string | null;
}
export interface KnowledgeLog { id: string; actorId: string; action: string; time: string; objectId: string; before: string; after: string; versionId: string; opinion: string }
export interface KnowledgeWorkspace {
  schemaVersion: number; presetVersion: string; revision: string; currentVersionId: string;
  versions: KnowledgeVersion[]; changes: KnowledgeChange[]; logs: KnowledgeLog[];
  identitySnapshots?: KnowledgeIdentitySnapshot[];
  receipts: { requestId: string; signature: string; entityId: string; changed: boolean }[];
}
export interface KnowledgeCatalog {
  actors: KnowledgeActor[]; types: { id: string; name: string; category: KnowledgeCategory }[];
  relationTypes: { id: string; name: string }[]; models: { id: string; name: string }[]; legacy: KnowledgeData;
}
export interface KnowledgeLoaded extends KnowledgeCatalog { workspace: KnowledgeWorkspace | null; error: string | null }
export interface KnowledgeQuery { versionId: string; categories: KnowledgeCategory[]; type?: string; query?: string; page?: number }
export interface KnowledgeSearch { versionId: string; items: KnowledgeEntity[]; total: number; page: number; similar: KnowledgeEntity[]; code: 0 | 4001 }
export interface KnowledgeDetail { versionId: string; entity: KnowledgeEntity; neighbors: KnowledgeEntity[]; relations: KnowledgeRelation[] }
export interface KnowledgeGraph extends KnowledgeSnapshot { versionId: string; totalNodes: number; totalEdges: number }
export interface DeviceKnowledge { versionId: string; modelId: string; items: KnowledgeDetail[] }
export interface KnowledgeIssue { objectId: string; field: string; message: string }
export interface KnowledgeMutation { actorId: string; baseRevision: string | null; requestId: string }
export interface KnowledgeChangeRequest extends KnowledgeMutation { changeId: string; revision: number }
export interface KnowledgeMutationResult { workspace: KnowledgeWorkspace; entityId: string; changed: boolean }
// 查询固定版本，写入携带工作区与送审修订，避免把两次操作混成一个快照。
export interface KnowledgeServices {
  loadKnowledgeWorkspace(): Promise<KnowledgeLoaded>;
  searchKnowledge(query: KnowledgeQuery): Promise<KnowledgeSearch>;
  getKnowledgeEntity(query: { versionId: string; entityId: string }): Promise<KnowledgeDetail>;
  queryKnowledgeGraph(query: KnowledgeQuery & { focusId?: string; expandedIds?: string[] }): Promise<KnowledgeGraph>;
  getDeviceKnowledge(query: { versionId: string; modelId: string; query?: string }): Promise<DeviceKnowledge>;
  saveKnowledgeChange(request: KnowledgeMutation & { changeId: string | null; revision: number | null; draft: KnowledgeDraft }): Promise<KnowledgeMutationResult>;
  submitKnowledgeChange(request: KnowledgeChangeRequest): Promise<KnowledgeMutationResult>;
  withdrawKnowledgeChange(request: KnowledgeChangeRequest): Promise<KnowledgeMutationResult>;
  reviewKnowledgeChange(request: KnowledgeChangeRequest & { submission: number; approved: boolean; opinion: string }): Promise<KnowledgeMutationResult>;
  publishKnowledgeChange(request: KnowledgeChangeRequest): Promise<KnowledgeMutationResult>;
  rollbackKnowledgeVersion(request: KnowledgeMutation & { versionId: string; reason: string }): Promise<KnowledgeMutationResult>;
  resetKnowledgeWorkspace(request: KnowledgeMutation): Promise<KnowledgeMutationResult>;
}

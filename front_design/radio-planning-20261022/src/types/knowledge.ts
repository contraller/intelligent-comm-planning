import type { NetworkLink } from './domain';
import type { MutationReceipt, PageQuery, PageResult, ReadRequest, SearchQuery } from './data-access';

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
  // 缺少字段表示未提供，null 表示明确移除；均不从版本外补读。
  principleFlow?: KnowledgePrincipleFlow | null;
  // 规则文本随实体保存，null 表示明确移除。
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
  relationTypes: { id: string; name: string }[]; models: { id: string; name: string }[];
}
export interface KnowledgeLoaded extends KnowledgeCatalog { workspace: KnowledgeWorkspace | null; error: string | null }
export interface KnowledgeFilter extends SearchQuery { versionId: string; categories: KnowledgeCategory[]; type?: string }
export interface KnowledgeQuery extends KnowledgeFilter, Partial<PageQuery> {}
export type KnowledgeEntitySummary = Pick<KnowledgeEntity,'id'|'name'|'category'|'type'>;
export interface KnowledgeSearch extends PageResult<KnowledgeEntitySummary> { versionId: string; similar: KnowledgeEntitySummary[]; code: 0 | 4001 }
export interface KnowledgeDetail { versionId: string; entity: KnowledgeEntity; neighbors: KnowledgeEntity[]; relations: KnowledgeRelation[] }
// 命中列表与显示上下文分离；空检索不把所有节点标记为命中。
export interface KnowledgeGraph { entities: KnowledgeEntitySummary[]; relations: KnowledgeRelation[]; versionId: string; totalNodes: number; totalEdges: number; matchedIds: string[] }
export interface DeviceKnowledge { versionId: string; modelId: string; items: KnowledgeDetail[] }
export interface KnowledgeIssue { objectId: string; field: string; message: string }
export interface KnowledgeMutation { actorId: string; baseRevision: string | null; requestId: string }
export interface KnowledgeChangeRequest extends KnowledgeMutation { changeId: string; revision: number }
export interface KnowledgeMutationResult { workspace: KnowledgeWorkspace; entityId: string; changed: boolean }
// 历史目录不含整版实体、草稿正文及送审全文。
export type KnowledgeVersionSummary = Omit<KnowledgeVersion,'entities'|'relations'>;
export type KnowledgeChangeSummary = Omit<KnowledgeChange,'content'|'submissions'> & { summary: string; baseVersionId: string };
export interface KnowledgeReadWorkspace { revision: string; currentVersionId: string; current: KnowledgeVersionSummary; counts: Record<KnowledgeCategory,number>; identitySnapshots: KnowledgeIdentitySnapshot[] }
export type KnowledgeMetadata = Omit<KnowledgeLoaded,'workspace'> & { workspace: KnowledgeReadWorkspace|null };
export interface KnowledgeReceipt extends MutationReceipt { entityId: string; currentVersionId: string; change?: KnowledgeChange }
export interface KnowledgeHistoryQuery extends PageQuery, ReadRequest { state?: KnowledgeState }
// 查询固定版本，写入携带工作区与送审修订，避免把两次操作混成一个快照。
export interface KnowledgeServices {
  loadKnowledgeMetadata(input?: ReadRequest): Promise<KnowledgeMetadata>;
  searchKnowledgeSummaries(query: KnowledgeQuery & ReadRequest): Promise<KnowledgeSearch>;
  getKnowledgeGraph(query: KnowledgeFilter & ReadRequest & {focusId?:string;expandedIds?:string[]}): Promise<KnowledgeGraph>;
  queryKnowledgeChanges(query: KnowledgeHistoryQuery): Promise<PageResult<KnowledgeChangeSummary>>;
  queryKnowledgeVersions(query: PageQuery & ReadRequest): Promise<PageResult<KnowledgeVersionSummary>>;
  queryKnowledgeLogs(query: PageQuery & ReadRequest): Promise<PageResult<KnowledgeLog>>;
  getKnowledgeChange(input: ReadRequest & {id:string}): Promise<KnowledgeChange>;
  getKnowledgeVersion(input: ReadRequest & {id:string}): Promise<KnowledgeVersion>;
  saveKnowledgeReceipt(request: Parameters<KnowledgeServices['saveKnowledgeChange']>[0]): Promise<KnowledgeReceipt>;
  submitKnowledgeReceipt(request: KnowledgeChangeRequest): Promise<KnowledgeReceipt>;
  withdrawKnowledgeReceipt(request: KnowledgeChangeRequest): Promise<KnowledgeReceipt>;
  reviewKnowledgeReceipt(request: Parameters<KnowledgeServices['reviewKnowledgeChange']>[0]): Promise<KnowledgeReceipt>;
  publishKnowledgeReceipt(request: KnowledgeChangeRequest): Promise<KnowledgeReceipt>;
  rollbackKnowledgeReceipt(request: Parameters<KnowledgeServices['rollbackKnowledgeVersion']>[0]): Promise<KnowledgeReceipt>;
  resetKnowledgeReceipt(request: KnowledgeMutation): Promise<KnowledgeReceipt>;
  loadKnowledgeWorkspace(): Promise<KnowledgeLoaded>;
  searchKnowledge(query: KnowledgeQuery): Promise<KnowledgeSearch>;
  getKnowledgeEntity(query: ReadRequest & { versionId: string; entityId: string }): Promise<KnowledgeDetail>;
  queryKnowledgeGraph(query: KnowledgeFilter & { focusId?: string; expandedIds?: string[] }): Promise<KnowledgeGraph>;
  getDeviceKnowledge(query: ReadRequest & SearchQuery & { versionId: string; modelId: string }): Promise<DeviceKnowledge>;
  saveKnowledgeChange(request: KnowledgeMutation & { changeId: string | null; revision: number | null; draft: KnowledgeDraft }): Promise<KnowledgeMutationResult>;
  submitKnowledgeChange(request: KnowledgeChangeRequest): Promise<KnowledgeMutationResult>;
  withdrawKnowledgeChange(request: KnowledgeChangeRequest): Promise<KnowledgeMutationResult>;
  reviewKnowledgeChange(request: KnowledgeChangeRequest & { submission: number; approved: boolean; opinion: string }): Promise<KnowledgeMutationResult>;
  publishKnowledgeChange(request: KnowledgeChangeRequest): Promise<KnowledgeMutationResult>;
  rollbackKnowledgeVersion(request: KnowledgeMutation & { versionId: string; reason: string }): Promise<KnowledgeMutationResult>;
  resetKnowledgeWorkspace(request: KnowledgeMutation): Promise<KnowledgeMutationResult>;
}

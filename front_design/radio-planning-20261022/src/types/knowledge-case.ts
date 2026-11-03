import type { KnowledgeCatalog, KnowledgeDraft, KnowledgeReadWorkspace, KnowledgeVersion } from './knowledge';
export interface KnowledgeCaseInput {
  caseId:string;title:string;faultType:string;objectType:string;deviceClass:''|'HF'|'VUHF';
  cause:string;component:string;solution:string;source:string;
  symptoms:string[];steps:{order:number;text:string;row?:number}[];row?:number;symptomRows?:number[];
}
export interface KnowledgeCaseContext {base:KnowledgeVersion;catalog:KnowledgeCatalog;metadata:KnowledgeReadWorkspace}
export interface KnowledgeCaseIssue {sheet:string;row:number;field:string;message:string}
export interface KnowledgeCasePreview {
  draft:KnowledgeDraft|null;issues:KnowledgeCaseIssue[];reusedEntities:number;skippedRelations:number;entityCount:number;relationCount:number;caseCount:number;
}

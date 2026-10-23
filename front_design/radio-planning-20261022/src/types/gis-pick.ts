import type { Coordinate } from './domain';

// 取点身份和来源仅在页面内使用，不进入资源 DTO 或存储。
export interface GisPickOwner { kind: 'station' | 'interference'; id: string }
export interface GisPickTarget extends GisPickOwner { name: string; coordinate: Coordinate }
export interface GisPickContext {
  key: string;
  active: boolean;
  enabled: boolean;
  owner: GisPickOwner | null;
  targets: GisPickTarget[];
}
export interface GisPickResult { key: string; coordinate: Coordinate; target?: GisPickTarget }
export interface GisPickToggle { key: string; enabled: boolean }

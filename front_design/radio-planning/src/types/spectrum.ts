// 配置版本与检查结果分离，Mock 检查不代表真实接入。
export type SpectrumDemo = 'success' | 'connection-failed' | 'format-invalid';
export interface SpectrumSource {
  id:string; name:string; endpoint:string; protocol:'HTTP_JSON'|'WEBSOCKET_JSON';
  intervalSeconds:number; minKhz:number|null; maxKhz:number|null; enabled:boolean; revision:string;
}
export interface SpectrumCheck {
  id:string; sourceId:string; configRevision:string; checkedAt:string; demo:SpectrumDemo;
  connection:'SUCCESS'|'FAILED'; validation:'SUCCESS'|'FAILED'|'NOT_RUN'; message:string;
}
export interface SpectrumWorkspace {
  schemaVersion:number; revision:string; sources:SpectrumSource[]; checks:SpectrumCheck[];
  receipts:{requestId:string;signature:string;objectId:string;changed:boolean}[];
}
export interface SpectrumResult { workspace:SpectrumWorkspace; objectId:string; changed:boolean; check?:SpectrumCheck }
export interface SpectrumServices {
  loadSpectrumWorkspace():Promise<SpectrumWorkspace>;
  saveSpectrumSource(request:{baseRevision:string;requestId:string;source:SpectrumSource}):Promise<SpectrumResult>;
  checkSpectrumSource(request:{baseRevision:string;requestId:string;sourceId:string;configRevision:string;demo:SpectrumDemo}):Promise<SpectrumResult>;
  resetSpectrumWorkspace(baseRevision:string|null):Promise<SpectrumResult>;
}

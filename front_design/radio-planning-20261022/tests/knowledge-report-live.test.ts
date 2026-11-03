import { describe,expect,it } from 'vitest';
import { mkdir,readFile,writeFile } from 'node:fs/promises';
import { createAuthHttp } from '../src/services/auth-http';
import { createKnowledgeHttp } from '../src/services/knowledge-http';
import { createDiagnosisHttp } from '../src/services/diagnosis-http';
import { knowledgeMedia } from '../src/config/knowledge-media';
import { knowledgeGraphModel } from '../src/graphs/knowledge-graph';
import { assertDiagnosisReportIdentity } from '../src/services/diagnosis-http-validation';
import { createDiagnosisExport } from '../src/reports/diagnosis-export';

const live=process.env.KNOWLEDGE_REWORK_LOCAL_URL,runId=process.env.KNOWLEDGE_REWORK_RUN_ID,output=process.env.KNOWLEDGE_REWORK_OUTPUT;
function connection(){
  const base=new URL(live!);if(!['127.0.0.1','localhost'].includes(base.hostname)||process.env.KNOWLEDGE_REWORK_ISOLATED!=='1')throw new Error('仅接受明确授权的本机隔离服务');
  let cookie='';
  const fetcher:typeof fetch=async(input,init)=>{const headers=new Headers(init?.headers);if(cookie)headers.set('Cookie',cookie);const response=await fetch(new URL(String(input),base),{...init,headers});const value=response.headers.get('set-cookie');if(value)cookie=value.split(';')[0];return response;};
  const auth=createAuthHttp({baseUrl:()=>'/api/v1',origin:()=>base.origin,fetcher});
  return{auth,knowledge:createKnowledgeHttp(auth.authenticatedRequest),diagnosis:createDiagnosisHttp(auth.authenticatedRequest)};
}
describe.skipIf(!live)('本地真实HTTP知识与报告证据（只读）',()=>{
  it('真实已发布快照中的两种电台图片在图节点及详情一致命中',async()=>{
    const s=connection(),identity=await s.auth.getSession();expect(identity?.permissions).toContain('knowledge.view');
    const meta=await s.knowledge.loadKnowledgeMetadata(),versionId=meta.workspace!.currentVersionId;
    const graph=await s.knowledge.getKnowledgeGraph({versionId,categories:['设备知识'],type:'DeviceModel',search:''});
    const catalog=meta.types.map(t=>t.id),model=knowledgeGraphModel(graph,'',catalog,{});
    const matches=[];
    for(const item of graph.entities){const media=knowledgeMedia(item);if(!media)continue;const detail=await s.knowledge.getKnowledgeEntity({versionId,entityId:item.id});expect(knowledgeMedia(detail.entity)?.url).toBe(media.url);expect(model.nodes.find(n=>n.id===item.id)?.symbol).toBe('image://'+media.url);matches.push({entityId:item.id,name:item.name,modelName:item.modelName,photo:media.url,versionId});}
    expect(matches.map(m=>m.modelName)).toEqual(expect.arrayContaining(['AN/PRC-150(C)','FT-891']));
    if(output){await mkdir(output,{recursive:true});await writeFile(output+'/knowledge-photo-hits.json',JSON.stringify({source:'真实HTTP冻结知识快照',versionId,matches},null,2));}
  },30000);
  it.skipIf(!runId)('真实授权运行报告核验冻结身份后生成可渲染中文图文PDF',async()=>{
    const s=connection(),identity=await s.auth.getSession();expect(identity?.permissions).toContain('diagnosis.export');
    const original=await s.diagnosis.getDiagnosisReport(runId!),authorized=await s.diagnosis.getDiagnosisReport(runId!);assertDiagnosisReportIdentity(authorized,original);
    if(output){await mkdir(output,{recursive:true});await writeFile(output+'/knowledge-real-http-record.json',JSON.stringify(authorized,null,2));}
    const fontBytes=new Uint8Array(await readFile('public/fonts/NotoSansCJKsc-Regular.otf')),file=await createDiagnosisExport(authorized,'pdf',{fontBytes});
    expect(new TextDecoder().decode(file.bytes.subarray(0,8))).toContain('%PDF-');expect(file.bytes.length).toBeGreaterThan(10000);expect((await s.auth.getSession())?.id).toBe(identity!.id);
    if(output){await mkdir(output,{recursive:true});await writeFile(output+'/knowledge-real-http-report.pdf',file.bytes);await writeFile(output+'/knowledge-real-http-report.json',JSON.stringify({source:'真实HTTP授权冻结报告',runId:original.id,scenarioId:original.scenarioId,scenarioVersion:original.scenarioVersion,planId:original.network.id,snapshotId:original.network.snapshotId,nodes:original.network.stationIds.length,bytes:file.bytes.length},null,2));}
  },60000);
});

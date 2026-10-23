import { describe, expect, it, vi } from 'vitest';
import { createHttpClient, httpService } from '../src/services/http';
import { ApiError } from '../src/services/types';
import { planningPresets } from '../src/mocks/planning-presets';

// 三个认证方法由独立契约测试覆盖；管理与演示辅助仍明确拒绝，不能回退 Mock。
it.each(['getLoginCatalog','loadSystemCatalog','querySystemAccounts','saveSystemAccount','setSystemAccountState','querySystemRoles','saveSystemRole','querySystemParameters','saveSystemParameter','queryOperationLogs','resetSystemWorkspace','recoverSystemWorkspace','resetOperationLogs'])('HTTP 系统方法 %s 明确未实现',async name=>{await expect((httpService as unknown as Record<string,()=>Promise<unknown>>)[name]()).rejects.toMatchObject({code:'NOT_IMPLEMENTED'});});

describe('HTTP 客户端保留失败语义', () => {
  it('已接入知识方法保留网络失败，不回退 Mock；重置仍拒绝', async () => {
    const fetcher = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new TypeError('网络断开'));
    const mutation = { actorId:'KG-EDITOR',baseRevision:'initial',requestId:'test' };
    const change = {...mutation,changeId:'change',revision:1};
    try {
      const actions = [
        () => httpService.loadKnowledgeWorkspace(),
        () => httpService.searchKnowledge({versionId:'v',categories:[]}),
        () => httpService.getKnowledgeEntity({versionId:'v',entityId:'e'}),
        () => httpService.queryKnowledgeGraph({versionId:'v',categories:[]}),
        () => httpService.getDeviceKnowledge({versionId:'v',modelId:'m'}),
        () => httpService.saveKnowledgeChange({...mutation,changeId:null,revision:null,draft:{summary:'test',baseVersionId:'v',entities:[],relations:[]}}),
        () => httpService.submitKnowledgeChange(change),
        () => httpService.withdrawKnowledgeChange(change),
        () => httpService.reviewKnowledgeChange({...change,submission:1,approved:true,opinion:''}),
        () => httpService.publishKnowledgeChange(change),
        () => httpService.rollbackKnowledgeVersion({...mutation,versionId:'v',reason:'test'}),
      ];
      for (const action of actions) await expect(action()).rejects.toMatchObject({code:'NETWORK_ERROR'});
      expect(fetcher).toHaveBeenCalled();
      await expect(httpService.resetKnowledgeWorkspace(mutation)).rejects.toMatchObject({code:'UNSUPPORTED_OPERATION'});
    } finally { fetcher.mockRestore(); }
  });
  it('已接入诊断方法保留网络失败，模板参数和重置单独校验', async () => {
    const fetcher = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new TypeError('网络断开'));
    const draft = {name:'场景',description:'',planId:'plan',faults:[]};
    const mutation = {baseRevision:'initial',requestId:'request'};
    try {
      const actions = [
        () => httpService.loadDiagnosisWorkspace(), () => httpService.loadDiagnosisSources(),
        () => httpService.validateDiagnosisScenario(draft),
        () => httpService.saveDiagnosisScenario({...mutation,scenarioId:null,draft}),
        () => httpService.archiveDiagnosisScenario({...mutation,scenarioId:'scene',archived:true}),
        () => httpService.getDiagnosisTemplate('csv','plan'),
        () => httpService.previewDiagnosisImport({name:'file.csv',bytes:new Uint8Array()},'plan'),
        () => httpService.commitDiagnosisImport({...mutation,drafts:[draft]}),
        () => httpService.submitDiagnosis({...mutation,scenarioVersionId:'version',demo:'normal'}),
        () => httpService.getDiagnosisRun('run'), () => httpService.cancelDiagnosisRun({...mutation,runId:'run'}),
        () => httpService.getDiagnosisReport('run'), () => httpService.exportDiagnosisReport('run','pdf'),
        () => httpService.exportDiagnosisImpact('run','xlsx','全部'),
      ];
      for (const action of actions) await expect(action()).rejects.toMatchObject({code:'NETWORK_ERROR'});
      expect(fetcher).toHaveBeenCalled();
      await expect(httpService.getDiagnosisTemplate('csv')).rejects.toMatchObject({code:'VALIDATION_ERROR'});
      await expect(httpService.resetDiagnosisWorkspace(null)).rejects.toMatchObject({code:'UNSUPPORTED_OPERATION'});
    } finally { fetcher.mockRestore(); }
  });
  it('规划 HTTP 全部明确未接入，不发猜测端点请求', async () => {
    const fetcher = vi.spyOn(globalThis, 'fetch');
    try {
      const actions = [
        () => httpService.loadPlanningWorkspace(),
        () =>
          httpService.submitPlanning({
            baseRevision: 'initial',
            requestId: 'r',
            taskId: null,
            parentPlanVersionId: null,
            input: planningPresets[0].input,
          }),
        () => httpService.getPlanningJob('job'),
        () => httpService.cancelPlanningJob({ baseRevision: 'r', jobId: 'job' }),
        () =>
          httpService.savePlanVersion({
            baseRevision: 'r',
            jobId: 'job',
            requestId: 'save',
            name: '名称',
            note: '',
          }),
        () =>
          httpService.confirmPlanVersion({ baseRevision: 'r', planId: 'p', requestId: 'confirm' }),
        () => httpService.comparePlanVersions(['p1', 'p2']),
        () => httpService.resetPlanningWorkspace(null),
      ];
      for (const action of actions)
        await expect(action()).rejects.toMatchObject({ code: 'NOT_IMPLEMENTED' });
      expect(fetcher).not.toHaveBeenCalled();
    } finally {
      fetcher.mockRestore();
    }
  });
  it('仅业务码为 0 且 HTTP 成功时返回 data', async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValue(
        new Response(JSON.stringify({ code: 0, message: '成功', data: { id: 'PLAN-V1' } })),
      );
    const request = createHttpClient('/api/', fetcher);
    expect(await request('/plans')).toEqual({ id: 'PLAN-V1' });
    expect(fetcher).toHaveBeenCalledWith('/api/plans', undefined);
  });
  it.each([3001, 3002, 4001])('HTTP 200 业务码 %s 保留建议与请求编号', async (code) => {
    const detail = { suggestions: ['尝试另一个档位'], gap: { nodes: ['ND-0007'] } };
    const request = createHttpClient(
      '/api',
      vi.fn<typeof fetch>().mockResolvedValue(
        new Response(
          JSON.stringify({
            code,
            message: '当前约束无法满足',
            data: detail,
            request_id: 'REQ-01',
          }),
        ),
      ),
    );
    await expect(request('/plans')).rejects.toMatchObject({
      code,
      data: detail,
      requestId: 'REQ-01',
      status: 200,
    });
  });
  it('HTTP 失败不因包络成功而伪装成成功', async () => {
    const request = createHttpClient(
      '/api',
      vi.fn<typeof fetch>().mockResolvedValue(
        new Response(JSON.stringify({ code: 0, message: '服务不可用', data: null }), {
          status: 503,
        }),
      ),
    );
    await expect(request('/plans')).rejects.toMatchObject({ status: 503, message: '服务不可用' });
  });
  it('网络断开、无效 JSON 和无效包络均有明确错误', async () => {
    const offline = createHttpClient(
      '/api',
      vi.fn<typeof fetch>().mockRejectedValue(new TypeError('网络断开')),
    );
    await expect(offline('/plans')).rejects.toMatchObject({ code: 'NETWORK_ERROR' });
    const invalid = createHttpClient(
      '/api',
      vi.fn<typeof fetch>().mockResolvedValue(new Response('<html>错误页</html>')),
    );
    await expect(invalid('/plans')).rejects.toMatchObject({ code: 'INVALID_RESPONSE' });
    const malformed = createHttpClient(
      '/api',
      vi
        .fn<typeof fetch>()
        .mockResolvedValue(new Response(JSON.stringify({ code: '0', data: {} }))),
    );
    await expect(malformed('/plans')).rejects.toMatchObject({ code: 'INVALID_ENVELOPE' });
  });
  it('未接入的 HTTP 业务适配明确拒绝，不回退 Mock', async () => {
    await expect(httpService.loadPreview()).rejects.toBeInstanceOf(ApiError);
    await expect(httpService.loadPreview()).rejects.toMatchObject({ code: 'NOT_IMPLEMENTED' });
    await expect(
      httpService.commitResources({ baseRevision: 'initial', stations: [], devices: [] }),
    ).rejects.toMatchObject({ code: 'NOT_IMPLEMENTED' });
    await expect(httpService.resetResources(null)).rejects.toMatchObject({
      code: 'NOT_IMPLEMENTED',
    });
  });
});

describe('第七批 HTTP 未接入边界',()=>{
  it('新增九个入口全部明确未实现，不发请求或回退 Mock',async()=>{
    const fetcher=vi.spyOn(globalThis,'fetch');
    const names=['getResourceTemplate','previewResourceImport','commitResourceImport','exportResources','setDeviceAvailability','loadSpectrumWorkspace','saveSpectrumSource','checkSpectrumSource','resetSpectrumWorkspace'];
    for(const name of names)await expect((httpService as unknown as Record<string,()=>Promise<unknown>>)[name]()).rejects.toMatchObject({code:'NOT_IMPLEMENTED'});
    expect(fetcher).not.toHaveBeenCalled();fetcher.mockRestore();
  });
});

// 真实协议未确认前，新观测入口必须明确失败，不请求猜测地址。
describe('第十批监控 HTTP 边界',()=>{
  it('四个入口均不发请求、不回退 Mock',async()=>{
    const fetcher=vi.spyOn(globalThis,'fetch');
    try{
      for(const name of ['loadMonitoringContext','getMonitoringFrame','loadSpectrumMonitoringContext','getSpectrumObservationFrame'])
        await expect((httpService as unknown as Record<string,()=>Promise<unknown>>)[name]()).rejects.toMatchObject({code:'NOT_IMPLEMENTED'});
      expect(fetcher).not.toHaveBeenCalled();
    }finally{fetcher.mockRestore();}
  });
});

describe('第九批 HTTP 边界',()=>{
  it('六个干扰入口均明确未实现，不猜端点',async()=>{
    const fetcher=vi.spyOn(globalThis,'fetch');
    try{
      for(const name of ['loadInterferenceWorkspace','loadInterferenceSources','submitInterferenceAnalysis','getInterferenceAnalysis','cancelInterferenceAnalysis','adoptInterferenceMeasure'])
        await expect((httpService as unknown as Record<string,()=>Promise<unknown>>)[name]()).rejects.toMatchObject({code:'NOT_IMPLEMENTED'});
      expect(fetcher).not.toHaveBeenCalled();
    }finally{fetcher.mockRestore();}
  });
});

// 图片响应单独解码，JSON 错误不能伪装为成功下载。
describe('覆盖图片传输',()=>{
  it('接受 PNG 二进制，并保留图片接口返回的业务错误',async()=>{
    const png=createHttpClient('/api',vi.fn<typeof fetch>().mockResolvedValue(new Response(new Uint8Array([137,80,78,71]),{headers:{'Content-Type':'image/png'}})));
    expect((await png<Blob>('/files/x.png',{},'blob')).size).toBe(4);
    const failed=createHttpClient('/api',vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({code:2001,message:'图片已过期',data:{snapshot_id:'S1'}}),{status:404})));
    await expect(failed('/files/x.png',{},'blob')).rejects.toMatchObject({code:2001,data:{snapshot_id:'S1'},status:404});
  });
});

// 文件下载必须有明确类型和附件头，JSON 错误不可降级为成功文件。
describe('共享安全文件下载',()=>{
  it.each([
    ['application/json', '{"report":{"id":"R1"}}'],
    ['application/pdf', '%PDF-1.7'],
    ['application/vnd.openxmlformats-officedocument.wordprocessingml.document', 'PK-docx'],
    ['application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 'PK-xlsx'],
    ['text/csv; charset=utf-8', 'id,name\n1,test'],
  ])('接受白名单附件 %s',async(mime,body)=>{
    const request=createHttpClient('/api',vi.fn<typeof fetch>().mockResolvedValue(new Response(body,{headers:{'Content-Type':mime,'Content-Disposition':'attachment; filename="report"'}})));
    expect(await (await request<Blob>('/download',{},'blob')).text()).toBe(body);
  });
  it.each([200,403])('附件头不掩盖 HTTP %s 的业务错误',async status=>{
    const request=createHttpClient('/api',vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({code:1104,message:'权限不足',data:null,request_id:'R1'}),{status,headers:{'Content-Type':'application/json','Content-Disposition':'attachment; filename="error.json"'}})));
    await expect(request('/download',{},'blob')).rejects.toMatchObject({code:1104,requestId:'R1',status});
  });
  it.each(['text/html','application/octet-stream'])('拒绝不支持的附件 %s',async mime=>{
    const request=createHttpClient('/api',vi.fn<typeof fetch>().mockResolvedValue(new Response('unexpected',{headers:{'Content-Type':mime,'Content-Disposition':'attachment'}})));
    await expect(request('/download',{},'blob')).rejects.toMatchObject({code:'INVALID_DOWNLOAD_FILE'});
  });
  it.each(['',new Uint8Array(20*1024*1024+1)])('拒绝空文件或实际超限文件',async body=>{
    const request=createHttpClient('/api',vi.fn<typeof fetch>().mockResolvedValue(new Response(body,{headers:{'Content-Type':'application/pdf','Content-Disposition':'attachment'}})));
    await expect(request('/download',{},'blob')).rejects.toMatchObject({code:'INVALID_DOWNLOAD_FILE'});
  });
  it.each(['invalid-json','{"code":0,"message":"ok","data":{}}'])('JSON 附件不能是无效 JSON 或业务成功包络',async body=>{
    const request=createHttpClient('/api',vi.fn<typeof fetch>().mockResolvedValue(new Response(body,{headers:{'Content-Type':'application/json','Content-Disposition':'attachment'}})));
    await expect(request('/download',{},'blob')).rejects.toMatchObject({code:'INVALID_DOWNLOAD_FILE'});
  });
  it('JSON 报告无附件头不能冒充普通业务包络',async()=>{
    const request=createHttpClient('/api',vi.fn<typeof fetch>().mockResolvedValue(new Response('{"report":{}}',{headers:{'Content-Type':'application/json'}})));
    await expect(request('/download',{},'blob')).rejects.toMatchObject({code:'INVALID_ENVELOPE'});
  });
  it('响应头声明超限时不继续读取文件',async()=>{
    const response=new Response('file',{headers:{'Content-Type':'application/pdf','Content-Disposition':'attachment','Content-Length':String(20*1024*1024+1)}});
    const body=vi.spyOn(response,'blob');
    const request=createHttpClient('/api',vi.fn<typeof fetch>().mockResolvedValue(response));
    await expect(request('/download',{},'blob')).rejects.toMatchObject({code:'INVALID_DOWNLOAD_FILE'});
    expect(body).not.toHaveBeenCalled();
  });
});

describe('第八批 HTTP 边界',()=>{
  it('任务和方案导出入口均明确未接入，不发出猜测请求',async()=>{
    const fetcher=vi.spyOn(globalThis,'fetch');
    for(const name of ["loadTaskWorkspace","saveTask","commitGisWorkspace","getTaskTemplate","previewTaskImport","exportPlanVersion"])await expect((httpService as unknown as Record<string,()=>Promise<unknown>>)[name]()).rejects.toMatchObject({code:'NOT_IMPLEMENTED'});
    expect(fetcher).not.toHaveBeenCalled();fetcher.mockRestore();
  });
});

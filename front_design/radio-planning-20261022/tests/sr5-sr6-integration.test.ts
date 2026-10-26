import { afterEach, describe, expect, it, vi } from 'vitest';
import { createPinia, setActivePinia } from 'pinia';
import { authorizeStore } from './helpers/auth';
import { previewService } from '../src/services';
import { useDiagnosisStore } from '../src/stores/diagnosis';

afterEach(()=>{vi.restoreAllMocks();vi.useRealTimers();});
describe('SR5 两阶段页面调度',()=>{
  it('诊断成功后单独提交影响，即使影响立即完成也读取完整报告',async()=>{
    setActivePinia(createPinia());authorizeStore();
    const network={id:'plan-a',taskId:'task-a',name:'构造',version:'V1',preset:'SR4',snapshotId:'snapshot',inputSnapshot:{stations:[],devices:[]},links:[],stationIds:[],regions:[],metrics:{},notes:[]};
    const result={fusionMode:'TWO_WAY_DEGRADED',disabledReason:'未启用 ML',conclusions:[],nodes:[],links:[],regions:[],summary:null,suggestions:[],notes:[]};
    const detail={run:{id:'run-a',diagnoseTaskId:'diag-a',impactTaskId:null,scenario:{id:'v',scenarioId:'s',version:1,name:'场景',description:'',planId:'plan-a',faults:[],network},presetId:'',presetVersion:'backend',startedAt:1,cancelledAt:null},state:'RUNNING',progress:50,phases:[],diagnosisReady:true,impactReady:false,error:null,source:{state:'CURRENT',reasons:[]},dataOrigin:'SAMPLE'};
    let impact=false;
    vi.spyOn(previewService,'loadDiagnosisContext').mockResolvedValue({revision:'SR5-1',error:null,presets:[],legacy:[],sources:{plans:[],error:null},symptoms:[],interferenceIds:[],latestRunId:null,dataOrigin:'SAMPLE',capabilities:{demoControls:false,twoStep:true}});
    vi.spyOn(previewService,'queryDiagnosisScenarios').mockResolvedValue({items:[],total:0,pageNum:1,pageSize:20});vi.spyOn(previewService,'queryDiagnosisHistory').mockResolvedValue({items:[],total:0,pageNum:1,pageSize:20});
    vi.spyOn(previewService,'getDiagnosisProgress').mockImplementation(async()=>({...detail,id:'run-a',resultVersion:impact?'complete':'diagnostic',state:impact?'SUCCESS':'RUNNING',impactReady:impact,progress:impact?100:50}) as any);
    vi.spyOn(previewService,'getDiagnosisDetail').mockImplementation(async()=>({...detail,run:{...detail.run,impactTaskId:impact?'impact-a':null},state:impact?'SUCCESS':'RUNNING',impactReady:impact}) as any);
    const submit=vi.spyOn(previewService,'submitDiagnosisImpactReceipt').mockImplementation(async()=>{impact=true;return{objectId:'run-a',entityIds:['run-a'],changed:true,revision:'SR5-2'};});
    vi.spyOn(previewService,'getDiagnosisStage').mockResolvedValue(result as any);
    const report=vi.spyOn(previewService,'getDiagnosisReport').mockResolvedValue({id:'run-a',result,network} as any);
    const store=useDiagnosisStore();await store.load();store.runId='run-a';await store.startPolling();
    expect(submit).toHaveBeenCalledTimes(1);expect(store.view?.state).toBe('SUCCESS');expect(report).toHaveBeenCalledTimes(1);expect(store.record?.id).toBe('run-a');await store.query();expect(submit).toHaveBeenCalledTimes(1);store.stopPolling();
  });
});

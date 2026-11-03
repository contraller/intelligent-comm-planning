import { afterEach, describe, expect, it, vi } from 'vitest';
import { createPinia, setActivePinia } from 'pinia';
import { authorizeStore } from './helpers/auth';
import { previewService } from '../src/services';
import { useDiagnosisStore } from '../src/stores/diagnosis';
import {
  readDiagnosisReport,
  assertDiagnosisReportIdentity,
} from '../src/services/diagnosis-http-validation';
import * as exports from '../src/reports/diagnosis-export';
import type { DiagnosisRecord } from '../src/types/diagnosis';

const sample = (): DiagnosisRecord =>
  ({
    id: 'run-pdf',
    legacy: false,
    dataOrigin: 'SAMPLE',
    scenarioId: 'scenario-pdf',
    scenarioVersion: 'version-pdf',
    name: '冻结诊断报告',
    description: '构造定向测试',
    startedAt: '2026-11-03T00:00:00Z',
    completedAt: '2026-11-03T00:01:00Z',
    diagnoseTaskId: 'diagnosis-pdf',
    impactTaskId: 'impact-pdf',
    faults: [],
    source: { state: 'CURRENT', reasons: [] },
    network: {
      id: 'plan-pdf',
      taskId: 'task-pdf',
      jobId: 'job-pdf',
      snapshotId: 'snapshot-pdf',
      name: '冻结网络',
      version: 'V1',
      preset: 'SR4',
      state: 'CONFIRMED',
      sourceChanged: false,
      notes: [],
      stationIds: ['node-a'],
      inputSnapshot: {
        stations: [
          {
            id: 'node-a',
            name: '节点',
            coordinate: [114, 37],
            elevationM: null,
            status: null,
            alert: null,
            parentIds: [],
            classes: ['HF'],
            echelon: '',
            region: '',
            mobility: '',
            relayCapable: false,
            key: false,
          },
        ],
        devices: [],
      },
      links: [],
      regions: [],
      metrics: {
        coveragePercent: null,
        connectivityPercent: 100,
        survivabilityPercent: 90,
        totalRadiatedPowerW: null,
        delayMs: null,
      },
    },
    result: {
      fusionMode: 'TWO_WAY_DEGRADED',
      disabledReason: 'ML未启用',
      conclusions: [],
      nodes: [],
      links: [],
      regions: [],
      summary: null,
      suggestions: [],
      notes: ['构造数据'],
    },
  }) as DiagnosisRecord;
afterEach(() => vi.restoreAllMocks());
describe('PDF冻结与授权读取', () => {
  it('报告核验拒绝跨网络故障、无效部署坐标和非法传播对象', () => {
    expect(readDiagnosisReport(sample(), 'run-pdf').id).toBe('run-pdf');
    const fault = sample();
    fault.faults = [
      {
        objectType: 'NODE',
        objectId: 'other',
        faultType: 'HW_FAILURE',
        symptomIds: [],
        occurTime: null,
        interferenceId: null,
      },
    ];
    expect(() => readDiagnosisReport(fault, 'run-pdf')).toThrow();
    const deployed = sample();
    (deployed.network as any).workflow = {
      configuration: { deployment: [{ stationId: 'node-a', plannedCoordinate: [NaN, 37] }] },
    };
    expect(() => readDiagnosisReport(deployed, 'run-pdf')).toThrow();
    const path = sample();
    path.result.propagationPaths = [
      { id: 'bad', faultKey: 'NODE:other', level: 'SEVERE', reason: '无效', steps: [] },
    ];
    expect(() => readDiagnosisReport(path, 'run-pdf')).toThrow();
  });
  it.each(['scenarioVersion', 'impactTaskId', 'snapshotId', 'coordinate', 'result'] as const)(
    '再次读取的 %s 改变时拒绝混版PDF',
    (field) => {
      const expected = sample(),
        actual = structuredClone(expected);
      if (field === 'snapshotId') actual.network.snapshotId = 'other';
      else if (field === 'coordinate')
        actual.network.inputSnapshot.stations[0].coordinate = [115, 37];
      else if (field === 'result') actual.result.notes.push('被替换的结果');
      else actual[field] = 'other';
      expect(() => assertDiagnosisReportIdentity(actual, expected)).toThrow('冻结诊断记录不一致');
      const history = sample();
      history.source = { state: 'HISTORICAL', reasons: ['资源已更新'] };
      expect(() => assertDiagnosisReportIdentity(history, expected)).not.toThrow();
    },
  );
  async function setup() {
    setActivePinia(createPinia());
    const auth = authorizeStore(),
      store = useDiagnosisStore();
    store.record = sample();
    const file = { name: '报告.pdf', mime: 'application/pdf', bytes: new Uint8Array([1]) };
    const read = vi.spyOn(previewService, 'getDiagnosisReport').mockResolvedValue(sample()),
      generate = vi.spyOn(exports, 'createDiagnosisExport').mockResolvedValue(file),
      download = vi.spyOn(exports, 'downloadDiagnosisFile').mockImplementation(() => {});
    return { auth, store, file, read, generate, download };
  }
  it('按钮沿授权报告读取生成图文PDF，完成后再次核实权限', async () => {
    const s = await setup(),
      check = vi.spyOn(s.auth, 'check').mockResolvedValue(true);
    await s.store.download('pdf');
    expect(s.read).toHaveBeenCalledExactlyOnceWith('run-pdf');
    expect(s.generate).toHaveBeenCalledExactlyOnceWith(sample(), 'pdf');
    expect(check).toHaveBeenCalled();
    expect(s.download).toHaveBeenCalledExactlyOnceWith(s.file);
    expect(s.store.exportError).toBe('');
  });
  it('授权失败或冻结身份不符保留输入并显示报告导出错误', async () => {
    const s = await setup();
    s.read.mockRejectedValueOnce(new Error('授权读取失败'));
    await s.store.download('pdf');
    expect(s.generate).not.toHaveBeenCalled();
    expect(s.store.exportError).toBe('授权读取失败');
    const changed = sample();
    changed.network.snapshotId = 'other';
    s.read.mockResolvedValueOnce(changed);
    await s.store.download('pdf');
    expect(s.generate).not.toHaveBeenCalled();
    expect(s.store.exportError).toContain('冻结诊断记录不一致');
    expect(s.store.record!.network.snapshotId).toBe('snapshot-pdf');
  });
  it.each(['selection', 'session'] as const)('生成期间%s改变，迟到PDF不发起下载', async (what) => {
    const s = await setup();
    let finish!: (value: typeof s.file) => void;
    s.generate.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const exporting = s.store.download('pdf');
    await Promise.resolve();
    await Promise.resolve();
    if (what === 'selection') s.store.record = { ...sample(), id: 'other-run' };
    else s.auth.accept({ ...s.auth.identity!, sessionId: 'other-session' });
    finish(s.file);
    await exporting;
    expect(s.download).not.toHaveBeenCalled();
    expect(s.store.exporting).toBe(false);
  });
});

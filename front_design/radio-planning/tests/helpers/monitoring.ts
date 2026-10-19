import { vi } from 'vitest';
import { nextTick } from 'vue';
import { createMonitoringMock } from '../../src/services/monitoring-mock';
import { createSpectrumMock } from '../../src/services/spectrum-mock';
import { previewService } from '../../src/services';
import type { MonitoringServices } from '../../src/types/monitoring';
import type { SpectrumDemo } from '../../src/types/spectrum';
import { interferenceFixture } from './interference';
import { TestStorage } from './storage';

// 沿用真实保存/确认流程；不伪造确认指针，不把测试文件写入历史样件目录。
export async function monitoringFixture(id='balanced',storage?:TestStorage){
  const base=await interferenceFixture(id,storage);
  const monitoring=createMonitoringMock(()=>base.storage,base.resource.read),spectrum=createSpectrumMock(()=>base.storage);
  async function enableSpectrum(minKhz=6000,maxKhz=10000){
    const w=await spectrum.loadSpectrumWorkspace();
    const saved=await spectrum.saveSpectrumSource({baseRevision:w.revision,requestId:crypto.randomUUID(),source:{...w.sources[0],minKhz,maxKhz}});
    return checkSpectrum('success',saved.workspace.sources[0].id);
  }
  async function checkSpectrum(demo:SpectrumDemo,sourceId='SP-01'){
    const w=await spectrum.loadSpectrumWorkspace(),source=w.sources.find(row=>row.id===sourceId)!;
    return spectrum.checkSpectrumSource({baseRevision:w.revision,requestId:crypto.randomUUID(),sourceId,configRevision:source.revision,demo});
  }
  return {...base,monitoring,spectrum,enableSpectrum,checkSpectrum};
}
export function bindMonitoring(service:MonitoringServices){
  vi.spyOn(previewService,'loadMonitoringContext').mockImplementation(service.loadMonitoringContext);
  vi.spyOn(previewService,'getMonitoringFrame').mockImplementation(service.getMonitoringFrame);
  vi.spyOn(previewService,'loadSpectrumMonitoringContext').mockImplementation(service.loadSpectrumMonitoringContext);
  vi.spyOn(previewService,'getSpectrumObservationFrame').mockImplementation(service.getSpectrumObservationFrame);
}
export async function settleMonitoring(){for(let i=0;i<16;i++)await Promise.resolve();await nextTick();}

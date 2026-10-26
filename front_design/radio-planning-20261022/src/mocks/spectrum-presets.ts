import type { SpectrumDemo, SpectrumWorkspace } from '../types/spectrum';
import { SPECTRUM_SCHEMA_VERSION } from '../config/demo';

// 频段没有来源值，必须由用户补全，不能用频率资源池替代采集配置。
export const initialSpectrum=():SpectrumWorkspace=>({
  schemaVersion:SPECTRUM_SCHEMA_VERSION,revision:'spectrum-initial',receipts:[],checks:[],
  sources:[
    {id:'SP-01',name:'区域频谱监测接口',endpoint:'/api/spectrum/observations',protocol:'HTTP_JSON',intervalSeconds:30,minKhz:null,maxKhz:null,enabled:true,revision:'initial'},
    {id:'SP-02',name:'干扰事件接口',endpoint:'/api/spectrum/events',protocol:'HTTP_JSON',intervalSeconds:60,minKhz:null,maxKhz:null,enabled:true,revision:'initial'},
  ],
});
export const spectrumDemos:Record<SpectrumDemo,string>={
  success:'Mock 连接及数据格式校验成功；未连接真实服务',
  'connection-failed':'Mock 连接失败：教学预设超时，数据校验未执行',
  'format-invalid':'Mock 连接成功，数据格式异常：教学预设缺少采样时间',
};

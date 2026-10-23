import type { ConfigurationPreset, ConfigurationScenario } from '../types/device-configuration';
import { DEVICE_CONFIGURATION_PRESET_VERSION } from '../config/demo';

// 人工固定教学组合；功率沿用资料档位，频率不是电台出厂设置。
export const configurationSource = '教学配置预设 · 非出厂默认值，不连接真实设备';
const rows: [string, number, number, number, number][] = [
  ['DM-0001',30,10000,36.99,15000],['DM-0002',30,10000,36.99,15000],['DM-0003',30,10000,36.99,15000],
  ['DM-0004',51.76,10000,51.76,15000],['DM-0005',50.97,10000,50.97,15000],['DM-0006',40,10000,46.99,15000],
  ['DM-0007',50.97,10000,50.97,15000],['DM-0008',46.02,10000,50,15000],['DM-0009',34.77,450000,36.99,460000],
  ['DM-0010',30,450000,36.09,460000],['DM-0011',30,450000,37,460000],['DM-0012',30,450000,36.02,460000],
  ['DM-0013',46.99,450000,46.99,460000],['DM-0014',43.98,450000,44.77,460000],['DM-0015',20,145000,30,435000],
  ['DM-0016',30,450000,33.98,460000],
];
export const configurationPresets: ConfigurationPreset[] = rows.flatMap(([modelId,p1,f1,p2,f2]) => [
  { id:modelId+':default', modelId, name:'教学默认值', version:DEVICE_CONFIGURATION_PRESET_VERSION, source:configurationSource, values:{txPowerDbm:p1,workFreqKhz:f1,currentWorkMode:'MOCK_FIXED'} },
  { id:modelId+':second', modelId, name:'教学预设二', version:DEVICE_CONFIGURATION_PRESET_VERSION, source:configurationSource, values:{txPowerDbm:p2,workFreqKhz:f2,currentWorkMode:'MOCK_HOPPING'} },
]);
export const configurationScenarios: { id: ConfigurationScenario; name: string }[] = [
  {id:'success',name:'成功回执'}, {id:'validation-rejected',name:'服务校验拒绝'}, {id:'send-failed',name:'模拟发送失败'},
  {id:'receipt-failed',name:'模拟回执失败'}, {id:'reply-lost',name:'已受理但提交响应丢失'},
];

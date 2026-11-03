// 本地绘制的类型示意，不表示任何型号、厂商商标或设备实物外观。
const icons = {
  Device: { label: '设备 · 电台', color: '#67cce1', paths: '<rect x="13" y="25" width="38" height="25" rx="5"/><path d="M19 25V13m0 0 6 4M21 33h15v8H21m21-7h2m-2 8h2M20 50v3m24-3v3"/>' },
  DeviceModel: { label: '设备型号 · 型号电台', color: '#7db8f2', paths: '<rect x="12" y="27" width="36" height="23" rx="4"/><path d="M18 27V14m0 0 6 4M19 34h14v8H19m20-7h3m-3 7h3M29 16h22v20m-18-14h12"/>' },
  Component: { label: '部件 · 芯片', color: '#ad9fe8', paths: '<rect x="20" y="20" width="24" height="24" rx="3"/><rect x="26" y="26" width="12" height="12" rx="1"/><path d="M25 14v6m7-6v6m7-6v6M25 44v6m7-6v6m7-6v6M14 25h6m-6 7h6m-6 7h6m24-14h6m-6 7h6m-6 7h6"/>' },
  Interface: { label: '接口 · 插接件', color: '#84c5c4', paths: '<path d="M22 15v12m8-12v12m-13 0h18v10a9 9 0 0 1-18 0V27Zm9 19v7m0-4h15a8 8 0 0 0 8-8v-8m-5 0h10v-9H44v9Z"/>' },
  Antenna: { label: '天线 · 发射塔', color: '#88d2a4', paths: '<path d="m24 51 8-29 8 29M27 39h10m-13 12h16M23 18a13 13 0 0 0 0 18m18-18a13 13 0 0 1 0 18M17 12a22 22 0 0 0 0 30m30-30a22 22 0 0 1 0 30"/><circle cx="32" cy="20" r="3"/>' },
  Function: { label: '功能 · 齿轮', color: '#77cfbd', paths: '<path d="m28 13-1 6-5 3-6-2-4 7 5 4v5l-5 4 4 7 6-2 5 3 1 6h8l1-6 5-3 6 2 4-7-5-4v-5l5-4-4-7-6 2-5-3-1-6Z"/><circle cx="32" cy="33" r="8"/>' },
  Parameter: { label: '参数 · 仪表', color: '#e6c578', paths: '<path d="M15 43a21 21 0 1 1 34 0M19 46h26M32 17v5m-14 1 4 4m24-4-4 4M32 36l10-9"/><circle cx="32" cy="36" r="3"/>' },
  Manufacturer: { label: '厂家 · 工厂', color: '#e9b48b', paths: '<path d="M13 50V28l13-8v12l12-8v10h13v16H13ZM17 25V13h8v8m-3 19h3m7 0h3m7 0h3M21 50v-4m10 4v-4m11 4v-4"/>' },
  WorkMode: { label: '工作模式 · 调节器', color: '#a8bbea', paths: '<path d="M17 15v34m15-34v34m15-34v34M12 25h10m5 14h10m5-17h10"/><rect x="12" y="22" width="10" height="6" rx="2"/><rect x="27" y="36" width="10" height="6" rx="2"/><rect x="42" y="19" width="10" height="6" rx="2"/>' },
  Node: { label: '节点 · 通信站点', color: '#69cdb2', paths: '<path d="m14 35 18-13 18 13M18 33v18h28V33M28 51V39h8v12M32 22V12m-6 3a8 8 0 0 0 0 10m12-10a8 8 0 0 1 0 10"/>' },
  Link: { label: '链路 · 链条', color: '#83bff1', paths: '<path d="m29 23 6-6a10 10 0 0 1 14 14l-8 8a10 10 0 0 1-14 0m8 2-6 6a10 10 0 0 1-14-14l8-8a10 10 0 0 1 14 0M25 39l14-14"/>' },
  Metric: { label: '运行指标 · 趋势仪表', color: '#9ed6a8', paths: '<path d="M15 14v36h37M21 40l9-13 8 7 11-17m-6 0h6v6M22 50v-3m10 3v-3m10 3v-3"/>' },
  LinkState: { label: '链路状态 · 指示面板', color: '#a3c8e8', paths: '<rect x="21" y="11" width="22" height="43" rx="6"/><circle cx="32" cy="21" r="4"/><circle cx="32" cy="32" r="4"/><circle cx="32" cy="43" r="4"/>' },
  NetworkRole: { label: '网络角色 · 层级站点', color: '#c2b7ee', paths: '<rect x="25" y="12" width="14" height="12" rx="3"/><rect x="11" y="41" width="14" height="12" rx="3"/><rect x="39" y="41" width="14" height="12" rx="3"/><path d="M32 24v9m-14 8v-8h28v8"/>' },
  NetRule: { label: '组网规则 · 规则盾牌', color: '#b6d28a', paths: '<path d="m32 11 19 8v14c0 10-9 17-19 21-10-4-19-11-19-21V19l19-8Zm-9 13h18m-18 7h10m-9 10 5 5 12-12"/>' },
  Fault: { label: '故障 · 警示', color: '#ef9d9e', paths: '<path d="m29 14-19 33a4 4 0 0 0 4 6h36a4 4 0 0 0 4-6L35 14a3 3 0 0 0-6 0ZM32 25v13m0 6v1"/>' },
  FaultType: { label: '故障类型 · 故障分类', color: '#e9ad87', paths: '<path d="M18 12h23l8 8v33H18V12Zm23 0v10h8M25 29h16m-16 7h7m-7 7h7m8-8v7m0 5v1"/>' },
  Symptom: { label: '现象 · 观测波形', color: '#e7b3da', paths: '<path d="M10 33h10l5-13 9 26 7-18 4 5h9M15 15h7m20 0h7M15 51h7m20 0h7"/>' },
  Cause: { label: '原因 · 查找', color: '#deb98b', paths: '<circle cx="28" cy="27" r="15"/><path d="m39 39 13 13M24 22a5 5 0 0 1 9 3c0 4-5 3-5 7m0 5v1"/>' },
  DiagnosisStep: { label: '诊断步骤 · 检查清单', color: '#9dcae0', paths: '<rect x="16" y="14" width="33" height="40" rx="4"/><path d="M25 14v-3h15v6H25v-3Zm-3 14 3 3 5-6m5 3h7M22 40l3 3 5-6m5 3h7"/>' },
  Solution: { label: '处置方案 · 检修工具', color: '#e4ca85', paths: '<path d="M42 12a12 12 0 0 0-15 15L13 41a7 7 0 0 0 10 10l14-14a12 12 0 0 0 15-15l-9 9-10-10 9-9Z"/><circle cx="19" cy="45" r="2"/>' },
  Tool: { label: '工具 · 工具箱', color: '#a8bddc', paths: '<rect x="11" y="25" width="42" height="27" rx="4"/><path d="M23 25v-9h18v9M11 35h42m-25-3h8v9h-8v-9Z"/>' },
  Spare: { label: '备件 · 部件包装', color: '#c5d59b', paths: '<path d="m12 22 20-10 20 10v25L32 56 12 47V22Zm0 0 20 10 20-10M32 32v24M22 17l20 10v10"/>' },
  Case: { label: '故障案例 · 案例档案', color: '#bfafe7', paths: '<path d="M12 47V18h15l6 6h19v13M12 25h35"/><circle cx="37" cy="40" r="11"/><path d="m45 48 8 8m-19-20h6m-6 5h6"/>' },
  ObjectType: { label: '故障对象类型 · 对象标签', color: '#97c7c1', paths: '<path d="M12 16h23l18 18-19 19-22-22V16Z"/><circle cx="23" cy="26" r="3"/><path d="m31 31 10 10m-15-5 10 10"/>' },
} as const;
const generic = { label: '其他知识实体 · 知识条目', color: '#adc2d4', paths: '<path d="M32 20c-7-6-15-6-23-3v31c8-3 16-3 23 3 7-6 15-6 23-3V17c-8-3-16-3-23 3Zm0 0v31M16 25h8m-8 7h8m16-7h8m-8 7h8"/>' };
const cache = new Map<string, { url: string; label: string; color: string }>();
export function knowledgeIcon(type: string) {
  const key = Object.prototype.hasOwnProperty.call(icons, type) ? type as keyof typeof icons : 'unknown';
  const existing = cache.get(key);
  if (existing) return existing;
  const icon = key === 'unknown' ? generic : icons[key];
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64" viewBox="0 0 64 64"><rect x="2" y="2" width="60" height="60" rx="14" fill="#112b40" stroke="${icon.color}" stroke-opacity=".55" stroke-width="1.5"/><g fill="none" stroke="${icon.color}" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">${icon.paths}</g></svg>`;
  const value = Object.freeze({ url: 'data:image/svg+xml;charset=UTF-8,' + encodeURIComponent(svg), label: icon.label, color: icon.color });
  cache.set(key, value);
  return value;
}

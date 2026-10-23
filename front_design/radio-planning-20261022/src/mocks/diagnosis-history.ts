import historicalNetworks from './planning.json';
import type { PlanVersion } from '../types/domain';
import type { DiagnosisRecord } from '../types/diagnosis';

// 内置历史报告直接采用当前契约；冻结网络与合法空值保留，不在运行时转换旧案例。
export const diagnosisHistory: DiagnosisRecord[] = [
  {
    "id": "DG-HW",
    "dataOrigin": "SAMPLE",
    "legacy": true,
    "scenarioId": "DG-HW",
    "scenarioVersion": "历史快照",
    "name": "硬件故障",
    "description": "",
    "faults": [],
    "network": historicalNetworks.plans[0] as unknown as PlanVersion,
    "startedAt": null,
    "completedAt": null,
    "diagnoseTaskId": null,
    "impactTaskId": null,
    "result": {
      "fusionMode": "TWO_WAY_DEGRADED",
      "disabledReason": "历史资料未提供机器学习结果",
      "conclusions": [
        {
          "fault": null,
          "label": "硬件故障",
          "faultType": "HW_FAILURE",
          "confidence": 0.9620000000000001,
          "rootCause": "Ⅱ双频机动站01 短波设备功放模块异常，导致上行链路中断。",
          "component": null,
          "needManualReview": null,
          "branches": [
            {
              "source": "RULE",
              "conclusion": "功放告警与功率异常同时满足",
              "confidence": 0.971,
              "weight": null,
              "contribution": null,
              "disabledReason": null,
              "evidence": []
            },
            {
              "source": "KG",
              "conclusion": "设备 — 链路 — 业务影响关系成立",
              "confidence": 0.953,
              "weight": null,
              "contribution": null,
              "disabledReason": null,
              "evidence": []
            },
            {
              "source": "ML",
              "conclusion": "当前样例未提供，降级展示规则与图谱的预设融合结果",
              "confidence": null,
              "weight": null,
              "contribution": null,
              "disabledReason": "原历史记录未提供该分支结果",
              "evidence": []
            }
          ],
          "candidates": [],
          "chain": [
            "功放模块异常",
            "发射能力下降",
            "PL-005 链路中断",
            "节点通信受影响"
          ]
        }
      ],
      "nodes": [
        {
          "nodeId": "ND-0007",
          "affectType": null,
          "level": null,
          "state": null,
          "reason": "直接影响 ND-0007；其下属设备通信存在中断风险。",
          "detourRoute": []
        }
      ],
      "links": [
        {
          "linkId": "PL-005",
          "level": null,
          "state": null,
          "faultKey": null,
          "bandwidthLossKbps": null,
          "isBackbone": null,
          "reason": "直接影响 ND-0007；其下属设备通信存在中断风险。"
        }
      ],
      "regions": [
        {
          "id": "IM-HW",
          "kind": "impact",
          "label": "硬件故障影响区",
          "rings": [
            [
              [
                114.05,
                37.47
              ],
              [
                114.11,
                37.45
              ],
              [
                114.16,
                37.5
              ],
              [
                114.13,
                37.56
              ],
              [
                114.06,
                37.55
              ],
              [
                114.05,
                37.47
              ]
            ]
          ],
          "level": null,
          "faultKey": null
        }
      ],
      "summary": null,
      "suggestions": [
        {
          "priority": 1,
          "action": "核查功放模块温度与供电",
          "applicability": "Ⅱ双频机动站01 短波设备功放模块异常，导致上行链路中断。",
          "steps": [],
          "spares": [],
          "tools": [],
          "estimatedTimeMin": null,
          "tripleIds": [],
          "similarCases": []
        },
        {
          "priority": 2,
          "action": "检查散热与连接状态",
          "applicability": "Ⅱ双频机动站01 短波设备功放模块异常，导致上行链路中断。",
          "steps": [],
          "spares": [],
          "tools": [],
          "estimatedTimeMin": null,
          "tripleIds": [],
          "similarCases": []
        },
        {
          "priority": 3,
          "action": "人工确认后更换故障设备并重新规划",
          "applicability": "Ⅱ双频机动站01 短波设备功放模块异常，导致上行链路中断。",
          "steps": [],
          "spares": [],
          "tools": [],
          "estimatedTimeMin": null,
          "tripleIds": [],
          "similarCases": []
        }
      ],
      "notes": [
        "内置历史记录；未提供完整故障输入、分路权重和结构化影响统计",
        "EV-01 · 功放温度：88 °C（预设阈值 80 °C）（预生成设备遥测）",
        "EV-02 · 发射功率反馈：低于设定值 12 dB（预生成设备遥测）",
        "EV-03 · 链路状态：PL-005 / FAULT（NET-DEMO-01）",
        "关联设备：DV-0067"
      ]
    },
    "source": {
      "state": "HISTORICAL",
      "reasons": []
    }
  },
  {
    "id": "DG-LINK",
    "dataOrigin": "SAMPLE",
    "legacy": true,
    "scenarioId": "DG-LINK",
    "scenarioVersion": "历史快照",
    "name": "链路中断",
    "description": "",
    "faults": [],
    "network": historicalNetworks.plans[0] as unknown as PlanVersion,
    "startedAt": null,
    "completedAt": null,
    "diagnoseTaskId": null,
    "impactTaskId": null,
    "result": {
      "fusionMode": "TWO_WAY_DEGRADED",
      "disabledReason": "历史资料未提供机器学习结果",
      "conclusions": [
        {
          "fault": null,
          "label": "链路中断",
          "faultType": "LINK_DOWN",
          "confidence": 0.934,
          "rootCause": "PL-005 心跳持续丢失，预设场景提示两端射频连接异常。",
          "component": null,
          "needManualReview": null,
          "branches": [
            {
              "source": "RULE",
              "conclusion": "连续丢包与心跳超时",
              "confidence": 0.946,
              "weight": null,
              "contribution": null,
              "disabledReason": null,
              "evidence": []
            },
            {
              "source": "KG",
              "conclusion": "端点连接异常可解释业务中断",
              "confidence": 0.9209999999999999,
              "weight": null,
              "contribution": null,
              "disabledReason": null,
              "evidence": []
            },
            {
              "source": "ML",
              "conclusion": "当前样例未提供，降级展示规则与图谱的预设融合结果",
              "confidence": null,
              "weight": null,
              "contribution": null,
              "disabledReason": "原历史记录未提供该分支结果",
              "evidence": []
            }
          ],
          "candidates": [],
          "chain": [
            "射频连接异常",
            "链路心跳丢失",
            "PL-005 不可用",
            "区域接入受损"
          ]
        }
      ],
      "nodes": [
        {
          "nodeId": "ND-0003",
          "affectType": null,
          "level": null,
          "state": null,
          "reason": "ND-0003 至 ND-0007 的业务连接受影响。",
          "detourRoute": []
        },
        {
          "nodeId": "ND-0007",
          "affectType": null,
          "level": null,
          "state": null,
          "reason": "ND-0003 至 ND-0007 的业务连接受影响。",
          "detourRoute": []
        }
      ],
      "links": [
        {
          "linkId": "PL-005",
          "level": null,
          "state": null,
          "faultKey": null,
          "bandwidthLossKbps": null,
          "isBackbone": null,
          "reason": "ND-0003 至 ND-0007 的业务连接受影响。"
        }
      ],
      "regions": [
        {
          "id": "IM-LINK",
          "kind": "impact",
          "label": "链路影响区",
          "rings": [
            [
              [
                114.05,
                37.48
              ],
              [
                114.15,
                37.46
              ],
              [
                114.2,
                37.51
              ],
              [
                114.09,
                37.54
              ],
              [
                114.05,
                37.48
              ]
            ]
          ],
          "level": null,
          "faultKey": null
        }
      ],
      "summary": null,
      "suggestions": [
        {
          "priority": 1,
          "action": "检查两端天线与馈线",
          "applicability": "PL-005 心跳持续丢失，预设场景提示两端射频连接异常。",
          "steps": [],
          "spares": [],
          "tools": [],
          "estimatedTimeMin": null,
          "tripleIds": [],
          "similarCases": []
        },
        {
          "priority": 2,
          "action": "确认设备工作频点一致",
          "applicability": "PL-005 心跳持续丢失，预设场景提示两端射频连接异常。",
          "steps": [],
          "spares": [],
          "tools": [],
          "estimatedTimeMin": null,
          "tripleIds": [],
          "similarCases": []
        },
        {
          "priority": 3,
          "action": "恢复后由后台重新检测链路",
          "applicability": "PL-005 心跳持续丢失，预设场景提示两端射频连接异常。",
          "steps": [],
          "spares": [],
          "tools": [],
          "estimatedTimeMin": null,
          "tripleIds": [],
          "similarCases": []
        }
      ],
      "notes": [
        "内置历史记录；未提供完整故障输入、分路权重和结构化影响统计",
        "EV-L1 · 心跳超时：连续 60 s（故障场景注入快照）",
        "EV-L2 · 链路丢包：100%（预生成监测结果）",
        "关联设备：DV-0027、DV-0067"
      ]
    },
    "source": {
      "state": "HISTORICAL",
      "reasons": []
    }
  },
  {
    "id": "DG-CONFIG",
    "dataOrigin": "SAMPLE",
    "legacy": true,
    "scenarioId": "DG-CONFIG",
    "scenarioVersion": "历史快照",
    "name": "配置异常",
    "description": "",
    "faults": [],
    "network": historicalNetworks.plans[0] as unknown as PlanVersion,
    "startedAt": null,
    "completedAt": null,
    "diagnoseTaskId": null,
    "impactTaskId": null,
    "result": {
      "fusionMode": "TWO_WAY_DEGRADED",
      "disabledReason": "历史资料未提供机器学习结果",
      "conclusions": [
        {
          "fault": null,
          "label": "配置异常",
          "faultType": "SW_CONFIG",
          "confidence": 0.9179999999999999,
          "rootCause": "预设故障场景中 DV-0037 工作频点与规划频点不一致。",
          "component": null,
          "needManualReview": null,
          "branches": [
            {
              "source": "RULE",
              "conclusion": "工作频点偏离方案记录",
              "confidence": 0.95,
              "weight": null,
              "contribution": null,
              "disabledReason": null,
              "evidence": []
            },
            {
              "source": "KG",
              "conclusion": "参数差异关联链路质量波动",
              "confidence": 0.8859999999999999,
              "weight": null,
              "contribution": null,
              "disabledReason": null,
              "evidence": []
            },
            {
              "source": "ML",
              "conclusion": "当前样例未提供，降级展示规则与图谱的预设融合结果",
              "confidence": null,
              "weight": null,
              "contribution": null,
              "disabledReason": "原历史记录未提供该分支结果",
              "evidence": []
            }
          ],
          "candidates": [],
          "chain": [
            "频点配置差异",
            "两端接收失配",
            "链路质量下降",
            "业务间歇异常"
          ]
        }
      ],
      "nodes": [
        {
          "nodeId": "ND-0004",
          "affectType": null,
          "level": null,
          "state": null,
          "reason": "影响 PL-002，可能降低区域链路可用性。",
          "detourRoute": []
        }
      ],
      "links": [
        {
          "linkId": "PL-002",
          "level": null,
          "state": null,
          "faultKey": null,
          "bandwidthLossKbps": null,
          "isBackbone": null,
          "reason": "影响 PL-002，可能降低区域链路可用性。"
        }
      ],
      "regions": [
        {
          "id": "IM-CONFIG",
          "kind": "impact",
          "label": "配置异常影响区",
          "rings": [
            [
              [
                114.23,
                37.23
              ],
              [
                114.32,
                37.19
              ],
              [
                114.39,
                37.26
              ],
              [
                114.31,
                37.33
              ],
              [
                114.23,
                37.23
              ]
            ]
          ],
          "level": null,
          "faultKey": null
        }
      ],
      "summary": null,
      "suggestions": [
        {
          "priority": 1,
          "action": "比对设备参数与方案快照",
          "applicability": "预设故障场景中 DV-0037 工作频点与规划频点不一致。",
          "steps": [],
          "spares": [],
          "tools": [],
          "estimatedTimeMin": null,
          "tripleIds": [],
          "similarCases": []
        },
        {
          "priority": 2,
          "action": "由操作人员修正参数",
          "applicability": "预设故障场景中 DV-0037 工作频点与规划频点不一致。",
          "steps": [],
          "spares": [],
          "tools": [],
          "estimatedTimeMin": null,
          "tripleIds": [],
          "similarCases": []
        },
        {
          "priority": 3,
          "action": "重新采集状态后复核",
          "applicability": "预设故障场景中 DV-0037 工作频点与规划频点不一致。",
          "steps": [],
          "spares": [],
          "tools": [],
          "estimatedTimeMin": null,
          "tripleIds": [],
          "similarCases": []
        }
      ],
      "notes": [
        "内置历史记录；未提供完整故障输入、分路权重和结构化影响统计",
        "EV-C1 · 规划频点：6500 kHz（PLAN-V1 / PL-002）",
        "EV-C2 · 场景工作频点：6600 kHz（独立故障注入预设）",
        "关联设备：DV-0037"
      ]
    },
    "source": {
      "state": "HISTORICAL",
      "reasons": []
    }
  },
  {
    "id": "DG-EMI",
    "dataOrigin": "SAMPLE",
    "legacy": true,
    "scenarioId": "DG-EMI",
    "scenarioVersion": "历史快照",
    "name": "电磁干扰",
    "description": "",
    "faults": [],
    "network": historicalNetworks.plans[0] as unknown as PlanVersion,
    "startedAt": null,
    "completedAt": null,
    "diagnoseTaskId": null,
    "impactTaskId": null,
    "result": {
      "fusionMode": "TWO_WAY_DEGRADED",
      "disabledReason": "历史资料未提供机器学习结果",
      "conclusions": [
        {
          "fault": null,
          "label": "电磁干扰",
          "faultType": "EMI",
          "confidence": 0.895,
          "rootCause": "预设频段噪声抬升，与相邻区域干扰事件的时间窗口重合。",
          "component": null,
          "needManualReview": null,
          "branches": [
            {
              "source": "RULE",
              "conclusion": "噪声底抬升与误码增加",
              "confidence": 0.882,
              "weight": null,
              "contribution": null,
              "disabledReason": null,
              "evidence": []
            },
            {
              "source": "KG",
              "conclusion": "干扰事件与频段重叠",
              "confidence": 0.9079999999999999,
              "weight": null,
              "contribution": null,
              "disabledReason": null,
              "evidence": []
            },
            {
              "source": "ML",
              "conclusion": "当前样例未提供，降级展示规则与图谱的预设融合结果",
              "confidence": null,
              "weight": null,
              "contribution": null,
              "disabledReason": "原历史记录未提供该分支结果",
              "evidence": []
            }
          ],
          "candidates": [],
          "chain": [
            "同频段干扰",
            "信噪比下降",
            "PL-003 误码增加",
            "业务质量受损"
          ]
        }
      ],
      "nodes": [
        {
          "nodeId": "ND-0004",
          "affectType": null,
          "level": null,
          "state": null,
          "reason": "影响 ND-0004 与 ND-0005 间链路质量。",
          "detourRoute": []
        },
        {
          "nodeId": "ND-0005",
          "affectType": null,
          "level": null,
          "state": null,
          "reason": "影响 ND-0004 与 ND-0005 间链路质量。",
          "detourRoute": []
        }
      ],
      "links": [
        {
          "linkId": "PL-003",
          "level": null,
          "state": null,
          "faultKey": null,
          "bandwidthLossKbps": null,
          "isBackbone": null,
          "reason": "影响 ND-0004 与 ND-0005 间链路质量。"
        }
      ],
      "regions": [
        {
          "id": "IM-EMI",
          "kind": "impact",
          "label": "干扰影响区",
          "rings": [
            [
              [
                114.31,
                37.34
              ],
              [
                114.43,
                37.27
              ],
              [
                114.67,
                37.49
              ],
              [
                114.76,
                37.68
              ],
              [
                114.64,
                37.73
              ],
              [
                114.47,
                37.57
              ],
              [
                114.31,
                37.34
              ]
            ]
          ],
          "level": null,
          "faultKey": null
        }
      ],
      "summary": null,
      "suggestions": [
        {
          "priority": 1,
          "action": "核查频谱监测记录",
          "applicability": "预设频段噪声抬升，与相邻区域干扰事件的时间窗口重合。",
          "steps": [],
          "spares": [],
          "tools": [],
          "estimatedTimeMin": null,
          "tripleIds": [],
          "similarCases": []
        },
        {
          "priority": 2,
          "action": "确认干扰时段与位置",
          "applicability": "预设频段噪声抬升，与相邻区域干扰事件的时间窗口重合。",
          "steps": [],
          "spares": [],
          "tools": [],
          "estimatedTimeMin": null,
          "tripleIds": [],
          "similarCases": []
        },
        {
          "priority": 3,
          "action": "选用其他预设频点重新规划",
          "applicability": "预设频段噪声抬升，与相邻区域干扰事件的时间窗口重合。",
          "steps": [],
          "spares": [],
          "tools": [],
          "estimatedTimeMin": null,
          "tripleIds": [],
          "similarCases": []
        }
      ],
      "notes": [
        "内置历史记录；未提供完整故障输入、分路权重和结构化影响统计",
        "EV-E1 · 噪声底抬升：14 dB（预生成频谱观测）",
        "EV-E2 · 重叠频段：6900–7100 kHz（独立干扰场景快照）",
        "关联设备：DV-0037、DV-0047"
      ]
    },
    "source": {
      "state": "HISTORICAL",
      "reasons": []
    }
  }
];


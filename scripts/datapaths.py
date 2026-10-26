"""数据文件在仓库中的落位。

目录结构与文件命名遵循 data/README.md；字段定义见 docs/design/01_数据字典.md。
脚本内部仍用简称（如 "node.csv"）引用数据集，只在本文件做一次到实际路径的映射，
以后调整目录只改这里。
"""
import os

DATA = os.path.normpath(
    os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "data"))

# 简称 -> 相对 data/ 的路径
PATHS = {
    "node.csv":                "synthetic/nodes/nodes_v1.csv",
    "device.csv":              "synthetic/nodes/devices_v1.csv",
    "device_model.csv":        "synthetic/nodes/device_models_v1.csv",
    "antenna_model.csv":       "synthetic/nodes/antenna_models_v1.csv",
    "task_scenario.csv":       "synthetic/tasks/task_scenarios_v1.csv",
    "comm_demand.csv":         "synthetic/tasks/task_links_v1.csv",
    "frequency_resource.csv":  "synthetic/frequency/frequency_resources_v1.csv",
    "interference_source.csv": "synthetic/interference/interference_sources_v1.csv",
    "link.csv":                "synthetic/topology/topology_links_v1.csv",
    "candidate_site.csv":      "synthetic/nodes/candidate_sites_v1.csv",
    "route.json":              "synthetic/topology/routes_v1.json",
    "frequency_conflict.csv":  "synthetic/topology/frequency_conflicts_v1.csv",
    "link_metric.csv":         "synthetic/link_status/link_status_v1.csv",
    "fault_case.csv":          "fault/cases/fault_cases_v1.csv",
    "fault_rule.csv":          "fault/rules/fault_rules_v1.csv",
    "fault_scenario.json":     "fault/cases/fault_scenarios_v1.json",
    "symptom_dict.csv":        "dictionary/symptom_dict_v1.csv",
}

# 人工整理的原始资料（不由脚本生成）
RAW_DEVICE_MODEL = os.path.join(DATA, "raw", "equipment_docs", "device_model.csv")
RAW_ANTENNA_MODEL = os.path.join(DATA, "raw", "equipment_docs", "antenna_model.csv")


def path(name):
    """按简称取绝对路径。"""
    return os.path.join(DATA, PATHS[name])

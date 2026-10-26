"""SR5 导出呈现的定向门禁，不运行规划或两阶段诊断。"""
from contextlib import nullcontext
from copy import deepcopy
import io
import json
from pathlib import Path
import sys
from types import SimpleNamespace
import xml.etree.ElementTree as ET
from zipfile import ZipFile

import pytest

# 与既有服务专项一致，允许从仓库根目录独立收集。
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "algorithm-service"))
from app import fault, fault_frontend_service


@pytest.fixture
def content():
    return {
        "scenario_id": "SCENE-A", "generated_at": "2026-10-25T00:00:00Z", "data_source": "CONSTRUCTED",
        "scenario": {"scenario_name": "构造故障", "faults": [{"object_type": "DEVICE", "object_id": "D1", "symptom_ids": ["SYM1"], "occur_time": None}]},
        "diagnosis": {"network_solution_id": "P", "network_task_id": "T", "network_revision": "PR1",
            "network_resource_revision": "resource-1111111111111111", "knowledge_version": "KG1", "results": [{
                "fault_object": {"object_type": "DEVICE", "object_id": "D1"}, "fault_component": None,
                "fused": {"fault_type": "HW_FAILURE", "root_cause": None, "confidence": 0, "need_manual_review": False},
                "branches": [
                    {"source": "RULE", "fault_type": "HW_FAILURE", "confidence": .8, "evidence": {"rule_ids": ["RULE1"], "match_kind": "EXACT", "source_case_ids": ["CASE1"], "source": "CONSTRUCTED"}},
                    {"source": "KG", "fault_type": "HW_FAILURE", "confidence": .7, "evidence": {"case_id": "CASE1", "triple_ids": ["TR1"], "source_docs": ["DOC1"],
                        "equally_supported_cases": ["CASE1"], "candidate_rankings": [{"case_id": f"CASE{i}", "fault_type": "HW_FAILURE", "score": .7, "matched_symptom_count": 1} for i in range(20)]}},
                    {"source": "ML", "fault_type": None, "confidence": None, "disabled_reason": "尚无经独立验证的模型", "evidence": {}},
                ],
            }]},
        "impact": {"scenario_id": "SCENE-A", "network_solution_id": "P", "network_task_id": "T",
            "affected_nodes": [{"node_id": "N1", "state": "INTERRUPTED", "level": "SEVERE", "reason": "直接影响"},
                               {"node_id": "N2", "state": "DEGRADED", "level": "MODERATE", "reason": "间接影响"}],
            "affected_links": [{"link_id": "L1", "state": "INTERRUPTED", "level": "SEVERE", "reason": "构造链路故障"}],
            "impact_scope": {"features": [{"geometry": {"type": "Point", "coordinates": [114, 37]}, "properties": {"node_id": "N1", "state": "INTERRUPTED"}}]},
            "summary": {"affected_node_count": 2, "direct_count": 1, "indirect_count": 1, "interrupted_node_count": 1,
                        "degraded_node_count": 1, "affected_link_count": 1, "total_bandwidth_loss_kbps": 0, "affected_mandatory_demand_ids": []}},
        "suggestions": {"suggestions": [{"priority": 1, "action": "核查设备", "source": "RULE", "steps": ["确认现场", "检查设备"],
                                        "required_tools": [], "required_spares": [], "estimated_time_min": None, "kg_source_triple_ids": ["TR1"]}]},
    }


@pytest.fixture
def network():
    return {"id": "P", "taskId": "T", "snapshotId": "SNAP1", "inputSnapshot": {"stations": [
        {"id": "N1", "coordinate": [114, 37]}, {"id": "N2", "coordinate": [114.02, 37.01]},
        {"id": "N3", "coordinate": [114.04, 37]},
    ]}, "links": [{"id": "L1", "a": "N1", "b": "N2"}, {"id": "L2", "a": "N2", "b": "N3"}]}


def flattened(sections):
    return "\n".join([title + "\n" + "\n".join(f"{key}：{value}" for key, value in rows) for title, rows in sections])


def test_structured_chinese_summary_preserves_machine_data(content):
    before = json.dumps(content, ensure_ascii=False, sort_keys=True)
    text = flattened(fault._report_sections(content, {"run_id": "RUN1", "snapshot_id": "SNAP1", "diagnose_task_id": "DT1"}))
    for expected in ("来源与场景", "运行编号：RUN1", "网络快照：SNAP1", "发生时间：未提供", "根因：未提供",
                     "故障类型：设备硬件故障（HW_FAILURE）", "融合得分：0.000", "需要人工研判：否", "规则编号：RULE1", "精确匹配", "来源文档：DOC1",
                     "三元组编号：TR1", "候选案例数：20", "另 15 项见同运行 JSON", "机器学习依据", "受影响节点数：2", "速率损失 / kbit/s：0"):
        assert expected in text
    assert "None" not in text and "candidate_rankings" not in text and "{'" not in text
    assert json.dumps(content, ensure_ascii=False, sort_keys=True) == before
    assert len(content["diagnosis"]["results"][0]["branches"][1]["evidence"]["candidate_rankings"]) == 20


def test_docx_uses_shared_sections_and_unprovided_values(content, tmp_path):
    path = tmp_path / "readable.docx"
    fault._report_docx(content, path, source={"run_id": "RUN1"})
    with ZipFile(path) as archive:
        xml = ET.fromstring(archive.read("word/document.xml"))
        text = "\n".join(node.text or "" for node in xml.iter("{http://schemas.openxmlformats.org/wordprocessingml/2006/main}t"))
        assert "宋体" in archive.read("word/styles.xml").decode("utf-8")
    assert "规则推理依据" in text and "知识图谱依据" in text and "影响统计" in text
    assert "根因：未提供" in text and "发生时间：未提供" in text and "None" not in text and "{'" not in text


def test_pdf_receives_readable_paragraphs_without_dict_dump(content, tmp_path, monkeypatch):
    from reportlab.platypus import SimpleDocTemplate
    original, observed = SimpleDocTemplate.build, []

    def build(document, flowables, *args, **kwargs):
        observed.extend(item.getPlainText() for item in flowables if hasattr(item, "getPlainText"))
        return original(document, flowables, *args, **kwargs)

    monkeypatch.setattr(SimpleDocTemplate, "build", build)
    path = tmp_path / "readable.pdf"
    fault._report_pdf(content, path, source={"run_id": "RUN1"})
    text = "\n".join(observed)
    assert path.read_bytes().startswith(b"%PDF")
    assert "发生时间：未提供" in text and "根因：未提供" in text and "规则编号：RULE1" in text
    assert "None" not in text and "candidate_rankings" not in text and "{'" not in text


def test_plot_uses_only_real_frozen_nodes_and_endpoint_links(content, network):
    before = deepcopy((content, network))
    geometry = fault._impact_geometry(content["impact"], network)
    assert {row["id"] for row in geometry["nodes"]} == {"N1", "N2", "N3"}
    assert {row["id"] for row in geometry["links"]} == {"L1", "L2"}
    assert geometry["nodes"][2]["state"] is None
    assert geometry["links"][1]["state"] is None
    assert geometry["nodes"][0]["coordinate"] == (114, 37)
    assert (content, network) == before


def test_missing_coordinates_and_unbound_links_are_not_fabricated(content, network):
    network["inputSnapshot"]["stations"].append({"id": "N4", "coordinate": None})
    network["links"].append({"id": "L3", "a": "N4", "b": "N1"})
    content["impact"]["affected_links"].append({"link_id": "L3", "state": "DEGRADED"})
    geometry = fault._impact_geometry(content["impact"], network)
    assert geometry["missing_coordinates"] == 1 and geometry["unlocated_links"] == 1
    assert "N4" not in {row["id"] for row in geometry["nodes"]}
    assert "L3" not in {row["id"] for row in geometry["links"]}
    fallback = fault._impact_geometry(content["impact"])
    assert [row["id"] for row in fallback["nodes"]] == ["N1"] and fallback["links"] == []


def test_foreign_network_is_rejected(content, network):
    network["id"] = "OTHER"
    with pytest.raises(ValueError, match="冻结方案"):
        fault._impact_geometry(content["impact"], network)


@pytest.mark.parametrize("kind", ["task", "snapshot"])
def test_foreign_task_or_snapshot_is_rejected_before_render(content, network, kind):
    source = {"snapshot_id": "SNAP1"}
    if kind == "task":
        network["taskId"] = "OTHER"
    else:
        source["snapshot_id"] = "OTHER"
    with pytest.raises(ValueError, match="冻结任务|网络快照"):
        fault._impact_png(content["impact"], network, source)


def test_png_contains_real_topology_pixels_source_and_legend(content, network):
    from PIL import Image
    try:
        fault._impact_font(12)
    except RuntimeError:
        pytest.skip("此环境无已有中文字体，不能将缺字图片登记通过")
    value, mime = fault._impact_png(content["impact"], network, {"run_id": "RUN1", "snapshot_id": "SNAP1"})
    image = Image.open(io.BytesIO(value)).convert("RGB")
    assert mime == "image/png" and image.info["Title"] == "故障影响示意"
    assert image.info["PlanId"] == "P" and image.info["SnapshotId"] == "SNAP1"
    assert image.info["RenderedNodes"] == "3" and image.info["RenderedLinks"] == "2"
    plot = image.crop((30, 132, 870, 520))
    colors = plot.getcolors(plot.width * plot.height)
    assert sum(count for count, color in colors if color == (200, 56, 50)) > 150
    assert sum(count for count, color in colors if color == (230, 170, 57)) > 30
    assert sum(count for count, color in colors if color == (164, 173, 183)) > 30


def test_missing_chinese_font_fails_instead_of_producing_garbled_png(monkeypatch):
    monkeypatch.setattr(fault.Path, "is_file", lambda self: False)
    with pytest.raises(RuntimeError, match="中文字体"):
        fault._impact_font(12)


def test_png_prefers_existing_shared_delivery_font(monkeypatch):
    from PIL import ImageFont
    expected = fault.ROOT / "front_design/radio-planning-20261022/public/fonts/NotoSansCJKsc-Regular.otf"
    observed, marker = [], object()
    monkeypatch.setattr(fault.Path, "is_file", lambda self: True)

    def load(path, size):
        observed.append((path, size))
        return marker

    monkeypatch.setattr(ImageFont, "truetype", load)
    assert fault._impact_font(14) is marker
    assert observed == [(str(expected), 14)]


def test_workbench_passes_same_run_network_and_keeps_json_unchanged(content, network, monkeypatch):
    record = {"id": "RUN1", "scenarioVersion": "SV1", "network": deepcopy(network), "result": {"machine": {"raw": [1, None, False]}}}
    row = SimpleNamespace(id="RUN1", task_id="T", plan_id="P", diagnose_task_id="DT1", impact_task_id="IT1",
                          diagnosis={"result": content["diagnosis"]}, impact={"result": content["impact"]})
    monkeypatch.setattr(fault_frontend_service, "report", lambda rid: deepcopy(record))
    monkeypatch.setattr(fault_frontend_service, "get_session_factory", lambda: lambda: nullcontext(object()))
    monkeypatch.setattr(fault_frontend_service, "_get_run", lambda session, rid: row)
    observed = []

    def export(tid, fmt, **kwargs):
        observed.append((tid, fmt, kwargs))
        return b"png-probe", "image/png"

    monkeypatch.setattr(fault, "export_impact", export)
    assert fault_frontend_service.export_file("RUN1", "impact", "png")[0] == b"png-probe"
    assert observed[0][0] == "IT1" and observed[0][2]["network"] == network
    assert observed[0][2]["source"]["snapshot_id"] == "SNAP1"
    exported, mime = fault_frontend_service.export_file("RUN1", "report", "json")
    assert mime == "application/json" and json.loads(exported) == record
    assert len(observed) == 1

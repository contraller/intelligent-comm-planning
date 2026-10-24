"""中文目录与检索的服务层验证；仅新临时库，不连接运行服务。"""
from __future__ import annotations

from copy import deepcopy
from pathlib import Path
import sys
from types import SimpleNamespace

import pytest
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "scripts"))
sys.path.insert(0, str(ROOT / "algorithm-service"))

from app import database, kg, kg_display as display, kg_frontend_service as facade
from app import kg_workflow_service as workflow
from app.kg_models import KgAudit, KgChange, KgReceipt, KgSubmission, KgVersion, KgWorkspace
from diagnosis.kg_store import ENTITY_TYPES, RELATIONS, KnowledgeGraph
from diagnosis.sr6 import build_graph


MODELS = (KgWorkspace, KgVersion, KgChange, KgSubmission, KgAudit, KgReceipt)


@pytest.fixture(scope="module")
def graph():
    return build_graph()[0]


@pytest.fixture(scope="module")
def isolated_database(tmp_path_factory, graph):
    directory = tmp_path_factory.mktemp("chinese-kg")
    assert directory.resolve().is_relative_to((ROOT / "data/runtime/tmp").resolve())
    path = directory / "chinese-kg.sqlite"
    assert not path.exists()
    engine = create_engine("sqlite:///" + str(path))
    database.Base.metadata.create_all(engine, tables=[model.__table__ for model in MODELS])
    factory = sessionmaker(bind=engine, autoflush=False, expire_on_commit=False)
    entity = facade._entity(next(e for e in graph.entities.values() if e["name"] == "voice"))
    draft = {"baseVersionId": "KGV-1", "summary": "构造历史草稿",
             "entities": [entity], "relations": []}
    with factory.begin() as session:
        session.add(KgWorkspace(id=1, current_version=1, revision=1))
        session.add(KgVersion(version=1, parent_version=None, restored_from=None, created_at=1,
                              note="构造中文检索基线", snapshot=graph._snapshot(), stats=graph.stats()))
        session.add(KgChange(change_id="constructed-draft", state="DRAFT", revision=1,
                             base_version=1, ops=[], submitter="fixture-editor", note=draft["summary"],
                             created_at=1, updated_at=1, frontend_content={"draft": draft}))
    try:
        yield SimpleNamespace(factory=factory, path=path, directory=directory, draft=draft)
    finally:
        engine.dispose()


@pytest.fixture
def env(isolated_database, monkeypatch):
    for module in (database, workflow, facade):
        monkeypatch.setattr(module, "get_session_factory", lambda: isolated_database.factory)
    legacy = isolated_database.directory / "absent-legacy.json"
    monkeypatch.setattr(kg, "STORE_PATH", legacy)
    before = isolated_database.path.read_bytes()
    yield isolated_database
    assert isolated_database.path.read_bytes() == before, "中文读取不得改变已保存数据库"
    assert not legacy.exists(), "不得写回旧图谱文件"


def search(term, **query):
    return facade.browse("search", {"versionId": "KGV-1", "search": term,
                                    "pageSize": "50", **query})


def projected(eid, name, etype="Device"):
    return facade._entity({"eid": eid, "name": name, "type": etype, "attrs": {}})


def test_metadata_covers_real_ontology_with_chinese_names_and_original_ids(env, graph):
    assert set(display.ENTITY_TYPE_NAMES) == ENTITY_TYPES
    assert set(display.RELATION_TYPE_NAMES) == RELATIONS
    result = facade.metadata()
    assert [t["id"] for t in result["types"]] == sorted(ENTITY_TYPES)
    assert [r["id"] for r in result["relationTypes"]] == sorted(RELATIONS)
    for row in result["types"] + result["relationTypes"]:
        assert any("\u4e00" <= c <= "\u9fff" for c in row["name"])
        assert "未配置" not in row["name"]
    assert {t["id"]: t["name"] for t in result["types"]} == display.ENTITY_TYPE_NAMES
    assert {r["id"]: r["name"] for r in result["relationTypes"]} == display.RELATION_TYPE_NAMES
    assert result["models"] == [{"id": e["name"], "name": e["name"]}
                                 for e in graph.entities.values() if e["type"] == "DeviceModel"]
    for key, value in {"Case": "故障案例", "WorkMode": "工作模式", "ObjectType": "故障对象类型",
                       "Manufacturer": "厂家", "Metric": "运行指标"}.items():
        assert display.type_name(key) == value
    assert display.relation_name("hasSymptom") == "具有现象"
    assert display.relation_name("producedBy") == "生产方"


def test_real_builder_attribute_keys_and_enum_names_have_explicit_aliases(graph):
    assert {key for e in graph.entities.values() for key in e["attrs"]} <= display.ATTRIBUTE_NAMES.keys()
    for etype, names in display.ENTITY_NAME_ALIASES.items():
        actual = {e["name"] for e in graph.entities.values() if e["type"] == etype}
        assert names.keys() <= actual
        for name, alias in names.items():
            assert alias in display.search_aliases(projected("fixture", name, etype))


@pytest.mark.parametrize("term,etype,name", [
    ("语音", "Function", "voice"), ("数据", "Function", "data"),
    ("设备硬件故障", "FaultType", "HW_FAILURE"), ("电磁干扰", "FaultType", "EMI"),
    ("链路中断", "FaultType", "LINK_DOWN"), ("软件配置异常", "FaultType", "SW_CONFIG"),
    ("优秀", "LinkState", "EXCELLENT"), ("良好", "LinkState", "GOOD"),
    ("预警", "LinkState", "WARNING"), ("故障", "LinkState", "FAULT"),
    ("背负式短波电台", "NetworkRole", "MANPACK"),
    ("Ⅱ双频机动节点站", "NetworkRole", "II_NODE"),
    ("跳频", "WorkMode", "frequency hopping"), ("常规", "WorkMode", "Conventional"),
    ("集群", "WorkMode", "Trunking"), ("模拟调频", "WorkMode", "Analog FM"),
    ("短波 信噪比 LR-0001", "Metric", "HF:snr_db:LR-0001"),
    ("超短波 吞吐率 LR-0028", "Metric", "VUHF:throughput_kbps:LR-0028"),
    ("最低频率=1600", "Parameter", "freq_min_khz=1600"),
    ("带宽=", "Parameter", "bandwidth_khz="),
    ("设备 DV-0001", "Device", "DV-0001"),
    ("设备型号 DM-0001", "DeviceModel", "DM-0001"),
    ("天线 AM-0001", "Antenna", "AM-0001"),
    ("故障 FC-0001", "Fault", "FC-0001"), ("故障案例 FC-0001", "Case", "FC-0001"),
    ("节点 ND-0001", "Node", "ND-0001"), ("链路 LK-0001", "Link", "LK-0001"),
    ("天线挂高", "Device", "DV-0001"),
    ("最大发射功率", "DeviceModel", "DM-0001"),
    ("中继能力", "Node", "ND-0001"),
    ("构造数据", "Function", "voice"),
])
def test_chinese_search_uses_real_builder_data_without_rewriting_results(env, term, etype, name):
    result = search(term, type=etype)
    assert result["code"] == 0
    assert name in {e["name"] for e in result["items"]}
    assert all(e["type"] == etype for e in result["items"])
    assert all(set(e) == {"id", "name", "category", "type"} for e in result["items"])


@pytest.mark.parametrize("term,etype,name", [
    ("VOICE", "Function", "voice"), ("HW_FAILURE", "FaultType", "HW_FAILURE"),
    ("HF:snr_db:LR-0001", "Metric", "HF:snr_db:LR-0001"),
    ("freq_min_khz=1600", "Parameter", "freq_min_khz=1600"),
    ("AN/PRC-150(C)", "DeviceModel", "DM-0001"),
    ("DM-0001", "DeviceModel", "DM-0001"), ("ALE", "WorkMode", "ALE"),
    ("Harris Corporation", "Manufacturer", "Harris Corporation"),
    ("CONSTRUCTED", "Function", "voice"),
])
def test_original_text_model_names_and_protocols_remain_searchable(env, term, etype, name):
    assert name in {e["name"] for e in search(term, type=etype)["items"]}


@pytest.mark.parametrize("relation_type", sorted(RELATIONS))
def test_every_relation_alias_matches_both_incident_endpoints_only(monkeypatch, relation_type):
    snap = {"entities": [projected("a", "CUSTOM-A"), projected("b", "CUSTOM-B"),
                         projected("outside", "CUSTOM-OUTSIDE")],
            "relations": [{"id": "raw-relation-id", "head": "a", "tail": "b",
                           "type": relation_type, "source": "sample.csv [CONSTRUCTED]", "weight": None}]}
    before = deepcopy(snap)
    monkeypatch.setattr(facade, "snapshot", lambda version: snap)
    for term in (relation_type, display.relation_name(relation_type), "构造数据", "CONSTRUCTED"):
        result = search(term)
        assert {e["id"] for e in result["items"]} == {"a", "b"}
        assert result["total"] == 2
    graph_result = facade.browse("graph", {"versionId": "KGV-1", "search": display.relation_name(relation_type)})
    assert set(graph_result["matchedIds"]) == {"a", "b"}
    assert graph_result["relations"] == snap["relations"]
    assert snap == before


def test_real_relation_search_keeps_category_type_and_paging_constraints(env, graph):
    expected = {r[end] for r in graph.triples.values() if r["relation"] == "hasSymptom"
                for end in ("head", "tail")}
    result = search("具有现象", categories="故障运维知识", pageSize="5")
    assert result["total"] == len(expected)
    assert len(result["items"]) == 5
    assert {e["id"] for e in result["items"]} <= expected
    second = search("具有现象", categories="故障运维知识", pageSize="5", pageNum="2")
    assert {e["id"] for e in result["items"]}.isdisjoint(e["id"] for e in second["items"])
    assert search("具有现象", type="Symptom")["total"] == len(
        [eid for eid in expected if graph.entities[eid]["type"] == "Symptom"])
    assert search("具有现象", categories="设备知识")["total"] == 0
    assert search("无此中文检索词")["code"] == 4001


def test_node_subtype_alias_searches_node_attributes(env, graph):
    for name, alias in display.NETWORK_ROLES.items():
        expected = {e["eid"] for e in graph.entities.values()
                    if e["type"] == "Node" and e["attrs"].get("node_subtype") == name}
        assert expected
        result = search(alias, type="Node")
        assert result["total"] == len(expected)
        found = {e["id"] for e in result["items"]}
        for page in range(2, (result["total"] + 49) // 50 + 1):
            found.update(e["id"] for e in search(alias, type="Node", pageNum=str(page))["items"])
        assert found == expected


def test_aliases_remain_within_requested_version_and_support_device_browse(env, monkeypatch):
    assert facade.browse("device", {"versionId": "KGV-1", "modelId": "DM-0001", "search": "语音"})["items"]
    versions = {"KGV-1": {"entities": [projected("old", "voice", "Function")], "relations": []},
                "KGV-2": {"entities": [projected("new", "data", "Function")], "relations": []}}
    monkeypatch.setattr(facade, "snapshot", lambda version: versions[version])
    assert search("语音")["total"] == 1
    assert search("语音", versionId="KGV-2")["total"] == 0
    assert search("数据", versionId="KGV-2")["items"][0]["name"] == "data"


def test_unknown_custom_names_are_not_guessed_or_replaced(monkeypatch):
    entity = projected("custom", "UnlistedVendor voice DMR X-9900", "Manufacturer")
    entity["attributes"] = [{"name": "custom_field", "value": "data CONSTRUCTED", "unit": None}]
    before = deepcopy(entity)
    aliases = display.search_aliases(entity)
    assert aliases == {"厂家"}
    assert display.type_name("CustomType") == "未配置中文名称（原文：CustomType）"
    assert display.relation_name("customRelation") == "未配置中文名称（原文：customRelation）"
    for name in ("DMR", "ALE", "IP Site Connect", "Capacity Plus", "Capacity Max"):
        assert display.search_aliases(projected("protocol", name, "WorkMode")) == {"工作模式"}
    entity["source"] = "NOT_CONSTRUCTED"
    assert "构造数据" not in display.search_aliases(entity)
    entity["source"] = before["source"]
    monkeypatch.setattr(facade, "snapshot", lambda version: {"entities": [entity], "relations": []})
    assert search("UnlistedVendor")["items"][0]["name"] == before["name"]
    assert search("语音")["total"] == 0
    assert entity == before


def test_read_views_and_historical_drafts_preserve_raw_values(env, graph):
    before = deepcopy(graph._snapshot())
    snapshot = facade.snapshot("KGV-1")
    facade.metadata()
    search("构造数据")
    for e in snapshot["entities"]:
        detail = facade.browse("entity", {"versionId": "KGV-1", "entityId": e["id"]}) if e["name"] == "voice" else None
        raw = before["entities"][e["id"]]
        assert e == facade._entity(raw)
        if detail:
            assert detail["entity"] == e
            assert detail["relations"] == [r for r in snapshot["relations"] if e["id"] in (r["head"], r["tail"])]
    assert facade.version_detail("KGV-1")["entities"] == snapshot["entities"]
    assert facade.change_detail("constructed-draft")["content"] == env.draft
    assert workflow.version_snapshot(kg.STORE_PATH, 1)["snapshot"] == before
    assert graph._snapshot() == before


def test_draft_roundtrip_after_chinese_search_produces_no_rename(env, graph):
    snap = facade.snapshot("KGV-1")
    types = {"Function", "FaultType", "LinkState", "NetworkRole", "Metric", "Parameter",
             "DeviceModel", "WorkMode", "Case", "ObjectType"}
    entities = [next(e for e in snap["entities"] if e["type"] == etype) for etype in sorted(types)]
    draft = {"baseVersionId": "KGV-1", "summary": "中文检索后回填原值",
             "entities": deepcopy(entities), "relations": []}
    before = deepcopy(draft)
    for term in ("语音", "故障对象类型", "构造数据", "具有现象"):
        search(term)
    with pytest.raises(workflow.KgWorkflowError, match="没有可保存的知识变更"):
        facade._draft_ops(draft)
    assert draft == before
    for entity in draft["entities"]:
        entity["description"] = "仅补充中文说明"
    ops = facade._draft_ops(draft)
    assert len(ops) == len(entities)
    assert all(op["op"] == "edit_entity" for op in ops)
    assert {op["entity_id"]: op["name"] for op in ops} == {e["id"]: e["name"] for e in entities}
    memory = KnowledgeGraph("constructed-roundtrip")
    memory._restore(graph._snapshot())
    memory.freeze("构造编辑前基线")
    change_id, errors = memory.submit_update(ops, "fixture-editor", "只改说明")
    assert not errors
    assert memory.review(change_id, True, "fixture-reviewer")
    assert {eid: e["name"] for eid, e in memory.entities.items()} == {
        eid: e["name"] for eid, e in graph.entities.items()}
    assert memory.triples == graph.triples
    assert workflow.version_snapshot(kg.STORE_PATH, 1)["snapshot"] == graph._snapshot()

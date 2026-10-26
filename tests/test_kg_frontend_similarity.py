"""R4-C 规则推荐专项；只使用 F 盘全新隔离库，不导入服务入口。"""
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

from app import database, kg, kg_frontend_service as facade, kg_workflow_service as workflow
from app import kg_similarity as similarity
from app.kg_models import KgAudit, KgChange, KgReceipt, KgSubmission, KgVersion, KgWorkspace

SUMMARY_FIELDS = {"id", "name", "category", "type"}
MODELS = (KgWorkspace, KgVersion, KgChange, KgSubmission, KgAudit, KgReceipt)


def entity(eid="E-1", name="射频功放", etype="Component", category="设备知识", **fields):
    return {"id": eid, "name": name, "type": etype, "category": category,
            "description": "", "keywords": [], "source": "构造专项资料 [CONSTRUCTED]",
            "attributes": [], "modelIds": [], **fields}


def relation(head, tail, rid="T-1"):
    return {"id": rid, "head": head, "tail": tail, "type": "hasSymptom",
            "weight": 1, "source": "构造关联 [CONSTRUCTED]"}


@pytest.fixture(autouse=True)
def prohibit_default_database(monkeypatch):
    def blocked():
        raise AssertionError("专项测试不得访问默认数据库或旧图谱加载器")
    for module in (database, workflow, facade):
        monkeypatch.setattr(module, "get_session_factory", blocked)
    monkeypatch.setattr(kg, "_load", blocked)


def search(query="", **filters):
    return facade.browse("search", {"versionId": "KGV-1", "search": query, **filters})


def use_snapshot(monkeypatch, entities, relations=()):
    snap = {"entities": entities, "relations": list(relations)}
    monkeypatch.setattr(facade, "snapshot", lambda version: snap)
    return snap


@pytest.mark.parametrize("query", ["radioo", "rado", "radix", "raido"])
def test_one_spelling_edit_and_adjacent_transposition(query):
    original = entity(name="radio")
    result = similarity.recommend(query, [original])
    assert len(result) == 1 and result[0].entity is original
    assert result[0].score == 80
    assert result[0].evidence[0].value == "radio"
    assert result[0].evidence[0].field == "name"
    assert result[0].evidence[0].method == "single_edit"


@pytest.mark.parametrize("query", ["哈里斯公同", "ＨＡＲＲＩＳ"])
def test_current_chinese_alias_and_fullwidth_normalization_use_real_name(query):
    original = entity(name="Harris Corporation", etype="Manufacturer")
    result = similarity.recommend(query, [original])
    assert len(result) == 1 and result[0].entity["name"] == "Harris Corporation"
    assert result[0].evidence[0].value in {"哈里斯公司", "Harris Corporation"}


@pytest.mark.parametrize("label", ["语音", "话音"])
def test_previous_and_current_aliases_combine_with_real_fields(label):
    original = entity(name="voice", etype="Function", description="终端配置说明")
    result = similarity.recommend(f"说明 {label}", [original])
    assert len(result) == 1 and result[0].score == 90
    assert any(item.value == label and item.field == "search_aliases" for item in result[0].evidence)
    assert any(item.value == original["description"] for item in result[0].evidence)


def test_chinese_word_pieces_have_explicit_overlap_evidence():
    original = entity(name="功放驻波比告警处置")
    result = similarity.recommend("功放驻波比处置", [original])
    assert len(result) == 1 and result[0].score == 70
    assert result[0].evidence[0].method == "chinese_bigrams"
    assert result[0].evidence[0].value == original["name"]


def test_attribute_value_and_controlled_attribute_alias_are_recommendation_evidence():
    original = entity(attributes=[{"name": "device_selftest", "value": "ALARM_PWR", "unit": None}])
    result = similarity.recommend("功放 电源告警", [original])
    assert len(result) == 1 and result[0].score == 90
    assert any(item.value == "电源告警" for item in result[0].evidence)
    assert original["attributes"][0]["value"] == "ALARM_PWR"


def test_related_property_requires_real_visible_edge_and_own_anchor():
    fault = entity("F-1", "功放故障", "Fault", "故障运维知识")
    symptom = entity("S-1", "驻波比告警", "Symptom", "故障运维知识")
    edge = relation(fault["id"], symptom["id"])
    result = similarity.recommend("功放 驻波比", [fault], [edge], context=[fault, symptom])
    assert len(result) == 1 and result[0].score == 85
    evidence = next(item for item in result[0].evidence if item.relation_id)
    assert (evidence.relation_id, evidence.entity_id, evidence.field, evidence.value) == (
        edge["id"], symptom["id"], "name", symptom["name"])
    assert similarity.recommend("功放 驻波比", [fault], [], context=[fault, symptom]) == []
    assert similarity.recommend("功放 驻波比", [fault], [edge], context=[fault]) == []
    assert similarity.recommend("驻波比 告警", [fault], [edge], context=[fault, symptom]) == []


@pytest.mark.parametrize("query", [
    "", " ", "---", "设备", "设备知识", "相关知识", "设备 状态", "Device", "unknown",
    "台", "台站", "rad", "a", "123", "E-99999", "DM-9999", "KGV-999", "FC-UNKNOWN",
    "功放 DM-9999", "Ｅ－９９９９９", "紫色月球烘焙器", "zzzzzzzzzz", "功放 月球烘焙器",
])
def test_blank_generic_short_unknown_identifiers_and_irrelevant_queries_do_not_recommend(query):
    rows = [entity(), entity("E-2", "设备状态", "Device"), entity("E-3", "radio"),
            entity("E-4", "台账电台", "Device")]
    assert similarity.recommend(query, rows) == []


def test_generic_aliases_and_source_text_cannot_supply_recommendation_evidence():
    row = entity(name="构造专用终端", source="秘密检索文本",
                 attributes=[{"name": "source_doc", "value": "秘密检索文本", "unit": None},
                             {"name": "device_id", "value": "假编号文本", "unit": None}])
    assert similarity.recommend("设备知误", [row]) == []
    assert similarity.recommend("秘密检索文木", [row]) == []
    assert similarity.recommend("假编号文木", [row]) == []


@pytest.mark.parametrize("value", ["", " ", "UNKNOWN", "None", "null", "未知", "未提供"])
def test_missing_attribute_placeholders_cannot_supply_recommendation_evidence(value):
    row = entity(attributes=[{"name": "rx_sensitivity_dbm", "value": value, "unit": None}])
    assert similarity.recommend("接收灵敏度 未提供", [row]) == []
    assert similarity.recommend("接收灵敏度 未知", [row]) == []


def test_unconfigured_type_hint_is_not_a_real_knowledge_field():
    row = entity(etype="CustomUnconfiguredType")
    assert similarity.recommend("未配置中文 名称", [row]) == []


def test_stable_scores_cap_unique_ids_and_no_mutation():
    rows = [entity(f"E-{i:02d}", "radio") for i in range(9)]
    before = deepcopy(rows)
    result = similarity.recommend("raido", list(reversed(rows)) + rows)
    assert len(result) == similarity.MAX_RECOMMENDATIONS == 5
    assert [item.entity["id"] for item in result] == [f"E-{i:02d}" for i in range(5)]
    assert result == similarity.recommend("raido", rows)
    assert rows == before


def test_stronger_text_evidence_precedes_typo_and_bigrams():
    rows = [entity("E-a", "功放驻波比告警处置"), entity("E-b", "功放驻波比处志"),
            entity("E-c", "功放驻波比处置")]
    result = similarity.recommend("功放驻波比处置", rows)
    assert [(item.entity["id"], item.score) for item in result] == [("E-c", 95), ("E-b", 80), ("E-a", 70)]


@pytest.mark.parametrize("query", ["射频功放", "语音", "话音", "ALARM_PWR", "电源告警", "包含部件"])
def test_exact_items_never_call_similarity(monkeypatch, query):
    rows = [entity(attributes=[{"name": "device_selftest", "value": "ALARM_PWR", "unit": None}]),
            entity("E-2", "voice", "Function")]
    edge = {**relation("E-1", "E-2"), "type": "hasComponent"}
    use_snapshot(monkeypatch, rows, [edge])
    monkeypatch.setattr(facade, "recommend", lambda *a, **k: pytest.fail("精确命中不得调用推荐"))
    result = search(query)
    assert result["code"] == 0 and result["total"] > 0 and result["items"]
    assert result["similar"] == []


@pytest.mark.parametrize("query", ["", "  ", " \t "])
def test_empty_search_keeps_listing_without_scoring(monkeypatch, query):
    use_snapshot(monkeypatch, [entity()])
    monkeypatch.setattr(facade, "recommend", lambda *a, **k: pytest.fail("空检索不得调用推荐"))
    result = search(query)
    assert result["total"] == 1 and result["code"] == 0 and result["similar"] == []


def test_empty_selected_domain_is_not_filled_with_fake_matches(monkeypatch):
    use_snapshot(monkeypatch, [entity()])
    result = search("", categories="故障运维知识")
    assert result["code"] == 4001 and result["total"] == 0
    assert result["items"] == result["similar"] == []


def test_past_last_exact_page_does_not_trigger_recommendations(monkeypatch):
    use_snapshot(monkeypatch, [entity()])
    monkeypatch.setattr(facade, "recommend", lambda *a, **k: pytest.fail("空分页不是无命中"))
    result = search("功放", pageNum="2", pageSize="5")
    assert result["items"] == result["similar"] == []
    assert result["total"] == 1 and result["code"] == 0


def test_candidates_obey_all_three_domains_type_and_summary_contract(monkeypatch):
    rows = [entity("E-device", "射频功放", "Component"),
            entity("E-network", "射频功放状态", "LinkState", "网络态势知识"),
            entity("E-fault", "射频功放故障", "Fault", "故障运维知识")]
    snap = use_snapshot(monkeypatch, rows)
    before = deepcopy(snap)
    for row in rows:
        result = search("射频功坊" + row["name"][4:], categories=row["category"], type=row["type"])
        assert result["code"] == 4001 and result["items"] == [] and result["total"] == 0
        assert len(result["similar"]) == 1
        assert result["similar"][0] == {key: row[key] for key in SUMMARY_FIELDS}
        assert set(result["similar"][0]) == SUMMARY_FIELDS
        assert set(result) == {"versionId", "items", "total", "pageNum", "pageSize", "similar", "code"}
    assert search("射频功坊", categories="设备知识", type="Manufacturer")["similar"] == []
    assert search("射频功坊", categories="")["similar"] == []
    assert snap == before


def test_hidden_domain_neighbor_cannot_supply_evidence(monkeypatch):
    fault = entity("F-1", "功放故障", "Fault", "故障运维知识")
    hidden = entity("N-1", "驻波比告警", "Metric", "网络态势知识")
    use_snapshot(monkeypatch, [fault, hidden], [relation(fault["id"], hidden["id"])])
    assert search("功放 驻波比", categories="故障运维知识")["similar"] == []
    allowed = search("功放 驻波比", categories="故障运维知识,网络态势知识", type="Fault")
    assert [row["id"] for row in allowed["similar"]] == [fault["id"]]


@pytest.mark.parametrize("query", ["E-99999", "DM-9999", "功放 不存在的星际燃料"])
def test_facade_unknown_search_retains_4001_with_no_fake_items(monkeypatch, query):
    use_snapshot(monkeypatch, [entity()])
    result = search(query)
    assert result["code"] == 4001 and result["total"] == 0
    assert result["items"] == result["similar"] == []


def test_other_browse_kinds_do_not_call_similarity_or_replace_missing_entity(monkeypatch):
    use_snapshot(monkeypatch, [entity(), entity("E-model", "DM-SAMPLE", "DeviceModel")])
    monkeypatch.setattr(facade, "recommend", lambda *a, **k: pytest.fail("只能在搜索分支推荐"))
    with pytest.raises(workflow.KgWorkflowError) as error:
        facade.browse("entity", {"versionId": "KGV-1", "entityId": "E-MISSING"})
    assert (error.value.status, error.value.code) == (404, 4001)
    assert facade.browse("graph", {"versionId": "KGV-1", "search": "功放检修拼错"})["entities"] == []
    assert facade.browse("device", {"versionId": "KGV-1", "modelId": "DM-SAMPLE",
                                    "search": "功放检修拼错"})["items"] == []


@pytest.mark.parametrize("filters", [{"search": "a" * 121}, {"search": "功放\x00"},
                                     {"search": "功放\n检修"}, {"categories": "未知分类"},
                                     {"pageNum": "0"}, {"pageSize": "101"}])
def test_existing_input_validation_is_not_bypassed(monkeypatch, filters):
    use_snapshot(monkeypatch, [entity()])
    with pytest.raises(ValueError):
        facade.browse("search", {"versionId": "KGV-1", **filters})


def raw_snapshot(rows):
    domains = {"设备知识": "device", "网络态势知识": "network", "故障运维知识": "fault"}
    return {"entities": {row["id"]: {"eid": row["id"], "name": row["name"], "type": row["type"],
             "graph": domains[row["category"]], "attrs": {"_frontend": deepcopy(row)}} for row in rows},
            "triples": {}}


@pytest.fixture(scope="module")
def isolated_database(tmp_path_factory):
    directory = tmp_path_factory.mktemp("kg-similarity")
    assert directory.resolve().is_relative_to((ROOT / "data/runtime/r4").resolve())
    path = directory / "similarity.sqlite"
    assert not path.exists()
    engine = create_engine("sqlite:///" + str(path))
    database.Base.metadata.create_all(engine, tables=[model.__table__ for model in MODELS])
    factory = sessionmaker(bind=engine, autoflush=False, expire_on_commit=False)
    first = raw_snapshot([entity("E-published", "射频功放")])
    second = raw_snapshot([entity("E-published", "野战天线")])
    draft = entity("E-draft", "未发布秘密天线")
    with factory.begin() as session:
        session.add(KgWorkspace(id=1, current_version=3, revision=4))
        for number, snap in ((1, first), (2, second), (3, first)):
            session.add(KgVersion(version=number, parent_version=number - 1 if number > 1 else None,
                                 restored_from=1 if number == 3 else None, created_at=number,
                                 note="构造已发布专项版本", snapshot=snap, stats={}))
        session.add(KgChange(change_id="constructed-unpublished", state="DRAFT", revision=1,
                             base_version=3, ops=[], submitter="fixture-editor", note="未发布草稿",
                             created_at=4, updated_at=4,
                             frontend_content={"draft": {"baseVersionId": "KGV-3", "summary": "未发布草稿",
                                                          "entities": [draft], "relations": []}}))
    try:
        yield SimpleNamespace(factory=factory, path=path, directory=directory)
    finally:
        engine.dispose()


@pytest.fixture
def env(prohibit_default_database, isolated_database, monkeypatch):
    for module in (database, workflow, facade):
        monkeypatch.setattr(module, "get_session_factory", lambda: isolated_database.factory)
    legacy = isolated_database.directory / "absent-legacy.json"
    monkeypatch.setattr(kg, "STORE_PATH", legacy)
    before = isolated_database.path.read_bytes()
    yield isolated_database
    assert isolated_database.path.read_bytes() == before, "检索不得改变隔离数据库"
    assert not legacy.exists(), "检索不得写回旧图谱文件"


def test_real_sql_snapshot_version_rollback_and_unpublished_isolation(env):
    first = search("射频功坊", versionId="KGV-1")
    second = search("射频功坊", versionId="KGV-2")
    restored = search("射频功坊", versionId="KGV-3")
    assert [row["name"] for row in first["similar"]] == ["射频功放"]
    assert second["similar"] == []
    assert restored["similar"] == first["similar"]
    for version in ("KGV-1", "KGV-2", "KGV-3"):
        assert search("未发布秘密天缐", versionId=version)["similar"] == []
        for candidate in search("射频功坊", versionId=version)["similar"]:
            detail = facade.browse("entity", {"versionId": version, "entityId": candidate["id"]})
            assert candidate == {key: detail["entity"][key] for key in SUMMARY_FIELDS}


@pytest.mark.parametrize("version,status,code", [("KGV-invalid", 422, 1001), ("KGV-999", 404, 4001)])
def test_bad_or_missing_sql_version_never_falls_back(env, version, status, code):
    with pytest.raises(workflow.KgWorkflowError) as error:
        search("射频功坊", versionId=version)
    assert (error.value.status, error.value.code) == (status, code)


def test_checked_in_constructed_graph_uses_current_real_aliases_without_mutation(monkeypatch):
    from diagnosis.sr6 import build_graph

    graph, _ = build_graph()
    before = deepcopy(graph._snapshot())
    projected = [facade._entity(row) for row in graph.entities.values()]
    edges = [facade._relation(row) for row in graph.triples.values()]
    use_snapshot(monkeypatch, projected, edges)
    result = search("哈里斯公同", categories="设备知识", type="Manufacturer")
    assert result["code"] == 4001 and result["items"] == [] and result["total"] == 0
    assert [row["name"] for row in result["similar"]] == ["Harris Corporation"]
    assert search("紫色月球烘焙器")["similar"] == []
    assert graph._snapshot() == before

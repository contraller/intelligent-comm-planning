"""已发布快照的确定性相似检索；解释依据只在服务内部保留。"""
from __future__ import annotations

from dataclasses import dataclass, replace
import re
import unicodedata

from .kg_display import (
    BANDS, ENTITY_TYPE_NAMES, RELATION_TYPE_NAMES, SOURCE_FILES, search_aliases,
)

MAX_RECOMMENDATIONS = 5
_IDENTIFIER = re.compile(
    r"(?<![a-z0-9])(?:[a-z0-9]+(?:[-_:./][a-z0-9]+)+|[a-z]*\d+[a-z0-9]*)(?![a-z0-9])",
    re.IGNORECASE,
)
_CHINESE = re.compile(r"[\u3400-\u9fff]{4,}")
_MISSING = {"", "unknown", "none", "null", "未知", "未提供"}


def _normalize(value):
    value = unicodedata.normalize("NFKC", value).casefold()
    return " ".join(re.findall(r"[^\W_]+", value))


_GENERIC = {_normalize(value) for value in (
    *ENTITY_TYPE_NAMES, *ENTITY_TYPE_NAMES.values(),
    *RELATION_TYPE_NAMES, *RELATION_TYPE_NAMES.values(), *SOURCE_FILES.values(), *BANDS.values(),
    "设备知识", "网络态势知识", "故障运维知识", "知识", "信息", "资料", "构造数据",
    "查询", "搜索", "推荐", "相似", "相关", "相关知识", "全部", "所有", "未知", "不存在",
    "设备信息", "设备资料", "属性", "类型", "名称", "模式", "状态", "参数", "功能",
    "图谱", "知识图谱", "图谱信息", "知识库", "情况", "内容", "简介", "详情", "未提供",
    "knowledge", "search", "similar", "data", "unknown", "none",
)}


@dataclass(frozen=True)
class SimilarityEvidence:
    entity_id: str
    field: str
    value: str
    method: str = ""
    relation_id: str | None = None


@dataclass(frozen=True)
class SimilarityCandidate:
    entity: dict
    score: int
    evidence: tuple[SimilarityEvidence, ...]


def _informative(value):
    return len(value) >= 2 and not value.isdecimal() and value not in _GENERIC


def _fields(entity):
    pairs = [("name", entity["name"]), ("description", entity.get("description", ""))]
    pairs.extend((f"keywords[{i}]", value) for i, value in enumerate(entity.get("keywords", ())))
    attributes = []
    for i, attribute in enumerate(entity.get("attributes", ())):
        # 编号、来源和单位不能成为拼写纠正的替代实体依据。
        if (attribute["name"].endswith("_id") or attribute["name"] in {"id", "source_doc"}
                or _normalize(attribute["value"]) in _MISSING):
            continue
        attributes.append(attribute)
        pairs.append((f"attributes[{i}].value", attribute["value"]))
    aliases = search_aliases({**entity, "source": "", "attributes": attributes})
    pairs.extend(("search_aliases", value) for value in sorted(aliases)
                 if not value.startswith("未配置中文名称"))
    return [(SimilarityEvidence(entity["id"], field, value), normalized)
            for field, value in pairs if (normalized := _normalize(value)) and _informative(normalized)]


def _one_edit(left, right):
    """仅接受一次增删改或一次相邻换位，不将短词相近当作依据。"""
    if min(len(left), len(right)) < 4 or abs(len(left) - len(right)) > 1 or left == right:
        return False
    if len(left) == len(right):
        differences = [i for i, (a, b) in enumerate(zip(left, right)) if a != b]
        return len(differences) == 1 or (
            len(differences) == 2 and differences[1] == differences[0] + 1
            and left[differences[0]] == right[differences[1]]
            and left[differences[1]] == right[differences[0]])
    shorter, longer = sorted((left, right), key=len)
    index = next((i for i, (a, b) in enumerate(zip(shorter, longer)) if a != b), len(shorter))
    return shorter[index:] == longer[index + 1:]


def _grams(value):
    return {value[i:i + 2] for i in range(len(value) - 1)}


def _direct_score(term, fields):
    best = (0, ())
    query_grams = _grams(term) if _CHINESE.fullmatch(term) else set()
    for evidence, value in fields:
        if term in value:
            return 95, (replace(evidence, method="normalized_text"),)
        variants = {value, *value.split()}
        if any(_one_edit(term, variant) for variant in sorted(variants)) and best[0] < 80:
            best = (80, (replace(evidence, method="single_edit"),))
        if query_grams and best[0] < 70:
            for text in _CHINESE.findall(value):
                grams = _grams(text)
                shared = len(query_grams & grams)
                if shared >= 2 and shared * 4 >= len(query_grams) * 3 and shared * 5 >= len(grams) * 3:
                    best = (70, (replace(evidence, method="chinese_bigrams"),))
                    break
    return best


def _token_score(tokens, own, related):
    if len(tokens) < 2 or not any(_informative(token) and any(token in text for _, text in own)
                                   for token in tokens):
        return 0, ()
    evidence = []
    for token in tokens:
        match = next((item for item, text in (*own, *related) if token in text), None)
        if match is None:
            return 0, ()
        item = replace(match, method="related_tokens" if match.relation_id else "all_tokens")
        if item not in evidence:
            evidence.append(item)
    return (85 if any(item.relation_id for item in evidence) else 90), tuple(evidence)


def recommend(query, candidates, relations=(), *, context=None):
    """调用方传入同版本、所选分类内的数据；类型过滤只限制候选。"""
    if not query or len(query) > 120 or any(ord(char) < 32 for char in query):
        return []
    term = _normalize(query)
    tokens = tuple(dict.fromkeys(term.split()))
    if (len(tokens) == 1 and len(tokens[0]) < 4) or not any(_informative(token) for token in tokens) or _IDENTIFIER.search(
            unicodedata.normalize("NFKC", query)):
        return []
    visible = {entity["id"]: entity for entity in (context if context is not None else candidates)}
    fields = {eid: _fields(entity) for eid, entity in visible.items()}
    neighbors = {}
    for relation in sorted(relations, key=lambda item: item["id"]):
        head, tail = relation["head"], relation["tail"]
        if head in visible and tail in visible and head != tail:
            neighbors.setdefault(head, []).append((tail, relation["id"]))
            neighbors.setdefault(tail, []).append((head, relation["id"]))
    results = {}
    for entity in candidates:
        eid = entity["id"]
        if eid not in visible or eid in results:
            continue
        own = fields[eid]
        score, evidence = _direct_score(term, own)
        if len(tokens) > 1 and score < 90:
            related = [(replace(item, relation_id=rid), text)
                       for neighbor, rid in neighbors.get(eid, ()) for item, text in fields[neighbor]]
            token_score, token_evidence = _token_score(tokens, own, related)
            if token_score > score:
                score, evidence = token_score, token_evidence
        if score:
            results[eid] = SimilarityCandidate(entity, score, evidence)
    return sorted(results.values(), key=lambda item: (-item.score, item.entity["id"]))[:MAX_RECOMMENDATIONS]

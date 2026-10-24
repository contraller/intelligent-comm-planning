"""固定资源内的搜索辅助；物理评分只调用现有Scenario。"""
import copy
import itertools
import time

import frequency as FQ
import interference as IF
import multi_objective as MO
import echelon as E
from devicespec import SpecFiller
from terrain import haversine_m


def binding_proposals(available, original, device_of, model_of):
    groups = {}
    for did in available:
        model = model_of[device_of[did]["model_id"]]
        signature = (model["model_id"], model.get("freq_min_khz"), model.get("freq_max_khz"))
        groups.setdefault(signature, []).append(did)

    def visit(chosen):
        if len(chosen) == len(original):
            yield tuple(chosen)
            return
        for group in groups.values():
            if not group:
                continue
            # 同型号/频率范围只评估一次；优先保留该网系原来的实物身份。
            preferred = original[len(chosen)]
            did = preferred if preferred in group else group[0]
            index = group.index(did)
            group.pop(index)
            yield from visit(chosen + [did])
            group.insert(index, did)

    yield from visit([])


def bandwidth_audit(scenario, devices, models):
    """只记录已使用的原生带宽及假设来源，不配置或重新选择带宽。"""
    device_of = {row["device_id"]: row for row in devices}
    model_of = {row["model_id"]: row for row in models}
    filler = SpecFiller(models)
    radios, links = {}, []
    for link in scenario.links:
        for station in (link.st_a, link.st_b):
            did = link.device.get(station.sid)
            if not did or did in radios:
                continue
            model = model_of[device_of[did]["model_id"]]
            raw = model.get("bandwidth_khz") or ""
            before = len(filler.substitutions)
            expected = filler.bandwidth(model)
            if len(filler.substitutions) != before:
                reason = filler.substitutions[-1][3]
                rule = "SAME_BAND_MEDIAN_ASSUMPTION" if reason.startswith("同类推定") else "STANDARD_DEFAULT_ASSUMPTION"
            else:
                reason = "原型号单值" if ";" not in raw else "沿用原生SpecFiller首项，非显式配置选择"
                rule = "MODEL_SINGLE_VALUE" if ";" not in raw else "IMPLICIT_FIRST_OPTION_ASSUMPTION"
            actual = station.radio[link.band]["bw"]
            radios[did] = {"device_id": did, "model_id": model["model_id"], "band": link.band,
                "effective_bw_khz": actual, "source_field": "bandwidth_khz", "source_value": raw,
                "selection_rule": rule, "reason": reason, "matches_legacy_rule": actual == expected,
                "device_configuration_verified": False}
        links.append({"link_id": link.link_id, "effective_bw_khz": link.bw,
                      "aggregation": "MAX_ENDPOINT_NATIVE_RADIO_BW", "device_ids": sorted(link.device.values())})
    return {"policy": "LEGACY_SPECFILLER_NO_BANDWIDTH_SEARCH", "devices": list(radios.values()), "links": links}


def failure_context(links, demands, required):
    nodes = {d[key] for d in demands for key in ("src_node_id", "dst_node_id")}
    adjacency = {node: [] for node in nodes}
    for index, row in enumerate(links):
        if (str(row.get("is_available", "true")).lower() == "false"
                or float(row["link_margin_db"]) < required):
            continue
        a, b = row["node_a_id"], row["node_b_id"]
        adjacency.setdefault(a, []).append((b, index))
        adjacency.setdefault(b, []).append((a, index))
    bridges, tin, tout, component = MO._bridges_and_times(sorted(adjacency), adjacency)
    mandatory = [d for d in demands if str(d.get("is_mandatory", "false")).lower() == "true"]
    connected = [d for d in mandatory
                 if component[d["src_node_id"]] == component[d["dst_node_id"]]]
    cuts = []
    for a, b in bridges:
        side = {node for node in tin if component[node] == component[b]
                and tin[b] <= tin[node] <= tout[b]}
        lost = [d["demand_id"] for d in connected
                if component[d["src_node_id"]] == component[b]
                and ((d["src_node_id"] in side) != (d["dst_node_id"] in side))]
        if lost:
            cuts.append({"edge": (a, b), "side": side, "lost": lost})
    cuts.sort(key=lambda row: (-len(row["lost"]), row["edge"]))
    disconnected = [d for d in mandatory if d not in connected]
    weights = {}
    for row in links:
        a, b = row["node_a_id"], row["node_b_id"]
        weights[row["link_id"]] = 1 + sum(
            len(cut["lost"]) for cut in cuts
            if component.get(a) == component.get(b) == component[cut["edge"][0]]
            and (a in cut["side"]) != (b in cut["side"]))
        if component.get(a) != component.get(b):
            weights[row["link_id"]] += sum(
                {component[d["src_node_id"]], component[d["dst_node_id"]]}
                == {component.get(a), component.get(b)} for d in disconnected)
    return {"cuts": cuts, "bridges": bridges, "component": component, "disconnected": disconnected,
            "weights": weights, "mandatory_count": len(mandatory),
            "failed_nodes": {row[key] for row in links if float(row["link_margin_db"]) < required
                             for key in ("node_a_id", "node_b_id")}}


def backup_solutions(problem, solution, result, demands, models, pool_rows, *, max_variants=4, checkpoint=None):
    """只在本次已有配置内补跨割边，端口不足时仅替换非关键备份。"""
    links = solution["links"]
    required = result["params"]["fade_margin_db"]
    context = failure_context(result["links"], demands, required)
    station_of = {station.sid: index for index, station in enumerate(problem.fm.stations)}
    model_of = {row["model_id"]: row for row in models}
    radios = {}
    for device in result["devices"]:
        model = model_of.get(device["model_id"])
        index = station_of.get(device["node_id"])
        if model is not None and index is not None and device.get("availability", "ACTIVE") == "ACTIVE":
            radios.setdefault((index, model["device_class"]), []).append(model)
    present = set((min(a, b), max(a, b), band) for a, b, band in links)
    active = {index for index, _band in radios}
    sub = lambda index: problem.fm.stations[index].subtype
    groups = E.peer_groups(sub, links, solution["uplinks"])
    pool = FQ.FreqPool(pool_rows)
    critical = {frozenset(edge) for edge in context["bridges"]}
    base_count = len(problem.base)
    seen, proposals = set(), []
    failed_optional = {index for index, row in enumerate(result["links"])
                       if index >= base_count and float(row["link_margin_db"]) < required}
    if failed_optional:
        removed = [edge for index, edge in enumerate(links) if index in failed_optional]
        proposals.append(dict(solution, links=[edge for index, edge in enumerate(links) if index not in failed_optional],
            repair_changes=solution.get("repair_changes", []) + [{"kind": "DROP_UNUSABLE_OPTIONAL_BACKUP",
                "edges": [[problem.sid[a], problem.sid[b], band] for a, b, band in removed]}]))
        if len(proposals) >= max_variants:
            return proposals

    def fits(edges):
        used = {}
        for a, b, band in edges:
            for key in ((a, band), (b, band)):
                used[key] = used.get(key, 0) + 1
        if any(count > E.capacity(sub(index), band) for (index, band), count in used.items()):
            return False
        rows = [{"link_id": str(index), "node_a_id": problem.sid[a], "node_b_id": problem.sid[b],
                 "device_class": band} for index, (a, b, band) in enumerate(edges)]
        by_id = {row["link_id"]: row for row in rows}
        nets = {}
        for task in FQ.tasks_from_nets(rows, result["nodes"]):
            for lid in task.members:
                row = by_id[lid]
                for node in (row["node_a_id"], row["node_b_id"]):
                    nets.setdefault((station_of[node], task.band), set()).add(task.task_id)
        return all(len(required_nets) <= len(radios.get(key, [])) for key, required_nets in nets.items())

    sides = [cut["side"] for cut in context["cuts"][:4]]
    sides.extend({node for node, component in context["component"].items()
                  if component == context["component"][row["src_node_id"]]}
                 for row in context["disconnected"][:2])
    # 多座割轮流给候选，避免第一座割占满有限实际核验名额。
    ranked_sides = []
    for side in sides:
        crossing = []
        for a in sorted(active):
            sa = problem.fm.stations[a]
            for b in sorted(active):
                sb = problem.fm.stations[b]
                if a >= b or (sa.sid in side) == (sb.sid in side):
                    continue
                if checkpoint and not checkpoint():
                    return proposals
                for band in sorted(set(sa.radio) & set(sb.radio)):
                    if ((a, b, band) in present or not E.relation_allowed(sub(a), sub(b), band)
                            or E.is_peer_pair(sub(a), sub(b)) and not E.peer_link_allowed(a, b, groups, solution["uplinks"])):
                        continue
                    allowed = [channel for channel in pool.of_band(band) if all(
                        any(float(model["freq_min_khz"]) <= channel["freq_khz"] <= float(model["freq_max_khz"])
                            for model in radios.get((index, band), [])) for index in (a, b))]
                    if allowed:
                        crossing.append((haversine_m(sa.lon, sa.lat, sb.lon, sb.lat), a, b, band))
        ranked_sides.append(sorted(crossing)[:8])
    for rank in range(8):
        for crossing in ranked_sides:
            if rank >= len(crossing):
                continue
            _distance, a, b, band = crossing[rank]
            choices = [[None]]
            for endpoint in (a, b):
                count = sum(endpoint in edge[:2] and edge[2] == band for edge in links)
                removable = [index for index, edge in enumerate(links) if index >= base_count
                             and endpoint in edge[:2] and edge[2] == band
                             and frozenset((problem.sid[edge[0]], problem.sid[edge[1]])) not in critical]
                choices.append(([] if count >= E.capacity(sub(endpoint), band) else [None]) + removable[:2])
            for removed in itertools.product(*choices):
                indices = set(removed) - {None}
                edges = [edge for index, edge in enumerate(links) if index not in indices] + [(a, b, band)]
                signature = tuple(sorted((min(x, y), max(x, y), frequency_band) for x, y, frequency_band in edges))
                if signature in seen or not fits(edges):
                    continue
                seen.add(signature)
                proposals.append(dict(solution, links=edges, repair_changes=solution.get("repair_changes", []) + [{
                    "kind": "ADD_PHYSICAL_BACKUP", "edge": [problem.sid[a], problem.sid[b], band],
                    "replaced_optional_edges": [[problem.sid[x], problem.sid[y], old_band]
                                                for index, (x, y, old_band) in enumerate(links) if index in indices]}]))
                if len(proposals) >= max_variants:
                    return proposals
    return proposals


def improve_bindings(links, nodes, devices, models, pool_rows, locked=(), checkpoint=None):
    """同站实物匹配只改善合法频点交集，不改变网系或指定设备。"""
    tasks = FQ.tasks_from_nets(links, nodes)
    by_link = {row["link_id"]: row for row in links}
    model_of = {row["model_id"]: row for row in models}
    device_of = {row["device_id"]: row for row in devices
                 if row.get("availability", "ACTIVE") == "ACTIVE"}
    pool = FQ.FreqPool(pool_rows)
    endpoints, bindings, inventory = {}, {}, {}
    for task in tasks:
        keys = set()
        for lid in task.members:
            row = by_link[lid]
            for side in ("a", "b"):
                key = (row["node_%s_id" % side], task.band, task.task_id)
                keys.add(key)
                bindings[key] = row.get("device_%s_id" % side)
        endpoints[task.task_id] = keys
    for did, device in device_of.items():
        model = model_of.get(device.get("model_id"))
        if model:
            inventory.setdefault((device["node_id"], model["device_class"]), []).append(did)

    def options(task):
        ranges = []
        for key in endpoints[task.task_id]:
            device = device_of.get(bindings.get(key))
            model = model_of.get(device.get("model_id")) if device else None
            if not model or not model.get("freq_min_khz") or not model.get("freq_max_khz"):
                return 0
            ranges.append((float(model["freq_min_khz"]), float(model["freq_max_khz"])))
        return sum(all(lo <= channel["freq_khz"] <= hi for lo, hi in ranges)
                   for channel in pool.of_band(task.band))

    changes, exhausted = 0, False
    for _round in range(2):
        round_changed = False
        for station, available in sorted(inventory.items()):
            if checkpoint and not checkpoint():
                exhausted = True
                break
            keys = sorted(key for key in bindings if key[:2] == station and key not in locked)
            reserved = {did for key, did in bindings.items() if key[:2] == station and key in locked}
            available = sorted(did for did in available if did not in reserved)
            if not keys or len(keys) > len(available):
                continue
            affected = [task for task in tasks if any(key in endpoints[task.task_id] for key in keys)]

            def score():
                counts = [options(task) for task in affected]
                return (sum(count > 0 for count in counts), min(counts, default=0), sum(counts))

            original = tuple(bindings[key] for key in keys)
            best, best_score = original, score()
            proposals = binding_proposals(available, original, device_of, model_of)
            for proposal in itertools.islice(proposals, 2000):
                if checkpoint and not checkpoint():
                    break
                bindings.update(zip(keys, proposal))
                value = score()
                if value > best_score:
                    best, best_score = proposal, value
            bindings.update(zip(keys, best))
            changes += best != original
            round_changed |= best != original
        if exhausted or not round_changed:
            break
    net_of = {lid: task.task_id for task in tasks for lid in task.members}
    for row in links:
        for side in ("a", "b"):
            key = (row["node_%s_id" % side], row["device_class"], net_of[row["link_id"]])
            row["device_%s_id" % side] = bindings[key] or ""
    return changes


class ChannelSearch:
    def __init__(self, models, antennas, terrain, interference_rows, *, deadline, progress=None):
        self.models = copy.deepcopy(models)
        self.antennas = copy.deepcopy(antennas)
        self.terrain = terrain
        self.interference_rows = copy.deepcopy(interference_rows)
        self.deadline = deadline
        self.progress = progress
        self.cache = {}
        self.evaluations = 0
        self.exhausted = False
        self.last_progress = float("-inf")
        self.complete_checks = 0

    def checkpoint(self):
        now = time.monotonic()
        if self.progress and now - self.last_progress >= 0.5:
            self.progress()
            now = self.last_progress = time.monotonic()
        if now >= self.deadline:
            self.exhausted = True
            return False
        return True

    def begin_check(self, estimate=0.0, *, allow_initial=False):
        ready = self.checkpoint()
        if self.complete_checks >= 24:
            return False
        if not (allow_initial and self.complete_checks == 0) and (
                not ready or time.monotonic() + estimate >= self.deadline):
            return False
        self.complete_checks += 1
        return True

    def preferences(self, result, pool_rows, demands, max_tasks=12, max_evaluations=1200):
        if not self.checkpoint():
            return {}
        links, caps = result["links"], result["caps"]
        required = result["params"]["fade_margin_db"]
        context = failure_context(links, demands, required)
        failed = {row["link_id"] for row in links if float(row["link_margin_db"]) < required}
        conflicted = {task_id for row in result["frequency"]["conflicts"] for task_id in row["link_ids"]}
        tasks = result["ftasks"]
        pool = FQ.FreqPool(pool_rows)
        FQ._prepare(tasks, pool)
        targets = [task for task in tasks if failed.intersection(task.members) or task.task_id in conflicted]
        targets.sort(key=lambda task: (-sum(context["weights"][lid] for lid in task.members if lid in failed),
                                       task.band != "HF", task.task_id))
        eligible = [row for row in links if row.get("device_a_id") in caps and row.get("device_b_id") in caps]
        seed = {lid: task.allowed[0]["freq_khz"] for task in tasks if task.allowed for lid in task.members}
        eligible = [row for row in eligible if row["link_id"] in seed]
        if not eligible or not targets:
            return {}
        maximum = [dict(row, tx_power_dbm=caps[row["device_id"]].tx_max)
                   for row in result["params"]["params"]]
        scenario = IF.scenario_from_plan({"stations": result["stations"], "links": eligible,
            "devices": result["devices"], "models": self.models, "antennas": self.antennas,
            "terrain": self.terrain, "params": {"params": maximum}, "freq_tasks": tasks,
            "frequency": {"link_assignments": [{"link_id": row["link_id"], "freq_khz": seed[row["link_id"]]}
                for row in eligible if row["link_id"] in seed]}}, self.interference_rows)
        by_link = {link.link_id: link for link in scenario.links}
        preference, used = {}, 0
        for task in targets[:max_tasks]:
            members = [by_link[lid] for lid in task.members if lid in by_link]
            if len(members) != len(task.members) or not task.allowed:
                continue
            scored = []
            for channel in task.allowed:
                if used >= max_evaluations or not self.checkpoint():
                    break
                margins = []
                for link in members:
                    radios = (link.st_a.radio[link.band], link.st_b.radio[link.band])
                    key = (tuple(sorted(link.device.items())), link.band, channel["freq_khz"],
                           (link.st_a.lon, link.st_a.lat, link.st_b.lon, link.st_b.lat),
                           tuple(tuple(sorted(radio.items())) for radio in radios))
                    margin = self.cache.get(key)
                    if margin is None:
                        old = link.f
                        try:
                            link.f = channel["freq_khz"]
                            margin = scenario.link_state(link)["margin_after"]
                        finally:
                            link.f = old
                        self.cache[key] = margin
                        self.evaluations += 1
                        used += 1
                    margins.append(margin)
                value = (sum(context["weights"][link.link_id] for link, margin in zip(members, margins)
                             if margin >= required), sum(margin >= required for margin in margins),
                         min(margins), -sum(max(0, required - margin) for margin in margins))
                scored.append((value, channel["freq_id"]))
            if scored:
                scored.sort(key=lambda row: row[0], reverse=True)
                preference[task.task_id] = [freq_id for _value, freq_id in scored]
            if used >= max_evaluations or self.exhausted:
                break
        return preference

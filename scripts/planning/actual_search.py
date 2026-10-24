"""固定资源内的搜索辅助；物理评分只调用现有Scenario。"""
import copy
import itertools
import time

import frequency as FQ
import interference as IF
import multi_objective as MO


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
    return {"cuts": cuts, "component": component, "disconnected": disconnected,
            "weights": weights, "mandatory_count": len(mandatory)}


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

    changes = 0
    for _round in range(2):
        for station, available in sorted(inventory.items()):
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
            for proposal in itertools.islice(itertools.permutations(available, len(keys)), 2000):
                if checkpoint and not checkpoint():
                    break
                bindings.update(zip(keys, proposal))
                value = score()
                if value > best_score:
                    best, best_score = proposal, value
            bindings.update(zip(keys, best))
            changes += best != original
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

    def checkpoint(self):
        now = time.monotonic()
        if self.progress and now - self.last_progress >= 0.5:
            self.progress()
            self.last_progress = now
        if now >= self.deadline:
            self.exhausted = True
            return False
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

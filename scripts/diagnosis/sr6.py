"""Build the three SR-6 knowledge domains from checked-in sample data."""
from __future__ import annotations

import csv

from datapaths import path as data_path
from diagnosis.kg_store import KnowledgeGraph
from diagnosis.link_state_kg import build_default


def _rows(name):
    with open(data_path(name), encoding="utf-8-sig", newline="") as handle:
        return list(csv.DictReader(handle))


def build_graph():
    graph = KnowledgeGraph("sr6_constructed")
    models = _rows("device_model.csv")
    antennas = _rows("antenna_model.csv")
    nodes = _rows("node.csv")
    devices = _rows("device.csv")
    links = _rows("link.csv")
    metrics = _rows("link_metric.csv")

    for row in models:
        mid = row["model_id"]
        source = f"device_models_v1.csv#{mid} [CONSTRUCTED]"
        model = ("DeviceModel", mid)
        graph.add_entity(*model, graph="device",
                         attrs=dict(row, dataset_origin="CONSTRUCTED"))
        for relation, etype, value in (
            ("producedBy", "Manufacturer", row.get("manufacturer")),
            ("hasFunction", "Function", row.get("service_type")),
            ("supportsMode", "WorkMode", row.get("work_mode")),
            ("constrainedBy", "Parameter", row.get("constraint_note")),
        ):
            for item in str(value or "").split(";"):
                if item.strip():
                    graph.add_triple(model, relation, (etype, item.strip()),
                                     source=source, graph="device")
        for field in ("device_class", "freq_min_khz", "freq_max_khz",
                      "tx_power_max_dbm", "rx_sensitivity_dbm", "bandwidth_khz"):
            graph.add_triple(model, "hasParameter", ("Parameter", f"{field}={row[field]}"),
                             source=source, graph="device")

    for row in antennas:
        aid = row["antenna_id"]
        graph.add_entity("Antenna", aid, graph="device", attrs=row)
    for row in nodes:
        nid = row["node_id"]
        graph.add_entity("Node", nid, graph="network", attrs=row)
        if row.get("node_subtype"):
            graph.add_triple(("Node", nid), "hasRole", ("NetworkRole", row["node_subtype"]),
                             source=f"nodes_v1.csv#{nid} [CONSTRUCTED]", graph="network")
    for row in devices:
        did = row["device_id"]
        source = f"devices_v1.csv#{did} [CONSTRUCTED]"
        graph.add_entity("Device", did, graph="device", attrs=row)
        for relation, etype, value in (
            ("instanceOf", "DeviceModel", row.get("model_id")),
            ("installedAt", "Node", row.get("node_id")),
            ("hasAntenna", "Antenna", row.get("antenna_id")),
        ):
            if value:
                graph.add_triple(("Device", did), relation, (etype, value),
                                 source=source, graph="device")

    for row in links:
        lid = row["link_id"]
        source = f"topology_links_v1.csv#{lid} [CONSTRUCTED]"
        graph.add_entity("Link", lid, graph="network", attrs=row)
        for endpoint in ("node_a_id", "node_b_id"):
            graph.add_triple(("Link", lid), "connects", ("Node", row[endpoint]),
                             source=source, graph="network")

    state, _throughput = build_default()
    for rule in state.rules:
        source = f"link_status_v1.csv [CONSTRUCTED, DERIVED:{rule['rule_id']}]"
        metric = ("Metric", f"{rule['band']}:{rule['metric']}:{rule['rule_id']}")
        graph.add_entity(*metric, graph="network", attrs=rule)
        graph.add_triple(metric, "indicates", ("LinkState", rule["state"]),
                         source=source, graph="network")
    latest = {}
    for row in metrics:
        lid = row["link_id"]
        if lid not in latest or row["timestamp"] > latest[lid]["timestamp"]:
            latest[lid] = row
    for lid, row in latest.items():
        graph.add_triple(("Link", lid), "evaluatedAs", ("LinkState", row["link_state"]),
                         source=f"link_status_v1.csv#{row['record_id']} [CONSTRUCTED]",
                         graph="network")

    from pathlib import Path
    fault_file = Path(data_path("fault_case.csv")).parents[1] / "knowledge_graph" / "fault_triples_v1.csv"
    graph.load_csv(str(fault_file), graph="fault")
    for row in _rows("fault_case.csv"):
        cid = row["case_id"]
        graph.add_entity("Case", cid, graph="fault", attrs=dict(row, dataset_origin="CONSTRUCTED"))
        graph.add_triple(("Fault", cid), "recordedIn", ("Case", cid),
                         source=f"fault_cases_v1.csv#{cid} [CONSTRUCTED]", graph="fault")
    graph.freeze("Constructed device, network and fault knowledge; not field-validated")
    return graph, state

"""固定网系中的物理电台分配与独立参数校验。"""
from __future__ import annotations

from scripts.planning import sr4_flow


def _topology():
    nodes = [
        {"node_id": "A", "node_subtype": "I_FIXED", "lon": "114", "lat": "37"},
        {"node_id": "B", "node_subtype": "II_FIXED", "lon": "114.1", "lat": "37"},
        {"node_id": "C", "node_subtype": "III_MOBILE", "lon": "114.2", "lat": "37"},
    ]
    links = [
        {"link_id": "L1", "node_a_id": "A", "node_b_id": "B",
         "device_class": "HF", "is_available": "true"},
        {"link_id": "L2", "node_a_id": "B", "node_b_id": "C",
         "device_class": "HF", "is_available": "true"},
    ]
    models = [{"model_id": "M", "device_class": "HF"}]
    devices = [
        {"device_id": "A1", "node_id": "A", "model_id": "M"},
        {"device_id": "B1", "node_id": "B", "model_id": "M"},
        {"device_id": "B2", "node_id": "B", "model_id": "M"},
        {"device_id": "C1", "node_id": "C", "model_id": "M"},
    ]
    return links, nodes, devices, models


def test_distinct_nets_bind_distinct_devices_at_same_station():
    links, nodes, devices, models = _topology()
    assert sr4_flow.bind_links_to_devices(links, nodes, devices, models) == []
    assert links[0]["device_a_id"] == "A1"
    assert links[1]["device_b_id"] == "C1"
    assert {links[0]["device_b_id"], links[1]["device_a_id"]} == {"B1", "B2"}


def test_device_shortage_is_explicit_and_does_not_reuse_a_radio():
    links, nodes, devices, models = _topology()
    devices = [row for row in devices if row["device_id"] != "B2"]
    errors = sr4_flow.bind_links_to_devices(links, nodes, devices, models)
    assert len(errors) == 1
    assert "B HF 需 2 台、仅有 1 台" in errors[0]
    assert sum(link.get("device_a_id") == "B1" for link in links) + sum(
        link.get("device_b_id") == "B1" for link in links) == 1


def test_device_endpoint_pins_the_first_route_network():
    links, nodes, devices, models = _topology()
    demands = [{"demand_id": "D1", "src_node_id": "B", "dst_node_id": "A",
                "source_device_id": "B2", "target_device_id": "A1"}]
    routes = {"routes": [{"demand_id": "D1", "reachable": True,
                           "primary": {"link_path": ["L1"]}}]}
    assert sr4_flow.bind_links_to_devices(
        links, nodes, devices, models, demands=demands, routes=routes) == []
    assert links[0]["device_b_id"] == "B2"
    assert links[1]["device_a_id"] == "B1"
    assert sr4_flow.endpoint_binding_errors(links, demands, routes) == []
    links[0]["device_b_id"] = "B1"
    assert sr4_flow.endpoint_binding_errors(links, demands, routes)


def test_power_override_changes_only_links_using_selected_radio(monkeypatch):
    import radio_params as RP

    links, nodes, devices, _ = _topology()
    models = sr4_flow.load("device_model.csv")
    model = next(row for row in models if row["device_class"] == "HF"
                 and len(RP.power_levels_of(row)) > 1)
    antennas = sr4_flow.load("antenna_model.csv")
    for device in devices:
        device.update(model_id=model["model_id"],
                      antenna_id=antennas[0]["antenna_id"],
                      tx_power_dbm="40", antenna_height_m="10")
    assert sr4_flow.bind_links_to_devices(links, nodes, devices, models) == []
    stations = sr4_flow.stations_from_nodes(nodes, devices, models, antennas)
    monkeypatch.setattr(RP, "_margin_with", lambda _terrain, _sa, _sb, _band,
                        tx_a, tx_b, _ha, _hb: (min(tx_a, tx_b) - 35, 1000, 80))
    cap = RP.capabilities_by_device(stations, devices, models, antennas)
    selected = links[0]["device_b_id"]
    other = links[1]["device_a_id"]

    def recalculate(power):
        return RP.plan_bound_devices(
            stations, links, devices, models, antennas, None,
            manual_override=[{"device_id": "A1", "tx_power_dbm": cap["A1"].tx_max},
                             {"device_id": selected, "tx_power_dbm": power}])

    low = recalculate(cap[selected].tx_min)
    high = recalculate(cap[selected].tx_max)
    assert not low["manual_errors"] and not high["manual_errors"]
    low_params = {row["device_id"]: row for row in low["params"]}
    high_params = {row["device_id"]: row for row in high["params"]}
    assert low_params[selected]["tx_power_dbm"] == cap[selected].tx_min
    assert high_params[selected]["tx_power_dbm"] == cap[selected].tx_max
    assert low_params[other] == high_params[other]
    assert low["links"][0]["margin_db"] < high["links"][0]["margin_db"]
    assert low["links"][1]["margin_db"] == high["links"][1]["margin_db"]


def test_interference_links_keep_separate_radios_at_same_station():
    import interference as IF
    from feasibility import Station

    links, _, _, _ = _topology()
    links[0].update(device_a_id="A1", device_b_id="B1")
    links[1].update(device_a_id="B2", device_b_id="C1")
    base_radio = {"tx_dbm": 35.0, "height": 5.0, "gain": 1.0,
                  "sens": -100.0, "bw": 3.0, "pattern": "OMNI",
                  "fmin": 3000.0, "fmax": 10000.0}
    stations = [Station(sid, 114 + index * 0.1, 37, "II_FIXED",
                        {"HF": dict(base_radio)})
                for index, sid in enumerate(("A", "B", "C"))]
    radios = {did: dict(base_radio, tx_dbm=power, height=height)
              for did, power, height in (("A1", 40.0, 10.0),
                                         ("B1", 30.0, 2.0),
                                         ("B2", 50.0, 20.0),
                                         ("C1", 45.0, 12.0))}
    scenario = IF.build_scenario(
        stations, links, None, [], freq_of={"L1": 7000.0, "L2": 7000.0},
        device_radios=radios)
    assert scenario.links[0].tx["B"] == 30.0
    assert scenario.links[1].tx["B"] == 50.0
    assert scenario.links[0].st_b.radio["HF"]["height"] == 2.0
    assert scenario.links[1].st_a.radio["HF"]["height"] == 20.0

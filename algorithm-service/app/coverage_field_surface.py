"""冻结覆盖的预测场强面；不修改部署求解器，不插值填平遮挡或静区。

场强由各向同性接收功率换算：E(dBµV/m)=Pr(dBm)+20log10(f_MHz)+77.21。
分级沿用现有链路质量的10/20dB余量显示界限，不作为新增验收门限。
"""
import math


VERSION = "V01-5"
FIELD_OFFSET = 77.21


def field_strength(rx_dbm, freq_khz):
    if not math.isfinite(rx_dbm) or not math.isfinite(freq_khz) or freq_khz <= 0:
        raise ValueError("场强换算输入必须为有限接收功率和正频率")
    return rx_dbm + 20 * math.log10(freq_khz / 1000) + FIELD_OFFSET


def signal_values(radio, loss, frequency, service, minimum):
    from propagation import noise_floor_dbm, REQUIRED_SNR_DB
    rx = radio["tx_dbm"] + radio["gain"] - loss  # 接收增益显式为0dBi
    required = max(radio["sens"], noise_floor_dbm(frequency, radio["bw"]) + REQUIRED_SNR_DB[service])
    margin = rx - required
    return dict(rx_power_dbm=rx, path_loss_db=loss, margin_db=margin,
                field_strength_dbuvm=field_strength(rx, frequency),
                required_field_dbuvm=field_strength(required, frequency),
                strength_class="STRONG" if margin >= 20 else "MEDIUM" if margin >= 10 else "WEAK",
                is_coverage=margin >= minimum)


def _feature(item, geometry, properties):
    return dict(type="Feature", geometry=geometry,
                properties=dict(device_id=item["device_id"], node_id=item["node_id"], **properties))


def vuhf_surface(terrain, item, options, check, limit):
    """逐网格中心计算P.1812地形剖面；仅绘制实际预算达标格，不连凸包。

    格面按分辨率显示，边界误差由cell_m决定。DEM外格不显示；nodata由
    已核验terrain拒绝。不在首次衰落处终止，避免抹去远处重新可达区域。
    """
    from propagation import vuhf_path_loss
    from terrain import haversine_m
    radio, frequency = item["radio_parameters"], item["frequency"]
    cell, radius = options["cell_m"], options["radius_m"]
    dx = cell / (111320 * math.cos(math.radians(item["lat"])))
    dy = cell / 111320
    west, south, east, north = terrain.bbox
    count = math.ceil(radius / cell)
    if (2 * count + 1) ** 2 > limit:
        raise ValueError("逐格覆盖超过本次剩余采样限额，请增大网格或减小半径")
    cells, features, evaluated = [], [], 0
    for gx in range(-count, count + 1):
        for gy in range(-count, count + 1):
            check()
            lon, lat = item["lon"] + gx * dx, item["lat"] + gy * dy
            # 完整格面须处于已核验DEM内；不把半个未知格染成已知覆盖。
            if not (west <= lon - dx / 2 and lon + dx / 2 < east
                    and south < lat - dy / 2 and lat + dy / 2 <= north):
                continue
            distance = haversine_m(item["lon"], item["lat"], lon, lat)
            if distance > radius or distance < 1:
                continue
            evaluated += 1
            loss, los, clearance, _ = vuhf_path_loss(terrain, (item["lon"], item["lat"]),
                (lon, lat), frequency, radio["height"], options["rx_height_m"])
            signal = signal_values(radio, loss, frequency, "数据", options["margin_min_db"])
            values = dict(gx=gx, gy=gy, los=los, clearance_m=clearance, **signal)
            cells.append(values)
            if not signal["is_coverage"]:
                continue
            ring = [[lon-dx/2, lat-dy/2], [lon+dx/2, lat-dy/2], [lon+dx/2, lat+dy/2],
                    [lon-dx/2, lat+dy/2], [lon-dx/2, lat-dy/2]]
            features.append(_feature(item, dict(type="Polygon", coordinates=[ring]),
                dict(freq_khz=frequency, surface_kind="TERRAIN_CELL", **values)))
    return dict(shape="CELLS", origin=[item["lon"], item["lat"]], cell_m=cell, radius_m=radius,
                cells=cells, rings=[], evaluated_samples=evaluated,
                geojson=dict(type="FeatureCollection", features=features))


def hf_surface(terrain, item, options, check, circle):
    """逐公里预算确定地波与天波落区，不用固定倍数画第一跳外缘。

    HF是距离环带模型，地物取冻结站点，电离层为原P.533假设；不冒充
    逐方位远域DEM或实测。无静区的NVIS可呈圆盘，不能伪造一个内孔。
    """
    from propagation import hf_ground_wave_loss
    from prop import p533
    radio, frequency, hour = item["radio_parameters"], item["frequency"], options["hour"]
    landcover = terrain.landcover(item["lon"], item["lat"])
    skip = p533.skip_distance_km(frequency, hour)
    samples, rings, features = [], [], []
    for km in range(1, options["hf_max_km"] + 1):
        check()
        ground = hf_ground_wave_loss(frequency, km * 1000, landcover)
        sky, details = p533.path_loss(km * 1000, frequency, hour, lat_deg=item["lat"], hops=1)
        # 不把P.533的不可用哨兵值换成一个可计算的巨大场强。
        mode, loss = ("GROUND", ground) if ground <= sky else ("SKYWAVE", sky)
        values = signal_values(radio, loss, frequency, "话音", options["margin_min_db"])
        samples.append(dict(distance_m=km * 1000, propagation_mode=mode, **values))
        covered = values["is_coverage"]
        kind = mode if covered else "SKIP_ZONE" if km < skip else "BELOW_THRESHOLD"
        key = (covered, kind, values["strength_class"] if covered else None)
        if not rings or rings[-1]["_key"] != key:
            rings.append(dict(_key=key, inner_m=(km-1)*1000, outer_m=km*1000,
                              is_coverage=covered, surface_kind=kind, _samples=[samples[-1]]))
        else:
            rings[-1]["outer_m"] = km*1000
            rings[-1]["_samples"].append(samples[-1])
    labels = {"GROUND":"地波连续覆盖", "SKYWAVE":"天波落区", "SKIP_ZONE":"静区：地波不足且天波尚未落地",
              "BELOW_THRESHOLD":"未达到接收门限"}
    for ring in rings:
        check()
        ring.pop("_key")
        values = ring.pop("_samples")
        # 每个色带显示其中最弱采样值，并保留全剖面，不用均值掩盖低场强。
        weakest = min(values, key=lambda row: row["field_strength_dbuvm"])
        ring.update({key:weakest[key] for key in ("field_strength_dbuvm", "rx_power_dbm", "path_loss_db",
                                                "required_field_dbuvm", "margin_db", "strength_class")})
        ring["note"] = labels[ring["surface_kind"]]
        shell = circle(item["lon"], item["lat"], ring["outer_m"], options["ring_vertices"], check)
        coordinates = [shell]
        if ring["inner_m"]:
            coordinates.append(list(reversed(circle(item["lon"], item["lat"], ring["inner_m"], options["ring_vertices"], check))))
        crosses = any(abs(a[0]-b[0]) > 180 for edge in coordinates for a,b in zip(edge,edge[1:]))
        geometry = None if crosses else dict(type="Polygon", coordinates=coordinates)
        features.append(_feature(item, geometry, dict(freq_khz=frequency, **ring)))
    return dict(shape="RINGS", cells=[], rings=rings, radial_samples=samples,
                skip_distance_m=skip*1000 if math.isfinite(skip) else None,
                max_distance_m=options["hf_max_km"]*1000, evaluated_samples=len(samples),
                geojson=dict(type="FeatureCollection", features=features))


def metadata():
    return dict(kind="PREDICTED_FIELD_STRENGTH", unit="dBuV/m", receiver_gain_dbi=0,
        conversion="E=Pr+20log10(f_MHz)+77.21", grading_basis="RECEIVER_THRESHOLD_MARGIN",
        medium_margin_db=10, strong_margin_db=20,
        grading_note="分级沿用现有链路质量10/20dB显示界限，非新增验收指标；数值为预测，非实测",
        hf_geometry="P368_P533_RADIAL_BUDGET", vuhf_geometry="P1812_TERRAIN_GRID")

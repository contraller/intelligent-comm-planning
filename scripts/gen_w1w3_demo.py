#!/usr/bin/env python3
"""Rebuild every terrain-dependent demo dataset from a checkpointed full run.

Run prepare_replacement_dem, gen_test_data, gen_algorithm_design_data,
build_fault_graph and rerun_dem_algorithms first. This exporter preserves only
the static UI and descriptive dictionaries, never previous computed results.
"""
import array
import base64
import csv
import datetime as dt
import io
import json
import math
from pathlib import Path
import pickle
import platform
import re
import subprocess
import sys
import time

from PIL import Image

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent
sys.path[:0] = [str(HERE), str(HERE / 'geo'), str(HERE / 'planning')]
from terrain import BBOX, DEM_HEADER, default_terrain, haversine_m
from datapaths import path as dpath
from feasibility import MAX_RANGE_M, FeasibilityMatrix, link_margin, representative_freq
import deployment as DEP
import echelon as E
import metrics as MET
import frequency as FQ
import radio_params as RP
import routing as ROUTE
import plan_check
import candidate_sites as CS
import viewshed as VS
from roads import RoadDistanceField
from gen_algorithm_design_data import CANDIDATE_SCAN
from update_replacement_demo import hillshade_data_uri

HTML = ROOT / 'W1-W3算法演示.html'
RESULTS = ROOT / 'data/results/current_dem'


def load(key):
    with open(dpath(key), encoding='utf-8-sig', newline='') as f:
        return list(csv.DictReader(f))


def b64(values, code):
    a = array.array(code, values)
    if sys.byteorder != 'little':
        a.byteswap()
    return base64.b64encode(a.tobytes()).decode('ascii')


def image_uri(img):
    buf = io.BytesIO()
    img.save(buf, format='PNG')
    return 'data:image/png;base64,' + base64.b64encode(buf.getvalue()).decode('ascii')


def node_record(st, row, terrain, added=False):
    radio = {band: dict(tx=r['tx_dbm'], gain=r['gain'], h=r['height'],
                        sens=r['sens'], bw=r['bw'], pat=r['pattern'],
                        fmin=r['fmin'], fmax=r['fmax']) for band, r in st.radio.items()}
    return dict(id=st.sid, name=row.get('node_name') or st.sid, sub=st.subtype,
                ech=E.SUBTYPE_ECHELON[st.subtype], lon=st.lon, lat=st.lat,
                elev=terrain.elevation(st.lon, st.lat), region=row.get('region') or '新增中继',
                key=str(row.get('is_key', '')).lower() == 'true',
                parents=row.get('parent_node_id', ''), bands=sorted(radio), radio=radio,
                added=added, site_id=st.sid.split('-')[-2] + '-' + st.sid.split('-')[-1] if added else '')


def pack_plan(fm, sol, demands, name, note, sid):
    ev = MET.evaluate(fm, sol, demands)
    dr = ev['demands']
    if sol.unconnected:
        note += f"；当前仍有 {len(sol.unconnected)} 个台站未接入，不是全连通可行解"
        if name == '方案1 最经济':
            name = '方案1 当前部署结果'
    m = {k: ev[k] for k in ('connectivity', 'stations', 'connected', 'unconnected',
                            'lower_bound', 'gap', 'proved_optimal')}
    m.update(link_margin_min_db=ev['margin_min'], link_margin_median_db=ev['margin_median'],
             ports_saturated=[ev['ports']['full'], ev['ports']['total']],
             backup_parent_nodes=ev['backup'], satisfied_demand_count=dr['reachable'],
             total_demand_count=dr['total'], hop_histogram=dr['hop_hist'],
             lateral_shortcut_count=dr['lateral'])
    added = []
    for i, sub in sol.added:
        st = fm.stations[i]
        added.append(dict(id=st.sid, sub=sub, site_id='-'.join(st.sid.split('-')[-2:]),
                          lon=st.lon, lat=st.lat, bands=sorted(st.radio),
                          serves=[fm.stations[c].sid for c, (p, _) in sol.parent_of.items() if p == i],
                          ports={b: [sol.ports.get((i, b), 0), E.capacity(sub, b)] for b in st.radio}))
    return dict(name=name, note=note, radio_count=len(sol.added), added=added,
                edges=[[fm.stations[c].sid, fm.stations[p].sid, b,
                        fm.margin_of(c, p, b)] for c, (p, b) in sol.parent_of.items()],
                unconnected=[fm.stations[i].sid for i in sorted(sol.unconnected)],
                layer_log=sol.layer_log, metrics=m, solution_id=sid,
                diagnose=[dict(id=r['station'], sub=r['subtype'], reasons=r['reasons'])
                          for r in DEP.diagnose(fm, sol)])


def candidate_grid(terrain, roads, nodes, candidates, lc_names):
    lon0, lat0, lon1, lat1 = BBOX
    mid = (lat0 + lat1) / 2
    ml = 111320 * math.cos(math.radians(mid))
    dx, dy = 500 / ml, 500 / 111320
    nc, nr = int((lon1 - lon0) / dx) + 1, int((lat1 - lat0) / dy) + 1
    lons, lats = [lon0 + k * dx for k in range(nc)], [lat0 + r * dy for r in range(nr)]
    elev, slopes, road2, lc, scores = [], [], [], [], []
    for lat in lats:
        for lon in lons:
            e, sl = terrain.elevation(lon, lat), terrain.slope_deg(lon, lat)
            cell = roads._cell(lon, lat)
            rd2 = int(roads._dist[cell]) if cell is not None else 4294967295
            rd = math.sqrt(rd2) * roads.cell_m
            nearest = min(haversine_m(lon, lat, float(n['lon']), float(n['lat'])) for n in nodes)
            elev.append(round(e))
            slopes.append(sl)
            road2.append(rd2)
            lc.append(lc_names.index(terrain.landcover(lon, lat)))
            scores.append(round(CS.score_site(e, sl, rd, nearest) * 100))
    return dict(ncols=nc, nrows=nr, lons=[round(v, 6) for v in lons], lats=[round(v, 6) for v in lats], lat_mid=mid, m_lon=ml,
                road_cell_m=roads.cell_m, no_road=4294967295, elev=b64(elev, 'h'),
                slope=b64(slopes, 'f'), road2=b64(road2, 'I'), lc=b64(lc, 'B'), score=b64(scores, 'H'),
                forbidden_default=list(CS.DEFAULT_FORBIDDEN_LANDCOVER), defaults=CANDIDATE_SCAN,
                level_thresholds=[70, 55, 40],
                backend_sites=[[r['site_id'], float(r['lon']), float(r['lat']),
                                r['recommendation_level'], float(r['score']), r['candidate_role']]
                               for r in candidates])


def basemap(terrain, roads, old):
    ext = terrain.bbox
    ml = 111320 * math.cos(math.radians((ext[1] + ext[3]) / 2))
    size = [math.ceil((ext[2] - ext[0]) * ml / 180), math.ceil((ext[3] - ext[1]) * 111320 / 180)]
    uri, erange = hillshade_data_uri(terrain._dem, ext, size)
    names = list(old['lc_names'])
    colors = list(old['lc_colors'])
    if '未知' not in names:
        names.append('未知')
        colors.append([100, 110, 115, 100])
    pixels = []
    for y in range(size[1]):
        lat = ext[3] - (ext[3] - ext[1]) * (y + .5) / size[1]
        for x in range(size[0]):
            lon = ext[0] + (ext[2] - ext[0]) * (x + .5) / size[0]
            pixels.append(tuple(colors[names.index(terrain.landcover(lon, lat))]))
    lc = Image.new('RGBA', tuple(size))
    lc.putdata(pixels)
    rd = Image.new('RGBA', (roads.width, roads.height))
    rd.putdata([(236, 218, 166, 230) if v == 0 else (0, 0, 0, 0) for v in roads._dist])
    return dict(extent=list(ext), size=size, px_m=180, terrain=uri, landcover=image_uri(lc),
                roads=image_uri(rd), roads_extent=[roads.lon0, roads.lat0, roads.lon1, roads.lat1],
                lc_names=names, lc_colors=colors, elev_range=erange, hypso=old['hypso'])


def coverage(terrain, stations, candidates):
    mid = (BBOX[1] + BBOX[3]) / 2
    ml = 111320 * math.cos(math.radians(mid))
    nx = int(round((BBOX[2] - BBOX[0]) * ml / 1000))
    ny = int(round((BBOX[3] - BBOX[1]) * 111320 / 1000))
    hx, hy = nx * 2, ny * 2
    maxm, counts = [0] * (hx * hy), [0] * (hx * hy)
    union, per = set(), []
    for k, st in enumerate(s for s in stations if s.has(E.VUHF)):
        res = VS.vuhf_coverage(terrain, st)
        local = set()
        sml = 111320 * math.cos(math.radians(st.lat))
        for (gx, gy), margin in res.cells.items():
            lon, lat = st.lon + gx * res.cell_m / sml, st.lat + gy * res.cell_m / 111320
            px, py = int(math.floor((lon - BBOX[0]) * ml / 500)), int(math.floor((lat - BBOX[1]) * 111320 / 500))
            if 0 <= px < hx and 0 <= py < hy:
                h = (hy - 1 - py) * hx + px
                maxm[h] = max(maxm[h], max(1, min(255, round(margin) + 1)))
                local.add((px // 2, py // 2))
        # Count each station at most once per heat-map cell.
        heat = set()
        for gx, gy in res.cells:
            px = math.floor((st.lon + gx * res.cell_m / sml - BBOX[0]) * ml / 500)
            py = math.floor((st.lat + gy * res.cell_m / 111320 - BBOX[1]) * 111320 / 500)
            if 0 <= px < hx and 0 <= py < hy:
                heat.add((hy - 1 - py) * hx + px)
        for h in heat:
            counts[h] = min(255, counts[h] + 1)
        union.update(local)
        ordered = sorted((ny - 1 - y) * nx + x for x, y in local)
        delta = [v - (ordered[i - 1] if i else 0) for i, v in enumerate(ordered)]
        per.append(dict(id=st.sid, area_km2=res.area_km2(), cells=b64(delta, 'I')))
        if k % 20 == 0:
            print('coverage stations:', k + 1, flush=True)
    zones = VS.blind_zones(union, BBOX)
    advice = VS.expansion_advice(terrain, zones[:10], candidates, stations, BBOX)
    for row, (_, cells, _) in zip(advice, zones[:10]):
        row['cells'] = sorted((ny - 1 - y) * nx + x for x, y in cells)
    return dict(nx=nx, ny=ny, cell_m=1000, hx=hx, hy=hy, heat_cell_m=500,
                maxm=b64(maxm, 'B'), cnt=b64(counts, 'B'), per_station=per,
                union_km2=len(union), planning_km2=nx * ny,
                blind_total=len(zones), blind_total_km2=sum(z[0] for z in zones), blind=advice,
                params=dict(radius_m=60000, cell_m=250, margin_min_db=6, az_step=2))


def hf_rings(terrain, stations, old):
    freqs, hours = old['freqs'], old['hours']
    rings, notes = {}, {}
    for st in stations:
        if not st.has(E.HF):
            continue
        rings[st.sid] = []
        for hour in hours:
            row = []
            for freq in freqs:
                res = VS.hf_coverage_rings(terrain, st, freq * 1000, hour)
                row.append([[a / 1000, b / 1000, 'S' if '静区' in label else 'H' if '第一跳' in label else 'G']
                            for a, b, label in res.rings if b > a])
                notes[f'{hour}|{freq}'] = VS.hf_skip_geometry(freq * 1000, hour)[1]
            rings[st.sid].append(row)
    return dict(freqs=freqs, hours=hours, rings=rings, notes=notes)


def pack_frequency(out):
    pool_rows = load('frequency_resource.csv')
    pool = FQ.FreqPool(pool_rows)
    idx = {c['freq_id']: i for i, c in enumerate(pool.channels)}
    assignments = {r['task_id']: r for r in out['frequency']['assignments']}
    tasks = out['freq_tasks']
    adj, sep = FQ.build_interference(tasks, pool)
    ft = [dict(id=t.task_id, label=t.label, band=t.band, members=list(t.members), pts=t.pts,
               allowed=[idx[c['freq_id']] for c in t.allowed],
               ch=idx.get(assignments[t.task_id]['freq_id']), fmin=t.freq_min_khz, fmax=t.freq_max_khz)
          for t in tasks]
    link_tasks = FQ.tasks_from_links(out['links'], out['nodes'], out['devices'], load('device_model.csv'))
    FQ.fill_ranges_by_node(link_tasks, out['links'], out['nodes'], out['devices'], load('device_model.csv'))
    lr = FQ.assign(link_tasks, pool)
    fr = out['frequency']
    return dict(pool=[dict(id=c['freq_id'], band=c['band'], f=c['freq_khz'],
                           bw=c['bandwidth_khz'], reuse=c['reuse_min_distance_m'], guard=c['adjacent_guard_khz'])
                      for c in pool.channels],
                pool_all=[dict(id=r['freq_id'], band=r['device_class'], f=float(r['center_freq_khz']),
                               bw=float(r['bandwidth_khz']), ok=r['is_available'] == 'true', note=r.get('note', ''))
                          for r in pool_rows], tasks=ft,
                edges=[[i, j, sep[(i, j)]] for i in range(len(tasks)) for j in sorted(adj[i]) if j > i],
                adj_ratio=FQ.ADJ_DISTANCE_RATIO, conflicts=fr['conflicts'], gap=fr['gap'],
                stats=fr['stats'], conflict_free=fr['conflict_free'], advice=fr.get('expansion_advice', []),
                link_granularity=dict(objects=len(link_tasks), conflicts=len(lr['conflicts']),
                                      co=sum(c['type'] == 'CO_CHANNEL' for c in lr['conflicts']),
                                      channels_used=lr['stats']['channels_used'], interference_edges=lr['stats']['interference_edges'],
                                      shortage={k: v['shortage'] for k, v in lr['gap'].items()},
                                      required={k: v['required_channels'] for k, v in lr['gap'].items()}))


def pack_params(out):
    comparison = RP.compare_plans(out['presets'])
    plans = {}
    for p in out['presets']:
        plans[p['preset']] = dict(name=p['preset_name'], note=p['note'], fade=p['fade_margin_db'], summary=p['summary'],
            params=[[r['node_id'], r['band'], r['model_id'], r['antenna_id'], r['tx_power_dbm'],
                     r['tx_power_levels_dbm'], r['antenna_height_m'], r['antenna_height_range_m'], int(r['active'])]
                    for r in p['params']],
            links=[[r['node_a'], r['node_b'], r['band'], r['distance_m'], r['path_loss_db'],
                    r['tx_a_dbm'], r['tx_b_dbm'], r['height_a_m'], r['height_b_m'],
                    r['margin_db'], r['margin_at_max_power_db'], int(r['meets'])] for r in p['links']],
            upgrade=RP.upgrade_advice(p, out['caps']))
    return dict(presets=RP.preset_list(), comparison=comparison,
                recommended=RP.recommend(comparison)['preset'], plans=plans, pipeline_default='TERRAIN')


def pack_routes(out, ni):
    def path(p):
        if not p:
            return None
        return [[ni[s] for s in p['node_path']], p['link_path'], p['hop_count'], p['band_switches'],
                p['total_delay_ms'], p['min_link_margin_db'], p['reliability'], p['bottleneck_link_id']]
    result = {}
    for strategy in ROUTE.STRATEGIES:
        rows = ROUTE.plan_routes(out['graph'], out['demands'], default_strategy=strategy)['routes']
        result[strategy] = [[r['demand_id'], int(r['reachable']), path(r.get('primary')), path(r.get('backup')),
                             r.get('backup_type', 'NONE'), [ni[s] for s in r.get('single_point_risks', [])]] for r in rows]
    return result


def refresh_w1(data, out, candidates):
    for ds in data['w1']['datasets']:
        target = ROOT / ds['file']
        ds['bytes'] = target.stat().st_size
        if target.suffix == '.csv':
            with target.open(encoding='utf-8-sig', newline='') as f:
                reader = csv.reader(f)
                ds['fields'] = next(reader)
                rows = list(reader)
            ds['rows'], ds['sample'] = len(rows), [[s[:40] for s in r] for r in rows[:5]]
        else:
            ds['rows'] = len(json.loads(target.read_text(encoding='utf-8')))
    raw = data['w1']['raw'][0]
    meta = json.loads(Path(DEM_HEADER).read_text(encoding='utf-8'))
    raw.update(file='data/raw/dem/' + meta['data_file'], size=f"{meta['width']} × {meta['height']}",
               bbox=meta['bbox'], source=meta['source'] + ' (原始地理坐标；数据来源待确认)')
    for r in data['w1']['raw'][1:]:
        r['source'] += '；仅使用与新规划区重叠的部分'
    stations = [s for s in out['stations'] if not s.is_candidate]
    data['w1']['quantity'] = dict(hf_nodes=sum(s.has(E.HF) for s in stations),
        vuhf_nodes=sum(s.has(E.VUHF) for s in stations), nodes=len(stations), area_km=[120, 120],
        devices=len(load('device.csv')), demands=len(out['demands']), candidates=len(candidates),
        channels=len(load('frequency_resource.csv')))


def write_report(data):
    meta, q, w2, w3, w4 = data['meta'], data['w1']['quantity'], data['w2'], data['w3'], data['w4']
    best = w4['optimization']['best']['objectives']
    count = len(base64.b64decode(w2['cgrid']['lc']))
    unknown = base64.b64decode(w2['cgrid']['lc']).count(data['basemap']['lc_names'].index('未知'))
    rows = ['# 新太行 DEM 全流程重算记录', '',
        f"生成时间：{meta['generated_at']}",
        f"输入：`{meta['dem']['source']}`；SHA256：`{meta['dem']['source_sha256']}`。", '',
        '## 地形与数据',
        '- 使用 TIFF 原始 EPSG:4326 坐标；没有把高程矩阵映射到旧经纬度。',
        f"- DEM：{meta['dem']['width']} × {meta['dem']['height']}，高程 {meta['dem']['elevation_min']}–{meta['dem']['elevation_max']} m，缺失像素 {meta['dem']['nodata_count']}。",
        f"- 地形边界：{meta['dem']['bbox']}；规划区：{meta['bbox']}，120 × 120 km。",
        f"- 现网合成节点 {q['nodes']}（短波 {q['hf_nodes']}、超短波 {q['vuhf_nodes']}），设备 {q['devices']}，候选站址 {q['candidates']}，通联需求 {q['demands']}。",
        '- 四个合成任务区中心随规划区定位。合成台站重新布设，不代表移动真实已部署固定站。',
        '- 道路、地物保留原始地理坐标，仅使用重叠部分，不伪造新区域道路或地物。',
        f'- 候选扫描网格中未知地物 {unknown}/{count}（{unknown / count:.1%}）；传播模型对此采用默认地物参数，结果需补充资料后复核。',
        '- 距路约束会排除现有道路资料未覆盖的区域，不能据此断言那里没有道路；西部部署备选受资料范围限制。',
        '- 覆盖射线不在 DEM 之外外推边缘高程。', '',
        '## W2 / W3',
        f"- 部署前连通 {w2['pre']['metrics']['connected']}/{q['nodes']}；P1 新增 {w2['p1']['count']} 台，连通 {w2['plans'][0]['metrics']['connected']}/{w2['plans'][0]['metrics']['stations']}。",
        f"- 下界 {w2['p1']['lower_bound']}；已证明最优：{w2['p1']['proved_optimal']}。",
        f"- 三种路由策略各重新计算 {q['demands']} 条需求。最高可靠性策略可达 {sum(r[1] for r in w3['routes']['MAX_RELIABILITY'])} 条。",
        f"- 频率冲突 {len(w3['freq']['conflicts'])} 处；缺口：{ {k: v['shortage'] for k, v in w3['freq']['gap'].items()} }。",
        f"- 地形配置方案校验通过：{w3['checks']['TERRAIN']['passed']}；分类：{w3['checks']['TERRAIN']['summary']['by_kind']}。",
        f"- W2/W3 管线 {meta['pipeline_sec']:.2f} s；覆盖、P2、三策略对照等演示额外计算另计。", '',
        '## P2 备选部署',
        '| 方案 | 新增台数 | 连通节点/参与节点 |', '|---|---:|---:|']
    rows += [f"| {p['name']} | {p['radio_count']} | {p['metrics']['connected']}/{p['metrics']['stations']} |" for p in w2['plans']]
    rows += ['', '## W4',
        f"- 优化找到可行解：{w4['optimization']['feasible']}；全部通联连通率 {best['e2e_connectivity']:.1%}，抗毁性 {best['survivability']:.1%}。",
        f"- 必要通联连通率 {w4['optimization']['best']['constraint_check']['mandatory_e2e_connectivity']['value']:.2%}，要求 100%；该硬约束未满足。",
        f"- 闭环频率冲突 {len(w4['frequency']['conflicts'])} 处；最终校验通过：{w4['check']['passed']}。",
        f"- 受扰链路 {w4['interference']['analysis']['summary']['affected_links']}；建议 {len(w4['interference']['countermeasures'])} 条，预测能恢复 {sum(bool(r['restores']) for r in w4['interference']['countermeasures'])} 条措施；未解决项 {len(w4['interference']['unresolved'])}。",
        f"- W4 全流程 {w4['total_s']:.2f} s。",
        '- 优化可行不代表资源校验全部通过；抗干扰建议是模型预测，不代表已操作真实设备。', '',
        '## 文件与复现',
        '- `w3.json`：部署后路由、频率、三套参数、校验及拓扑。',
        '- `w4.json`：多目标优化、优化后资源重规划、校验及干扰/抗干扰结果。',
        '- `demo_data.json`：与 HTML 嵌入数据一致的完整数据。',
        '- `source.json`：DEM 元数据和各输入文件哈希。',
        '- `browser_validation.json`、`desktop-*.png`、`mobile-overview.png`：浏览器检查与截图。',
        '- 一键重算：`.venv\\Scripts\\python.exe scripts/update_replacement_demo.py`。',
        '- 回归测试：`.venv\\Scripts\\python.exe -m pytest tests -q`。',
        '- 浏览器检查：安装 Node Playwright 到 `.browser-tools` 后运行 `node scripts/verify_dem_demo.cjs`（使用本机 Edge）。',
        '- 若算法接口服务已启动，重新启动服务以清除其进程内地形/拓扑缓存；历史任务不删除。',
        '- 本次未假设扩充频率池；模型参数及地形数据来源仍保留待确认口径。', '']
    (RESULTS / 'README.md').write_text('\n'.join(rows), encoding='utf-8')


def normalize_status(data):
    # An optimality gap is defined only for a feasible solution of P1.
    if data['w2']['plans'][0]['metrics']['unconnected']:
        data['w2']['p1']['gap'] = None
        data['w2']['p1']['proved_optimal'] = False
        data['w2']['plans'][0]['name'] = '方案1 当前部署结果'
    for plan in [data['w2']['pre']] + data['w2']['plans'] + data['w2']['fixed']:
        if plan['metrics']['unconnected']:
            plan['metrics']['gap'] = None
            plan['metrics']['proved_optimal'] = False


def publish(html, match, data):
    normalize_status(data)
    packed = json.dumps(data, ensure_ascii=False, separators=(',', ':'), allow_nan=False).replace('</', '<\\/')
    HTML.write_text(html[:match.start(2)] + packed + html[match.end(2):], encoding='utf-8')
    (RESULTS / 'demo_data.json').write_text(packed, encoding='utf-8')
    write_report(data)


def main():
    started = time.perf_counter()
    html = HTML.read_text(encoding='utf-8')
    match = re.search(r'(<script id="demo-data" type="application/json">)(.*?)(</script>)', html, re.S)
    data = json.loads(match[2])
    meta = json.loads(Path(DEM_HEADER).read_text(encoding='utf-8'))
    if '--publish-current' in sys.argv:
        from rerun_dem_algorithms import input_manifest
        if data['meta']['dem']['source_sha256'] != meta['source_sha256'] or data['meta']['input_sha256'] != input_manifest():
            raise ValueError('Cannot publish stale results: rerun the full workflow')
        publish(html, match, data)
        return
    with (RESULTS / 'w3_checkpoint.pkl').open('rb') as f:
        digest, out = pickle.load(f)
    if digest != meta['source_sha256']:
        raise ValueError('Stale checkpoint: rerun algorithms on current DEM first')
    from rerun_dem_algorithms import input_manifest
    manifest = json.loads((RESULTS / 'source.json').read_text(encoding='utf-8'))
    if manifest.get('input_sha256') != input_manifest():
        raise ValueError('Input datasets changed after the run: rerun algorithms first')
    w4 = json.loads((RESULTS / 'w4.json').read_text(encoding='utf-8'))
    terrain, fm, sol = out['terrain'], out['fm'], out['sol']
    candidates, base_nodes = load('candidate_site.csv'), load('node.csv')
    nb = len(base_nodes)
    base_idx, cand_idx = list(range(nb)), list(range(nb, len(fm.stations)))
    timings = [dict(name='第 2+3 周全流程 plan_pipeline.run', sec=sum(s for _, s in out['steps']))]
    timings += [dict(name='└ ' + n, sec=s, sub=True) for n, s in out['steps']]
    def timed(name, fun):
        print(name, flush=True)
        t = time.perf_counter()
        result = fun()
        timings.append(dict(name=name, sec=time.perf_counter() - t))
        return result
    alternatives = timed('部署规划：多方案 P2', lambda: DEP.multi_plan(fm, base_idx, cand_idx, sol))
    plans = [pack_plan(fm, p['sol'], out['demands'], p['name'], p['note'], f'PL-{i:04}') for i, p in enumerate(alternatives, 1)]
    pre = pack_plan(fm, DEP.solve_assignment(fm, active=base_idx), out['demands'], '部署前（仅现网台站）', '未新增电台', 'PRE')
    fixed = []
    for p in range(1, 5):
        psol = timed(f'部署规划：指定数量 p={p}', lambda: DEP.p2_solve(fm, base_idx, cand_idx, p))
        row = pack_plan(fm, psol, out['demands'], f'指定数量 p={p}', 'SR-4.2.1.2 c', f'FIXED-{p}')
        row['p'] = p
        fixed.append(row)
    by_id = {r['node_id']: r for r in base_nodes}
    required = set(by_id)
    for p in plans + fixed:
        required.update(r['id'] for r in p['added'])
    required.update(r['node_id'] for r in w4['nodes'])
    data['nodes'] = [node_record(s, by_id.get(s.sid, {}), terrain, s.sid not in by_id)
                     for s in fm.stations if s.sid in required]
    ni = {r['id']: i for i, r in enumerate(data['nodes'])}
    roads = timed('道路距离场', lambda: RoadDistanceField(str(ROOT / 'data/raw/roads/roads_taihang.geojson.gz'), BBOX))
    data['basemap'] = timed('底图：DEM 晕渲 / 地物 / 道路', lambda: basemap(terrain, roads, data['basemap']))
    cgrid = timed('候选站址筛选：网格因子', lambda: candidate_grid(terrain, roads, base_nodes, candidates, data['basemap']['lc_names']))
    def feas():
        pairs = []
        basefm = FeasibilityMatrix(fm.stations[:nb], terrain)
        for i, sa in enumerate(fm.stations[:nb]):
            for j in range(i + 1, nb):
                sb = fm.stations[j]
                for band in sorted(set(sa.radio) & set(sb.radio)):
                    if haversine_m(sa.lon, sa.lat, sb.lon, sb.lat) > MAX_RANGE_M[band]:
                        continue
                    margin, dist, loss = link_margin(terrain, sa, sb, band)
                    r, q = sa.radio[band], sb.radio[band]
                    rx = min(r['tx_dbm'], q['tx_dbm']) + r['gain'] + q['gain'] - loss
                    pairs.append([ni[sa.sid], ni[sb.sid], int(band == E.VUHF), margin, dist, loss,
                                  rx, rx - margin - (10 if band == E.HF else 15), representative_freq(r, q, band)])
        return dict(pairs=pairs, stats=basefm.stats(), margin_min=6, max_range_m=MAX_RANGE_M)
    topology = [dict(id=r['link_id'], a=r['node_a_id'], b=r['node_b_id'], band=r['device_class'],
                     margin=float(r['link_margin_db']), dist=float(r['distance_m']), backup=r['is_backup'] == 'true') for r in out['links']]
    p1 = dict(count=sol.count, lower_bound=sol.lower_bound, lower_bound_parts=sol.lower_bound_parts,
              proved_optimal=sol.proved_optimal, gap=sol.gap, exact_evals=sol.exact_evals,
              naive_evals=len(cand_idx) * max(1, sol.count), candidate_pool=len(cand_idx),
              candidate_sites=len(candidates), deployable_types=list(E.DEPLOYABLE_TYPES), bb_stats=sol.bb_stats)
    oldhf = data['w2']['hf']
    data['w2'] = dict(cgrid=cgrid, feas=timed('链路能力分析：现网两两链路预算', feas),
        pre=pre, p1=p1, plans=plans, fixed=fixed, topo_links=topology,
        coverage=timed('超短波视域 / 盲区 / 扩容建议', lambda: coverage(terrain, out['stations'], candidates)),
        hf=timed('短波跳距与静区', lambda: hf_rings(terrain, out['stations'], oldhf)))
    graph = dict(links=[dict(id=r['link_id'], a=r['a'], b=r['b'], band=r['band'], margin=r['margin_db'],
                             dist=r['distance_m'], delay=r['delay_ms'], rel=r['reliability'],
                             wrel=-math.log(r['reliability']), backup=next(t['backup'] for t in topology if t['id'] == r['link_id']))
                        for r in out['graph'].links.values()], band_switch_ms=ROUTE.BAND_SWITCH_MS,
                 hop_ms=ROUTE.HOP_PROCESS_MS, sigma_db=ROUTE.SHADOW_SIGMA_DB)
    demands = [dict(id=r['demand_id'], task=r['task_id'], src=ni[r['src_node_id']], dst=ni[r['dst_node_id']],
                    pri=r['priority'], mand=r['is_mandatory'] == 'true', svc=r['service_type'],
                    rate=float(r['required_rate_kbps']), max_delay=float(r['max_delay_ms']),
                    min_rel=float(r['min_reliability']), pref=r['preferred_class']) for r in out['demands']]
    checks = {p['preset']: plan_check.check(freq_result=out['frequency'], freq_tasks=out['freq_tasks'],
               param_result=p, route_result=out['routes'], links=out['links'], nodes=out['nodes'], caps=out['caps']) for p in out['presets']}
    data['w3'] = dict(graph=graph, strategies=list(ROUTE.STRATEGIES), demands=demands,
                     routes=timed('路由规划 × 3 策略', lambda: pack_routes(out, ni)),
                     freq=timed('频率分配（链路粒度对照）', lambda: pack_frequency(out)),
                     params=pack_params(out), checks=checks)
    data['w4'] = w4
    refresh_w1(data, out, candidates)
    data['meta'].update(generated_at=dt.datetime.now().strftime('%Y-%m-%d %H:%M:%S'), bbox=list(BBOX),
        commit=subprocess.check_output(['git', 'rev-parse', '--short', 'HEAD'], cwd=ROOT, text=True).strip(), dirty=True,
        python=platform.python_version(), platform=platform.platform(), timings=timings,
        pipeline_sec=sum(sec for _, sec in out['steps']), dem=meta, input_sha256=manifest['input_sha256'],
        data_limitations=['台站、通联需求、频率资源和干扰源为合成测试数据。',
                          '道路和地物资料仅覆盖部分新规划区；未知地物采用模型默认值，未测绘区域不能据此判定无道路。'])
    data['meta'].pop('replacement_run', None)
    timings.append(dict(name='SR-4 全流程（W4）', sec=w4['total_s']))
    timings.append(dict(name='演示数据导出额外计算', sec=time.perf_counter() - started))
    publish(html, match, data)
    print('Refreshed all demo data:', HTML, flush=True)


if __name__ == '__main__':
    main()

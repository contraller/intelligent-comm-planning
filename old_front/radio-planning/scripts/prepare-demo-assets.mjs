import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { gunzipSync } from 'node:zlib';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = fileURLToPath(new URL('../', import.meta.url));
const sourceRoot = path.join(root, 'docs/数据接口样例');

// 仅执行格式转换；引号内的逗号和换行不能按普通分隔符处理。
function parseCsv(text) {
  const rows = [];
  let row = [];
  let cell = '';
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === '"') {
      if (quoted && text[i + 1] === '"') {
        cell += '"';
        i++;
      } else quoted = !quoted;
    } else if (ch === ',' && !quoted) {
      row.push(cell);
      cell = '';
    } else if (ch === '\n' && !quoted) {
      row.push(cell.replace(/\r$/, ''));
      rows.push(row);
      row = [];
      cell = '';
    } else cell += ch;
  }
  if (cell || row.length) {
    row.push(cell.replace(/\r$/, ''));
    rows.push(row);
  }
  const headers = rows.shift().map((value) => value.replace(/^\uFEFF/, ''));
  return rows
    .filter((values) => values.some(Boolean))
    .map((values) => Object.fromEntries(headers.map((key, index) => [key, values[index] ?? ''])));
}
const readCsv = async (name) =>
  parseCsv(
    await readFile(path.join(sourceRoot, `04_联调数据/synthetic/nodes/${name}_v1.csv`), 'utf8'),
  );
const numeric = (value) => (value === '' ? null : Number(value));
const multiple = (value) => (value ? value.split(';').filter(Boolean) : []);
const boolean = (value) => value === 'true';

// 演示状态是独立覆盖层，保留原始 CSV。告警与运行状态分别记录。
const stationStatus = { 'ND-0007': 'FAULT', 'ND-0015': 'OFFLINE' };
const deviceStatus = { 'DV-0067': 'FAULT', 'DV-0103': 'OFFLINE' };
const alertStations = new Set(['ND-0004', 'ND-0007', 'ND-0015']);
const alertDevices = new Set(['DV-0037', 'DV-0067', 'DV-0103']);
const [nodes, devices, models, antennas] = await Promise.all(
  ['nodes', 'devices', 'device_models', 'antenna_models'].map(readCsv),
);
const resources = {
  version: 'preview-v0.1',
  source:
    '甲方 synthetic CSV 格式转换；3 个节点和设备附加独立演示告警/状态，见 ATTRIBUTION 与实施方案。',
  stations: nodes.map((r) => ({
    id: r.node_id,
    name: r.node_name,
    echelon: r.echelon,
    parentIds: multiple(r.parent_node_id),
    coordinate: [Number(r.lon), Number(r.lat)],
    elevationM: numeric(r.elevation_m),
    region: r.region,
    classes: multiple(r.device_class),
    status: stationStatus[r.node_id] ?? r.status,
    alert: alertStations.has(r.node_id),
    relayCapable: boolean(r.relay_capable),
    key: boolean(r.is_key),
    mobility: r.mobility,
  })),
  devices: devices.map((r) => ({
    id: r.device_id,
    stationId: r.node_id,
    modelId: r.model_id,
    antennaId: r.antenna_id,
    status: deviceStatus[r.device_id] ?? r.status,
    alert: alertDevices.has(r.device_id),
    antennaHeightM: numeric(r.antenna_height_m),
    txPowerDbm: numeric(r.tx_power_dbm),
    workFreqKhz: numeric(r.work_freq_khz),
    installedAt: r.install_time,
  })),
  models: models.map((r) => ({
    id: r.model_id,
    name: r.model_name,
    manufacturer: r.manufacturer,
    deviceClass: r.device_class,
    freqMinKhz: Number(r.freq_min_khz),
    freqMaxKhz: Number(r.freq_max_khz),
    txPowerMaxDbm: Number(r.tx_power_max_dbm),
    modulation: multiple(r.modulation),
    workMode: multiple(r.work_mode),
  })),
  antennas: antennas.map((r) => ({ id: r.antenna_id, name: r.antenna_name })),
};
const roads = JSON.parse(
  gunzipSync(
    await readFile(path.join(sourceRoot, '05_地理与原始数据/raw/roads/roads_taihang.geojson.gz')),
  ).toString('utf8'),
);
const classes = new Set([
  'motorway',
  'motorway_link',
  'trunk',
  'trunk_link',
  'primary',
  'primary_link',
  'secondary',
  'tertiary',
]);
const features = roads.features
  .filter((feature) => classes.has(feature.properties.fclass))
  .map((feature) => ({
    type: 'Feature',
    properties: { fclass: feature.properties.fclass, name: feature.properties.name ?? '' },
    geometry: feature.geometry,
  }));
await mkdir(path.join(root, 'src/mocks'), { recursive: true });
await mkdir(path.join(root, 'public/maps'), { recursive: true });
// 这两个 JSON 是可再生成的数据产物，不修改任何来源文件。
await writeFile(
  path.join(root, 'src/mocks/resources.json'),
  `${JSON.stringify(resources, null, 2)}\n`,
  'utf8',
);
await writeFile(
  path.join(root, 'public/maps/demo-roads.geojson'),
  `${JSON.stringify({ type: 'FeatureCollection', features })}\n`,
  'utf8',
);
console.log(
  `已生成 ${resources.stations.length} 个节点、${resources.devices.length} 台设备、${features.length} 条道路；未执行业务计算。`,
);

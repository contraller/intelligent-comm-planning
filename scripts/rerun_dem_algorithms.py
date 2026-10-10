"""Checkpoint a complete native-DEM run for the static demo exporter."""
import json
import hashlib
from pathlib import Path
import pickle
import sys

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent
sys.path[:0] = [str(HERE), str(HERE / 'planning')]
import plan_pipeline
import sr4_flow
from terrain import DEM_HEADER
from datapaths import PATHS, path as dpath


def input_manifest():
    return {name: hashlib.sha256(Path(dpath(name)).read_bytes()).hexdigest() for name in PATHS}


def main():
    target = ROOT / 'data/results/current_dem'
    target.mkdir(parents=True, exist_ok=True)
    meta = json.loads(Path(DEM_HEADER).read_text(encoding='utf-8'))
    meta['input_sha256'] = input_manifest()
    print('W2/W3 native DEM run', flush=True)
    w3 = plan_pipeline.run(verbose=True)
    with (target / 'w3_checkpoint.pkl').open('wb') as f:
        pickle.dump((meta['source_sha256'], w3), f)
    clean = {k: w3[k] for k in ('routes', 'frequency', 'params', 'presets', 'check',
                               'steps', 'links', 'nodes', 'devices', 'demands')}
    (target / 'w3.json').write_text(json.dumps(clean, ensure_ascii=False, indent=2), encoding='utf-8')
    print('W4 complete closed-loop native DEM run', flush=True)
    w4 = sr4_flow.run(verbose=True)
    (target / 'w4.json').write_text(json.dumps(w4, ensure_ascii=False, indent=2), encoding='utf-8')
    (target / 'source.json').write_text(json.dumps(meta, indent=2), encoding='utf-8')


if __name__ == '__main__':
    main()

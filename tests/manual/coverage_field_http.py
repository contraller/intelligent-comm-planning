"""V5真实HTTP专项；显式计算一次，后续仅原作业回读，不修改父方案或带宽。

账户仅从本轮私有配置内存读取，证据不含口令、Cookie或会话令牌。
"""
import argparse
import hashlib
import json
from pathlib import Path
import uuid

import r4_internal_http as shared

ROOT=Path(__file__).resolve().parents[2]
RUNTIME=ROOT/'data/runtime/r2/r4-f79ea5c1b6c54e38ae495d840c142013'
shared.ORIGIN='http://127.0.0.24:5324'
PLAN='PLAN-5273d94aa08345e4b047d62b915e2928'
TASK='r4-network-89db2499fcf6'
SNAPSHOT='SNP-PL-0F4B502A'
PARAMETERS=dict(radius_m=60000,cell_m=5000,az_step_deg=10,hour=12,hf_max_km=900)


def digest(value):
    return hashlib.sha256(json.dumps(value,ensure_ascii=False,sort_keys=True,separators=(',',':')).encode()).hexdigest()


def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--compute',action='store_true')
    parser.add_argument('--evidence-dir',required=True)
    args=parser.parse_args()
    directory=Path(args.evidence_dir).resolve()
    if not directory.is_relative_to((ROOT/'data/runtime/r2').resolve()):raise ValueError('证据必须位于隔离目录')
    directory.mkdir(parents=True,exist_ok=True)
    private=json.loads((RUNTIME/'private.json').read_text(encoding='utf-8'))
    records=[]
    probe=shared.Probe(RUNTIME,private['accounts']['editor'],records)
    checkpoint=directory/'checkpoint.json'
    endpoint='/api/v1/planning-coverages/'+PLAN
    query=dict(task_id=TASK,snapshot_id=SNAPSHOT,context='planning')
    plan_path='/api/v1/plans/'+PLAN
    try:
        probe.login()
        options=probe.call('GET',endpoint+'/bandwidth-options',params=query)
        assert options['anchor']['engine_version']=='V01-5','API尚未加载V5'
        saved=options['current_selection']
        assert saved,'本方案没有已保存的显式选择，禁止代选'
        cache_query=dict(**query,parameters=json.dumps(PARAMETERS),bandwidth_selection_id=saved['selection_id'])
        if not checkpoint.exists():
            assert args.compute,'首次执行必须显式指定--compute'
            original=probe.call('GET',plan_path,params=dict(task_id=TASK,context='planning'))
            legacy=probe.call('GET',endpoint+'/cache',params=dict(**cache_query,engine_version='V01-4'))
            current=probe.call('GET',endpoint+'/cache',params=dict(**cache_query,engine_version='V01-5'))
            assert legacy['state']=='HIT','原V4基线未命中，停止写入'
            state=dict(plan_sha256=digest(original),legacy_sha256=digest(legacy),selection_id=saved['selection_id'],
                       selection_hash=saved['selection_hash'],parameters=PARAMETERS,
                       body=dict(task_id=TASK,snapshot_id=SNAPSHOT,request_id='FIELD-'+uuid.uuid4().hex,
                                 parameters=PARAMETERS,bandwidth_selection_id=saved['selection_id']))
            shared.write_new(checkpoint,state)
            if current['state']=='HIT':
                state['existing_cache']=True
            else:
                accepted=probe.call('POST',endpoint+'/compute',state['body'],expected=(200,202))
                state['job_id']=accepted['job_id']
            checkpoint.write_text(json.dumps(state,ensure_ascii=False,indent=2),encoding='utf-8')
        else:
            state=json.loads(checkpoint.read_text(encoding='utf-8'))
            assert not args.compute,'已有原请求，仅回读，不再次提交'
            assert saved['selection_id']==state['selection_id'] and saved['selection_hash']==state['selection_hash'],'选择已变化，停止'
        if not state.get('existing_cache'):
            assert state.get('job_id'),'原请求结果未核实，禁止自动换号'
            job=probe.call('GET','/api/v1/planning-coverages/jobs/'+state['job_id'],params=dict(**query,plan_id=PLAN))
            shared.write_new(directory/('poll-'+uuid.uuid4().hex[:8]+'.json'),job)
            if job['state'] in ('PENDING','RUNNING'):
                print(json.dumps(dict(state=job['state'],progress=job['progress'],job_id=job['job_id'],evidence=str(directory))))
                return
            assert job['state']=='SUCCESS',job.get('error')
        cached=probe.call('GET',endpoint+'/cache',params=dict(**cache_query,engine_version='V01-5'))
        assert cached['state']=='HIT'
        result=cached['result']
        assert result['provenance']['units']['field_strength']=='dBuV/m'
        original=probe.call('GET',plan_path,params=dict(task_id=TASK,context='planning'))
        legacy=probe.call('GET',endpoint+'/cache',params=dict(**cache_query,engine_version='V01-4'))
        assert digest(original)==state['plan_sha256'] and digest(legacy)==state['legacy_sha256'],'原方案或旧缓存发生变化'
        geometries={}
        for device in result['devices']:
            for part in device['computations']:
                for feature in part['geojson']['features']:
                    p=feature['properties']
                    assert p['field_strength_dbuvm']==p['field_strength_dbuvm']
                    if feature['geometry'] and p['is_coverage']:
                        assert feature['geometry']['type']=='Polygon'
                        key=device['band']+':'+p['strength_class']
                        geometries[key]=geometries.get(key,0)+1
        if (directory/'result.json').exists():
            previous=json.loads((directory/'result.json').read_text(encoding='utf-8'))
            assert previous['cache_key']==cached['cache_key'],'缓存键变化，停止'
        else:shared.write_new(directory/'result.json',cached)
        summary=dict(state='SUCCESS',cache_key=cached['cache_key'],summary=result['summary'],geometry_counts=geometries,
                     original_plan_unchanged=True,legacy_cache_unchanged=True,selection_unchanged=True,
                     method='REAL_HTTP_LOCAL_PASSWORD_REAL_DEM_MODEL_PREDICTION_NOT_MEASURED')
        if (directory/'summary.json').exists():
            assert json.loads((directory/'summary.json').read_text(encoding='utf-8'))==summary,'原验证摘要变化，停止'
        else:shared.write_new(directory/'summary.json',summary)
        print(json.dumps(dict(**summary,evidence=str(directory)),ensure_ascii=False))
    finally:
        probe.close()
        shared.write_new(directory/('requests-'+uuid.uuid4().hex[:8]+'.json'),records)


if __name__=='__main__':main()

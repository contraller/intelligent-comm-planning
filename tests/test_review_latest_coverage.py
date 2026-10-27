from test_frozen_coverage_service import context, BODY, ACTOR, terminal, QUERY
from test_frozen_coverage_engine import SMALL, scenario


def test_latest_coverage_is_readonly_and_restores_actual_parameters(context):
    service=context.make();service.start()
    assert service.latest_cache('P1','T1','SNP-PL-UNIT')['state']=='MISS'
    job,_=service.submit('P1',BODY,ACTOR)
    assert terminal(service,job['job_id'])['state']=='SUCCESS'
    latest=service.latest_cache('P1','T1','SNP-PL-UNIT')
    assert latest['state']=='HIT' and latest['parameters']['cell_m']==SMALL['cell_m']
    assert latest['anchor']['snapshot_id']=='SNP-PL-UNIT'
    before={p.name:p.stat().st_mtime_ns for p in service.root.iterdir()}
    assert service.latest_cache('P1','T1','SNP-PL-UNIT')==latest
    assert before=={p.name:p.stat().st_mtime_ns for p in service.root.iterdir()}


def test_latest_includes_new_successful_requests_that_hit_prior_cache(context):
    service=context.make();service.start()
    a,_=service.submit('P1',BODY,ACTOR)
    assert terminal(service,a['job_id'])['state']=='SUCCESS'
    options={**SMALL,'radius_m':500}
    b,_=service.submit('P1',{**BODY,'request_id':'R-B','parameters':options},ACTOR)
    assert terminal(service,b['job_id'])['state']=='SUCCESS'
    latest=service.latest_cache('P1','T1','SNP-PL-UNIT')
    assert latest['parameters']['radius_m']==500
    a2,_=service.submit('P1',{**BODY,'request_id':'R-A2'},ACTOR)
    assert a2['state']=='SUCCESS' and a2['from_cache']
    latest=service.latest_cache('P1','T1','SNP-PL-UNIT')
    assert latest['parameters']['radius_m']==SMALL['radius_m']

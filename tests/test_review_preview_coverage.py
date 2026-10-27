"""Candidate coverage reads actual successful jobs without persisting a plan."""
from copy import deepcopy
import pytest
from sqlalchemy import func, select
from test_interference_frontend_api import api
from app import frozen_coverage_service as coverage
from app import planning_w3, planning_adjustment_service
from app.planning_job_models import PlanningJob
from app.planning_plan_models import PlanningPlan


def test_preview_source_is_frozen_job_not_parent_plan(api, monkeypatch):
    _, factory, baseline, _, raw = api
    candidate=deepcopy(raw); candidate['solution_id']='PL-U'
    candidate['detail']['devices'][0]['planned_power_w']=12
    candidate['terrain_fingerprint']='a'*64
    with factory.begin() as session:
        baseline_job=session.get(PlanningJob,'JOB-P1')
        values={column.name:deepcopy(getattr(baseline_job,column.name)) for column in PlanningJob.__table__.columns}
        values.update(job_id='JOB-U',request_id='unsaved-request')
        session.add(PlanningJob(**values))
        before_count=session.scalar(select(func.count()).select_from(PlanningPlan))
    monkeypatch.setattr(planning_w3,'get_task_record',lambda job:{'result':{'solution_id':'PL-U'}})
    monkeypatch.setattr(planning_adjustment_service,'capture_raw_snapshot',lambda result:deepcopy(candidate))
    source=coverage._source_loader(factory,'PREVIEW-JOB-U','T1','SNP-PL-U')
    assert source['raw_snapshot']==candidate and source['resource_revision']==baseline['revision']
    source['raw_snapshot']['detail']['devices'][0]['planned_power_w']=99
    with factory() as session:
        assert session.get(PlanningPlan,'P1').raw_snapshot==raw
        assert session.scalar(select(func.count()).select_from(PlanningPlan))==before_count
    with pytest.raises(coverage.CoverageServiceError,match='快照'):
        coverage._source_loader(factory,'PREVIEW-JOB-U','T1','SNP-PL-OTHER')
    with pytest.raises(coverage.CoverageServiceError,match='归属'):
        coverage._source_loader(factory,'PREVIEW-JOB-U','T2','SNP-PL-U')
    with factory.begin() as session:
        session.get(PlanningJob,'JOB-U').status='RUNNING'
    with pytest.raises(coverage.CoverageServiceError,match='尚未完成'):
        coverage._source_loader(factory,'PREVIEW-JOB-U','T1','SNP-PL-U')


def test_adjusted_preview_keeps_baseline_terrain_and_owner_errors_typed(api, monkeypatch):
    from app.system_management_schemas import SystemManagementError
    _, factory, _, _, raw = api
    original = deepcopy(raw)
    original['terrain_fingerprint'] = 'a' * 64
    candidate = deepcopy(original)
    candidate['terrain_fingerprint'] = 'b' * 64
    with factory.begin() as session:
        session.get(PlanningPlan, 'P1').raw_snapshot = original
        session.get(PlanningPlan, 'P1').result_snapshot = {'snapshot_id':'SNP-PL-P1'}
        job = session.get(PlanningJob, 'JOB-P1')
        job.parent_plan_id = 'P1'
        job.adjustment = {'source_plan_id': 'P1'}
    monkeypatch.setattr(planning_w3, 'get_task_record', lambda job: {'result': {'solution_id': 'PL-P1'}})
    monkeypatch.setattr(planning_adjustment_service, 'capture_raw_snapshot', lambda result: deepcopy(candidate))
    source = coverage._source_loader(factory, 'PREVIEW-JOB-P1', 'T1', 'SNP-PL-P1')
    assert source['raw_snapshot']['terrain_fingerprint'] == 'a' * 64
    class Denied:
        _writing = True
        def require_owner(self, *args, **kwargs):
            raise SystemManagementError('different owner', 1104, 403)
    with factory.begin() as session:
        with pytest.raises(SystemManagementError) as error:
            coverage._preview_source(session, 'PREVIEW-JOB-P1', 'T1', 'SNP-PL-P1', Denied())
        assert error.value.status == 403


def test_saved_candidate_source_survives_missing_runtime_and_does_not_rebind(api, monkeypatch):
    _, factory, _, _, raw = api
    frozen = deepcopy(raw); frozen['terrain_fingerprint'] = 'c' * 64
    with factory.begin() as session:
        plan=session.get(PlanningPlan, 'P1')
        plan.raw_snapshot=frozen; plan.result_snapshot={'snapshot_id':'SNP-PL-P1'}
    monkeypatch.setattr(planning_w3, 'get_task_record', lambda _: pytest.fail('saved source must not read runtime'))
    monkeypatch.setattr(planning_adjustment_service, 'capture_raw_snapshot', lambda _: pytest.fail('saved source must not recapture'))
    source=coverage._source_loader(factory, 'PREVIEW-JOB-P1', 'T1', 'SNP-PL-P1')
    assert source['plan_id']=='PREVIEW-JOB-P1' and source['raw_snapshot']==frozen
    with pytest.raises(coverage.CoverageServiceError, match='不一致'):
        coverage._source_loader(factory, 'PREVIEW-JOB-P1', 'T1', 'SNP-PL-WRONG')

"""正式当前身份与历史署名分开，不向本地页面填充联调角色。"""
from copy import deepcopy
from pathlib import Path
import sys

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'algorithm-service'))
from app.kg_frontend_service import _actors


def identity(permissions):
    return {'account_id':'local-actor','display_name':'当前署名','role_id':'local-role',
            'role_name':'本地角色','permissions':permissions}


@pytest.mark.parametrize('permissions,role', [(['knowledge.view','knowledge.edit'],'EDITOR'),
    (['knowledge.view','knowledge.review'],'REVIEWER'),
    (['knowledge.edit','knowledge.review'],'EDITOR')])
def test_local_actor_comes_from_trusted_identity(permissions, role):
    assert _actors([], identity(permissions)) == [{'id':'local-actor','name':'当前署名','role':role}]


def test_historical_names_remain_immutable_and_current_display_wins_only_in_catalog():
    snapshots = [{'key':'change:1','id':'local-actor','name':'历史署名','role':'EDITOR'},
                 {'key':'audit:1','id':'old-reviewer','name':'历史审核者','role':'REVIEWER'}]
    before = deepcopy(snapshots)
    result = _actors(snapshots, identity(['knowledge.edit']))
    assert result == [{'id':'local-actor','name':'当前署名','role':'EDITOR'},
                      {'id':'old-reviewer','name':'历史审核者','role':'REVIEWER'}]
    assert snapshots == before


def test_local_viewer_is_not_labeled_reviewer_or_given_demo_actors():
    assert _actors([], identity(['knowledge.view'])) == []


def test_explicit_integration_catalog_is_compatible():
    assert _actors([], {**identity([]), 'integration_mode':True}) == _actors([])
    assert {row['role'] for row in _actors([])} == {'EDITOR','REVIEWER'}

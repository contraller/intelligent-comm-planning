"""设备受理身份桥只投影已安装真实本地认证，不读取客户端角色。"""
from copy import deepcopy
from pathlib import Path
from types import SimpleNamespace
import sys

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'algorithm-service'))
from app import main


def test_device_actor_preserves_verified_identity_and_adds_real_authentication_mode(monkeypatch):
    actor = {'account_id':'local-user','display_name':'本地用户','role_id':'local-role','identity_revision':'1'}
    before = deepcopy(actor)
    seen = []
    monkeypatch.setattr(main.integration_identity,'require',lambda request, permission, **kw: seen.append((permission,kw)) or actor)
    request = SimpleNamespace(app=SimpleNamespace(state=SimpleNamespace(
        local_identity_adapter=SimpleNamespace(auth_mode='LOCAL_PASSWORD'))))
    result = main._frontend_device_actor(request,'resources.device.edit',writing=True)
    assert result == {**actor,'authentication_mode':'LOCAL_PASSWORD'}
    assert actor == before and seen == [('resources.device.edit',{'writing':True})]
    assert 'integration_mode' not in result


@pytest.mark.parametrize('adapter',[None,SimpleNamespace(auth_mode='INTEGRATION')])
def test_missing_or_wrong_authentication_adapter_is_not_upgraded_to_local(monkeypatch,adapter):
    monkeypatch.setattr(main.integration_identity,'require',lambda *a,**kw: {'account_id':'not-local'})
    request = SimpleNamespace(app=SimpleNamespace(state=SimpleNamespace(local_identity_adapter=adapter)))
    with pytest.raises(main.integration_identity.IdentityError) as error:
        main._frontend_device_actor(request,'resources.view')
    assert (error.value.code,error.value.status) == (5001,503)

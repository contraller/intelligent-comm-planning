"""使用独立临时目录核验真实跨进程锁，不连接运行库或启动服务。"""
import os
from pathlib import Path
import subprocess
import sys

import pytest

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'algorithm-service'))
from app.runtime_ownership import exclusive_runtime_directory


def child(directory):
    code = """import sys
from app.runtime_ownership import exclusive_runtime_directory
try:
 with exclusive_runtime_directory(sys.argv[1]): pass
except RuntimeError:
 sys.exit(2)
"""
    return subprocess.run([sys.executable,'-B','-c',code,str(directory)],
        env={**os.environ,'PYTHONPATH':str(ROOT / 'algorithm-service')},
        capture_output=True,timeout=30)


def test_live_owner_excludes_another_process_and_release_preserves_file(tmp_path):
    directory = tmp_path / 'exclusive-runtime'
    with exclusive_runtime_directory(directory):
        assert child(directory).returncode == 2
        assert (directory / 'interference-worker.lock').is_file()
    assert child(directory).returncode == 0
    assert (directory / 'interference-worker.lock').read_bytes() == b'\x00'


def test_exception_releases_ownership_without_deleting_evidence(tmp_path):
    with pytest.raises(ValueError):
        with exclusive_runtime_directory(tmp_path):
            raise ValueError('test exception')
    assert child(tmp_path).returncode == 0
    assert (tmp_path / 'interference-worker.lock').is_file()

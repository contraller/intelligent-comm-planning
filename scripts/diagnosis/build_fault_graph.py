"""Regenerate the synthetic SR-5 fault graph from the checked-in case table."""
from pathlib import Path
import sys

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "scripts"))

from diagnosis.sr5 import FaultEngine  # noqa: E402


def main():
    target = ROOT / "data" / "fault" / "knowledge_graph" / "fault_triples_v1.csv"
    count = FaultEngine().write_graph_csv(target)
    print("%s: %d derived triples (CONSTRUCTED)" % (target, count))


if __name__ == "__main__":
    main()

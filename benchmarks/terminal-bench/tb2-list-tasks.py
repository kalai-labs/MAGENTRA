"""Print every task name in a Harbor dataset, one per line.

Used to regenerate `tb2-tasks.txt` (the 89-task Terminal-Bench 2.0 manifest the
runner shards across API keys). Must run under Harbor's own interpreter:

    & "$env:APPDATA\uv\tools\harbor\Scripts\python.exe" tb2-list-tasks.py > tb2-tasks.txt
"""

import asyncio
import sys

from harbor.models.job.config import DatasetConfig


async def main() -> int:
    dataset = sys.argv[1] if len(sys.argv) > 1 else "terminal-bench/terminal-bench-2"
    configs = await DatasetConfig(name=dataset).get_task_configs()
    for name in sorted(str(getattr(c, "name", c)) for c in configs):
        print(name)
    return 0


if __name__ == "__main__":
    raise SystemExit(asyncio.run(main()))

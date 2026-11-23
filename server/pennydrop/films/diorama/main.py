"""Entry for Blender: Blender -b --factory-startup --python-exit-code 1 -P main.py -- job.json"""

import sys
from pathlib import Path

PACKAGE = Path(__file__).resolve().parent
sys.path.insert(0, str(PACKAGE.parent))

job = __import__(PACKAGE.name + ".job", fromlist=["run"])
job.run(Path(sys.argv[sys.argv.index("--") + 1]))

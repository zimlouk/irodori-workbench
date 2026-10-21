"""Return only public dev-server ports to Vite; never serialize installation settings or keys."""
import json
from pathlib import Path
import sys

sys.path.insert(0, str(Path(__file__).resolve().parents[1]/'backend/src'))
from irodori_workbench.settings import load_settings

settings = load_settings()
print(json.dumps({'port': settings.port, 'dev_port': settings.dev_port}))

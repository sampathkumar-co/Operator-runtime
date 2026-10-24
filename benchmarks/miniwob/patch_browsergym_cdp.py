"""Apply reversible, explicit loopback CDP instrumentation to a disposable BrowserGym venv."""
from pathlib import Path
import hashlib
import browsergym.core.env
p=Path(browsergym.core.env.__file__).resolve()
if "site-packages" not in p.parts:raise RuntimeError("ONLY_INSTALLED_DISPOSABLE_VENV")
if "browsergym-venv" not in str(p).lower():raise RuntimeError("EXPECTED_DEDICATED_BENCHMARK_VENV")
source=p.read_text(encoding="utf8")
marker="if os.environ.get('MECORD_BENCH_CDP_PORT'):"
if marker in source:
 print("BROWSERGYM_CDP_PATCH=already_present")
else:
 anchor="args = [arg for arg in args if arg is not None]  # Remove None values"
 if source.count(anchor)!=1:raise RuntimeError("BROWSERGYM_PIN_VERSION_MISMATCH")
 backup=p.with_name(p.name+".mecord-prepatch")
 if backup.exists():raise RuntimeError("EXISTING_BACKUP_NO_AUTOMATIC_OVERWRITE")
 backup.write_text(source,encoding="utf8")
 replacement=anchor+"\n        # Synthetic benchmark only; loopback CDP for Mecord browser provider.\n        import os\n        "+marker+"\n            args.append('--remote-debugging-address=127.0.0.1')\n            args.append('--remote-debugging-port=' + os.environ['MECORD_BENCH_CDP_PORT'])"
 p.write_text(source.replace(anchor,replacement),encoding="utf8")
 print("BROWSERGYM_CDP_PATCH=applied")
print("BROWSERGYM_ENV_SHA256="+hashlib.sha256(p.read_bytes()).hexdigest())

import argparse
import os
from pathlib import Path
import re
import secrets
import stat
import tempfile
import uuid


def main():
    parser = argparse.ArgumentParser(description="Set the E1 UAT gateway secret only, without enabling outbound calls")
    mode = parser.add_mutually_exclusive_group(required=True)
    mode.add_argument("--check", action="store_true")
    mode.add_argument("--apply", action="store_true")
    parser.add_argument("--env-file", default="/opt/dcontact-uat/uat.env")
    args = parser.parse_args()
    path = Path(args.env_file)
    metadata = path.lstat()
    if not stat.S_ISREG(metadata.st_mode) or stat.S_IMODE(metadata.st_mode) != 0o600:
        raise SystemExit("UAT_ENV must be a regular file with permission 600")
    if metadata.st_uid != os.geteuid():
        raise SystemExit("run as the owner of UAT_ENV only")
    text = path.read_text()
    values = {}
    for line in text.splitlines():
        match = re.fullmatch(r"([A-Z0-9_]+)=(.*)", line)
        if match:
            if match[1] in values:
                raise SystemExit("found a duplicate key in UAT_ENV; stopping to check by hand")
            values[match[1]] = match[2]
    tenant_id = values.get("UAT_TENANT_ID", "")
    if not re.fullmatch(r"[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}", tenant_id):
        raise SystemExit("UAT_TENANT_ID is not the designated UUID")
    key = "UAT_E1_VOICE_COMMAND_SECRET"
    existing = values.get(key)
    if existing is not None:
        if not re.fullmatch(r"[a-f0-9]{64}", existing):
            raise SystemExit("the existing secret is invalid; not overwriting automatically")
        print("CHECK passed: the gateway secret is ready; the Voice rollout is not enabled or changed")
        return
    if args.check:
        raise SystemExit("the gateway secret does not exist yet; use --apply to create it without enabling outbound calls")
    suffix = uuid.uuid4().hex
    backup = path.with_name(f"{path.name}.before-e1-voice-{suffix}")
    os.link(path, backup)
    descriptor, temporary = tempfile.mkstemp(prefix=".uat-e1-voice-", dir=path.parent)
    try:
        with os.fdopen(descriptor, "w") as stream:
            stream.write(text.rstrip("\n") + f"\n{key}={secrets.token_hex(32)}\n")
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temporary, path)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)
    print("APPLY passed: the gateway secret is ready; backup permission 600; the Voice rollout is unchanged")


if __name__ == "__main__":
    main()

"""Fixed isolated CLI; never search cwd or PYTHONPATH for the sibling implementation."""
import argparse
import importlib.util
import json
import os
from pathlib import Path
import sys
import threading


def arm_watchdog(seconds, result_path):
    """Hard stop armed before any runtime work, so no code path can outlive it.

    The in-runtime deadline can only fire between model calls and can block on the job
    lock; this timer publishes a coded timeout when it can and then exits regardless.
    """
    if seconds is None or seconds <= 0:
        return None

    def expire():
        try:
            if result_path and not os.path.exists(result_path):
                payload = json.dumps(
                    {"schema_version": 1, "status": "failed",
                     "error": {"code": "watchdog_expired", "message": "Analysis watchdog expired."}},
                    ensure_ascii=False, allow_nan=False, separators=(",", ":"))
                temporary = f"{result_path}.watchdog"
                with open(temporary, "w", encoding="utf-8") as stream:
                    stream.write(payload)
                    stream.flush()
                    os.fsync(stream.fileno())
                os.replace(temporary, result_path)
        except Exception:
            pass
        finally:
            os._exit(3)

    timer = threading.Timer(float(seconds), expire)
    timer.daemon = True
    timer.start()
    return timer


def load_runtime():
    path = Path(__file__).resolve().with_name("runtime.py")
    spec = importlib.util.spec_from_file_location("_moss_gbc_runtime", path)
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


def main(argv=None):
    try:
        runtime = load_runtime()

        class Parser(argparse.ArgumentParser):
            def error(self, message):
                raise runtime.BridgeError("invalid_arguments", "Invalid bridge command arguments.")

        parser = Parser(description="MOSS isolated GBC runner (no automatic model downloads)")
        parser.add_argument("--doctor", action="store_true")
        parser.add_argument("--config", required=True)
        parser.add_argument("--request")
        parser.add_argument("--result")
        parser.add_argument("--watchdog-seconds", type=float)
        args = parser.parse_args(argv)
        if args.doctor:
            if args.request or args.result:
                parser.error("doctor cannot execute a request")
            result, code = runtime.doctor(args.config), 0
        else:
            if not args.request or not args.result:
                parser.error("request and result are required")
            arm_watchdog(args.watchdog_seconds, args.result)
            result, code = runtime.run_request(args.request, args.result, args.config)
        print(runtime.json_bytes(result).decode("utf-8"), flush=True)
        return code
    except Exception as exc:
        if "runtime" in locals() and isinstance(exc, runtime.BridgeError):
            result = runtime.error_result(exc)
        else:
            result = {"schema_version": 1, "status": "failed",
                      "error": {"code": "bridge_error", "message": "Bridge could not start safely."}}
        print(json.dumps(result, ensure_ascii=False, allow_nan=False, separators=(",", ":")), flush=True)
        return 2


if __name__ == "__main__":
    sys.exit(main())

"""Isolated GBC v1 boundary. Importing this module never imports a model runtime."""
from contextlib import ExitStack, contextmanager
import hashlib
from importlib import metadata
import io
import json
import math
import os
from pathlib import Path
import re
import stat
import sys
import threading
import time
from urllib.parse import urlsplit
import uuid

CORE = ("kohakugbc", "togeari", "kohakugbc-data", "kohakunode", "kohakuvault")
VISION = ("torch", "torchvision", "transformers", "sentence-transformers", "inflect")
REQUEST_MAX = 32 * 1024
CONFIG_MAX = 64 * 1024
GRAPH_MAX = 1024 * 1024
RESULT_MAX = 2 * 1024 * 1024
IMAGE_MAX = 32 * 1024 * 1024
HEX = re.compile(r"[0-9a-f]{64}\Z")
FORMATS = {"image/png": ("input.png", "PNG"), "image/jpeg": ("input.jpg", "JPEG"),
           "image/webp": ("input.webp", "WEBP")}


class BridgeError(Exception):
    def __init__(self, code, message, status="failed"):
        super().__init__(message)
        self.code, self.message, self.status = code, message, status


def fail(code, message, status="failed"):
    raise BridgeError(code, message, status)


def json_bytes(value, maximum=RESULT_MAX):
    try:
        data = json.dumps(value, ensure_ascii=False, allow_nan=False,
                          separators=(",", ":")).encode("utf-8")
    except (ValueError, TypeError, RecursionError, UnicodeError):
        fail("invalid_json", "Data is not finite UTF-8 JSON.")
    if len(data) > maximum:
        fail("output_too_large", "Result exceeds the allowed size.")
    return data


def parse_json(data):
    def pairs(items):
        result = {}
        for key, value in items:
            if key in result:
                raise ValueError("duplicate key")
            result[key] = value
        return result

    def invalid(_):
        raise ValueError("non-finite number")

    def finite_float(value):
        number = float(value)
        if not math.isfinite(number):
            raise ValueError("non-finite number")
        return number

    try:
        if isinstance(data, bytes):
            data = data.decode("utf-8")
        return json.loads(data, object_pairs_hook=pairs, parse_constant=invalid, parse_float=finite_float)
    except (ValueError, TypeError, RecursionError, UnicodeError):
        fail("invalid_json", "Invalid JSON encoding, duplicate key, or non-finite number.")


def canonical_path(value, *, exists=True, directory=False, _checked=None):
    if not isinstance(value, str) or not value or "\x00" in value:
        fail("unsafe_path", "An absolute canonical local path is required.")
    p = Path(value)
    if (not p.is_absolute() or value.startswith(("\\\\", "//"))
            or any(x in (".", "..") for x in re.split(r"[\\/]", value))
            or (os.name == "nt" and ":" in value[2:])):
        fail("unsafe_path", "An absolute canonical local path is required.")
    try:
        resolved = p.resolve(strict=exists)
        if os.path.normcase(str(p)) != os.path.normcase(str(resolved)):
            fail("unsafe_path", "Non-canonical paths are not accepted.")
        for node in reversed((p, *p.parents)):
            try:
                st = node.lstat()
            except FileNotFoundError:
                if node == p and not exists:
                    continue
                raise
            if stat.S_ISLNK(st.st_mode) or getattr(st, "st_file_attributes", 0) & 0x400:
                fail("unsafe_path", "Links and reparse points are not accepted.")
        if exists:
            st = p.stat()
            if directory:
                if not stat.S_ISDIR(st.st_mode):
                    fail("unsafe_path", "Expected an existing directory.")
            elif not stat.S_ISREG(st.st_mode) or st.st_nlink != 1:
                fail("unsafe_path", "Expected an unaliased regular file.")
            if _checked is not None:
                _checked.append(st)  # Capture the object validated here, before opening can race.
    except OSError:
        fail("unsafe_path", "Path is unavailable or unsafe.")
    return p


def _windows_locked_fd(path, directory):
    import ctypes
    from ctypes import wintypes
    import msvcrt

    class FileInformation(ctypes.Structure):
        _fields_ = [("attributes", wintypes.DWORD), ("creation", wintypes.FILETIME),
                    ("access", wintypes.FILETIME), ("write", wintypes.FILETIME),
                    ("volume", wintypes.DWORD), ("size_high", wintypes.DWORD),
                    ("size_low", wintypes.DWORD), ("links", wintypes.DWORD),
                    ("id_high", wintypes.DWORD), ("id_low", wintypes.DWORD)]

    kernel = ctypes.WinDLL("kernel32", use_last_error=True)
    kernel.CreateFileW.argtypes = [wintypes.LPCWSTR, wintypes.DWORD, wintypes.DWORD,
                                  wintypes.LPVOID, wintypes.DWORD, wintypes.DWORD, wintypes.HANDLE]
    kernel.CreateFileW.restype = wintypes.HANDLE
    kernel.CloseHandle.argtypes = [wintypes.HANDLE]
    kernel.GetFileType.argtypes = [wintypes.HANDLE]
    kernel.GetFileType.restype = wintypes.DWORD
    kernel.GetFileInformationByHandle.argtypes = [wintypes.HANDLE, ctypes.POINTER(FileInformation)]
    kernel.GetFileInformationByHandle.restype = wintypes.BOOL
    flags = 0x00200000 | (0x02000000 if directory else 0)  # OPEN_REPARSE_POINT / BACKUP_SEMANTICS
    handle = kernel.CreateFileW(str(path), 0x80000000, 3 if directory else 1, None, 3, flags, None)
    if handle == wintypes.HANDLE(-1).value:
        fail("unsafe_path", "Could not lock the authorized path.")
    try:
        info = FileInformation()
        if kernel.GetFileType(handle) != 1 or not kernel.GetFileInformationByHandle(handle, ctypes.byref(info)):
            fail("unsafe_path", "Opened object is not a verifiable disk file or directory.")
        if (info.attributes & 0x400 or bool(info.attributes & 0x10) != directory or info.links != 1):
            fail("unsafe_path", "Opened object has unsafe type, reparse attributes, or aliases.")
        fd = msvcrt.open_osfhandle(handle, os.O_RDONLY | os.O_BINARY)
        handle = None  # The descriptor now owns the HANDLE.
        return fd
    finally:
        if handle is not None:
            kernel.CloseHandle(handle)


@contextmanager
def locked_file(path, *, directory=False):
    """Bind the opened HANDLE to the checked object; keep sharing locks until consumption ends."""
    checked = []
    p = canonical_path(str(path), directory=directory, _checked=checked)
    fd = None
    try:
        fd = (_windows_locked_fd(p, directory) if os.name == "nt" else
              os.open(p, os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0)))
        opened = os.fstat(fd)  # Same HANDLE identity representation as Python's checked stat.
        expected = checked[0]
        correct_type = stat.S_ISDIR(opened.st_mode) if directory else stat.S_ISREG(opened.st_mode)
        if (not correct_type or getattr(opened, "st_file_attributes", 0) & 0x400
                or (not directory and opened.st_nlink != 1)
                or (opened.st_dev, opened.st_ino) != (expected.st_dev, expected.st_ino)):
            fail("unsafe_path", "Opened object changed since validation or has unsafe attributes.")
        if directory:
            yield None
        else:
            stream = os.fdopen(fd, "rb")
            fd = None
            with stream:
                yield stream
    except OSError:
        fail("unsafe_path", "Could not verify or consume the authorized object.")
    finally:
        if fd is not None:
            os.close(fd)


def read_json(path, maximum):
    with locked_file(path) as stream:
        data = stream.read(maximum + 1)
    if len(data) > maximum:
        fail("input_too_large", "JSON exceeds the allowed size.")
    return parse_json(data)


def shape(obj, required, optional=(), code="invalid_request"):
    if not isinstance(obj, dict) or not set(required) <= set(obj) or set(obj) - set(required) - set(optional):
        fail(code, "Unexpected or missing fields.")


def integer(value, low, high, code):
    if type(value) is not int or not low <= value <= high:
        fail(code, "Integer outside the allowed range.")
    return value


def text(value, maximum, code):
    if not isinstance(value, str) or not value.strip() or len(value) > maximum or any(ord(c) < 32 for c in value):
        fail(code, "Invalid text field.")
    return value


def identity(request):
    try:
        key = request["analysis_id"]
        parsed = uuid.UUID(key)
        inp = request["input"]
        valid = (str(parsed) == key and parsed.version == 4 and isinstance(inp, dict)
                 and isinstance(inp.get("sha256"), str) and HEX.fullmatch(inp["sha256"])
                 and type(inp.get("width")) is int and 1 <= inp["width"] <= 4096
                 and type(inp.get("height")) is int and 1 <= inp["height"] <= 4096)
        if valid:
            return {"schema_version": 1, "analysis_id": key, "source_sha256": inp["sha256"],
                    "width": inp["width"], "height": inp["height"]}
    except (KeyError, TypeError, ValueError, AttributeError):
        pass
    return None


def validate_request(request, job):
    shape(request, ("schema_version", "analysis_id", "input", "profile"))
    if type(request["schema_version"]) is not int or request["schema_version"] != 1 or identity(request) is None:
        fail("invalid_request", "Invalid schema version or request identity.")
    text(request["profile"], 32, "invalid_request")
    if request["profile"] not in ("quick", "balanced", "detailed"):
        fail("invalid_request", "Unknown analysis profile.")
    inp = request["input"]
    shape(inp, ("path", "sha256", "width", "height", "media_type"))
    text(inp["media_type"], 32, "invalid_request")
    if inp["width"] * inp["height"] > 16_000_000 or inp["media_type"] not in FORMATS:
        fail("invalid_request", "Unsupported image dimensions or media type.")
    image = canonical_path(inp["path"])
    if image.parent != job or image.name != FORMATS[inp["media_type"]][0]:
        fail("unsafe_path", "Input must be the frozen image in this job directory.")
    return image


def validate_image(request, stream):
    from PIL import Image
    inp = request["input"]
    data = stream.read(IMAGE_MAX + 1)
    if len(data) > IMAGE_MAX:
        fail("input_too_large", "Image exceeds the allowed size.")
    if hashlib.sha256(data).hexdigest() != inp["sha256"]:
        fail("image_hash_mismatch", "Frozen image digest does not match.")
    try:
        with Image.open(io.BytesIO(data)) as image:
            if image.format != FORMATS[inp["media_type"]][1]:
                fail("image_format_mismatch", "Image encoding does not match its declared type.")
            if image.size != (inp["width"], inp["height"]):
                fail("image_dimensions_mismatch", "Image dimensions do not match.")
            if image.getexif().get(274, 1) != 1:
                fail("image_orientation", "Host must normalize EXIF orientation first.")
            if getattr(image, "n_frames", 1) != 1:
                fail("invalid_image", "Animated images are not accepted.")
        with Image.open(io.BytesIO(data)) as image:
            image.verify()
        with Image.open(io.BytesIO(data)) as image:
            image.load()
    except BridgeError:
        raise
    except Exception:
        fail("invalid_image", "Image cannot be safely decoded.")


def validate_config(config):
    code = "invalid_config"
    shape(config, ("schema_version",), ("enabled", "vlm", "detector", "embedder", "limits", "remote"), code)
    if type(config["schema_version"]) is not int or config["schema_version"] != 1:
        fail(code, "Unsupported runtime configuration version.")
    if "enabled" in config and type(config["enabled"]) is not bool:
        fail(code, "enabled must be a boolean.")
    if config.get("enabled") is False:
        # Even disabled configurations must not hide unvalidated executable settings.
        if set(config) != {"schema_version", "enabled"}:
            copy = dict(config)
            copy["enabled"] = True
            validate_config(copy)
        return config
    shape(config, ("schema_version", "vlm", "detector", "embedder", "limits"), ("enabled", "remote"), code)
    vlm = config["vlm"]
    shape(vlm, ("protocol", "flavour", "model", "base_url", "api_key_env", "max_inflight", "timeout_seconds"),
          ("structured", "system_prefix", "sampling", "mode", "fallback"), code=code)
    text(vlm["protocol"], 32, code)
    text(vlm["flavour"], 32, code)
    if vlm["protocol"] not in ("openai", "anthropic") or vlm["flavour"] not in ("openai", "openrouter", "vllm", "sglang", "llama.cpp"):
        fail(code, "Unsupported VLM protocol or flavour.")
    text(vlm["model"], 256, code)
    text(vlm["base_url"], 2048, code)
    try:
        url = urlsplit(vlm["base_url"])
        valid = (url.hostname and not url.username and not url.password and not url.query and not url.fragment
                 and (url.scheme == "https" or (url.scheme == "http" and url.hostname in ("localhost", "127.0.0.1", "::1"))))
        if not valid or "\\" in vlm["base_url"] or (url.port is not None and not 1 <= url.port <= 65535):
            fail(code, "Endpoint must be HTTPS or exact loopback HTTP without credentials.")
    except ValueError:
        fail(code, "Invalid endpoint URL.")
    if not isinstance(vlm["api_key_env"], str) or not re.fullmatch(r"[A-Za-z_][A-Za-z0-9_]{0,127}", vlm["api_key_env"]):
        fail(code, "Invalid credential environment variable name.")
    integer(vlm["max_inflight"], 1, 4, code)
    integer(vlm["timeout_seconds"], 1, 600, code)
    # Optional Host-side switch: the Host may route GBC's reference-image questions through
    # its own LLM instead of the HTTP endpoint. The worker only tolerates the fields; host-agent
    # execution is decided and performed by the Host before this process starts.
    if "mode" in vlm and vlm["mode"] not in ("http", "host-agent"):
        fail("invalid_request", "Unsupported VLM mode.")
    if "fallback" in vlm and type(vlm["fallback"]) is not bool:
        fail("invalid_request", "VLM fallback must be a boolean.")
    # Optional: how the JSON schema travels ("grammar" to the server, "prompt" only in the
    # prompt), and an operator-supplied instruction prepended to every model's system prompt.
    if "structured" in vlm and vlm["structured"] not in ("grammar", "prompt"):
        fail(code, "Unsupported structured-output mode.")
    if "system_prefix" in vlm:
        text(vlm["system_prefix"], 4000, code)
    # Optional: extra chat-completion body fields for a vendor that needs them (for example a
    # reasoning model that otherwise spends the whole token budget before writing an answer).
    if "sampling" in vlm:
        sampling = vlm["sampling"]
        if not isinstance(sampling, dict) or not 0 < len(sampling) <= 16:
            fail(code, "Sampling must be a small non-empty object.")
        try:
            encoded = json.dumps(sampling, ensure_ascii=False, allow_nan=False).encode("utf-8")
        except (TypeError, ValueError):
            fail(code, "Sampling must be JSON data.")
        if len(encoded) > 2048:
            fail(code, "Sampling is too large.")
    for slot in ("detector", "embedder"):
        settings = config[slot]
        shape(settings, ("model_path", "device", "model_type") if slot == "detector" else ("model_path", "device"), code=code)
        text(settings["model_path"], 4096, code)
        text(settings["device"], 16, code)
        if not Path(settings["model_path"]).is_absolute() or settings["device"] not in ("cpu", "cuda:0"):
            fail(code, "Models require absolute local paths and supported devices.")
    text(config["detector"]["model_type"], 16, code)
    if config["detector"]["model_type"] not in ("owlv2", "sam3"):
        fail(code, "Unsupported detector type.")
    shape(config["limits"], ("max_model_calls", "deadline_seconds"), code=code)
    integer(config["limits"]["max_model_calls"], 1, 512, code)
    integer(config["limits"]["deadline_seconds"], 1, 1800, code)
    if "remote" in config:
        # The vision models may run on another machine's engine host; this process then only
        # orchestrates and calls the VLM. Every field names that host explicitly.
        remote = config["remote"]
        shape(remote, ("host", "port", "detect_unit", "embed_unit", "authkey_file"), code=code)
        text(remote["host"], 255, code)
        text(remote["detect_unit"], 200, code)
        text(remote["embed_unit"], 200, code)
        text(remote["authkey_file"], 4096, code)
        integer(remote["port"], 1, 65535, code)
        if not Path(remote["authkey_file"]).is_absolute():
            fail(code, "The engine host key requires an absolute local path.")
        for unit in (remote["detect_unit"], remote["embed_unit"]):
            if any(character in unit for character in "/\\ \t"):
                fail(code, "Engine host unit names cannot contain separators or spaces.")
        if remote["host"].startswith(("http://", "https://")) or ":" in remote["host"]:
            fail(code, "The engine host takes a bare host name or address.")
    return config


def versions():
    result = {"python": ".".join(map(str, sys.version_info[:3]))}
    for name in CORE:
        try:
            result[name] = metadata.version(name)
        except metadata.PackageNotFoundError:
            result[name] = None
    try:
        dist = metadata.distribution("kohakugbc")
        direct = parse_json(dist.read_text("direct_url.json") or "{}")
        vcs = direct.get("vcs_info", {})
        commit = vcs.get("commit_id")
        if (vcs.get("vcs") == "git" and isinstance(commit, str)
                and re.fullmatch(r"[0-9a-f]{40}", commit)
                and direct.get("url") == "https://github.com/KohakuBlueleaf/KohakuGBC"):
            result["kohakugbc_source_commit"] = commit
        receipt_path = Path(sys.prefix) / "gbc-install-receipt.json"
        if receipt_path.is_file():
            receipt = read_json(str(receipt_path), CONFIG_MAX)
            record = (dist.read_text("RECORD") or "").encode("utf-8")
            if (receipt.get("schema_version") == 1 and receipt.get("installed_record_sha256") == hashlib.sha256(record).hexdigest()
                    and re.fullmatch(r"[0-9a-f]{40}", receipt.get("source_commit", ""))
                    and HEX.fullmatch(receipt.get("source_archive_sha256", ""))):
                result["kohakugbc_source_commit"] = receipt["source_commit"]
                result["kohakugbc_archive_sha256"] = receipt["source_archive_sha256"]
    except (metadata.PackageNotFoundError, BridgeError, OSError, TypeError, AttributeError):
        pass
    return result


def readiness(config):
    if config.get("enabled") is False:
        return {"readiness": "disabled", "checks": {"enabled": False}}
    checks = {}
    remote = config.get("remote")
    # With a remote engine host the vision stack runs there; this process never imports it.
    for name in (*CORE, *(VISION if remote is None else ())):
        try:
            metadata.version(name)
            checks[name] = True
        except metadata.PackageNotFoundError:
            checks[name] = False
    for slot in ("detector", "embedder"):
        if remote is not None:
            key = f"{slot}_remote"
            try:
                checks[key] = canonical_path(remote["authkey_file"]).is_file()
            except BridgeError:
                checks[key] = False
            continue
        try:
            p = canonical_path(config[slot]["model_path"], directory=True)
            checks[slot + "_local"] = (p / "config.json").is_file() and (
                any(p.glob("*.safetensors")) or any(p.glob("pytorch_model*.bin")))
        except BridgeError:
            checks[slot + "_local"] = False
    detector = config["detector"]
    if remote is not None:
        checks["detector_compatible"] = detector["model_type"] == "owlv2"
    else:
        try:
            model_meta = read_json(str(Path(detector["model_path"]) / "config.json"), CONFIG_MAX)
            sam_path = "sam3" in detector["model_path"].lower()
            expected_sam = detector["model_type"] == "sam3"
            checks["detector_compatible"] = (sam_path == expected_sam and isinstance(model_meta, dict)
                and model_meta.get("model_type") in (("sam3", "sam3_video") if expected_sam else ("owlv2",)))
        except BridgeError:
            checks["detector_compatible"] = False
    checks["credential_available"] = config["vlm"]["api_key_env"] in os.environ
    # Ready means local prerequisites only, never a successful device/model/network probe.
    return {"readiness": "ready" if all(checks.values()) else "not_ready", "checks": checks,
            "device_probe": "deferred_to_execution"}


def doctor(config_path):
    config = validate_config(read_json(str(canonical_path(config_path)), CONFIG_MAX))
    return {"schema_version": 1, **readiness(config), "versions": versions()}


def error_result(error, request_identity=None):
    return {**(request_identity or {"schema_version": 1}), "status": error.status,
            "error": {"code": error.code, "message": error.message}, "warnings": [],
            "stats": {}, "versions": versions()}


def failure_detail(exc):
    """Only fixed categories cross the wire; upstream text/class names may contain secrets."""
    if isinstance(exc, TimeoutError):
        return "Analysis execution timed out."
    if isinstance(exc, ConnectionError):
        return "Analysis connection failed."
    return "Analysis execution failed."


def publish(path, result):
    """Atomic completed file publication with hard-link CREATE_NEW semantics, never replace."""
    data = json_bytes(result)
    canonical_path(str(path.parent), directory=True)
    temporary = path.parent / (".result-" + uuid.uuid4().hex + ".tmp")
    try:
        with open(temporary, "xb") as stream:
            stream.write(data)
            stream.flush()
            os.fsync(stream.fileno())
        os.link(temporary, path)  # Fails if any destination already exists, including a symlink.
    except FileExistsError:
        fail("result_exists", "A result already exists; this invocation will not replay.")
    except OSError:
        fail("result_write_failed", "Could not publish an atomic result.")
    finally:
        if temporary.parent == path.parent and temporary.exists():
            temporary.unlink()


def profile_controls(profile):
    rows = {"quick": (2, 6, 2, 1, 4, 2, 3, 0),
            "balanced": (4, 12, 3, 2, 6, 3, 4, 0),
            "detailed": (6, 20, 4, 3, 6, 4, 4, 1)}
    keys = ("min_nodes", "max_nodes", "max_rounds", "max_depth", "max_top_level",
            "max_features_per_entity", "max_instances_per_text", "max_breadth_rounds")
    return {**dict(zip(keys, rows[profile])), "relational": "both", "relate": "end"}


class _PrefixAdapter:
    """The VLM's adapter with an operator instruction in front of every system prompt.

    Only the system text changes: the request's schema, images and query reach the engine
    untouched, so the JSON contract and the trace keys stay identical.
    """

    light = True

    def __init__(self, inner, prefix):
        self.inner, self.prefix = inner, prefix
        self.protocols = inner.protocols

    def check(self, signature):
        return self.inner.check(signature)

    def prepare(self, inputs, protocol):
        request = dict(inputs["request"])
        system = request.get("system")
        request["system"] = self.prefix if system is None else f"{self.prefix}\n\n{system}"
        return self.inner.prepare({**inputs, "request": request}, protocol)

    def decode(self, raw, protocol):
        return self.inner.decode(raw, protocol)


def _register_vlm_entry():
    """Register ``moss_api`` once: the built-in ``api`` entry, optionally prefixing prompts."""
    from kohakugbc.engines import registry
    from kohakugbc.engines.vlm import api as vlm_api

    if ("vlm", "moss_api") in registry.ENTRIES:
        return

    @registry.entry("vlm", "moss_api")
    def moss_api(settings, shared):
        prefix = settings.pop("system_prefix", None)
        slot = vlm_api.api(settings, shared)
        if prefix is not None:
            slot.adapter = _PrefixAdapter(slot.adapter, prefix)
        return slot


def engine_config(config):
    from togeari import Retry
    _register_vlm_entry()
    vlm = config["vlm"]
    timeout = min(vlm["timeout_seconds"], config["limits"]["deadline_seconds"])

    def lane():
        return {"retry": Retry(max=0), "timeout_s": timeout, "lane_dead_s": timeout}

    settings = {"entry": "moss_api", "protocol": vlm["protocol"], "flavour": vlm["flavour"],
                "model": vlm["model"], "structured": vlm.get("structured", "grammar"),
                "timeout_s": timeout, "connect_timeout_s": min(timeout, 10), "lane": lane(),
                "endpoints": [{"base_url": vlm["base_url"], "api_key_env": vlm["api_key_env"],
                               "max_inflight": vlm["max_inflight"]}]}
    if "system_prefix" in vlm:
        settings["system_prefix"] = vlm["system_prefix"]
    if "sampling" in vlm:
        settings["sampling"] = dict(vlm["sampling"])
    engines = {
        "vlm": settings,
        "cpu": {"entry": "python", "workers": 2, "mode": "thread"},
    }
    remote = config.get("remote")
    if remote is None:
        engines["detect"] = {"entry": "torch", "model": config["detector"]["model_path"],
                             "devices": [config["detector"]["device"]], "max_batch": 1, "lane": lane()}
        engines["embed"] = {"entry": "torch", "model": config["embedder"]["model_path"],
                            "devices": [config["embedder"]["device"]], "max_batch": 1, "lane": lane()}
        return engines
    # The vision units run in another machine's engine host; this process only names them.
    key = Path(_host_authkey_path(remote))
    os.environ["KOHAKUGBC_HOST_KEY"] = key.read_text(encoding="utf-8").strip()
    base = f"{remote['host']}:{int(remote['port'])}"

    def remote_slot(unit):
        return {"entry": "remote", "hosts": [f"{base}/{unit}"], "authkey_env": "KOHAKUGBC_HOST_KEY",
                "kind": "batch", "adapter": "torch", "protocol": "torch", "max_batch": 1,
                "transport": "inband", "lane": lane()}

    engines["detect"] = remote_slot(remote["detect_unit"])
    engines["embed"] = remote_slot(remote["embed_unit"])
    return engines


def _host_authkey_path(remote):
    return str(canonical_path(remote["authkey_file"]))


def create_guard(max_calls, deadline):
    from togeari import BasePlugin, PluginBlockError, Ok

    class ModelGuard(BasePlugin):
        name = "moss_gbc_budget"
        priority = 0

        def __init__(self):
            self.calls = self.errors = self.blocked = 0
            self.poisoned = False
            self.expired = False

        def pre_submit(self, item, unit, lane):
            try:
                if self.poisoned:
                    raise PluginBlockError("guard_unavailable")
                if time.monotonic() >= deadline:
                    self.expired = True
                    self.blocked += 1
                    raise PluginBlockError("deadline_exceeded")
                if lane not in ("vlm", "detect", "embed"):
                    return None
                if self.calls >= max_calls:
                    self.blocked += 1
                    raise PluginBlockError("model_call_limit")
                self.calls += 1
            except PluginBlockError:
                raise
            except Exception:
                self.poisoned = True
                raise PluginBlockError("guard_unavailable") from None
            return None

        def post_result(self, result, node, job):
            try:
                name = (node or "").rsplit(".", 1)[-1]
                if name in ("chat", "detector", "embedder"):
                    if not isinstance(result, Ok) or (name == "chat" and not result.value):
                        self.errors += 1
            except Exception:
                # Post hooks cannot throw generic errors: the upstream would ignore/disable them.
                self.poisoned = True
            return None

    return ModelGuard()


def _guard_healthy(machine, guard):
    states = machine.inspect("plugins").result(5)
    return (not guard.poisoned and any(p["name"] == guard.name and p["enabled"]
                                      and p["errors"] == 0 for p in states))


def offline_environment():
    os.environ.update(HF_HUB_OFFLINE="1", TRANSFORMERS_OFFLINE="1", HF_HUB_DISABLE_TELEMETRY="1")
    # The isolated worker must not inherit an undisclosed HTTP proxy/redirect mechanism.
    for name in list(os.environ):
        if name.lower() in ("http_proxy", "https_proxy", "all_proxy", "no_proxy"):
            os.environ.pop(name, None)


def run_machine(engines, source, controls, limits):
    """Internal Python seam: production supplies API/local engines; tests supply upstream replay."""
    offline_environment()
    from kohakugbc.machine import build
    from togeari import Retry
    deadline = time.monotonic() + limits["deadline_seconds"]
    safe_engines = {k: {**v, "lane": {**v.get("lane", {}), "retry": Retry(max=0)}}
                    for k, v in engines.items()}
    safe_engines["cpu"] = {"entry": "python", "workers": 2, "mode": "thread"}
    cfg = {"engines": safe_engines, "machine": {"max_jobs": 1, "vlm_waiting": 1,
           "report": None, "start_timeout_s": limits["deadline_seconds"]},
           "source": None, "sink": {"kind": "memory"}, "controls": controls}
    machine, _, sink = build(cfg)
    guard = create_guard(limits["max_model_calls"], deadline)
    try:
        machine.command("plugin_add", plugin=guard).result(5)
        if not _guard_healthy(machine, guard):
            fail("guard_unavailable", "Call-budget guard could not be enabled.")
        summary = machine.run(source, sink, limit=1)
        healthy = _guard_healthy(machine, guard)
        health = {"model_calls": guard.calls, "model_errors": guard.errors,
                  "blocked": guard.blocked, "guard_ok": healthy,
                  "deadline_exceeded": guard.expired or time.monotonic() >= deadline}
        if not healthy:
            fail("guard_unavailable", "Call-budget guard failed closed.")
        return sink.records, summary, health
    finally:
        machine.stop(drain=False, timeout=2)


def process_records(request, records, summary, health):
    if not health.get("guard_ok"):
        fail("guard_unavailable", "Call-budget guard was not healthy.")
    if health.get("deadline_exceeded") or summary.get("stopped"):
        fail("deadline_exceeded", "Analysis deadline was exceeded.")
    if len(records) != 1 or records[0].key != request["analysis_id"]:
        fail("result_identity_mismatch", "Upstream returned an unexpected job identity.")
    record = records[0]
    if not record.ok or summary.get("jobs_failed", 0) or summary.get("jobs_ok") != 1:
        fail("upstream_failed", "The upstream image job did not complete successfully.")
    raw = record.outputs.get("graph")
    if not isinstance(raw, str) or not raw:
        fail("empty_graph", "Upstream returned no described graph.")
    if len(raw.encode("utf-8")) > GRAPH_MAX:
        fail("output_too_large", "Graph exceeds the allowed size.")
    graph = parse_json(raw)
    if not isinstance(graph, dict) or not isinstance(graph.get("vertices"), list) or not 1 <= len(graph["vertices"]) <= 128:
        fail("invalid_graph", "Graph must contain 1 to 128 vertices.")
    vertices = graph["vertices"]
    ids, roots = set(), []
    for vertex in vertices:
        if not isinstance(vertex, dict) or not isinstance(vertex.get("vertex_id"), str):
            fail("invalid_graph", "Invalid vertex identity.")
        key = vertex["vertex_id"]
        if key in ids or len(key) > 1024 or vertex.get("label") not in ("image", "entity", "relation", "composition"):
            fail("invalid_graph", "Invalid or duplicate graph vertex.")
        ids.add(key)
        if vertex["label"] == "image":
            roots.append(vertex)
        box = vertex.get("bbox")
        if not isinstance(box, dict):
            fail("invalid_graph", "Vertex is missing its bounding box.")
        coords = [box.get(k) for k in ("left", "top", "right", "bottom")]
        if (any(type(x) not in (int, float) or not math.isfinite(x) or not 0 <= x <= 1 for x in coords)
                or coords[0] >= coords[2] or coords[1] >= coords[3]):
            fail("invalid_graph", "Invalid normalized bounding box.")
        confidence = box.get("confidence")
        if confidence is not None and (type(confidence) not in (int, float) or not math.isfinite(confidence) or not 0 <= confidence <= 1):
            fail("invalid_graph", "Invalid optional box confidence.")
        if not isinstance(vertex.get("descs"), list):
            fail("invalid_graph", "Invalid vertex descriptions.")
        for desc in vertex["descs"]:
            if not isinstance(desc, dict) or not isinstance(desc.get("text"), str) or len(desc["text"]) > 16384:
                fail("invalid_graph", "Invalid graph caption.")
    if len(roots) != 1:
        fail("invalid_graph", "Graph must contain exactly one image root.")
    if graph.get("img_size") not in (None, [request["input"]["width"], request["input"]["height"]]):
        fail("invalid_graph", "Graph image dimensions do not match the request.")
    for vertex in vertices:
        for field in ("in_edges", "out_edges"):
            edges = vertex.get(field, [])
            if not isinstance(edges, list) or len(edges) > 16384:
                fail("invalid_graph", "Invalid graph edges.")
            for edge in edges:
                if (not isinstance(edge, dict) or edge.get("source") not in ids or edge.get("target") not in ids
                        or not isinstance(edge.get("text"), str)):
                    fail("invalid_graph", "Graph edge references an absent vertex.")
    json_bytes(graph, GRAPH_MAX)
    warnings = []
    if health.get("model_errors", 0):
        warnings.append({"code": "model_error", "message": "Some model invocations failed; inspect this partial graph."})
    if health.get("blocked", 0):
        warnings.append({"code": "model_call_limit", "message": "The model-call budget blocked additional work."})
    if not any(d["text"].strip() for d in roots[0]["descs"]):
        warnings.append({"code": "empty_root_caption", "message": "The image root has no required description."})
    stats = {"vertices": len(vertices)}
    for name in ("model_calls", "model_errors", "blocked"):
        value = health.get(name, 0)
        if type(value) is int and 0 <= value <= 1_000_000:
            stats[name] = value
    for name in ("edges", "captions", "depth", "roots", "leaves"):
        value = record.outputs.get("stats", {}).get(name)
        if type(value) is int and 0 <= value <= 1_000_000:
            stats[name] = value
    seconds = summary.get("seconds")
    if type(seconds) in (int, float) and math.isfinite(seconds) and 0 <= seconds <= 86400:
        stats["seconds"] = round(seconds, 3)
    result = {**identity(request), "status": "degraded" if warnings else "succeeded",
              "graph": graph, "stats": stats, "warnings": warnings, "versions": versions()}
    json_bytes(result)
    return result


def execute(request, config):
    offline_environment()
    from togeari import SourceItem
    if any(config[s]["device"] == "cuda:0" for s in ("detector", "embedder")):
        import torch
        if not torch.cuda.is_available():
            fail("runtime_not_ready", "The configured CUDA device is unavailable.", "not_ready")
    if config["detector"]["model_type"] == "sam3" and "sam3" not in config["detector"]["model_path"].lower():
        fail("runtime_not_ready", "This upstream SAM3 entry requires an approved local directory named with sam3.", "not_ready")
    controls = profile_controls(request["profile"])
    inputs = {"image": {"path": request["input"]["path"], "key": request["analysis_id"]}, "controls": controls}
    records, summary, health = run_machine(engine_config(config), [SourceItem(request["analysis_id"], inputs)],
                                          controls, config["limits"])
    return process_records(request, records, summary, health)


def _flush_output_buffers(streams):
    """Drain Python/cached streams and the platform C runtime before changing their FDs."""
    import ctypes
    seen = set()
    for stream in streams:
        if stream is not None and id(stream) not in seen:
            seen.add(id(stream))
            if not getattr(stream, "closed", False):
                stream.flush()
    libc = ctypes.CDLL("ucrtbase" if os.name == "nt" else None)
    libc.fflush.argtypes = [ctypes.c_void_p]
    libc.fflush.restype = ctypes.c_int
    if libc.fflush(None) != 0:
        raise OSError("stdio flush failed")


@contextmanager
def quiet_runtime():
    """Sink Python streams, cached refs and native FDs; flush while still sunk on every exit."""
    original = (sys.stdout, sys.stderr)
    cached = (*original, sys.__stdout__, sys.__stderr__)
    saved = []
    restore_fds = True
    try:
        _flush_output_buffers(cached)
    except Exception:
        fail("output_quiet_failed", "Output streams could not be safely isolated.")
    null = open(os.devnull, "w", encoding="utf-8")
    try:
        for fd in (1, 2):
            saved.append((fd, os.dup(fd)))
            os.dup2(null.fileno(), fd)
        sys.stdout = sys.stderr = null
        try:
            yield
        finally:
            try:
                # Cached original TextIOWrapper/.buffer refs still point at the sunk FDs.
                _flush_output_buffers((sys.stdout, sys.stderr, null, *cached))
            except Exception:
                # Never restore outward FDs with unflushed upstream data still queued.
                restore_fds = False
                fail("output_quiet_failed", "Output streams could not be safely drained.")
    finally:
        sys.stdout, sys.stderr = original
        for fd, duplicate in saved:
            try:
                if restore_fds:
                    os.dup2(duplicate, fd)
            finally:
                os.close(duplicate)
        null.close()


def deadline_call(fn, seconds, on_timeout):
    """Publish a safe timeout and terminate when the watchdog can run; Host kill is the backstop."""
    lock = threading.Lock()
    finished = False

    def expire():
        with lock:
            if finished:
                return
            try:
                on_timeout()
            finally:
                os._exit(3)

    timer = threading.Timer(seconds, expire)
    timer.daemon = True
    timer.start()
    try:
        return fn()
    finally:
        with lock:
            finished = True
        timer.cancel()
        timer.join()


def run_request(request_path, result_path, config_path):
    request_identity = None
    result_file = None
    try:
        req_file = canonical_path(request_path)
        result_file = canonical_path(result_path, exists=False)
        job = req_file.parent
        if req_file.name != "request.json" or result_file.name != "result.json" or result_file.parent != job:
            fail("unsafe_path", "Request and result must be exact files in one precreated job.")
        if result_file.exists():
            fail("result_exists", "A result already exists; this invocation will not replay.")
        with ExitStack() as stack:
            stack.enter_context(locked_file(job, directory=True))
            raw = read_json(str(req_file), REQUEST_MAX)
            request_identity = identity(raw)
            # A malformed/unidentified request is never allowed to create files.
            if request_identity is None:
                fail("invalid_request", "Invalid request identity.")
            claim = job / ".gbc-claim"
            try:
                with open(claim, "xb") as stream:
                    stream.write(b"gbc-v1: one invocation only\n")
                    stream.flush()
                    os.fsync(stream.fileno())
            except FileExistsError:
                fail("job_claimed", "A prior invocation claimed this job; no automatic replay.")
            try:
                image = validate_request(raw, job)
                image_stream = stack.enter_context(locked_file(image))
                validate_image(raw, image_stream)
                config_file = canonical_path(config_path)
                if config_file.is_relative_to(job):
                    fail("unsafe_path", "Runtime configuration must be outside the job directory.")
                config = validate_config(read_json(str(config_file), CONFIG_MAX))
                state = readiness(config)
                if state["readiness"] == "disabled":
                    fail("runtime_disabled", "Analysis runtime is disabled.", "not_ready")
                if state["readiness"] != "ready":
                    if state["checks"].get("detector_local") and not state["checks"].get("detector_compatible"):
                        fail("runtime_not_ready", "Detector type, path dispatch and local config.json model_type disagree.", "not_ready")
                    fail("runtime_not_ready", "Approved local model dependencies or resources are unavailable.", "not_ready")
                def timeout_result():
                    publish(result_file, error_result(BridgeError("deadline_exceeded", "Analysis deadline was exceeded."), request_identity))

                with quiet_runtime():
                    result = deadline_call(lambda: execute(raw, config), config["limits"]["deadline_seconds"], timeout_result)
            except BridgeError as exc:
                result = error_result(exc, request_identity)
            except Exception as exc:
                # The quiet scope has ended. Never restore an upstream exception or traceback.
                print("[gbc] runtime_error", file=sys.stderr, flush=True)
                result = error_result(BridgeError("runtime_error", failure_detail(exc)), request_identity)
            publish(result_file, result)
            return result, 0 if result["status"] in ("succeeded", "degraded") else 3
    except BridgeError as exc:
        return error_result(exc, request_identity), 2
    except Exception:
        return error_result(BridgeError("boundary_error", "Request could not be processed safely."), request_identity), 2

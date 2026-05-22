import os
import signal
import socket
import subprocess
import sys
import uuid
from pathlib import Path
from typing import Any

from control_plane.engine_registry import EngineRegistry


REPO_ROOT = Path(__file__).resolve().parents[1]


class EngineProcessManager:
    """Starts and stops local data-plane engine processes."""

    def __init__(
        self,
        registry: EngineRegistry,
        port_start: int | None = None,
        port_end: int | None = None,
        control_url: str | None = None,
    ):
        self.registry = registry
        self.port_start = int(port_start or os.getenv("LIVE_ENGINE_PORT_START", "9000"))
        self.port_end = int(port_end or os.getenv("LIVE_ENGINE_PORT_END", "9999"))
        self.control_url = control_url or os.getenv("CONTROL_PLANE_URL", "http://localhost:8000")

    def start_engine(self, data: dict[str, Any]) -> dict[str, Any]:
        broker = data.get("broker") or "angel"
        account_env = _normalize_env(data.get("account_env"))
        strategy_name = data.get("strategy_name") or "default"
        client_mode = "bracket" if data.get("client_mode") == "bracket" else "standard"
        symbol = data.get("symbol")
        token = data.get("token")
        engine_id = data.get("id") or _engine_id(broker, symbol, strategy_name, account_env)
        host = data.get("host") or "localhost"
        port = int(data.get("port") or self.allocate_port())
        label = data.get("label") or f"{broker}-{symbol or '*'}-strategy-{strategy_name}"
        api_base_url = data.get("api_base_url") or f"http://{host}:{port}/api/live"
        ws_url = data.get("ws_url") or f"ws://{host}:{port}/ws/live"

        engine = self.registry.upsert_engine(
            {
                "id": engine_id,
                "label": label,
                "broker": broker,
                "symbol": symbol,
                "token": token,
                "strategy_name": strategy_name,
                "account_env": account_env,
                "host": host,
                "port": port,
                "api_base_url": api_base_url,
                "ws_url": ws_url,
                "status": "starting",
                "metadata": data.get("metadata") or {},
            }
        )

        cmd = [
            sys.executable,
            "-m",
            "api.live_server",
            "--port",
            str(port),
            "--env",
            account_env,
            "--engine-id",
            engine_id,
            "--control-url",
            self.control_url,
            "--broker",
            broker,
            "--strategy-name",
            strategy_name,
            "--client-mode",
            client_mode,
        ]
        if symbol:
            cmd.extend(["--symbol", str(symbol)])
        if token:
            cmd.extend(["--token", str(token)])
        if broker == "fake" or data.get("use_fake_client"):
            cmd.append("--fake")

        log_file = self._log_file(label)
        env = {**os.environ, "PYTHONUNBUFFERED": "1"}
        with log_file.open("a") as stream:
            process = subprocess.Popen(
                cmd,
                cwd=str(REPO_ROOT),
                env=env,
                stdout=stream,
                stderr=subprocess.STDOUT,
                start_new_session=True,
            )

        return self.registry.update_engine(
            engine["id"],
            {
                "pid": process.pid,
                "status": "starting",
                "metadata": {
                    **(engine.get("metadata") or {}),
                    "command": cmd,
                    "log_file": str(log_file),
                },
            },
        )

    def stop_engine(self, engine_id: str) -> dict[str, Any] | None:
        engine = self.registry.get_engine(engine_id)
        if not engine:
            return None

        pid = engine.get("pid")
        if pid:
            try:
                os.killpg(int(pid), signal.SIGTERM)
            except ProcessLookupError:
                pass
            except PermissionError:
                os.kill(int(pid), signal.SIGTERM)

        return self.registry.update_engine(engine_id, {"status": "stopped"})

    def allocate_port(self) -> int:
        used_ports = {int(engine["port"]) for engine in self.registry.list_engines() if engine.get("port")}
        for port in range(self.port_start, self.port_end + 1):
            if port in used_ports:
                continue
            if self._port_available(port):
                return port
        raise RuntimeError(f"No free data-plane ports in range {self.port_start}-{self.port_end}")

    @staticmethod
    def _port_available(port: int) -> bool:
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
            sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
            try:
                sock.bind(("127.0.0.1", port))
            except OSError:
                return False
        return True

    @staticmethod
    def _log_file(name: str) -> Path:
        log_dir = REPO_ROOT / "logs" / "executions"
        log_dir.mkdir(parents=True, exist_ok=True)
        return (log_dir / f"{_safe_filename(name)}.log").resolve()


def _normalize_env(value: Any) -> str:
    return "demo" if str(value or "live").lower() == "demo" else "live"


def _engine_id(broker: str, symbol: str | None, strategy_name: str, account_env: str) -> str:
    suffix = str(uuid.uuid4())[:8]
    base = f"{broker}-{symbol or 'all'}-strategy-{strategy_name}-{account_env}-{suffix}".lower()
    return "".join(ch if ch.isalnum() else "-" for ch in base).strip("-")


def _safe_filename(value: str) -> str:
    safe = "".join(ch if ch.isalnum() or ch in {"-", "_", "."} else "-" for ch in value.lower())
    return safe.strip("-") or "execution"

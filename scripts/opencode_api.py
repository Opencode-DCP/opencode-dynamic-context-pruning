#!/usr/bin/env python3
"""Shared helpers for querying the OpenCode HTTP API from scripts."""

from __future__ import annotations

import base64
import json
import os
import re
import selectors
import subprocess
import time
from dataclasses import dataclass
from typing import Any, TextIO, cast
from urllib.error import HTTPError, URLError
from urllib.parse import urlencode
from urllib.request import Request, urlopen


DEFAULT_HOSTNAME = "127.0.0.1"
DEFAULT_PORT = 0
DEFAULT_SERVER_TIMEOUT = 8.0
DEFAULT_REQUEST_TIMEOUT = 30.0
DEFAULT_SESSION_LIST_LIMIT = 5000


class APIError(RuntimeError):
    """OpenCode API request error."""

    def __init__(self, message: str, *, status_code: int | None = None):
        super().__init__(message)
        self.status_code = status_code


@dataclass
class ManagedServer:
    process: subprocess.Popen[str]
    url: str


def _auth_header(username: str, password: str) -> str:
    token = base64.b64encode(f"{username}:{password}".encode("utf-8")).decode("ascii")
    return f"Basic {token}"


def _parse_server_url(line: str) -> str | None:
    if not line.startswith("opencode server listening"):
        return None
    match = re.search(r"on\s+(https?://\S+)", line)
    if not match:
        return None
    return match.group(1)


def _start_server(hostname: str, port: int, timeout_seconds: float) -> ManagedServer:
    process = subprocess.Popen(
        ["opencode", "serve", f"--hostname={hostname}", f"--port={port}"],
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        text=True,
        bufsize=1,
        env=os.environ.copy(),
    )
    if process.stdout is None:
        process.kill()
        raise APIError("Failed to read opencode server output")

    selector = selectors.DefaultSelector()
    selector.register(process.stdout, selectors.EVENT_READ)

    deadline = time.monotonic() + timeout_seconds
    output: list[str] = []
    url: str | None = None

    while time.monotonic() < deadline:
        if process.poll() is not None:
            break
        for key, _ in selector.select(timeout=0.2):
            stream = cast(TextIO, key.fileobj)
            line = stream.readline()
            if not line:
                continue
            line = line.rstrip("\n")
            output.append(line)
            parsed = _parse_server_url(line)
            if parsed:
                url = parsed
                break
        if url:
            break

    selector.close()

    if url:
        return ManagedServer(process=process, url=url)

    if process.poll() is None:
        process.kill()
        process.wait(timeout=2)
    details = "\n".join(output[-20:]).strip()
    if details:
        raise APIError(f"Timed out waiting for opencode server startup. Last output:\n{details}")
    raise APIError("Timed out waiting for opencode server startup")


class OpencodeAPI:
    def __init__(
        self,
        *,
        url: str | None,
        username: str,
        password: str | None,
        request_timeout: float,
        server_hostname: str,
        server_port: int,
        server_timeout: float,
    ):
        self._managed_server: ManagedServer | None = None
        if url:
            self.base_url = url.rstrip("/")
        else:
            self._managed_server = _start_server(server_hostname, server_port, server_timeout)
            self.base_url = self._managed_server.url.rstrip("/")

        self.request_timeout = request_timeout
        self.headers = {"Accept": "application/json"}
        if password:
            self.headers["Authorization"] = _auth_header(username, password)

    def close(self):
        if self._managed_server is None:
            return
        process = self._managed_server.process
        self._managed_server = None
        if process.poll() is None:
            process.terminate()
            try:
                process.wait(timeout=2)
            except subprocess.TimeoutExpired:
                process.kill()
                process.wait(timeout=2)

    def __enter__(self):
        return self

    def __exit__(self, exc_type, exc, tb):
        self.close()

    def get_json(self, path: str, query: dict[str, Any] | None = None) -> Any:
        params = {k: v for k, v in (query or {}).items() if v is not None}
        url = f"{self.base_url}{path}"
        if params:
            url = f"{url}?{urlencode(params)}"

        request = Request(url, headers=self.headers, method="GET")
        try:
            with urlopen(request, timeout=self.request_timeout) as response:
                body = response.read().decode("utf-8")
                if not body:
                    return None
                return json.loads(body)
        except HTTPError as err:
            body = err.read().decode("utf-8", errors="replace")
            message = f"GET {path} failed with HTTP {err.code}"
            if body:
                message = f"{message}: {body}"
            raise APIError(message, status_code=err.code) from err
        except URLError as err:
            raise APIError(f"GET {path} failed: {err}") from err

    def health(self) -> dict[str, Any]:
        return self.get_json("/global/health")

    def list_projects(self) -> list[dict[str, Any]]:
        return self.get_json("/project")

    def list_sessions(
        self,
        *,
        directory: str | None = None,
        roots: bool | None = None,
        start: int | None = None,
        search: str | None = None,
        limit: int | None = None,
    ) -> list[dict[str, Any]]:
        return self.get_json(
            "/session",
            {
                "directory": directory,
                "roots": str(roots).lower() if roots is not None else None,
                "start": start,
                "search": search,
                "limit": limit,
            },
        )

    def get_session(self, session_id: str, *, directory: str | None = None) -> dict[str, Any]:
        return self.get_json(f"/session/{session_id}", {"directory": directory})

    def get_session_messages(
        self,
        session_id: str,
        *,
        directory: str | None = None,
        limit: int | None = None,
    ) -> list[dict[str, Any]]:
        return self.get_json(
            f"/session/{session_id}/message",
            {
                "directory": directory,
                "limit": limit,
            },
        )

    def get_session_message(
        self,
        session_id: str,
        message_id: str,
        *,
        directory: str | None = None,
    ) -> dict[str, Any]:
        return self.get_json(
            f"/session/{session_id}/message/{message_id}",
            {"directory": directory},
        )


def add_api_arguments(parser):
    parser.add_argument("--url", type=str, default=None, help="OpenCode server URL (default: start local server)")
    parser.add_argument("--username", type=str, default=os.environ.get("OPENCODE_SERVER_USERNAME", "opencode"))
    parser.add_argument("--password", type=str, default=os.environ.get("OPENCODE_SERVER_PASSWORD"))
    parser.add_argument("--hostname", type=str, default=DEFAULT_HOSTNAME, help="Hostname for spawned local server")
    parser.add_argument("--port", type=int, default=DEFAULT_PORT, help="Port for spawned local server (0 = auto)")
    parser.add_argument(
        "--server-timeout",
        type=float,
        default=DEFAULT_SERVER_TIMEOUT,
        help="Seconds to wait for spawned server startup",
    )
    parser.add_argument(
        "--request-timeout",
        type=float,
        default=DEFAULT_REQUEST_TIMEOUT,
        help="HTTP request timeout in seconds",
    )
    parser.add_argument(
        "--session-list-limit",
        type=int,
        default=DEFAULT_SESSION_LIST_LIMIT,
        help="Max sessions fetched per project from /session",
    )


def create_client_from_args(args) -> OpencodeAPI:
    client = OpencodeAPI(
        url=getattr(args, "url", None),
        username=getattr(args, "username", "opencode"),
        password=getattr(args, "password", None),
        request_timeout=getattr(args, "request_timeout", DEFAULT_REQUEST_TIMEOUT),
        server_hostname=getattr(args, "hostname", DEFAULT_HOSTNAME),
        server_port=getattr(args, "port", DEFAULT_PORT),
        server_timeout=getattr(args, "server_timeout", DEFAULT_SERVER_TIMEOUT),
    )
    client.health()
    return client


def list_sessions_across_projects(
    client: OpencodeAPI,
    *,
    search: str | None = None,
    roots: bool | None = None,
    per_project_limit: int = DEFAULT_SESSION_LIST_LIMIT,
) -> list[dict[str, Any]]:
    sessions_by_id: dict[str, dict[str, Any]] = {}
    projects = client.list_projects()

    for project in projects:
        directory = project.get("worktree")
        if not directory:
            continue
        try:
            sessions = client.list_sessions(
                directory=directory,
                roots=roots,
                search=search,
                limit=per_project_limit,
            )
        except APIError:
            continue
        for session in sessions:
            session_id = session.get("id")
            if not session_id:
                continue
            sessions_by_id[session_id] = session

    results = list(sessions_by_id.values())
    results.sort(key=lambda item: item.get("time", {}).get("updated", 0), reverse=True)
    return results

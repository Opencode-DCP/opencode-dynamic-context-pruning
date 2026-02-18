#!/usr/bin/env python3
"""Shared helpers for querying the OpenCode SQLite database from scripts."""

from __future__ import annotations

import json
import sqlite3
from pathlib import Path
from typing import Any


DEFAULT_DB_PATH = Path.home() / ".local/share/opencode/opencode.db"
DEFAULT_SESSION_LIST_LIMIT = 5000


class APIError(RuntimeError):
    """Script data access error (kept for backwards compatibility)."""

    def __init__(self, message: str, *, status_code: int | None = None):
        super().__init__(message)
        self.status_code = status_code


class OpencodeAPI:
    """Compatibility wrapper with the old API client interface."""

    def __init__(self, db_path: Path):
        self.db_path = db_path
        self.conn = sqlite3.connect(f"file:{db_path}?mode=ro", uri=True)
        self.conn.row_factory = sqlite3.Row

    def close(self):
        self.conn.close()

    def __enter__(self):
        return self

    def __exit__(self, exc_type, exc, tb):
        self.close()

    def health(self) -> dict[str, Any]:
        self.conn.execute("SELECT 1").fetchone()
        return {"status": "ok"}

    def list_projects(self) -> list[dict[str, Any]]:
        rows = self.conn.execute(
            "SELECT id, worktree FROM project ORDER BY time_updated DESC"
        ).fetchall()
        return [{"id": row["id"], "worktree": row["worktree"]} for row in rows]

    def _format_session_row(self, row: sqlite3.Row) -> dict[str, Any]:
        return {
            "id": row["id"],
            "projectID": row["project_id"],
            "parentID": row["parent_id"],
            "directory": row["directory"],
            "title": row["title"],
            "time": {"created": row["time_created"], "updated": row["time_updated"]},
        }

    def list_sessions(
        self,
        *,
        directory: str | None = None,
        roots: bool | None = None,
        start: int | None = None,
        search: str | None = None,
        limit: int | None = None,
    ) -> list[dict[str, Any]]:
        clauses: list[str] = []
        params: list[Any] = []

        if directory:
            clauses.append("directory = ?")
            params.append(directory)
        if roots is True:
            clauses.append("parent_id IS NULL")
        elif roots is False:
            clauses.append("parent_id IS NOT NULL")
        if search:
            clauses.append("LOWER(title) LIKE ?")
            params.append(f"%{search.lower()}%")

        where = f"WHERE {' AND '.join(clauses)}" if clauses else ""
        query = f"""
            SELECT id, project_id, parent_id, directory, title, time_created, time_updated
            FROM session
            {where}
            ORDER BY time_updated DESC
        """

        if start is not None and start > 0:
            query += " LIMIT -1 OFFSET ?"
            params.append(start)
            if limit is not None and limit > 0:
                query = query.replace("LIMIT -1", "LIMIT ?", 1)
                params[-1] = limit
                params.append(start)
        elif limit is not None and limit > 0:
            query += " LIMIT ?"
            params.append(limit)

        rows = self.conn.execute(query, params).fetchall()
        return [self._format_session_row(row) for row in rows]

    def get_session(self, session_id: str, *, directory: str | None = None) -> dict[str, Any]:
        params: list[Any] = [session_id]
        query = """
            SELECT id, project_id, parent_id, directory, title, time_created, time_updated
            FROM session
            WHERE id = ?
        """
        if directory:
            query += " AND directory = ?"
            params.append(directory)
        row = self.conn.execute(query, params).fetchone()
        if row is None:
            raise APIError(f"Session not found: {session_id}", status_code=404)
        return self._format_session_row(row)

    def get_session_messages(
        self,
        session_id: str,
        *,
        directory: str | None = None,
        limit: int | None = None,
    ) -> list[dict[str, Any]]:
        if directory:
            self.get_session(session_id, directory=directory)

        message_query = """
            SELECT id, data
            FROM message
            WHERE session_id = ?
            ORDER BY time_created ASC
        """
        message_params: list[Any] = [session_id]
        if limit is not None and limit > 0:
            message_query += " LIMIT ?"
            message_params.append(limit)
        message_rows = self.conn.execute(message_query, message_params).fetchall()

        part_rows = self.conn.execute(
            """
            SELECT message_id, data
            FROM part
            WHERE session_id = ?
            ORDER BY time_created ASC
            """,
            [session_id],
        ).fetchall()

        parts_by_message: dict[str, list[dict[str, Any]]] = {}
        for row in part_rows:
            try:
                payload = json.loads(row["data"])
            except (json.JSONDecodeError, TypeError):
                continue
            parts_by_message.setdefault(row["message_id"], []).append(payload)

        messages: list[dict[str, Any]] = []
        for row in message_rows:
            try:
                info = json.loads(row["data"])
            except (json.JSONDecodeError, TypeError):
                info = {}
            info["id"] = row["id"]
            messages.append({"info": info, "parts": parts_by_message.get(row["id"], [])})
        return messages

    def get_session_message(
        self,
        session_id: str,
        message_id: str,
        *,
        directory: str | None = None,
    ) -> dict[str, Any]:
        if directory:
            self.get_session(session_id, directory=directory)

        row = self.conn.execute(
            """
            SELECT data
            FROM message
            WHERE session_id = ? AND id = ?
            """,
            [session_id, message_id],
        ).fetchone()
        if row is None:
            raise APIError(f"Message not found: {message_id}", status_code=404)

        try:
            info = json.loads(row["data"])
        except (json.JSONDecodeError, TypeError):
            info = {}
        info["id"] = message_id

        part_rows = self.conn.execute(
            """
            SELECT data
            FROM part
            WHERE session_id = ? AND message_id = ?
            ORDER BY time_created ASC
            """,
            [session_id, message_id],
        ).fetchall()

        parts: list[dict[str, Any]] = []
        for part_row in part_rows:
            try:
                parts.append(json.loads(part_row["data"]))
            except (json.JSONDecodeError, TypeError):
                continue

        return {"info": info, "parts": parts}


def add_api_arguments(parser):
    parser.add_argument(
        "--db",
        type=str,
        default=str(DEFAULT_DB_PATH),
        help=f"Path to OpenCode SQLite database (default: {DEFAULT_DB_PATH})",
    )
    parser.add_argument(
        "--session-list-limit",
        type=int,
        default=DEFAULT_SESSION_LIST_LIMIT,
        help="Max sessions scanned",
    )


def create_client_from_args(args) -> OpencodeAPI:
    db_path = Path(getattr(args, "db", DEFAULT_DB_PATH)).expanduser()
    if not db_path.exists():
        raise APIError(f"OpenCode database not found: {db_path}")
    client = OpencodeAPI(db_path)
    client.health()
    return client


def list_sessions_across_projects(
    client: OpencodeAPI,
    *,
    search: str | None = None,
    roots: bool | None = None,
    per_project_limit: int = DEFAULT_SESSION_LIST_LIMIT,
) -> list[dict[str, Any]]:
    return client.list_sessions(search=search, roots=roots, limit=per_project_limit)

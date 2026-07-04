"""Pluto Python SDK — minimal reference client.

Not a complete port of the JS SDK. Ships the REST query builder,
GraphQL passthrough, auth helpers, storage upload/download, and edge
function invoke — enough for scripts and backend integrations.
"""
from __future__ import annotations

import json
from dataclasses import dataclass, field
from typing import Any, Dict, List, Optional, Union
from urllib.parse import urlencode

try:
    import requests
except ImportError as e:  # pragma: no cover
    raise ImportError("pluto-sdk requires the `requests` package") from e


@dataclass
class PlutoClient:
    base_url: str
    anon_key: str
    workspace: Optional[str] = None
    _token: Optional[str] = field(default=None, init=False, repr=False)

    def set_session(self, access_token: Optional[str]) -> None:
        self._token = access_token

    # --- HTTP helpers ---------------------------------------------------
    def _headers(self, extra: Optional[Dict[str, str]] = None) -> Dict[str, str]:
        h = {
            "apikey": self.anon_key,
            "content-type": "application/json",
        }
        if self._token:
            h["authorization"] = f"Bearer {self._token}"
        if self.workspace:
            h["x-workspace-id"] = self.workspace
        if extra:
            h.update(extra)
        return h

    def _req(self, method: str, path: str, *, params=None, body=None, headers=None) -> Any:
        url = f"{self.base_url.rstrip('/')}{path}"
        r = requests.request(
            method, url, params=params,
            data=None if body is None else json.dumps(body),
            headers=self._headers(headers), timeout=30,
        )
        if r.status_code >= 400:
            raise PlutoError(r.status_code, r.text)
        if r.headers.get("content-type", "").startswith("application/json"):
            return r.json()
        return r.content

    # --- Sub-clients ----------------------------------------------------
    def rest(self, table: str) -> "RestBuilder":
        return RestBuilder(self, table)

    def graphql(self, query: str, variables: Optional[Dict[str, Any]] = None) -> Any:
        return self._req("POST", "/graphql/v1", body={"query": query, "variables": variables or {}})

    def invoke(self, slug: str, payload: Any = None) -> Any:
        return self._req("POST", f"/fn/v3/invoke/{slug}", body=payload or {})

    @property
    def auth(self) -> "Auth":
        return Auth(self)

    @property
    def storage(self) -> "Storage":
        return Storage(self)


class PlutoError(RuntimeError):
    def __init__(self, status: int, body: str) -> None:
        super().__init__(f"pluto[{status}]: {body}")
        self.status = status
        self.body = body


@dataclass
class RestBuilder:
    client: PlutoClient
    table: str
    _select: str = "*"
    _filters: Dict[str, str] = field(default_factory=dict)
    _order: Optional[str] = None
    _limit: Optional[int] = None
    _offset: Optional[int] = None
    _insert_body: Any = None
    _update_body: Any = None
    _mode: str = "select"

    def select(self, cols: str) -> "RestBuilder": self._select = cols; return self
    def eq(self, col, v):   self._filters[col] = f"eq.{v}";  return self
    def neq(self, col, v):  self._filters[col] = f"neq.{v}"; return self
    def gt(self, col, v):   self._filters[col] = f"gt.{v}";  return self
    def gte(self, col, v):  self._filters[col] = f"gte.{v}"; return self
    def lt(self, col, v):   self._filters[col] = f"lt.{v}";  return self
    def lte(self, col, v):  self._filters[col] = f"lte.{v}"; return self
    def in_(self, col, vs): self._filters[col] = f"in.({','.join(map(str, vs))})"; return self
    def order(self, s):     self._order = s; return self
    def limit(self, n):     self._limit = n; return self
    def offset(self, n):    self._offset = n; return self

    def insert(self, body: Union[Dict[str, Any], List[Dict[str, Any]]]):
        self._mode = "insert"; self._insert_body = body; return self
    def update(self, body: Dict[str, Any]):
        self._mode = "update"; self._update_body = body; return self
    def delete(self):
        self._mode = "delete"; return self

    def execute(self):
        params = {"select": self._select, **self._filters}
        if self._order:  params["order"]  = self._order
        if self._limit is not None:  params["limit"]  = self._limit
        if self._offset is not None: params["offset"] = self._offset
        qs = "?" + urlencode(params) if params else ""
        path = f"/rest/v1/{self.table}{qs}"
        if self._mode == "select":
            return self.client._req("GET", path)
        if self._mode == "insert":
            return self.client._req("POST", f"/rest/v1/{self.table}", body=self._insert_body)
        if self._mode == "update":
            return self.client._req("PATCH", path, body=self._update_body)
        if self._mode == "delete":
            return self.client._req("DELETE", path)
        raise ValueError(f"bad mode {self._mode}")


@dataclass
class Auth:
    client: PlutoClient
    def sign_up(self, email, password):
        return self.client._req("POST", "/auth/v1/signup", body={"email": email, "password": password})
    def sign_in_with_password(self, email, password):
        r = self.client._req("POST", "/auth/v1/token?grant_type=password",
                             body={"email": email, "password": password})
        if isinstance(r, dict) and "access_token" in r:
            self.client.set_session(r["access_token"])
        return r
    def sign_out(self):
        self.client.set_session(None); return {"ok": True}
    def reset_password_for_email(self, email):
        return self.client._req("POST", "/auth/v1/recover", body={"email": email})


@dataclass
class Storage:
    client: PlutoClient
    def upload(self, bucket: str, path: str, data: bytes, content_type: str = "application/octet-stream"):
        url = f"{self.client.base_url.rstrip('/')}/storage/v1/object/{bucket}/{path}"
        r = requests.post(url, data=data,
                          headers={**self.client._headers({"content-type": content_type})}, timeout=60)
        if r.status_code >= 400: raise PlutoError(r.status_code, r.text)
        return r.json() if r.headers.get("content-type", "").startswith("application/json") else {}
    def download(self, bucket: str, path: str) -> bytes:
        return self.client._req("GET", f"/storage/v1/object/{bucket}/{path}")
    def create_signed_url(self, bucket, path, expires_in=3600):
        return self.client._req("POST", f"/storage/v1/object/sign/{bucket}/{path}",
                                body={"expires_in": expires_in})

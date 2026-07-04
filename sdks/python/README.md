# Pluto Python SDK (skeleton)

Thin wrapper around the Pluto REST + GraphQL API. Depends only on
`requests`.

```bash
pip install pluto-sdk  # (once published)
```

```python
from pluto import PlutoClient

pluto = PlutoClient("https://api.example.com", anon_key="pluto_...")
todos = pluto.rest("todos").select("*").eq("done", False).limit(10).execute()
new   = pluto.rest("todos").insert({"title": "hi"}).execute()

# GraphQL
data = pluto.graphql("{ todos(limit: 5) { id title } }")

# Auth
session = pluto.auth.sign_in_with_password("me@example.com", "pw")
pluto.set_session(session["access_token"])
```

See `src/pluto/client.py` for the reference implementation.

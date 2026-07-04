# Phase 42 — Storage production

Enable with `PLUTO_ENABLE_STORAGE_V2=1`. Registers under `/storage/v1/*`
alongside the existing storage + storage_ext modules.

## Multipart uploads (S3-style, > 5 GB objects)

```
POST   /storage/v1/multipart/:bucket/*                           → { upload_id, min_part_size }
PUT    /storage/v1/multipart/:bucket/*?upload_id=…&part=N        → { etag, part, size }
POST   /storage/v1/multipart/:bucket/*/complete
       body: { upload_id, parts: [{ part, etag }, …] }           → { ok, size, etag }
DELETE /storage/v1/multipart/:bucket/*/abort?upload_id=…         → { ok }
```

Parts are staged at `.multipart/<upload_id>/<n>` in the same bucket and
concatenated on `complete`. `etag` is md5 of the part bytes (S3 semantics).

## Presigned POST (browser direct upload with constraints)

```
POST /storage/v1/presigned-post
     body: { bucket, key_prefix, max_size, content_types, expires_in_sec }
     → { url, fields: { policy, signature, key_prefix, bucket }, expires_at }
```

Client then posts the file bytes to `/storage/v1/presigned-post/upload`
with headers `x-pluto-policy`, `x-pluto-signature`, `x-pluto-filename`,
`content-type`. Server verifies HMAC(policy) against JWT_SECRET, enforces
size + content-type list, and stores under `{key_prefix}/{ts}-{safeName}`.

## Antivirus scan queue (ClamAV)

Every completed multipart / presigned-post upload is enqueued to
`public.storage_scan_queue`. When `PLUTO_CLAMAV_HOST` is set the worker
streams bytes over the clamd INSTREAM protocol. Endpoints:

```
GET  /storage/v1/scan/:bucket/*    → { status, verdict, scanner, scanned_at }
POST /storage/v1/scan/:bucket/*    → scan on demand
```

`status ∈ pending | scanning | clean | infected | error | skipped`.
When ClamAV env is unset, `skipped` is returned so pipelines don't block.

## CDN cache purge

```
POST /storage/v1/cdn/purge   body: { targets: string[] }
```

Provider chosen by `PLUTO_CDN_PROVIDER`:

| Provider | Required env |
| --- | --- |
| `cloudflare` | `PLUTO_CLOUDFLARE_ZONE`, `PLUTO_CLOUDFLARE_TOKEN` |
| `fastly`     | `PLUTO_FASTLY_TOKEN` |
| `generic`    | none (issues HTTP `PURGE`) |

Every attempt is logged in `public.storage_cdn_purges`.

## imgproxy signed URLs

```
GET /storage/v1/render/imgproxy/:bucket/*?width=&height=&resize=&quality=&format=
     → 302 to <PLUTO_IMGPROXY_URL>/<sig>/rs:…/q:…/<b64-src>.<ext>
```

Env: `PLUTO_IMGPROXY_URL`, `PLUTO_IMGPROXY_KEY` (hex), `PLUTO_IMGPROXY_SALT`
(hex), optional `PLUTO_IMGPROXY_SIG_LEN` (default 32),
`PLUTO_IMGPROXY_SOURCE_BASE` (public URL the sidecar can fetch bytes from).
When unset, the endpoint returns `501 imgproxy_disabled`.

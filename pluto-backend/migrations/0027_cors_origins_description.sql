-- Phase 15 · 0027 — Add description column to admin.cors_origins
-- Required by the dynamic CORS registry (routes/cors.ts).

alter table admin.cors_origins
  add column if not exists description text;

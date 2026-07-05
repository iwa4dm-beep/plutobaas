-- Pluto BaaS — storage schema
CREATE SCHEMA IF NOT EXISTS storage;

-- Buckets
CREATE TABLE IF NOT EXISTS storage.buckets (
  id text PRIMARY KEY,
  name text NOT NULL,
  owner_id uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  public boolean NOT NULL DEFAULT false,
  file_size_limit bigint,
  allowed_mime_types text[],
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now()
);

-- Objects
CREATE TABLE IF NOT EXISTS storage.objects (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  bucket_id text NOT NULL REFERENCES storage.buckets(id) ON DELETE CASCADE,
  name text NOT NULL,
  owner_id uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  size bigint NOT NULL DEFAULT 0,
  mime_type text,
  etag text,
  metadata jsonb DEFAULT '{}'::jsonb,
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now(),
  UNIQUE (bucket_id, name)
);
CREATE INDEX IF NOT EXISTS objects_bucket_idx ON storage.objects (bucket_id);
CREATE INDEX IF NOT EXISTS objects_owner_idx ON storage.objects (owner_id);
CREATE INDEX IF NOT EXISTS objects_name_idx ON storage.objects (bucket_id, name text_pattern_ops);

GRANT USAGE ON SCHEMA storage TO anon, authenticated, service_role;
GRANT SELECT ON storage.buckets TO anon, authenticated;
GRANT ALL ON storage.buckets TO service_role;
GRANT SELECT ON storage.objects TO anon, authenticated;
GRANT ALL ON storage.objects TO service_role;

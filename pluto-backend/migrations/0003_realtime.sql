-- Pluto BaaS — realtime: broadcast changes via NOTIFY on 'pluto_realtime'
CREATE OR REPLACE FUNCTION public.pluto_notify_change() RETURNS trigger AS $$
DECLARE
  payload jsonb;
  rec jsonb;
BEGIN
  IF TG_OP = 'DELETE' THEN
    rec = to_jsonb(OLD);
  ELSE
    rec = to_jsonb(NEW);
  END IF;
  payload = jsonb_build_object(
    'schema', TG_TABLE_SCHEMA,
    'table',  TG_TABLE_NAME,
    'type',   TG_OP,
    'record', CASE WHEN TG_OP = 'DELETE' THEN NULL ELSE rec END,
    'old',    CASE WHEN TG_OP = 'INSERT' THEN NULL ELSE to_jsonb(OLD) END,
    'ts',     extract(epoch from now())
  );
  PERFORM pg_notify('pluto_realtime', payload::text);
  RETURN COALESCE(NEW, OLD);
END;
$$ LANGUAGE plpgsql;

-- Helper: enable realtime broadcast on a table
CREATE OR REPLACE FUNCTION public.pluto_enable_realtime(tbl regclass) RETURNS void AS $$
DECLARE
  trigname text := 'pluto_realtime_' || replace(tbl::text, '.', '_');
BEGIN
  EXECUTE format('DROP TRIGGER IF EXISTS %I ON %s', trigname, tbl);
  EXECUTE format(
    'CREATE TRIGGER %I AFTER INSERT OR UPDATE OR DELETE ON %s
     FOR EACH ROW EXECUTE FUNCTION public.pluto_notify_change()',
    trigname, tbl
  );
END;
$$ LANGUAGE plpgsql;

-- Presence + broadcast channels registry (in-memory in the API; this is optional bookkeeping)
CREATE TABLE IF NOT EXISTS public.realtime_channels (
  name text PRIMARY KEY,
  created_at timestamptz DEFAULT now()
);
GRANT SELECT, INSERT ON public.realtime_channels TO authenticated;
GRANT ALL ON public.realtime_channels TO service_role;

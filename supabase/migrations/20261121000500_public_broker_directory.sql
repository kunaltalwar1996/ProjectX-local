-- Public broker directory: expose only fields already used by public broker
-- identity cards. Private contact and profile fields remain protected.
CREATE OR REPLACE FUNCTION public.get_public_brokers()
RETURNS TABLE (id uuid, full_name text, avatar_url text)
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path TO pg_catalog, public
AS $$
  SELECT p.id, p.full_name, p.avatar_url
  FROM public.profiles p
  WHERE p.role = 'Broker'
  ORDER BY p.full_name NULLS LAST, p.id;
$$;

REVOKE ALL ON FUNCTION public.get_public_brokers() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_public_brokers() TO anon, authenticated;

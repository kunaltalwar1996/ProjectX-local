-- Keep the profile email visible to authorized app queries, using Supabase
-- Auth as the source of truth. This also covers accounts created by the
-- service-role create-staff-user Edge Function.
CREATE OR REPLACE FUNCTION public.sync_profile_email_from_auth()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO pg_catalog, public, auth
AS $$
DECLARE auth_email text;
BEGIN
  SELECT u.email INTO auth_email
  FROM auth.users AS u
  WHERE u.id = NEW.id;

  IF auth_email IS NOT NULL THEN
    NEW.email := auth_email;
  END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION public.sync_profile_email_from_auth() FROM PUBLIC;

DROP TRIGGER IF EXISTS aaa_sync_profile_email_from_auth ON public.profiles;
CREATE TRIGGER aaa_sync_profile_email_from_auth
  BEFORE INSERT ON public.profiles
  FOR EACH ROW
  EXECUTE FUNCTION public.sync_profile_email_from_auth();

-- Backfill profiles created before the sync trigger. Temporarily bypass the
-- profile protection trigger for this trusted migration-only data repair.
ALTER TABLE public.profiles DISABLE TRIGGER trg_protect_profile_sensitive_columns;
UPDATE public.profiles AS p
SET email = u.email
FROM auth.users AS u
WHERE u.id = p.id
  AND p.email IS DISTINCT FROM u.email;
ALTER TABLE public.profiles ENABLE TRIGGER trg_protect_profile_sensitive_columns;

NOTIFY pgrst, 'reload schema';

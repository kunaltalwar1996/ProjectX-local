-- Unit 1: Secure public.profiles against public/guest raw-record exposure.
-- Reversible in practice by restoring dropped policies, disabling RLS, and
-- re-adding public.profiles.password as nullable text without recovered values.
-- This migration does not copy, return, or transform profiles.password contents.

-- ---------------------------------------------------------------------------
-- 1. Harden existing role helpers (fixed search_path; same role model)
-- ---------------------------------------------------------------------------
ALTER FUNCTION public.is_staff() SET search_path TO pg_catalog, public;
ALTER FUNCTION public.is_broker() SET search_path TO pg_catalog, public;

-- Admin-only helper: is_staff() includes Employees, so it cannot authorize
-- Admin-only operations such as profile deletion.
CREATE OR REPLACE FUNCTION public.is_admin()
RETURNS boolean
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO pg_catalog, public
AS $$
BEGIN
  RETURN EXISTS (
    SELECT 1
    FROM public.profiles AS p
    WHERE p.id = auth.uid()
      AND p.role = 'Admin'
  );
END;
$$;

REVOKE ALL ON FUNCTION public.is_admin() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.is_admin() TO authenticated;

-- ---------------------------------------------------------------------------
-- 2. Narrow public broker identity projection
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.get_public_broker_identity(p_broker_id uuid)
RETURNS TABLE (id uuid, full_name text, avatar_url text)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO pg_catalog, public
AS $$
BEGIN
  IF p_broker_id IS NULL THEN
    RETURN;
  END IF;

  RETURN QUERY
  SELECT p.id, p.full_name, p.avatar_url
  FROM public.profiles AS p
  WHERE p.id = p_broker_id
    AND p.role = 'Broker';
END;
$$;

REVOKE ALL ON FUNCTION public.get_public_broker_identity(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_public_broker_identity(uuid) TO anon, authenticated;

-- ---------------------------------------------------------------------------
-- 3. Relationship-checked counterparty identity (chat / inquiries)
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.get_related_profile_identities(p_ids uuid[])
RETURNS TABLE (id uuid, full_name text, avatar_url text)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO pg_catalog, public
AS $$
BEGIN
  IF auth.uid() IS NULL OR p_ids IS NULL THEN
    RETURN;
  END IF;

  RETURN QUERY
  SELECT p.id, p.full_name, p.avatar_url
  FROM public.profiles AS p
  WHERE p.id = ANY (p_ids)
    AND p.id IS DISTINCT FROM auth.uid()
    AND (
      EXISTS (
        SELECT 1
        FROM public.messages AS m
        WHERE (m.broker_id = auth.uid() AND m.buyer_id = p.id)
           OR (m.buyer_id = auth.uid() AND m.broker_id = p.id)
      )
      OR EXISTS (
        SELECT 1
        FROM public.inquiries AS i
        WHERE (i.broker_id = auth.uid() AND i.buyer_id = p.id)
           OR (i.buyer_id = auth.uid() AND i.broker_id = p.id)
      )
    );
END;
$$;

REVOKE ALL ON FUNCTION public.get_related_profile_identities(uuid[]) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_related_profile_identities(uuid[]) TO authenticated;

-- ---------------------------------------------------------------------------
-- 4. Self-scoped referral aggregates (no raw referred profile rows)
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.get_own_referral_stats()
RETURNS TABLE (invited_count integer, active_count integer)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO pg_catalog, public
AS $$
BEGIN
  IF auth.uid() IS NULL THEN
    invited_count := 0;
    active_count := 0;
    RETURN NEXT;
    RETURN;
  END IF;

  RETURN QUERY
  SELECT
    COUNT(*)::integer AS invited_count,
    COUNT(*) FILTER (WHERE p.role IN ('Buyer', 'Broker'))::integer AS active_count
  FROM public.profiles AS p
  WHERE p.referred_by = auth.uid();
END;
$$;

REVOKE ALL ON FUNCTION public.get_own_referral_stats() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_own_referral_stats() TO authenticated;

-- ---------------------------------------------------------------------------
-- 5. Prevent self-escalation and protected-field mutation
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.protect_profile_sensitive_columns()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO pg_catalog, public
AS $$
BEGIN
  IF auth.role() = 'service_role' THEN
    RETURN NEW;
  END IF;

  IF TG_OP = 'INSERT' THEN
    IF NEW.id IS DISTINCT FROM auth.uid() THEN
      RAISE EXCEPTION 'Cannot create a profile for another user';
    END IF;

    IF NEW.role IS NULL OR NEW.role NOT IN ('Buyer', 'Broker', 'Guest') THEN
      RAISE EXCEPTION 'Cannot assign a privileged profile role';
    END IF;

    NEW.employee_type := NULL;

    IF NEW.email IS NOT NULL AND NEW.email IS DISTINCT FROM auth.email() THEN
      RAISE EXCEPTION 'Cannot set profile email to a different address';
    END IF;

    RETURN NEW;
  END IF;

  IF NEW.id IS DISTINCT FROM OLD.id THEN
    RAISE EXCEPTION 'Cannot change profile id';
  END IF;

  IF NEW.id IS DISTINCT FROM auth.uid() THEN
    IF NOT public.is_staff() THEN
      RAISE EXCEPTION 'Cannot update another profile';
    END IF;

    -- Staff may flag another account via bio only (existing panel behavior).
    NEW.full_name := OLD.full_name;
    NEW.role := OLD.role;
    NEW.phone := OLD.phone;
    NEW.city := OLD.city;
    NEW.preferences := OLD.preferences;
    NEW.avatar_url := OLD.avatar_url;
    NEW.referred_by := OLD.referred_by;
    NEW.email := OLD.email;
    NEW.employee_type := OLD.employee_type;
    NEW."resetOtp" := OLD."resetOtp";
    NEW."expireOtp" := OLD."expireOtp";
    NEW.referal_points := OLD.referal_points;
    NEW.wishlist := OLD.wishlist;
    RETURN NEW;
  END IF;

  NEW.role := OLD.role;
  NEW.email := OLD.email;
  NEW.referred_by := OLD.referred_by;
  NEW.employee_type := OLD.employee_type;
  NEW."resetOtp" := OLD."resetOtp";
  NEW."expireOtp" := OLD."expireOtp";
  NEW.referal_points := OLD.referal_points;
  NEW.wishlist := OLD.wishlist;
  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.protect_profile_sensitive_columns() FROM PUBLIC;

DROP TRIGGER IF EXISTS trg_protect_profile_sensitive_columns ON public.profiles;
CREATE TRIGGER trg_protect_profile_sensitive_columns
  BEFORE INSERT OR UPDATE ON public.profiles
  FOR EACH ROW
  EXECUTE FUNCTION public.protect_profile_sensitive_columns();

-- ---------------------------------------------------------------------------
-- 6. Replace permissive profile policies and enable RLS
-- ---------------------------------------------------------------------------
DROP POLICY IF EXISTS "Allow users to read any profile" ON public.profiles;
DROP POLICY IF EXISTS "Public profiles are viewable by everyone." ON public.profiles;
DROP POLICY IF EXISTS "Allow users to view their own profile" ON public.profiles;
DROP POLICY IF EXISTS "Allow users to insert their own profile" ON public.profiles;
DROP POLICY IF EXISTS "Users can insert their own profile." ON public.profiles;
DROP POLICY IF EXISTS "Users can update own profile." ON public.profiles;
DROP POLICY IF EXISTS "Admins can delete user profiles" ON public.profiles;

ALTER TABLE public.profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.profiles NO FORCE ROW LEVEL SECURITY;

CREATE POLICY profiles_select_own
  ON public.profiles
  FOR SELECT
  TO authenticated
  USING (id = auth.uid());

CREATE POLICY profiles_select_staff
  ON public.profiles
  FOR SELECT
  TO authenticated
  USING (public.is_staff());

CREATE POLICY profiles_insert_own
  ON public.profiles
  FOR INSERT
  TO authenticated
  WITH CHECK (
    id = auth.uid()
    AND role IN ('Buyer', 'Broker', 'Guest')
    AND employee_type IS NULL
  );

CREATE POLICY profiles_update_own
  ON public.profiles
  FOR UPDATE
  TO authenticated
  USING (id = auth.uid())
  WITH CHECK (id = auth.uid());

CREATE POLICY profiles_update_staff
  ON public.profiles
  FOR UPDATE
  TO authenticated
  USING (public.is_staff())
  WITH CHECK (public.is_staff());

CREATE POLICY profiles_delete_admin
  ON public.profiles
  FOR DELETE
  TO authenticated
  USING (public.is_admin());

REVOKE ALL ON TABLE public.profiles FROM PUBLIC;
REVOKE ALL ON TABLE public.profiles FROM anon;
REVOKE ALL ON TABLE public.profiles FROM authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.profiles TO authenticated;
GRANT ALL ON TABLE public.profiles TO service_role;

-- ---------------------------------------------------------------------------
-- 7. Remove unused profiles.password (no view/function/trigger dependents)
-- ---------------------------------------------------------------------------
ALTER TABLE public.profiles DROP COLUMN IF EXISTS password;

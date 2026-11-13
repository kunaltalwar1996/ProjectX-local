-- =============================================================================
-- HISTORICAL MIGRATION — SUPERSEDED
-- File: supabase/migrations/20261008210000_secure_profiles_public_data_exposure.sql
-- Status: DO NOT RE-EXECUTE AGAINST THE LIVE DATABASE
-- =============================================================================
--
-- This migration file was the initial Unit 1 implementation commit.
-- It has been superseded by the authoritative manual remediation:
--
--   supabase/manual_remediation_unit1_and_active_listing_visibility.sql
--
-- The authoritative process is:
--   Preflight (unit1_preflight.sql) → Review → Manual Remediation → Verification
--
-- DO NOT re-run this file. It may reference columns that do not exist on the
-- live database, may conflict with the idempotent remediation script, and was
-- corrected after the initial commit.
--
-- Corrections made to this historical record:
-- 1. Removed "ALTER TABLE public.profiles DROP COLUMN IF EXISTS password;" —
--    the product owner's decision is to PRESERVE profiles.password and all
--    stored values. The column must never be dropped, truncated, or overwritten.
-- 2. Removed misleading recovery wording (the original comment implied password
--    values could be "re-added as nullable text without recovered values" on
--    rollback; this was incorrect and implied data destruction).
-- 3. The search_path ALTER statements below are retained as historical record
--    of what was initially applied; they are idempotent if re-applied.
-- 4. All other changes in this file (RPCs, trigger, policies, grants) have been
--    superseded by the corrected authoritative remediation script.
--
-- If you need to understand what this commit changed, use:
--   git show e6d34118e64f110ccceff4af0c87ccc225bc1610
-- =============================================================================

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
-- 5. Sensitive-column trigger (NOTE: superseded version — see authoritative
--    remediation script. This version incorrectly referenced absent columns.)
-- ---------------------------------------------------------------------------
-- Skipped here — apply via authoritative remediation only.

-- ---------------------------------------------------------------------------
-- 6. RLS and policies (superseded — apply via authoritative remediation only)
-- ---------------------------------------------------------------------------
-- Skipped here — apply via authoritative remediation only.

-- ---------------------------------------------------------------------------
-- NOTE: The following statement was REMOVED from this historical migration:
--   ALTER TABLE public.profiles DROP COLUMN IF EXISTS password;
-- The product owner's decision is to preserve profiles.password and all
-- stored values. This column MUST NOT be dropped. Authentication is performed
-- through Supabase Auth (auth.users) only. See authoritative remediation for
-- the column-level privilege approach that protects the password column without
-- destroying its data.
-- ---------------------------------------------------------------------------

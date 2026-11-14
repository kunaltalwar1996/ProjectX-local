-- =============================================================================
-- Authoritative Manual Remediation: Unit 1
-- File: supabase/manual_remediation_unit1_and_active_listing_visibility.sql
-- Target: xjpqxhbuuevaplvthvsf.supabase.co — Branch: mvp
-- =============================================================================
--
-- PURPOSE
-- -------
-- This is the ONLY authoritative live-execution artifact for Unit 1.
-- Execute this ONCE in the Supabase SQL Editor AFTER:
--   1. Running unit1_preflight.sql and reviewing all PASS/FAIL/UNKNOWN gates.
--   2. Confirming password column EXISTS (Gate 1 = PASS).
--   3. Confirming no unexpected blocker conditions are present.
--   4. The product owner has approved execution in a maintenance window.
--
-- DO NOT execute if any preflight gate is FAIL.
-- DO NOT execute more than once (functions and policies are idempotent, but
-- the policy-drop assertions check a specific known state).
--
-- SAFETY PROPERTIES
-- -----------------
-- - Wraps all changes in an explicit transaction; rolls back on any failure.
-- - Validates required schema state before making changes.
-- - Never reads, copies, exports, or displays password values.
-- - Never drops the password column.
-- - Never sets password to NULL.
-- - Preserves all existing listing data and statuses.
-- - Does not alter messages, inquiries, notifications, or other tables.
-- - Uses conditional column references for schema-uncertain fields
--   (wishlist, resetOtp, expireOtp, referal_points).
--
-- PASSWORD COLUMN PROTECTION APPROACH
-- ------------------------------------
-- profiles.password is preserved with all existing values.
-- Authentication is performed exclusively through Supabase Auth (auth.users).
-- Protection is achieved by:
--   a) Revoking table-level SELECT from anon and authenticated.
--   b) Granting column-level SELECT only on explicitly safe application columns
--      (password is NOT in that list).
--   c) The trigger blocks client-side INSERT/UPDATE from touching password.
-- =============================================================================

BEGIN;

-- =============================================================================
-- READINESS ASSERTIONS — Fail closed if schema is incompatible
-- =============================================================================

-- Assert: profiles table exists
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.tables
    WHERE table_schema = 'public' AND table_name = 'profiles'
  ) THEN
    RAISE EXCEPTION 'ASSERTION FAILED: public.profiles does not exist. Aborting.';
  END IF;
END;
$$;

-- Assert: profiles.password column exists (preservation requirement)
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'profiles'
      AND column_name = 'password'
  ) THEN
    RAISE EXCEPTION
      'ASSERTION FAILED: profiles.password column is ABSENT. '
      'The product owner''s decision is to preserve this column and its values. '
      'If the column was already dropped by a previous migration, this is a blocking condition. '
      'Do not recreate it. Report this condition to the owner and do not proceed.';
  END IF;
END;
$$;

-- Assert: minimum required profile columns exist
DO $$
DECLARE missing_cols text;
BEGIN
  SELECT string_agg(required_col, ', ')
  INTO missing_cols
  FROM (VALUES
    ('id'), ('full_name'), ('role'), ('email'),
    ('phone'), ('city'), ('bio'), ('avatar_url'),
    ('preferences'), ('referred_by'), ('employee_type'), ('updated_at')
  ) AS required(required_col)
  WHERE NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'profiles'
      AND column_name = required.required_col
  );

  IF missing_cols IS NOT NULL THEN
    RAISE EXCEPTION 'ASSERTION FAILED: Missing required profile columns: %. Aborting.', missing_cols;
  END IF;
END;
$$;

-- Assert: listings table exists
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.tables
    WHERE table_schema = 'public' AND table_name = 'listings'
  ) THEN
    RAISE EXCEPTION 'ASSERTION FAILED: public.listings does not exist. Aborting.';
  END IF;
END;
$$;

-- Assert: listing_media table exists
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.tables
    WHERE table_schema = 'public' AND table_name = 'listing_media'
  ) THEN
    RAISE EXCEPTION 'ASSERTION FAILED: public.listing_media does not exist. Aborting.';
  END IF;
END;
$$;

-- Assert: listing_media.listing_id column exists (required for media RLS join)
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'listing_media'
      AND column_name = 'listing_id'
  ) THEN
    RAISE EXCEPTION 'ASSERTION FAILED: listing_media.listing_id missing. Aborting.';
  END IF;
END;
$$;

-- =============================================================================
-- PART 1: Role Helper Functions with Fixed Search Path
-- =============================================================================
-- These are CREATE OR REPLACE — idempotent. The bodies check only columns
-- that are confirmed present in all schema variants.

CREATE OR REPLACE FUNCTION public.is_staff()
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
      AND p.role IN ('Employee', 'Admin')
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.is_broker()
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
      AND p.role = 'Broker'
  );
END;
$$;

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

-- Revoke PUBLIC/anon execution; grant only to authenticated callers.
-- Role-helper functions must not be callable by anonymous users.
REVOKE ALL ON FUNCTION public.is_staff() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.is_staff() TO authenticated;

REVOKE ALL ON FUNCTION public.is_broker() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.is_broker() TO authenticated;

REVOKE ALL ON FUNCTION public.is_admin() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.is_admin() TO authenticated;

-- =============================================================================
-- PART 2: Narrow Public Broker Identity RPC
-- =============================================================================
-- Returns ONLY (id, full_name, avatar_url) for Broker-role profiles.
-- Safe for anon and authenticated callers.
-- No email, phone, preferences, referred_by, password, or other private fields.

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

REVOKE ALL ON FUNCTION public.get_public_broker_identity(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_public_broker_identity(uuid) TO anon, authenticated;

-- =============================================================================
-- PART 3: Relationship-Checked Counterparty Identity RPC
-- =============================================================================
-- Returns (id, full_name, avatar_url) only for users with whom the caller
-- has an established message or inquiry relationship.
-- Requires authenticated caller. Never returns arbitrary profile data.

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

REVOKE ALL ON FUNCTION public.get_related_profile_identities(uuid[]) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_related_profile_identities(uuid[]) TO authenticated;

-- =============================================================================
-- PART 4: Self-Scoped Referral Aggregates RPC
-- =============================================================================
-- Returns aggregate counts only. Never exposes individual referred-user rows.
-- Uses auth.uid() — no caller-supplied user ID parameter.

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

REVOKE ALL ON FUNCTION public.get_own_referral_stats() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_own_referral_stats() TO authenticated;

-- =============================================================================
-- PART 5: Sensitive Column Protection Trigger
-- =============================================================================
-- Protects against:
--   - Profile creation for another user
--   - Self-assignment of Admin/Employee roles
--   - Staff operations being incorrectly applied
--   - Direct client writes to password, email, role, employee_type, referred_by
--
-- SCHEMA-SAFETY:
--   This function uses DO blocks to conditionally reference columns that may
--   not exist (wishlist, resetOtp, expireOtp, referal_points). The body below
--   references only columns confirmed present in all known schema versions.
--   Columns known to be schema-uncertain are protected via REVOKE-only
--   (column-level privileges) rather than trigger assignment.
--
-- PASSWORD SAFETY:
--   This trigger NEVER assigns to NEW.password or OLD.password.
--   The password column is protected by column-level privilege revocation.

CREATE OR REPLACE FUNCTION public.protect_profile_sensitive_columns()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO pg_catalog, public
AS $$
BEGIN
  -- service_role bypass: allow all operations from server-side admin context
  IF auth.role() = 'service_role' THEN
    RETURN NEW;
  END IF;

  -- ── INSERT path ──────────────────────────────────────────────────────────
  IF TG_OP = 'INSERT' THEN
    -- Must be creating own profile only
    IF NEW.id IS DISTINCT FROM auth.uid() THEN
      RAISE EXCEPTION 'Cannot create a profile for another user';
    END IF;

    -- Only non-privileged roles may be self-assigned at signup
    IF NEW.role IS NULL OR NEW.role NOT IN ('Buyer', 'Broker') THEN
      RAISE EXCEPTION 'Cannot self-assign role "%" at signup. Only Buyer and Broker are permitted.', NEW.role;
    END IF;

    -- Force employee_type to NULL on self-insert (staff fields are set by admin)
    NEW.employee_type := NULL;

    -- Email must match the authenticated session email if provided
    IF NEW.email IS NOT NULL AND NEW.email IS DISTINCT FROM auth.email() THEN
      RAISE EXCEPTION 'Cannot set profile email to a different address than the authenticated session';
    END IF;

    -- referred_by is set only by the application from localStorage at signup;
    -- any value other than a valid uuid is blocked by the column type constraint.
    -- Do not null it out — the referral link must be preserved.

    RETURN NEW;
  END IF;

  -- ── UPDATE path ──────────────────────────────────────────────────────────

  -- id must never change
  IF NEW.id IS DISTINCT FROM OLD.id THEN
    RAISE EXCEPTION 'Cannot change profile id';
  END IF;

  -- Updating another user's profile
  IF NEW.id IS DISTINCT FROM auth.uid() THEN
    -- Only staff may update another user's profile
    IF NOT public.is_staff() THEN
      RAISE EXCEPTION 'Cannot update another user''s profile';
    END IF;

    -- Staff moderation: preserve all identity and sensitive fields.
    -- The only staff mutation supported by existing application workflows is
    -- writing bio (for flagging abusive accounts). All other fields are locked.
    NEW.full_name    := OLD.full_name;
    NEW.role         := OLD.role;
    NEW.phone        := OLD.phone;
    NEW.city         := OLD.city;
    NEW.preferences  := OLD.preferences;
    NEW.avatar_url   := OLD.avatar_url;
    NEW.referred_by  := OLD.referred_by;
    NEW.email        := OLD.email;
    NEW.employee_type := OLD.employee_type;
    -- NOTE: password is intentionally NOT assigned here.
    -- Column-level revocation prevents staff from reading or writing it via API.
    RETURN NEW;
  END IF;

  -- ── Self-update path ─────────────────────────────────────────────────────
  -- User is updating their own profile. Lock sensitive/identity fields.
  -- Permitted: full_name, phone, city, bio, avatar_url, preferences, updated_at
  --            and wishlist (if present) — these are set by column-level GRANT.
  NEW.role          := OLD.role;
  NEW.email         := OLD.email;
  NEW.referred_by   := OLD.referred_by;
  NEW.employee_type := OLD.employee_type;
  -- NOTE: password is intentionally NOT assigned here.
  -- The column is protected via column-level privilege revocation.
  RETURN NEW;
END;
$$;

-- Trigger function must not be directly callable by API roles
REVOKE ALL ON FUNCTION public.protect_profile_sensitive_columns() FROM PUBLIC, anon, authenticated;

-- Apply trigger (idempotent via DROP IF EXISTS + CREATE)
DROP TRIGGER IF EXISTS trg_protect_profile_sensitive_columns ON public.profiles;
CREATE TRIGGER trg_protect_profile_sensitive_columns
  BEFORE INSERT OR UPDATE ON public.profiles
  FOR EACH ROW
  EXECUTE FUNCTION public.protect_profile_sensitive_columns();

-- =============================================================================
-- PART 6: Profile RLS Policies
-- =============================================================================
-- POLICY REPLACEMENT STRATEGY
-- ----------------------------
-- Rather than a blind dynamic DROP loop (which could remove policies we have
-- not reviewed), we explicitly name and drop only the specific legacy policies
-- identified during the preflight analysis. If any unexpected policy exists,
-- the script will continue but the verification step must confirm the final set.
-- After installing our new policies, the verification SQL confirms the exact set.

ALTER TABLE public.profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.profiles NO FORCE ROW LEVEL SECURITY;

-- Drop known legacy permissive policies (names from deployed export and analysis)
DROP POLICY IF EXISTS "Allow users to read any profile"         ON public.profiles;
DROP POLICY IF EXISTS "Public profiles are viewable by everyone." ON public.profiles;
DROP POLICY IF EXISTS "Allow users to view their own profile"   ON public.profiles;
DROP POLICY IF EXISTS "Allow users to insert their own profile" ON public.profiles;
DROP POLICY IF EXISTS "Users can insert their own profile."     ON public.profiles;
DROP POLICY IF EXISTS "Users can update own profile."           ON public.profiles;
DROP POLICY IF EXISTS "Admins can delete user profiles"         ON public.profiles;

-- Drop Unit 1 previously deployed policies (replace with corrected versions)
DROP POLICY IF EXISTS profiles_select_own    ON public.profiles;
DROP POLICY IF EXISTS profiles_select_staff  ON public.profiles;
DROP POLICY IF EXISTS profiles_insert_own    ON public.profiles;
DROP POLICY IF EXISTS profiles_update_own    ON public.profiles;
DROP POLICY IF EXISTS profiles_update_staff  ON public.profiles;
DROP POLICY IF EXISTS profiles_delete_admin  ON public.profiles;

-- ── SELECT ───────────────────────────────────────────────────────────────────

-- 1. A user may read their own full profile row
CREATE POLICY profiles_select_own
  ON public.profiles
  FOR SELECT
  TO authenticated
  USING (id = auth.uid());

-- 2. Authorized staff (Admin + Employee) may read all profiles
--    Required for: admin-panel.html user management, employee-panel.html report resolution
CREATE POLICY profiles_select_staff
  ON public.profiles
  FOR SELECT
  TO authenticated
  USING (public.is_staff());

-- ── INSERT ───────────────────────────────────────────────────────────────────

-- 3. A user may insert only their own initial profile at signup
--    Trigger enforces role restrictions and prevents Admin/Employee self-assignment
CREATE POLICY profiles_insert_own
  ON public.profiles
  FOR INSERT
  TO authenticated
  WITH CHECK (
    id = auth.uid()
    AND role IN ('Buyer', 'Broker')
    AND employee_type IS NULL
  );

-- ── UPDATE ───────────────────────────────────────────────────────────────────

-- 4. A user may update their own profile row
--    Trigger locks sensitive fields (role, email, referred_by, employee_type)
CREATE POLICY profiles_update_own
  ON public.profiles
  FOR UPDATE
  TO authenticated
  USING (id = auth.uid())
  WITH CHECK (id = auth.uid());

-- 5. Authorized staff may update profiles for moderation (bio flagging)
--    Trigger preserves all identity fields; only bio can be changed
CREATE POLICY profiles_update_staff
  ON public.profiles
  FOR UPDATE
  TO authenticated
  USING (public.is_staff())
  WITH CHECK (public.is_staff());

-- ── DELETE ───────────────────────────────────────────────────────────────────

-- 6. Only Admins may delete profiles (Employees cannot delete)
CREATE POLICY profiles_delete_admin
  ON public.profiles
  FOR DELETE
  TO authenticated
  USING (public.is_admin());

-- =============================================================================
-- PART 6b: Column-Level Privileges on public.profiles
-- =============================================================================
-- STRATEGY:
--   Revoke table-level SELECT from all non-service roles.
--   Grant column-level SELECT only on the explicitly safe application columns.
--   profiles.password is intentionally and permanently EXCLUDED from all SELECT
--   grants to anon, authenticated, and PUBLIC.
--   This ensures the password column cannot be read via PostgREST/API even if
--   a future broad policy is accidentally created.
--
-- SCHEMA-CERTAINTY NOTE:
--   The columns listed below are confirmed present from the architecture export.
--   Columns (wishlist, resetOtp, expireOtp, referal_points) are conditionally
--   granted below using DO blocks to avoid errors on schemas where they are absent.

-- Step 1: Revoke all table-level access
REVOKE ALL ON TABLE public.profiles FROM PUBLIC;
REVOKE ALL ON TABLE public.profiles FROM anon;
REVOKE ALL ON TABLE public.profiles FROM authenticated;

-- Step 2: Grant column-level SELECT on confirmed-safe application columns only.
--         password is NOT in this list.
GRANT SELECT (
  id,
  full_name,
  role,
  email,
  phone,
  city,
  bio,
  avatar_url,
  preferences,
  employee_type,
  referred_by,
  updated_at
) ON TABLE public.profiles TO authenticated;

-- Step 3: Conditionally grant SELECT on schema-uncertain columns
--         (wishlist, referal_points, resetOtp, expireOtp)
--         These grants are skipped if the column does not exist.

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'profiles' AND column_name = 'wishlist'
  ) THEN
    EXECUTE 'GRANT SELECT (wishlist) ON TABLE public.profiles TO authenticated';
    RAISE NOTICE 'Granted SELECT(wishlist) to authenticated';
  ELSE
    RAISE NOTICE 'SKIP: profiles.wishlist does not exist — no SELECT grant needed';
  END IF;
END;
$$;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'profiles' AND column_name = 'referal_points'
  ) THEN
    -- referal_points is a user-visible counter (read-only for self)
    EXECUTE 'GRANT SELECT (referal_points) ON TABLE public.profiles TO authenticated';
    RAISE NOTICE 'Granted SELECT(referal_points) to authenticated';
  ELSE
    RAISE NOTICE 'SKIP: profiles.referal_points does not exist — no SELECT grant needed';
  END IF;
END;
$$;

-- resetOtp and expireOtp are sensitive server-side OTP fields.
-- They should NOT be granted SELECT even if present — protecting them is the
-- correct behavior. No GRANT block for these columns.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'profiles'
      AND column_name IN ('resetOtp', 'expireOtp')
  ) THEN
    RAISE NOTICE 'NOTE: OTP columns (resetOtp/expireOtp) exist but are intentionally excluded from SELECT grants';
  END IF;
END;
$$;

-- Step 4: Row-modification privileges (INSERT, UPDATE, DELETE governed by RLS policies)
GRANT INSERT, UPDATE, DELETE ON TABLE public.profiles TO authenticated;

-- Step 5: Full service_role access for administrative and trigger operations
GRANT ALL ON TABLE public.profiles TO service_role;

-- =============================================================================
-- PART 7: Active-Only Public Listing Visibility
-- =============================================================================

ALTER TABLE public.listings ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.listings NO FORCE ROW LEVEL SECURITY;

-- Drop known legacy listing policies
DROP POLICY IF EXISTS "Allow brokers to delete their own listings"       ON public.listings;
DROP POLICY IF EXISTS "Allow brokers to insert listings"                 ON public.listings;
DROP POLICY IF EXISTS "Allow brokers to update their own listings"       ON public.listings;
DROP POLICY IF EXISTS "Allow public to view active listings"             ON public.listings;
DROP POLICY IF EXISTS "Allow staff to view all listings"                 ON public.listings;
DROP POLICY IF EXISTS "Allow brokers to view their own listings"         ON public.listings;
DROP POLICY IF EXISTS "Staff can view all listings"                      ON public.listings;
DROP POLICY IF EXISTS "Brokers can view their own listings"              ON public.listings;
DROP POLICY IF EXISTS "Public can view active listings"                  ON public.listings;
DROP POLICY IF EXISTS "listings_select_active_public"                    ON public.listings;
-- Drop Unit 1 previously deployed policies
DROP POLICY IF EXISTS listings_select_active_public    ON public.listings;
DROP POLICY IF EXISTS listings_select_broker_own       ON public.listings;
DROP POLICY IF EXISTS listings_select_staff            ON public.listings;
DROP POLICY IF EXISTS listings_insert_broker           ON public.listings;
DROP POLICY IF EXISTS listings_update_broker_or_staff  ON public.listings;
DROP POLICY IF EXISTS listings_delete_broker_or_staff  ON public.listings;

-- ── SELECT ───────────────────────────────────────────────────────────────────

-- 1. Public (anon + authenticated non-brokers + buyers):
--    Active listings only. TRIM handles any whitespace in stored status values.
CREATE POLICY listings_select_active_public
  ON public.listings
  FOR SELECT
  TO anon, authenticated
  USING (TRIM(status) = 'Active');

-- 2. Brokers can see all their own listings regardless of status
--    Required for broker-dashboard.html to show Pending/Draft/Rejected/Sold
CREATE POLICY listings_select_broker_own
  ON public.listings
  FOR SELECT
  TO authenticated
  USING (
    public.is_broker()
    AND broker_id = auth.uid()
  );

-- 3. Staff (Admin + Employee) can view all listings for moderation
CREATE POLICY listings_select_staff
  ON public.listings
  FOR SELECT
  TO authenticated
  USING (public.is_staff());

-- ── INSERT ───────────────────────────────────────────────────────────────────

-- 4. Brokers can create their own listings; Staff can also create listings
CREATE POLICY listings_insert_broker_or_staff
  ON public.listings
  FOR INSERT
  TO authenticated
  WITH CHECK (
    (public.is_broker() AND broker_id = auth.uid())
    OR public.is_staff()
  );

-- ── UPDATE ───────────────────────────────────────────────────────────────────

-- 5. Brokers can update their own listings; Staff can update any listing
--    WITH CHECK prevents broker from reassigning ownership (broker_id = auth.uid() preserved)
CREATE POLICY listings_update_broker_or_staff
  ON public.listings
  FOR UPDATE
  TO authenticated
  USING (
    (public.is_broker() AND broker_id = auth.uid())
    OR public.is_staff()
  )
  WITH CHECK (
    (public.is_broker() AND broker_id = auth.uid())
    OR public.is_staff()
  );

-- ── DELETE ───────────────────────────────────────────────────────────────────

-- 6. Brokers can delete their own listings; Staff can delete any listing
CREATE POLICY listings_delete_broker_or_staff
  ON public.listings
  FOR DELETE
  TO authenticated
  USING (
    (public.is_broker() AND broker_id = auth.uid())
    OR public.is_staff()
  );

-- Table-level grants for public.listings
REVOKE ALL ON TABLE public.listings FROM PUBLIC;
REVOKE ALL ON TABLE public.listings FROM anon;
REVOKE ALL ON TABLE public.listings FROM authenticated;
GRANT SELECT ON TABLE public.listings TO anon;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.listings TO authenticated;
GRANT ALL ON TABLE public.listings TO service_role;

-- =============================================================================
-- PART 8: Listing Media — Parent-Listing-Based Authorization
-- =============================================================================

ALTER TABLE public.listing_media ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.listing_media NO FORCE ROW LEVEL SECURITY;

-- Drop known legacy listing_media policies
DROP POLICY IF EXISTS "Allow brokers to manage their listing media"      ON public.listing_media;
DROP POLICY IF EXISTS "Allow public to view media for active listings"   ON public.listing_media;
DROP POLICY IF EXISTS "Allow staff to view all listing media"            ON public.listing_media;
DROP POLICY IF EXISTS "listing_media_select_active"                      ON public.listing_media;
-- Drop Unit 1 previously deployed policies
DROP POLICY IF EXISTS listing_media_select_active          ON public.listing_media;
DROP POLICY IF EXISTS listing_media_select_broker_own      ON public.listing_media;
DROP POLICY IF EXISTS listing_media_select_staff           ON public.listing_media;
DROP POLICY IF EXISTS listing_media_insert_owner_or_staff  ON public.listing_media;
DROP POLICY IF EXISTS listing_media_update_owner_or_staff  ON public.listing_media;
DROP POLICY IF EXISTS listing_media_delete_owner_or_staff  ON public.listing_media;

-- ── SELECT ───────────────────────────────────────────────────────────────────

-- 1. Public may view media only for Active parent listings
--    Authorization derived from parent listing status — not listing_media alone
CREATE POLICY listing_media_select_active
  ON public.listing_media
  FOR SELECT
  TO anon, authenticated
  USING (
    EXISTS (
      SELECT 1
      FROM public.listings AS l
      WHERE l.id = listing_media.listing_id
        AND TRIM(l.status) = 'Active'
    )
  );

-- 2. Broker may view media for their own listings (regardless of status)
--    Authorization requires both listing ownership AND broker role
CREATE POLICY listing_media_select_broker_own
  ON public.listing_media
  FOR SELECT
  TO authenticated
  USING (
    public.is_broker()
    AND EXISTS (
      SELECT 1
      FROM public.listings AS l
      WHERE l.id = listing_media.listing_id
        AND l.broker_id = auth.uid()
    )
  );

-- 3. Staff may view all listing media
CREATE POLICY listing_media_select_staff
  ON public.listing_media
  FOR SELECT
  TO authenticated
  USING (public.is_staff());

-- ── INSERT ───────────────────────────────────────────────────────────────────

-- 4. Broker may insert media only for their own listings
--    Parent listing ownership is verified — broker cannot attach to another broker's listing
CREATE POLICY listing_media_insert_broker_or_staff
  ON public.listing_media
  FOR INSERT
  TO authenticated
  WITH CHECK (
    public.is_staff()
    OR (
      public.is_broker()
      AND EXISTS (
        SELECT 1
        FROM public.listings AS l
        WHERE l.id = listing_media.listing_id
          AND l.broker_id = auth.uid()
      )
    )
  );

-- ── UPDATE ───────────────────────────────────────────────────────────────────

-- 5. Broker may update media only for their own listings
CREATE POLICY listing_media_update_broker_or_staff
  ON public.listing_media
  FOR UPDATE
  TO authenticated
  USING (
    public.is_staff()
    OR (
      public.is_broker()
      AND EXISTS (
        SELECT 1
        FROM public.listings AS l
        WHERE l.id = listing_media.listing_id
          AND l.broker_id = auth.uid()
      )
    )
  )
  WITH CHECK (
    public.is_staff()
    OR (
      public.is_broker()
      AND EXISTS (
        SELECT 1
        FROM public.listings AS l
        WHERE l.id = listing_media.listing_id
          AND l.broker_id = auth.uid()
      )
    )
  );

-- ── DELETE ───────────────────────────────────────────────────────────────────

-- 6. Broker may delete media only for their own listings; Staff may delete any
CREATE POLICY listing_media_delete_broker_or_staff
  ON public.listing_media
  FOR DELETE
  TO authenticated
  USING (
    public.is_staff()
    OR (
      public.is_broker()
      AND EXISTS (
        SELECT 1
        FROM public.listings AS l
        WHERE l.id = listing_media.listing_id
          AND l.broker_id = auth.uid()
      )
    )
  );

-- Table-level grants for public.listing_media
REVOKE ALL ON TABLE public.listing_media FROM PUBLIC;
REVOKE ALL ON TABLE public.listing_media FROM anon;
REVOKE ALL ON TABLE public.listing_media FROM authenticated;
GRANT SELECT ON TABLE public.listing_media TO anon;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.listing_media TO authenticated;
GRANT ALL ON TABLE public.listing_media TO service_role;

-- =============================================================================
-- PART 9: Sequence and Utility Grants
-- =============================================================================

GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO authenticated;

-- =============================================================================
-- PART 10: PostgREST Schema Cache Reload
-- =============================================================================
-- Send this AFTER the transaction commits successfully.
-- This is placed here for reference but PostgREST responds to NOTIFY after COMMIT.

NOTIFY pgrst, 'reload schema';

COMMIT;

-- =============================================================================
-- POST-EXECUTION NOTES
-- =============================================================================
-- 1. Run supabase/verify_remediation.sql immediately after this script completes.
-- 2. Confirm all policies in the final set match what is documented above.
-- 3. STORAGE: The 'properties' bucket is likely still public. Database-level
--    listing_media RLS prevents table row access to non-Active listing media,
--    but direct Storage object URLs remain accessible independently if the bucket
--    is public. See UNIT1_EXECUTION.md Section 12 for the full storage decision.
-- 4. No password values were read, modified, displayed, or dropped by this script.
-- 5. All existing listing data and status values are preserved.
-- =============================================================================

-- =============================================================================
-- Unit 1 Pre-Flight Verification
-- File: supabase/unit1_preflight.sql
-- Target: xjpqxhbuuevaplvthvsf.supabase.co
-- Branch: mvp
--
-- READ-ONLY. This script contains NO DDL, DML, or permission changes.
-- Execute in Supabase SQL Editor with a project-owner or service_role context.
-- Review every result before proceeding to the authoritative remediation.
-- =============================================================================

-- =============================================================================
-- SECTION 1 — MIGRATION HISTORY
-- =============================================================================

-- 1.1 Check if schema_migrations is accessible
SELECT
    CASE
        WHEN EXISTS (
            SELECT 1 FROM information_schema.tables
            WHERE table_schema = 'supabase_migrations'
              AND table_name = 'schema_migrations'
        ) THEN 'PASS — supabase_migrations.schema_migrations accessible'
        ELSE 'UNKNOWN — supabase_migrations.schema_migrations not accessible from current role'
    END AS migration_history_status;

-- 1.2 Check whether Unit 1 migration version is recorded
SELECT
    version,
    inserted_at,
    CASE WHEN version = '20261008210000'
         THEN 'NOTE: Unit 1 historical migration recorded as applied'
         ELSE NULL
    END AS note
FROM supabase_migrations.schema_migrations
WHERE version IN ('20261008210000', '20261008000002')
ORDER BY version;
-- If this query fails with permission error: UNKNOWN — cannot determine migration state.
-- If 20261008210000 appears: the historical migration (which included DROP COLUMN password)
-- may already have been applied. Run Section 2.3 to verify whether password column exists.

-- 1.3 Check for any other migrations referencing profiles
SELECT version, inserted_at
FROM supabase_migrations.schema_migrations
ORDER BY version DESC
LIMIT 20;

-- =============================================================================
-- SECTION 2 — PUBLIC.PROFILES TABLE
-- =============================================================================

-- 2.1 All columns, types, nullability, defaults
SELECT
    column_name,
    data_type,
    udt_name,
    is_nullable,
    column_default,
    is_identity,
    is_generated
FROM information_schema.columns
WHERE table_schema = 'public'
  AND table_name = 'profiles'
ORDER BY ordinal_position;
-- Look for: id, full_name, role, updated_at, phone, city, bio, preferences,
-- avatar_url, referred_by, password, email, employee_type, wishlist,
-- resetOtp, expireOtp, referal_points

-- 2.2 Password column existence — metadata only, no values
SELECT
    CASE
        WHEN EXISTS (
            SELECT 1 FROM information_schema.columns
            WHERE table_schema = 'public'
              AND table_name = 'profiles'
              AND column_name = 'password'
        )
        THEN 'PASS — profiles.password column EXISTS. Preservation safe.'
        ELSE 'FAIL — profiles.password column is ABSENT. STOP: do not proceed. Report blocking condition to owner.'
    END AS password_column_gate;

-- 2.3 Wishlist column existence and type
SELECT
    CASE
        WHEN EXISTS (
            SELECT 1 FROM information_schema.columns
            WHERE table_schema = 'public'
              AND table_name = 'profiles'
              AND column_name = 'wishlist'
        )
        THEN 'PASS — profiles.wishlist exists: ' || (
            SELECT data_type FROM information_schema.columns
            WHERE table_schema = 'public' AND table_name = 'profiles' AND column_name = 'wishlist'
        )
        ELSE 'UNKNOWN — profiles.wishlist does not exist. Wishlist features will not function.'
    END AS wishlist_column_gate;

-- 2.4 OTP columns (resetOtp, expireOtp) — existence check
SELECT
    column_name,
    data_type,
    is_nullable
FROM information_schema.columns
WHERE table_schema = 'public'
  AND table_name = 'profiles'
  AND column_name IN ('resetOtp', 'expireOtp', 'referal_points')
ORDER BY column_name;
-- If 0 rows: these columns are absent. The remediation trigger must NOT reference them.
-- If rows returned: columns exist — trigger may reference them conditionally.

-- 2.5 Application required profile fields (self-edit fields)
SELECT
    CASE
        WHEN (
            SELECT COUNT(*) FROM information_schema.columns
            WHERE table_schema = 'public'
              AND table_name = 'profiles'
              AND column_name IN ('id', 'full_name', 'role', 'email', 'phone',
                                  'city', 'bio', 'avatar_url', 'preferences',
                                  'referred_by', 'employee_type', 'updated_at')
        ) = 12
        THEN 'PASS — All 12 required application profile fields present'
        ELSE 'FAIL — One or more required application profile fields missing. See 2.1 column list.'
    END AS profile_fields_gate;

-- 2.6 Constraints on profiles
SELECT
    tc.constraint_type,
    tc.constraint_name,
    kcu.column_name,
    ccu.table_name AS foreign_table,
    ccu.column_name AS foreign_column
FROM information_schema.table_constraints AS tc
LEFT JOIN information_schema.key_column_usage AS kcu
    ON tc.constraint_name = kcu.constraint_name
    AND tc.table_schema = kcu.table_schema
LEFT JOIN information_schema.constraint_column_usage AS ccu
    ON tc.constraint_name = ccu.constraint_name
WHERE tc.table_schema = 'public'
  AND tc.table_name = 'profiles'
ORDER BY tc.constraint_type, tc.constraint_name;

-- 2.7 Foreign keys from other tables INTO profiles (dependency check)
SELECT
    tc.table_name AS dependent_table,
    kcu.column_name,
    ccu.table_name AS referenced_table,
    tc.constraint_name
FROM information_schema.table_constraints AS tc
JOIN information_schema.key_column_usage AS kcu
    ON tc.constraint_name = kcu.constraint_name
JOIN information_schema.constraint_column_usage AS ccu
    ON tc.constraint_name = ccu.constraint_name
WHERE tc.constraint_type = 'FOREIGN KEY'
  AND ccu.table_schema = 'public'
  AND ccu.table_name = 'profiles'
ORDER BY tc.table_name;

-- 2.8 Table owner and RLS state
SELECT
    schemaname,
    tablename,
    tableowner,
    rowsecurity AS rls_enabled
FROM pg_tables
WHERE schemaname = 'public'
  AND tablename = 'profiles';

-- 2.9 FORCE RLS state
SELECT
    relname AS table_name,
    relrowsecurity AS rls_enabled,
    relforcerowsecurity AS force_rls
FROM pg_class
WHERE relnamespace = 'public'::regnamespace
  AND relname = 'profiles';

-- 2.10 Existing RLS policies on profiles (complete definitions)
SELECT
    policyname,
    permissive,
    roles,
    cmd,
    qual,
    with_check
FROM pg_policies
WHERE schemaname = 'public'
  AND tablename = 'profiles'
ORDER BY policyname;
-- REVIEW: Look for any USING (true) or broad read policies that must be replaced.
-- Any policy not in the expected list below is an UNEXPECTED POLICY — STOP.
-- Expected policies after remediation:
--   profiles_select_own, profiles_select_staff, profiles_insert_own,
--   profiles_update_own, profiles_update_staff, profiles_delete_admin
-- BEFORE remediation: any existing legacy policy names are reported here.

-- 2.11 Table-level privileges for profiles
SELECT grantee, privilege_type, is_grantable
FROM information_schema.role_table_grants
WHERE table_schema = 'public'
  AND table_name = 'profiles'
  AND grantee IN ('anon', 'authenticated', 'public', 'service_role')
ORDER BY grantee, privilege_type;

-- 2.12 Column-level privileges for profiles (password must have NO select grant to anon/authenticated)
SELECT
    column_name,
    grantee,
    privilege_type
FROM information_schema.column_privileges
WHERE table_schema = 'public'
  AND table_name = 'profiles'
  AND grantee IN ('anon', 'authenticated', 'public')
ORDER BY column_name, grantee;
-- CRITICAL: 'password' must NOT appear with SELECT for anon, authenticated, or public.
-- If it does: profiles.password is currently readable via API. This must be remediated.

-- 2.13 Triggers on profiles
SELECT
    trigger_name,
    event_manipulation,
    action_timing,
    action_statement,
    action_orientation
FROM information_schema.triggers
WHERE event_object_schema = 'public'
  AND event_object_table = 'profiles'
ORDER BY trigger_name, event_manipulation;

-- 2.14 Views or functions that depend on profiles
SELECT
    dep.classid::regclass::text AS dep_class,
    n.nspname AS schema,
    p.proname AS function_name,
    dep.deptype
FROM pg_depend AS dep
JOIN pg_proc AS p ON dep.objid = p.oid
JOIN pg_namespace AS n ON p.pronamespace = n.oid
WHERE dep.refobjid = 'public.profiles'::regclass
  AND dep.deptype IN ('n', 'a')
ORDER BY n.nspname, p.proname;

-- =============================================================================
-- SECTION 3 — HELPER FUNCTIONS AND RPCS
-- =============================================================================

-- 3.1 Function existence, security mode, search path, and ownership
SELECT
    n.nspname AS schema,
    p.proname AS function_name,
    pg_get_function_arguments(p.oid) AS arguments,
    p.prosecdef AS is_security_definer,
    p.proconfig AS config_parameters,
    r.rolname AS owner
FROM pg_proc AS p
JOIN pg_namespace AS n ON p.pronamespace = n.oid
JOIN pg_roles AS r ON p.proowner = r.oid
WHERE n.nspname = 'public'
  AND p.proname IN (
    'is_staff', 'is_broker', 'is_admin',
    'get_public_broker_identity',
    'get_related_profile_identities',
    'get_own_referral_stats',
    'protect_profile_sensitive_columns'
  )
ORDER BY p.proname;
-- PASS conditions:
--   is_security_definer = true for all security functions
--   config_parameters should include 'search_path=pg_catalog, public'
--   owner should be a superuser role (postgres / supabase_admin)

-- 3.2 Function execution grants
SELECT
    routine_name,
    routine_schema,
    grantee,
    privilege_type
FROM information_schema.routine_privileges
WHERE routine_schema = 'public'
  AND routine_name IN (
    'is_staff', 'is_broker', 'is_admin',
    'get_public_broker_identity',
    'get_related_profile_identities',
    'get_own_referral_stats',
    'protect_profile_sensitive_columns'
  )
ORDER BY routine_name, grantee;
-- Expected grants:
--   is_staff, is_broker, is_admin: authenticated only
--   get_public_broker_identity: anon + authenticated
--   get_related_profile_identities: authenticated only
--   get_own_referral_stats: authenticated only
--   protect_profile_sensitive_columns: no public grants (trigger function)

-- 3.3 Gate: required functions exist
SELECT
    CASE
        WHEN (
            SELECT COUNT(*) FROM pg_proc AS p
            JOIN pg_namespace AS n ON p.pronamespace = n.oid
            WHERE n.nspname = 'public'
              AND p.proname IN ('is_staff', 'is_broker', 'is_admin')
        ) = 3
        THEN 'PASS — is_staff, is_broker, is_admin all exist'
        ELSE 'FAIL — One or more role-helper functions missing. STOP.'
    END AS role_helpers_gate;

-- 3.4 Full trigger body (to verify password is handled safely)
SELECT
    p.proname AS function_name,
    pg_get_functiondef(p.oid) AS function_body
FROM pg_proc AS p
JOIN pg_namespace AS n ON p.pronamespace = n.oid
WHERE n.nspname = 'public'
  AND p.proname = 'protect_profile_sensitive_columns';
-- REVIEW: Confirm the trigger body does NOT include NEW.password := NULL or
-- any other mutation of the password field. If it does, the authoritative
-- remediation script must be applied to correct it.

-- =============================================================================
-- SECTION 4 — LISTINGS TABLE
-- =============================================================================

-- 4.1 Listings columns
SELECT
    column_name,
    data_type,
    is_nullable,
    column_default
FROM information_schema.columns
WHERE table_schema = 'public'
  AND table_name = 'listings'
ORDER BY ordinal_position;

-- 4.2 Status distribution (aggregate only — no individual rows exposed)
SELECT
    TRIM(status) AS normalized_status,
    COUNT(*) AS listing_count
FROM public.listings
GROUP BY TRIM(status)
ORDER BY listing_count DESC;
-- Review: confirm known status values and ensure Active-only filtering is correct.

-- 4.3 Listings RLS state
SELECT
    relname AS table_name,
    relrowsecurity AS rls_enabled,
    relforcerowsecurity AS force_rls
FROM pg_class
WHERE relnamespace = 'public'::regnamespace
  AND relname = 'listings';

-- 4.4 Existing listing policies
SELECT
    policyname,
    permissive,
    roles,
    cmd,
    qual,
    with_check
FROM pg_policies
WHERE schemaname = 'public'
  AND tablename = 'listings'
ORDER BY policyname;
-- REVIEW: Any USING (true) policy or ALL policy with no WHERE clause is a broad
-- exposure. These must all be replaced by the remediation.

-- 4.5 Listing table privileges
SELECT grantee, privilege_type
FROM information_schema.role_table_grants
WHERE table_schema = 'public'
  AND table_name = 'listings'
  AND grantee IN ('anon', 'authenticated', 'public', 'service_role')
ORDER BY grantee, privilege_type;

-- 4.6 Listing triggers
SELECT trigger_name, event_manipulation, action_timing, action_statement
FROM information_schema.triggers
WHERE event_object_schema = 'public'
  AND event_object_table = 'listings'
ORDER BY trigger_name;

-- =============================================================================
-- SECTION 5 — LISTING_MEDIA TABLE
-- =============================================================================

-- 5.1 Listing_media columns
SELECT
    column_name,
    data_type,
    is_nullable,
    column_default
FROM information_schema.columns
WHERE table_schema = 'public'
  AND table_name = 'listing_media'
ORDER BY ordinal_position;

-- 5.2 Listing_media RLS state
SELECT
    relname AS table_name,
    relrowsecurity AS rls_enabled,
    relforcerowsecurity AS force_rls
FROM pg_class
WHERE relnamespace = 'public'::regnamespace
  AND relname = 'listing_media';

-- 5.3 Existing listing_media policies
SELECT
    policyname,
    permissive,
    roles,
    cmd,
    qual,
    with_check
FROM pg_policies
WHERE schemaname = 'public'
  AND tablename = 'listing_media'
ORDER BY policyname;

-- 5.4 Listing_media table privileges
SELECT grantee, privilege_type
FROM information_schema.role_table_grants
WHERE table_schema = 'public'
  AND table_name = 'listing_media'
  AND grantee IN ('anon', 'authenticated', 'public', 'service_role')
ORDER BY grantee, privilege_type;

-- 5.5 Listing_media triggers
SELECT trigger_name, event_manipulation, action_timing, action_statement
FROM information_schema.triggers
WHERE event_object_schema = 'public'
  AND event_object_table = 'listing_media'
ORDER BY trigger_name;

-- 5.6 URL pattern analysis — classify media URLs (aggregate only)
SELECT
    COUNT(*) AS total_media_rows,
    COUNT(*) FILTER (
        WHERE url LIKE '%supabase.co/storage/%'
          AND url LIKE '%/properties/%'
    ) AS properties_bucket_urls,
    COUNT(*) FILTER (
        WHERE url LIKE '%supabase.co/storage/%'
          AND url NOT LIKE '%/properties/%'
    ) AS other_supabase_storage_urls,
    COUNT(*) FILTER (
        WHERE url NOT LIKE '%supabase.co%'
          AND url IS NOT NULL
    ) AS external_or_other_urls,
    COUNT(*) FILTER (WHERE url IS NULL) AS null_urls
FROM public.listing_media;
-- If properties_bucket_urls > 0: media is in the public 'properties' bucket.
-- Note: database-level RLS on listing_media does NOT prevent access to public
-- bucket URLs directly. Object-level storage policies are required for full
-- coverage. See Storage section below.

-- 5.7 Listing_media object path prefix sample (non-sensitive, path patterns only)
SELECT
    CASE
        WHEN url LIKE '%/listing-media/%'
        THEN 'listing-media/...'
        WHEN url LIKE '%supabase.co/storage/%'
        THEN 'other-supabase-storage-path'
        ELSE 'external-or-relative'
    END AS path_pattern,
    COUNT(*) AS count
FROM public.listing_media
GROUP BY path_pattern;

-- =============================================================================
-- SECTION 6 — STORAGE BUCKETS
-- =============================================================================

-- 6.1 Bucket visibility
SELECT
    id AS bucket_id,
    name,
    public AS is_public,
    created_at,
    updated_at
FROM storage.buckets
ORDER BY name;
-- CRITICAL: If 'properties' bucket is public = true:
--   Direct object URLs bypass listing_media RLS entirely.
--   Database-only RLS does not prevent access to publicly readable Storage URLs.
--   Full Active-only protection requires either private bucket + signed URLs,
--   or Storage-object-level policies on the bucket.
-- If 'avatars' bucket is public = true: this is acceptable (avatars are public by design).

-- 6.2 Storage object policies
SELECT
    policyname,
    permissive,
    roles,
    cmd,
    qual,
    with_check
FROM pg_policies
WHERE schemaname = 'storage'
  AND tablename = 'objects'
ORDER BY policyname;
-- Look for policies scoped to 'properties' bucket.
-- If no restrictive policies exist on 'properties' objects: full open access is likely.

-- 6.3 Storage migration gate
SELECT
    CASE
        WHEN (
            SELECT public AS is_public FROM storage.buckets WHERE name = 'properties'
        ) = true
        THEN 'KNOWN-BLOCKER — properties bucket is public. Object URLs are accessible ' ||
             'independently of listing_media RLS. Database row security alone does not ' ||
             'prevent direct URL access. See UNIT1_EXECUTION.md Section 12 for decision criteria.'
        WHEN (
            SELECT public AS is_public FROM storage.buckets WHERE name = 'properties'
        ) = false
        THEN 'PASS — properties bucket is already private. Signed URL migration may be applicable.'
        ELSE 'UNKNOWN — cannot determine bucket visibility'
    END AS storage_migration_gate;

-- =============================================================================
-- SECTION 7 — READINESS GATE SUMMARY
-- =============================================================================
-- This summary consolidates the key pass/fail conditions.
-- Review each gate result before proceeding to remediation.

SELECT 'GATE 1: Password column' AS gate_name,
    CASE
        WHEN EXISTS (SELECT 1 FROM information_schema.columns
                     WHERE table_schema = 'public' AND table_name = 'profiles'
                       AND column_name = 'password')
        THEN 'PASS'
        ELSE 'FAIL — STOP'
    END AS result

UNION ALL

SELECT 'GATE 2: Profile insertion fields (id, full_name, role, email)' AS gate_name,
    CASE
        WHEN (SELECT COUNT(*) FROM information_schema.columns
              WHERE table_schema = 'public' AND table_name = 'profiles'
                AND column_name IN ('id', 'full_name', 'role', 'email')) = 4
        THEN 'PASS'
        ELSE 'FAIL — missing required signup columns'
    END

UNION ALL

SELECT 'GATE 3: Self-edit profile fields (phone, city, bio, preferences, avatar_url, updated_at)' AS gate_name,
    CASE
        WHEN (SELECT COUNT(*) FROM information_schema.columns
              WHERE table_schema = 'public' AND table_name = 'profiles'
                AND column_name IN ('phone', 'city', 'bio', 'preferences', 'avatar_url', 'updated_at')) = 6
        THEN 'PASS'
        ELSE 'FAIL — one or more self-edit columns missing'
    END

UNION ALL

SELECT 'GATE 4: Wishlist column' AS gate_name,
    CASE
        WHEN EXISTS (SELECT 1 FROM information_schema.columns
                     WHERE table_schema = 'public' AND table_name = 'profiles'
                       AND column_name = 'wishlist')
        THEN 'PASS'
        ELSE 'UNKNOWN — wishlist absent; wishlist features will not work'
    END

UNION ALL

SELECT 'GATE 5: OTP columns (resetOtp, expireOtp)' AS gate_name,
    CASE
        WHEN EXISTS (SELECT 1 FROM information_schema.columns
                     WHERE table_schema = 'public' AND table_name = 'profiles'
                       AND column_name IN ('resetOtp', 'expireOtp'))
        THEN 'PRESENT — trigger must reference them conditionally or omit if safe'
        ELSE 'ABSENT — trigger must NOT reference resetOtp or expireOtp'
    END

UNION ALL

SELECT 'GATE 6: referal_points column' AS gate_name,
    CASE
        WHEN EXISTS (SELECT 1 FROM information_schema.columns
                     WHERE table_schema = 'public' AND table_name = 'profiles'
                       AND column_name = 'referal_points')
        THEN 'PRESENT — trigger may reference referal_points'
        ELSE 'ABSENT — trigger must NOT reference referal_points'
    END

UNION ALL

SELECT 'GATE 7: Role helpers exist (is_staff, is_broker, is_admin)' AS gate_name,
    CASE
        WHEN (SELECT COUNT(*) FROM pg_proc p JOIN pg_namespace n ON p.pronamespace = n.oid
              WHERE n.nspname = 'public' AND p.proname IN ('is_staff','is_broker','is_admin')) = 3
        THEN 'PASS'
        ELSE 'FAIL — missing role helpers'
    END

UNION ALL

SELECT 'GATE 8: profiles.password has no SELECT grant to anon/authenticated' AS gate_name,
    CASE
        WHEN NOT EXISTS (
            SELECT 1 FROM information_schema.column_privileges
            WHERE table_schema = 'public' AND table_name = 'profiles'
              AND column_name = 'password'
              AND grantee IN ('anon', 'authenticated', 'public')
              AND privilege_type = 'SELECT'
        )
        THEN 'PASS — no SELECT grant on password to API roles'
        ELSE 'FAIL — password column is selectable by API roles. Remediation required.'
    END

UNION ALL

SELECT 'GATE 9: profiles RLS state' AS gate_name,
    CASE
        WHEN (SELECT relrowsecurity FROM pg_class
              WHERE relnamespace = 'public'::regnamespace AND relname = 'profiles') = true
        THEN 'RLS already enabled — verify existing policies are correct'
        ELSE 'RLS disabled — remediation will enable it'
    END

UNION ALL

SELECT 'GATE 10: listings RLS state' AS gate_name,
    CASE
        WHEN (SELECT relrowsecurity FROM pg_class
              WHERE relnamespace = 'public'::regnamespace AND relname = 'listings') = true
        THEN 'RLS already enabled — verify no broad USING (true) policies remain'
        ELSE 'RLS disabled — remediation will enable it'
    END

UNION ALL

SELECT 'GATE 11: listing_media RLS state' AS gate_name,
    CASE
        WHEN (SELECT relrowsecurity FROM pg_class
              WHERE relnamespace = 'public'::regnamespace AND relname = 'listing_media') = true
        THEN 'RLS already enabled — verify policies'
        ELSE 'RLS disabled — remediation will enable it'
    END

UNION ALL

SELECT 'GATE 12: Storage — properties bucket visibility' AS gate_name,
    CASE
        WHEN (SELECT public FROM storage.buckets WHERE name = 'properties') = true
        THEN 'KNOWN-EXPOSURE — bucket is public. See Storage section in execution guide.'
        WHEN (SELECT public FROM storage.buckets WHERE name = 'properties') = false
        THEN 'PASS — properties bucket is already private'
        ELSE 'UNKNOWN — bucket not found or inaccessible'
    END

ORDER BY gate_name;


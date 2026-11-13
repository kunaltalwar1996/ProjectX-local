-- =============================================================================
-- Unit 1 Post-Remediation Verification
-- File: supabase/verify_remediation.sql
-- Target: xjpqxhbuuevaplvthvsf.supabase.co — Branch: mvp
--
-- READ-ONLY. No DDL, DML, or permission changes.
-- Execute AFTER manual_remediation_unit1_and_active_listing_visibility.sql
-- has completed successfully in the Supabase SQL Editor.
-- =============================================================================

-- =============================================================================
-- SECTION A — DATABASE CATALOG VERIFICATION
-- (Run immediately after the remediation transaction commits)
-- =============================================================================

-- ---------------------------------------------------------------------------
-- A1. Confirm RLS is enabled on all three security-critical tables
-- ---------------------------------------------------------------------------
SELECT
    relname AS table_name,
    relrowsecurity AS rls_enabled,
    relforcerowsecurity AS force_rls_enabled
FROM pg_class
WHERE relnamespace = 'public'::regnamespace
  AND relname IN ('profiles', 'listings', 'listing_media')
ORDER BY relname;
-- EXPECTED: rls_enabled = true for all three. force_rls_enabled = false (normal).
-- FAIL if any table shows rls_enabled = false.

-- ---------------------------------------------------------------------------
-- A2. Confirm password column was NOT dropped (preservation requirement)
-- ---------------------------------------------------------------------------
SELECT
    CASE
        WHEN EXISTS (
            SELECT 1 FROM information_schema.columns
            WHERE table_schema = 'public'
              AND table_name = 'profiles'
              AND column_name = 'password'
        )
        THEN 'PASS — profiles.password column preserved'
        ELSE 'FAIL — profiles.password column is missing. This violates the preservation requirement.'
    END AS password_preservation_check;

-- ---------------------------------------------------------------------------
-- A3. All profiles columns (verify no structural change was made)
-- ---------------------------------------------------------------------------
SELECT
    column_name,
    data_type,
    udt_name,
    is_nullable
FROM information_schema.columns
WHERE table_schema = 'public'
  AND table_name = 'profiles'
ORDER BY ordinal_position;
-- Verify: same columns as preflight. Only structural change allowed: none.

-- ---------------------------------------------------------------------------
-- A4. Table-level privileges — confirm anon has NO access to profiles
-- ---------------------------------------------------------------------------
SELECT
    table_name,
    grantee,
    privilege_type,
    is_grantable
FROM information_schema.role_table_grants
WHERE table_schema = 'public'
  AND table_name IN ('profiles', 'listings', 'listing_media')
  AND grantee IN ('anon', 'authenticated', 'public')
ORDER BY table_name, grantee, privilege_type;
-- EXPECTED:
--   profiles: anon has NO privileges at all. authenticated has INSERT, UPDATE, DELETE only.
--   listings: anon has SELECT only. authenticated has SELECT, INSERT, UPDATE, DELETE.
--   listing_media: anon has SELECT only. authenticated has SELECT, INSERT, UPDATE, DELETE.
-- FAIL if anon has any privilege on profiles.
-- FAIL if authenticated has table-level SELECT on profiles (should be column-level only).

-- ---------------------------------------------------------------------------
-- A5. Column-level privileges — confirm password has NO SELECT grant
-- ---------------------------------------------------------------------------
SELECT
    column_name,
    grantee,
    privilege_type
FROM information_schema.column_privileges
WHERE table_schema = 'public'
  AND table_name = 'profiles'
  AND grantee IN ('anon', 'authenticated', 'public')
ORDER BY column_name, grantee;
-- EXPECTED:
--   password does NOT appear with SELECT for anon, authenticated, or public.
--   The following columns should have SELECT for 'authenticated':
--     id, full_name, role, email, phone, city, bio, avatar_url, preferences,
--     employee_type, referred_by, updated_at
--     (and wishlist, referal_points if those columns exist on the live schema)
-- FAIL if 'password' appears with SELECT for any API role.

-- ---------------------------------------------------------------------------
-- A6. OTP column privileges (if present — should have NO SELECT grant)
-- ---------------------------------------------------------------------------
SELECT
    CASE
        WHEN EXISTS (
            SELECT 1 FROM information_schema.column_privileges
            WHERE table_schema = 'public' AND table_name = 'profiles'
              AND column_name IN ('resetOtp', 'expireOtp')
              AND grantee IN ('anon', 'authenticated', 'public')
              AND privilege_type = 'SELECT'
        )
        THEN 'FAIL — OTP column has SELECT grant to API role. Must be revoked.'
        WHEN EXISTS (
            SELECT 1 FROM information_schema.columns
            WHERE table_schema = 'public' AND table_name = 'profiles'
              AND column_name IN ('resetOtp', 'expireOtp')
        )
        THEN 'PASS — OTP columns exist but have no SELECT grant to API roles'
        ELSE 'N/A — OTP columns not present in schema'
    END AS otp_column_privilege_check;

-- ---------------------------------------------------------------------------
-- A7. Profile RLS policies — exact final set
-- ---------------------------------------------------------------------------
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
-- EXPECTED final policies (exactly these 6, no others):
--   profiles_delete_admin    — DELETE — USING (is_admin())
--   profiles_insert_own      — INSERT — WITH CHECK (id = uid() AND role IN (...))
--   profiles_select_own      — SELECT — USING (id = uid())
--   profiles_select_staff    — SELECT — USING (is_staff())
--   profiles_update_own      — UPDATE — USING (id = uid()) WITH CHECK (id = uid())
--   profiles_update_staff    — UPDATE — USING (is_staff()) WITH CHECK (is_staff())
-- FAIL if any additional policy exists (potential bypass).
-- FAIL if any policy has USING (true) or no WHERE condition.

-- Gate: no unexpected profile policies
SELECT
    CASE
        WHEN (
            SELECT COUNT(*) FROM pg_policies
            WHERE schemaname = 'public' AND tablename = 'profiles'
        ) = 6
        AND NOT EXISTS (
            SELECT 1 FROM pg_policies
            WHERE schemaname = 'public' AND tablename = 'profiles'
              AND policyname NOT IN (
                'profiles_select_own', 'profiles_select_staff',
                'profiles_insert_own', 'profiles_update_own',
                'profiles_update_staff', 'profiles_delete_admin'
              )
        )
        THEN 'PASS — Exactly 6 expected policies, no unexpected policies'
        ELSE 'FAIL — Unexpected policy count or name. See A7 for details.'
    END AS profile_policy_set_check;

-- ---------------------------------------------------------------------------
-- A8. Listing RLS policies — final set
-- ---------------------------------------------------------------------------
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
-- EXPECTED:
--   listings_delete_broker_or_staff
--   listings_insert_broker_or_staff
--   listings_select_active_public    — USING (TRIM(status) = 'Active')
--   listings_select_broker_own       — USING (is_broker() AND broker_id = uid())
--   listings_select_staff            — USING (is_staff())
--   listings_update_broker_or_staff
-- FAIL if any USING (true) policy remains or any policy allows unrestricted public read.

-- Gate: no broad listing SELECT
SELECT
    CASE
        WHEN NOT EXISTS (
            SELECT 1 FROM pg_policies
            WHERE schemaname = 'public' AND tablename = 'listings'
              AND cmd = 'SELECT'
              AND (qual = 'true' OR qual IS NULL OR qual = '')
        )
        THEN 'PASS — No unconditional listing SELECT policy'
        ELSE 'FAIL — A broad/unconditional listing SELECT policy exists. Must be removed.'
    END AS listings_no_broad_select;

-- ---------------------------------------------------------------------------
-- A9. Listing_media RLS policies — final set
-- ---------------------------------------------------------------------------
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
-- EXPECTED:
--   listing_media_delete_broker_or_staff
--   listing_media_insert_broker_or_staff
--   listing_media_select_active          — requires parent listing Active
--   listing_media_select_broker_own      — requires parent listing ownership
--   listing_media_select_staff
--   listing_media_update_broker_or_staff

-- ---------------------------------------------------------------------------
-- A10. Function signatures, security mode, search path, ownership
-- ---------------------------------------------------------------------------
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
-- EXPECTED for all functions:
--   is_security_definer = true
--   config_parameters contains 'search_path=pg_catalog, public'
-- protect_profile_sensitive_columns: no PUBLIC/anon/authenticated execute grant

-- ---------------------------------------------------------------------------
-- A11. Function execution grants
-- ---------------------------------------------------------------------------
SELECT
    routine_name,
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
-- EXPECTED:
--   get_public_broker_identity: anon + authenticated
--   is_admin, is_broker, is_staff: authenticated only
--   get_related_profile_identities: authenticated only
--   get_own_referral_stats: authenticated only
--   protect_profile_sensitive_columns: NO public grants (trigger only)

-- ---------------------------------------------------------------------------
-- A12. Trigger definitions on profiles
-- ---------------------------------------------------------------------------
SELECT
    trigger_name,
    event_manipulation,
    action_timing,
    action_orientation,
    action_statement
FROM information_schema.triggers
WHERE event_object_schema = 'public'
  AND event_object_table = 'profiles'
ORDER BY trigger_name, event_manipulation;
-- EXPECTED: trg_protect_profile_sensitive_columns BEFORE INSERT OR UPDATE FOR EACH ROW

-- ---------------------------------------------------------------------------
-- A13. Trigger body — confirm password is NOT mutated
-- ---------------------------------------------------------------------------
SELECT
    p.proname AS function_name,
    CASE
        WHEN pg_get_functiondef(p.oid) LIKE '%NEW.password%'
          OR pg_get_functiondef(p.oid) LIKE '%OLD.password%'
        THEN 'REVIEW — trigger body references password column. Inspect manually.'
        ELSE 'PASS — trigger body does not reference password'
    END AS password_mutation_check
FROM pg_proc AS p
JOIN pg_namespace AS n ON p.pronamespace = n.oid
WHERE n.nspname = 'public'
  AND p.proname = 'protect_profile_sensitive_columns';

-- ---------------------------------------------------------------------------
-- A14. Listing triggers (preserve cover-image sync, timestamps)
-- ---------------------------------------------------------------------------
SELECT
    trigger_name,
    event_manipulation,
    action_timing,
    action_statement
FROM information_schema.triggers
WHERE event_object_schema = 'public'
  AND event_object_table IN ('listings', 'listing_media')
ORDER BY event_object_table, trigger_name;
-- Verify no existing listing or media trigger was broken.

-- ---------------------------------------------------------------------------
-- A15. Storage bucket visibility
-- ---------------------------------------------------------------------------
SELECT
    id AS bucket_id,
    name,
    public AS is_public
FROM storage.buckets
ORDER BY name;
-- EXPECTED:
--   avatars: public = true (intentional — avatars are public by design)
--   properties: check value
-- If properties is public = true: direct object URLs remain accessible.
--   Database listing_media RLS prevents row access, but Storage URL access
--   is independent. See UNIT1_EXECUTION.md Section 12 for the full decision.

-- ---------------------------------------------------------------------------
-- A16. Storage object policies
-- ---------------------------------------------------------------------------
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
-- If 'properties' bucket has no restrictive policies and bucket is public:
-- object URLs are publicly accessible regardless of database RLS.

-- ---------------------------------------------------------------------------
-- A17. PostgREST schema cache reload reminder
-- ---------------------------------------------------------------------------
-- If not already done, run the following to reload PostgREST schema cache:
--   NOTIFY pgrst, 'reload schema';
-- Or use the Supabase Dashboard: API Settings → Reload Schema Cache

-- ---------------------------------------------------------------------------
-- A18. Migration history observation
-- ---------------------------------------------------------------------------
SELECT
    version,
    inserted_at
FROM supabase_migrations.schema_migrations
ORDER BY version DESC
LIMIT 20;
-- Note whether version 20261008210000 appears as applied.
-- If it was applied before this remediation script, that historical migration
-- may have already altered functions/policies. The remediation script is
-- designed to be safe even if the historical migration was partially applied.

-- =============================================================================
-- SECTION B — LIVE API / APPLICATION VERIFICATION
-- (Manual post-execution verification — NOT proven by catalog SQL above)
-- =============================================================================
--
-- These checks require actual Supabase API calls or browser testing.
-- Use EXISTING authorized accounts only. Do NOT create test users.
-- The required outcome for all security checks is that unauthorized data
-- is NEVER returned. PostgREST may return either an error or an empty
-- result set for denied queries — both are acceptable.
-- =============================================================================

/*
B1. ANONYMOUS DIRECT PROFILES QUERY
   Test: Anonymous (no auth token) query:
     GET /rest/v1/profiles?select=*
   Expected: Empty result set or error (no profile rows returned).
   FAIL if: Any profile row is returned.

B2. AUTHENTICATED DIRECT PASSWORD SELECT
   Test: Authenticated user (Buyer or Broker) query:
     GET /rest/v1/profiles?id=eq.<own-user-id>&select=password
   Expected: Error ("column does not exist in schema cache") or column is absent.
   FAIL if: Any value is returned for the password column.

B3. SELF-PROFILE SELECT
   Test: Authenticated user query for their own profile:
     GET /rest/v1/profiles?id=eq.<own-user-id>&select=id,full_name,role,email
   Expected: One row with the caller's own profile data.
   FAIL if: Errors with no data, or returns another user's data.

B4. PERMITTED SELF-PROFILE UPDATE
   Test: Authenticated user PATCH:
     PATCH /rest/v1/profiles?id=eq.<own-user-id>
     Body: {"full_name": "Updated Name", "phone": "9999999999", "city": "Delhi"}
   Expected: 200 OK, profile updated successfully.
   FAIL if: Update fails for permitted fields.

B5. REJECTED PROTECTED-FIELD CHANGE
   Test: Authenticated Buyer/Broker PATCH attempting role escalation:
     PATCH /rest/v1/profiles?id=eq.<own-user-id>
     Body: {"role": "Admin"}
   Expected: The trigger reverts role to original value OR returns an error.
   FAIL if: Profile role changes to Admin.

B6. PUBLIC BROKER IDENTITY RPC
   Test: Anonymous or authenticated call:
     POST /rest/v1/rpc/get_public_broker_identity
     Body: {"p_broker_id": "<known-broker-uuid>"}
   Expected: Returns {id, full_name, avatar_url} only. No email, phone, etc.
   FAIL if: Returns email, phone, preferences, password, or other private fields.
   FAIL if: Returns data for a non-Broker profile.

B7. RELATIONSHIP IDENTITY RPC
   Test: Authenticated call with no existing relationship:
     POST /rest/v1/rpc/get_related_profile_identities
     Body: {"p_ids": ["<arbitrary-other-user-uuid>"]}
   Expected: Empty result set.
   FAIL if: Returns profile data for a user with no message/inquiry relationship.

B8. OWN-REFERRAL STATISTICS RPC
   Test: Authenticated call:
     POST /rest/v1/rpc/get_own_referral_stats
   Expected: Returns {invited_count, active_count} aggregates only.
   FAIL if: Returns individual referred-user rows or private data.
   FAIL if: Anonymous call returns any data.

B9. ANONYMOUS ACTIVE LISTING READS
   Test: Anonymous query:
     GET /rest/v1/listings?select=id,title,status&status=eq.Active
   Expected: Returns Active listings only.
   FAIL if: Returns listings with status other than 'Active'.

B10. EXPLICIT NON-ACTIVE FILTER
   Test: Anonymous query:
     GET /rest/v1/listings?select=id,title,status&status=eq.Pending
   Expected: Empty result set (RLS filters Pending listings for anon).
   FAIL if: Returns Pending listing rows.

B11. BROKER ACCESS TO OWN NON-ACTIVE LISTINGS
   Test: Authenticated Broker query:
     GET /rest/v1/listings?select=id,title,status&broker_id=eq.<own-broker-id>
   Expected: All the broker's own listings (Active, Pending, Draft, Rejected, Sold).
   FAIL if: Only Active listings are returned for the authenticated owning broker.

B12. BROKER LISTING CREATE AND EDIT
   Test: Authenticated Broker INSERT and UPDATE:
     POST /rest/v1/listings (with broker_id = auth.uid())
     PATCH /rest/v1/listings?id=eq.<own-listing-id>
   Expected: Both succeed for broker's own listings.
   FAIL if: Broker cannot create or update their own listings.

B13. ADMIN MODERATION
   Test: Authenticated Admin:
     - GET /rest/v1/profiles?select=id,full_name,role (should return all)
     - PATCH /rest/v1/listings?id=eq.<any-id> {"status": "Active"}
     - DELETE /rest/v1/profiles?id=eq.<target-id>
   Expected: All succeed.
   FAIL if: Admin cannot access profiles, update listings, or delete profiles.

B14. EMPLOYEE MODERATION
   Test: Authenticated Employee:
     - GET /rest/v1/profiles?select=id,full_name,role (should return all)
     - PATCH /rest/v1/profiles?id=eq.<target-id> {"bio": "[FLAGGED]"}
     - DELETE /rest/v1/profiles?id=eq.<target-id>
   Expected: Profile read and bio update succeed. DELETE fails (Employees cannot delete).
   FAIL if: Employee can delete profiles.

B15. LISTING MEDIA VISIBILITY
   Test: Anonymous query:
     GET /rest/v1/listing_media?listing_id=eq.<active-listing-id>
   Expected: Returns media rows.
   Test: Anonymous query for non-Active listing media:
     GET /rest/v1/listing_media?listing_id=eq.<pending-listing-id>
   Expected: Empty result.
   FAIL if: Media for non-Active listings is returned to anonymous callers.

B16. BROKER MEDIA OWNERSHIP
   Test: Authenticated Broker INSERT into listing_media for another broker's listing.
   Expected: Error / empty result. No media inserted.
   FAIL if: Broker can attach media to another broker's listing.

B17. STORAGE OBJECT ACCESS
   If properties bucket is PUBLIC:
     - Direct URL access remains independent of database RLS.
     - Verify that listing_media table rows for non-Active listings are not
       returned via the API (database-level protection works even if direct
       URL access is not restricted).
     - Document remaining URL-level exposure in results.
   If properties bucket is PRIVATE:
     - Verify signed URL generation works for authorized callers.
     - Verify unsigned direct URLs return 400/403.

B18. SIGNUP AND LOGIN
   Test: New user signup via /login.html (Buyer or Broker role).
   Expected: Account created, profile row inserted, login succeeds.
   Test: Existing user login.
   Expected: Profile data loaded, role-based navigation works.
   FAIL if: Signup fails or profile creation is rejected.

B19. PROFILE EDITING
   Test: Authenticated user visits /profile.html, edits name/phone/city/bio.
   Expected: Changes save successfully, profile updates in DB.
   FAIL if: Save fails for permitted fields.

B20. WISHLIST PERSISTENCE
   Test: Authenticated Buyer/Broker saves a listing to wishlist.
   Expected: Wishlist ID persists in profiles.wishlist (if column exists).
   Test: View profile wishlist — should show accessible (Active) listings.
   Test: Saved listing transitions to Pending — wishlist ID should NOT be deleted.
   FAIL if: Wishlist IDs are silently removed when RLS filters a listing.

B21. PROPERTY BROWSING (properties.html, search.html, map.html)
   Test: Anonymous user browses property listings.
   Expected: Only Active listings are displayed.
   FAIL if: Pending, Draft, or non-Active listings appear in public browsing.

B22. PROPERTY DETAIL PAGES (property-details.html)
   Test: Anonymous user accesses a property detail page for an Active listing.
   Expected: Full listing details and gallery load.
   Test: Direct URL access to a Pending listing detail page.
   Expected: Page loads but listing data is unavailable (RLS filters it).
   FAIL if: Non-Active listing details are shown to anonymous users.

B23. MESSAGING AND ENQUIRIES
   Test: Buyer sends enquiry on an Active listing.
   Expected: Inquiry created, broker receives notification.
   Test: Buyer attempts to view another buyer's messages.
   Expected: Access denied / empty result.
   FAIL if: Cross-user message access is possible.

-- =============================================================================
-- END OF VERIFICATION DOCUMENT
-- =============================================================================
-- Record the actual outcomes from B1–B23 above.
-- Do NOT mark any check as PASS unless it has actually been verified.
-- Document any residual Storage exposure separately.
-- =============================================================================
*/

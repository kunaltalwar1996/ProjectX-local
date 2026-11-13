# Unit 1 Execution Guide — Project X Security Remediation
## Profiles · Listing Visibility · Media · Storage

**Repository:** `E:\Project X\ProjectX-mirror\ProjectX-mirror-mvp`  
**Branch:** `mvp`  
**Supabase project:** `xjpqxhbuuevaplvthvsf.supabase.co`

---

> [!IMPORTANT]
> This guide governs the **live database execution** of Unit 1.  
> No SQL has been executed against the live database as of the time this guide was written.  
> Review every step before executing. Never execute remediation unless all required preflight gates pass.

---

## Step 1 — Review Repository Changes

Before touching the database, review and confirm the state of the repository.

### 1.1 Verify branch and status

```bash
cd "E:\Project X\ProjectX-mirror\ProjectX-mirror-mvp"
git branch
git status
```

**Expected:**
- Branch: `mvp`
- `auth.js` shows as `modified` (the existing uncommitted broker-dashboard listing query restriction)
- `supabase/manual_remediation_unit1_and_active_listing_visibility.sql` untracked
- `supabase/verify_remediation.sql` untracked
- `lib/wishlist.js` modified (wishlist preservation fix)

### 1.2 Confirm the uncommitted auth.js change is preserved

```bash
git diff auth.js
```

Confirm the diff includes the broker-dashboard listing filter:
```js
if (user && userRole === 'Broker' && currentPage === 'broker-dashboard.html') {
    query = query.eq('broker_id', user.id);
}
```

This change restricts broker dashboard listings to the authenticated broker's own inventory and **must not be reverted**.

### 1.3 Review all deliverable files

Review the following files before execution:

| File | Purpose |
|------|---------|
| `supabase/unit1_preflight.sql` | Read-only preflight checks |
| `supabase/manual_remediation_unit1_and_active_listing_visibility.sql` | **Authoritative remediation** (execute once only) |
| `supabase/verify_remediation.sql` | Post-execution catalog + runtime verification |
| `supabase/UNIT1_EXECUTION.md` | This guide |
| `supabase/migrations/20261008210000_secure_profiles_public_data_exposure.sql` | Historical migration (corrected; do not re-execute) |
| `lib/wishlist.js` | Wishlist preservation fix applied |

> [!CAUTION]
> Do NOT commit or push during Unit 1 execution. The existing uncommitted changes are intentional.

---

## Step 2 — Run Read-Only Preflight

Execute **`supabase/unit1_preflight.sql`** in the Supabase SQL Editor.

**Use a project-owner or service_role context.**

The preflight script is entirely read-only. It performs no schema changes, data modifications, or permission changes.

Execute all queries in the script from top to bottom, reviewing each result section.

---

## Step 3 — Review All Readiness Gates

The final `GATE SUMMARY` query in `unit1_preflight.sql` will return 12 gates. Review each one carefully.

| Gate | Required State | Action if Failed |
|------|---------------|-----------------|
| GATE 1: Password column | **PASS** | STOP — do not proceed. This is a hard blocker. |
| GATE 2: Profile insertion fields | **PASS** | STOP if any required column is missing |
| GATE 3: Self-edit profile fields | **PASS** | STOP if critical columns missing |
| GATE 4: Wishlist column | PASS or UNKNOWN | UNKNOWN: wishlist features will not work but remediation is safe |
| GATE 5: OTP columns (resetOtp, expireOtp) | Either | Note result — trigger is conditional |
| GATE 6: referal_points column | Either | Note result — column grant is conditional |
| GATE 7: Role helpers exist | **PASS** | STOP if helpers missing; check `is_staff`, `is_broker` existence |
| GATE 8: Password SELECT grant | **PASS** | If FAIL: execute remediation to remove the grant |
| GATE 9: profiles RLS state | Either | Note current state |
| GATE 10: listings RLS state | Either | Note current state |
| GATE 11: listing_media RLS state | Either | Note current state |
| GATE 12: Storage — properties bucket | Note result | See Section 12 of this guide |

Also review:
- Section 2.10 (existing profile policies) — note any UNEXPECTED policy names before proceeding
- Section 3.4 (trigger body) — confirm `protect_profile_sensitive_columns` does not mutate password if already deployed
- Section 4.4 (listing policies) — look for any `USING (true)` or unscoped policies

---

## Step 4 — Stop Conditions

**Do NOT execute the remediation if any of the following are true:**

1. **Gate 1 (password column) is FAIL** — the password column is absent. This violates the preservation requirement. Report immediately; do not create a replacement column.

2. **Any required profile column is missing** — a column required by the application signup or update path is absent from the live schema.

3. **An unexpected policy, trigger, or function exists** that was not identified during analysis and that could conflict with the remediation.

4. **The trigger body already references `NEW.password :=`** and was applied — the previous historical migration may have installed a trigger that sets password to NULL. If confirmed, the new remediation script will replace it. Confirm the new trigger body is correct before executing.

5. **Migration 20261008210000 is recorded as applied and the trigger is already in place** — the remediation script's DROP TRIGGER + CREATE TRIGGER is idempotent, but verify that the trigger body was not the one that calls `NEW.password := NULL`.

If you encounter any stop condition, do not proceed. Document the exact blocker and consult this guide for the resolution path.

---

## Step 5 — Execute Manual Remediation

Only after:
- All required preflight gates pass
- The owner has reviewed and approved the preflight results
- A maintenance window has been confirmed

Execute **`supabase/manual_remediation_unit1_and_active_listing_visibility.sql`** in the Supabase SQL Editor.

**Important execution notes:**
- The script begins with `BEGIN;` and ends with `COMMIT;`
- If any assertion fails, the entire transaction rolls back automatically
- Do not execute the script more than once against the same database state (functions are CREATE OR REPLACE but policies are dropped and recreated)
- The NOTIFY at the end signals PostgREST to reload its schema cache

**What the script does:**
1. Validates required schema state (assertions fail and roll back if conditions are not met)
2. Creates or replaces role helpers (`is_staff`, `is_broker`, `is_admin`) with safe search paths
3. Creates or replaces narrow broker identity RPC (`get_public_broker_identity`)
4. Creates or replaces relationship-based counterparty identity RPC (`get_related_profile_identities`)
5. Creates or replaces self-scoped referral statistics RPC (`get_own_referral_stats`)
6. Creates or replaces the sensitive-column protection trigger (without password mutation)
7. Enables RLS on profiles; replaces known legacy policies with 6 scoped policies
8. Revokes table-level SELECT from API roles; grants column-level SELECT on safe columns only (excluding password)
9. Enables RLS on listings; replaces known legacy policies with 6 scoped Active-only and ownership policies
10. Enables RLS on listing_media; replaces known legacy policies with 6 parent-listing-based policies
11. Issues `NOTIFY pgrst, 'reload schema'`

**What the script does NOT do:**
- Does not drop or modify the password column
- Does not read, display, or return any password values
- Does not alter messages, inquiries, notifications, or other tables
- Does not modify Storage bucket configuration
- Does not create test users or demo data
- Does not commit or push to git

---

## Step 6 — Reload PostgREST Schema Cache

The remediation script includes `NOTIFY pgrst, 'reload schema'` before `COMMIT`. This should trigger an automatic schema cache reload.

If the reload does not occur automatically:

1. Go to the Supabase Dashboard → Project → API Settings → "Reload Schema Cache"
2. Or execute manually in SQL Editor:
   ```sql
   NOTIFY pgrst, 'reload schema';
   ```

---

## Step 7 — Catalog Verification

Immediately after the transaction commits, execute **`supabase/verify_remediation.sql`** (Section A only).

Review each result against the expected outcomes documented in the script.

**Critical checks:**
- A1: RLS enabled on all three tables
- A2: Password column still present
- A4: anon has NO privileges on profiles table
- A5: 'password' column has NO SELECT grant to any API role
- A6: OTP columns have no SELECT grant (if present)
- A7: Exactly 6 expected profile policies, no others
- A8: No `USING (true)` listing SELECT policy
- A13: Trigger body does not reference password

If any catalog check fails, **do not proceed to runtime verification**. Diagnose and correct the specific failure before proceeding.

---

## Step 8 — Runtime Verification

Perform the manual checks documented in `supabase/verify_remediation.sql` Section B.

**Required accounts:**
- An existing anonymous session (no login)
- An existing Buyer account
- An existing Broker account with at least one listing in non-Active status
- An existing Employee account
- An existing Admin account

**Do not create new test users** for these verifications.

The 23 verification checks (B1–B23) cover all critical security boundaries. Record each actual result.

---

## Step 9 — Record Results

After completing Steps 7 and 8, record the following:

```
Date/time of execution:
Executed by:

Catalog verification results:
  A1 RLS enabled:        [PASS/FAIL]
  A2 Password preserved: [PASS/FAIL]
  A4 anon privileges:    [PASS/FAIL]
  A5 Password SELECT:    [PASS/FAIL]
  A7 Profile policies:   [PASS/FAIL]
  A8 No broad listing:   [PASS/FAIL]
  A13 Trigger safe:      [PASS/FAIL]

Runtime verification results:
  B1  Anonymous profiles:    [PASS/FAIL]
  B2  Password SELECT:       [PASS/FAIL]
  B3  Self-profile:          [PASS/FAIL]
  B4  Self-update:           [PASS/FAIL]
  B5  Role escalation:       [PASS/FAIL]
  B6  Broker identity RPC:   [PASS/FAIL]
  B7  Related identity RPC:  [PASS/FAIL]
  B8  Referral stats RPC:    [PASS/FAIL]
  B9  Anon active listings:  [PASS/FAIL]
  B10 Non-Active filter:     [PASS/FAIL]
  B11 Broker own listings:   [PASS/FAIL]
  B12 Broker CRUD:           [PASS/FAIL]
  B13 Admin moderation:      [PASS/FAIL]
  B14 Employee moderation:   [PASS/FAIL]
  B15 Media visibility:      [PASS/FAIL]
  B16 Media ownership:       [PASS/FAIL]
  B17 Storage access:        [PASS/FAIL/N/A]
  B18 Signup/Login:          [PASS/FAIL]
  B19 Profile editing:       [PASS/FAIL]
  B20 Wishlist:              [PASS/FAIL]
  B21 Property browsing:     [PASS/FAIL]
  B22 Property details:      [PASS/FAIL]
  B23 Messaging:             [PASS/FAIL]

Unresolved conditions:
  [List any FAIL or unresolved items here]

Residual exposure:
  [Document Storage URL exposure below]
```

---

## Section 12 — Storage Security Assessment

> [!WARNING]
> Database-level RLS on `listing_media` does NOT prevent direct access to Storage object URLs if the `properties` bucket is public.

### Current Known State

Based on the supplied schema export, the `properties` Storage bucket is **public**. This means:

- Any URL of the form `https://xjpqxhbuuevaplvthvsf.supabase.co/storage/v1/object/public/properties/listing-media/<listing-id>/...` is accessible without authentication
- Database RLS on `listing_media` controls which **rows** are returned via the API, but does **not** control direct URL access
- A user who knows or guesses a media object path can access it directly

### Database-Level Protection (What IS implemented)

- `listing_media_select_active` policy: anonymous callers cannot query listing_media rows for non-Active listings via PostgREST
- This protects the row-level data but not the underlying storage objects

### What Would Be Required for Full Protection

Full object-level Active-only protection would require all of:

1. Making the `properties` bucket **private**
2. Replacing all `getPublicUrl()` calls with **signed URL generation**
3. Adding Storage RLS object policies that validate parent listing status
4. Ensuring all existing media records have correct object paths mapped in `listing_media.metadata` or `url`

### Why This Is NOT Being Implemented in This Unit

The preflight must first confirm:
- The percentage of media records with mappable Supabase-hosted paths vs external URLs
- Whether `listing_media.url` values consistently follow the `listing-media/<listing-id>/...` path pattern used by new uploads
- Whether any existing records use external URLs (e.g., Unsplash) that cannot be mapped to Storage objects

**Making the bucket private without first confirming object path mapping would break existing public media delivery.**

### Decision Criteria for Bucket Conversion

**SAFE to convert the bucket private when ALL of the following are true:**
1. Preflight Section 5.6 shows zero `external_or_other_urls`
2. All `properties_bucket_urls` follow the `listing-media/<uuid>/...` path convention
3. All affected `auth.js` media delivery paths have been updated to use signed URLs
4. Storage RLS policies have been tested on a staging/preview environment

**DO NOT convert the bucket private in production until these criteria are confirmed.**

### Residual Exposure Statement

Until the bucket privacy change is made:
- `listing_media` table rows for non-Active listings are protected by database RLS (anon callers cannot retrieve them)
- Direct Storage object URLs for non-Active listing media remain publicly accessible if the URL is known
- This is an **accepted residual exposure** pending the preflight storage assessment
- Document the actual count of affected media objects from preflight Section 5.6

---

## Unit 1 Completion Assessment

| Component | Status |
|-----------|--------|
| Repository application code updated | ✅ Complete |
| Wishlist preservation fix applied | ✅ Complete |
| Historical migration corrected | ✅ Complete |
| Preflight SQL prepared | ✅ Complete |
| Authoritative remediation SQL prepared | ✅ Complete |
| Verification SQL prepared | ✅ Complete |
| Execution guide prepared | ✅ Complete |
| Static validation (build) | ✅ Complete |
| **Supabase preflight execution** | ⏳ **Pending — owner must run** |
| **Live remediation execution** | ⏳ **Pending — after preflight review** |
| **Catalog verification** | ⏳ **Pending — after remediation** |
| **Runtime verification** | ⏳ **Pending — after catalog verification** |
| **Storage bucket private conversion** | ⏳ **Pending — requires preflight storage assessment** |

> [!NOTE]
> Unit 1 repository and SQL artifact implementation is complete. Live database security is NOT yet active. The owner must execute Steps 2–9 of this guide against the live Supabase project to complete Unit 1.


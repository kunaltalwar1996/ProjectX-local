-- ============================================================
-- Migration: custom_filters v2 – add slug + is_public columns
-- Target: Supabase (PostgreSQL 15)
--
-- INSTRUCTIONS:
--   1. Open Supabase Dashboard → SQL Editor
--   2. Paste this entire file and click "Run"
--   3. The script is safe to run on a live table that already
--      has rows (existing rows are backfilled automatically).
--
-- Verified against actual live schema:
--   Existing columns: id (bigint), broker_id (uuid), name (text),
--                     criteria (jsonb), created_at (timestamptz)
--   Missing columns:  slug (text UNIQUE), is_public (boolean)
-- ============================================================


-- ── 1. Add missing columns (without UNIQUE constraint initially) ──

-- slug: opaque 8-char identifier used in /shared-filter/<slug> URLs.
-- Initially NOT NULL with a placeholder default so the ALTER succeeds even with
-- existing rows. The backfill in step 2 will replace these placeholder values.
ALTER TABLE public.custom_filters
    ADD COLUMN IF NOT EXISTS slug text NOT NULL DEFAULT '';

-- is_public: controls whether the shared link is accessible without auth.
-- Default true so all existing filters are treated as public (safe default).
ALTER TABLE public.custom_filters
    ADD COLUMN IF NOT EXISTS is_public boolean NOT NULL DEFAULT true;


-- ── 2. Backfill slug for all existing rows ───────────────────
-- Generates a random 8-character base-36 slug for every row that
-- still has the empty placeholder or any duplicate value.
-- The DO block loops until every row has a unique non-empty slug.

DO $$
DECLARE
    rec RECORD;
    new_slug TEXT;
    attempt  INT;
BEGIN
    FOR rec IN
        SELECT id FROM public.custom_filters
        WHERE slug = '' OR slug IS NULL
    LOOP
        attempt := 0;
        LOOP
            -- Generate 8 random hex characters (readable, URL-safe)
            new_slug := lower(substring(md5(random()::text || rec.id::text || clock_timestamp()::text) FROM 1 FOR 8));
            -- Retry on collision (extremely rare but handled)
            EXIT WHEN NOT EXISTS (
                SELECT 1 FROM public.custom_filters WHERE slug = new_slug
            );
            attempt := attempt + 1;
            IF attempt > 20 THEN
                RAISE EXCEPTION 'Could not generate unique slug after 20 attempts for id=%', rec.id;
            END IF;
        END LOOP;

        UPDATE public.custom_filters
        SET slug = new_slug
        WHERE id = rec.id;
    END LOOP;
END $$;


-- ── 3. Enforce UNIQUE on slug & Clean up Default ──────────────

-- Remove the empty-string default now that all rows are populated.
-- New inserts must always supply an explicit slug (done by the app).
ALTER TABLE public.custom_filters
    ALTER COLUMN slug DROP DEFAULT;

-- Drop the constraint first if it exists (idempotent re-run safety).
ALTER TABLE public.custom_filters
    DROP CONSTRAINT IF EXISTS custom_filters_slug_key;

-- Now safely apply the UNIQUE constraint, since every row has been assigned a unique slug.
ALTER TABLE public.custom_filters
    ADD CONSTRAINT custom_filters_slug_key UNIQUE (slug);


-- ── 4. Indexes ────────────────────────────────────────────────

-- Fast slug lookup for the /shared-filter/<slug> landing page.
CREATE INDEX IF NOT EXISTS idx_custom_filters_slug
    ON public.custom_filters (slug);

-- Fast broker-scoped listing for the dashboard.
CREATE INDEX IF NOT EXISTS idx_custom_filters_broker_id
    ON public.custom_filters (broker_id);


-- ── 5. Row-Level Security ─────────────────────────────────────
-- RLS is already enabled on this table (confirmed in existing schema).
-- The existing four policies cover broker CRUD on their own rows.
-- We only need to ADD the policy that allows public (anonymous) read
-- of is_public=true filters, which the shared-filter page requires.
--
-- NOTE: CREATE POLICY IF NOT EXISTS is NOT available in PostgreSQL 15
-- (Supabase default). Use DROP + CREATE to make this idempotent.

DROP POLICY IF EXISTS "Public filters readable by anyone" ON public.custom_filters;

CREATE POLICY "Public filters readable by anyone"
    ON public.custom_filters
    FOR SELECT
    USING (is_public = true);

-- Verify the existing broker policies are still in place (informational).
-- The four policies below should already exist; this comment is a reminder.
-- "Brokers can delete their own custom filters"   FOR DELETE USING (auth.uid() = broker_id)
-- "Brokers can insert their own custom filters"   FOR INSERT WITH CHECK (auth.uid() = broker_id)
-- "Brokers can update their own custom filters"   FOR UPDATE USING/WITH CHECK (auth.uid() = broker_id)
-- "Brokers can view their own custom filters"     FOR SELECT USING (auth.uid() = broker_id)
--
-- The new "Public filters readable by anyone" policy does NOT conflict
-- with "Brokers can view their own custom filters" — Postgres RLS uses
-- OR logic across SELECT policies (any matching policy grants access).


-- ── 6. Verify ────────────────────────────────────────────────
-- After running, validate with:
--
-- SELECT column_name, data_type
-- FROM information_schema.columns
-- WHERE table_schema = 'public' AND table_name = 'custom_filters'
-- ORDER BY ordinal_position;
--
-- Expected columns: id, broker_id, name, criteria, created_at, slug, is_public
--
-- SELECT id, slug, is_public FROM public.custom_filters LIMIT 10;
-- (all rows should have non-empty slugs and is_public = true)

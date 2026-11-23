-- Unit 2, Phase 1: structured broker professional details.
--
-- This migration is additive. It deliberately leaves legacy values in
-- public.profiles.preferences untouched, and it must be applied only after
-- the Unit 1 profile/role security baseline is present in the target database.

BEGIN;

-- Fail closed against a database that merely has similarly named objects.
-- In particular, do not create a dependent table unless profiles has the
-- primary key, role constraint, and helper functions this migration needs.
DO $$
DECLARE
  profiles_oid oid;
  profiles_id_attnum smallint;
BEGIN
  profiles_oid := to_regclass('public.profiles');
  IF profiles_oid IS NULL THEN
    RAISE EXCEPTION 'public.profiles must exist before broker_public_details';
  END IF;

  SELECT a.attnum
    INTO profiles_id_attnum
  FROM pg_attribute AS a
  WHERE a.attrelid = profiles_oid
    AND a.attname = 'id'
    AND a.atttypid = 'uuid'::regtype
    AND a.attnotnull
    AND a.attnum > 0
    AND NOT a.attisdropped;

  IF profiles_id_attnum IS NULL
     OR NOT EXISTS (
       SELECT 1
       FROM pg_constraint AS c
       WHERE c.conrelid = profiles_oid
         AND c.contype = 'p'
         AND c.conkey = ARRAY[profiles_id_attnum]::smallint[]
     ) THEN
    RAISE EXCEPTION 'public.profiles.id must be a NOT NULL uuid primary key';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_attribute AS a
    WHERE a.attrelid = profiles_oid
      AND a.attname = 'role'
      AND a.atttypid = 'text'::regtype
      AND a.attnum > 0
      AND NOT a.attisdropped
  ) OR NOT EXISTS (
    SELECT 1
    FROM pg_attribute AS a
    WHERE a.attrelid = profiles_oid
      AND a.attname = 'preferences'
      AND a.atttypid = 'jsonb'::regtype
      AND a.attnum > 0
      AND NOT a.attisdropped
  ) THEN
    RAISE EXCEPTION 'public.profiles requires text role and jsonb preferences columns';
  END IF;

  -- This does not rely on a constraint name. It verifies that the current
  -- controlled role constraint still admits the Broker role this table models.
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint AS c
    WHERE c.conrelid = profiles_oid
      AND c.contype = 'c'
      AND pg_get_constraintdef(c.oid) LIKE '%Broker%'
  ) THEN
    RAISE EXCEPTION 'public.profiles must retain a CHECK constraint allowing role Broker';
  END IF;

  IF to_regprocedure('public.is_broker()') IS NULL
     OR to_regprocedure('public.is_staff()') IS NULL THEN
    RAISE EXCEPTION 'public.is_broker() and public.is_staff() must exist before broker_public_details';
  END IF;
END;
$$;

-- Immutable validation used by the table constraint. The whole array must be
-- drawn from the controlled vocabulary and no selected area may be duplicated.
CREATE OR REPLACE FUNCTION public.broker_operation_areas_are_valid(p_areas text[])
RETURNS boolean
LANGUAGE sql
IMMUTABLE
STRICT
SET search_path TO pg_catalog
AS $$
  SELECT
    p_areas <@ ARRAY['Gurugram', 'Faridabad', 'Mumbai', 'Noida', 'Ghaziabad', 'Delhi']::text[]
    AND cardinality(p_areas) = (
      SELECT count(DISTINCT area)::integer
      FROM unnest(p_areas) AS area
    );
$$;

REVOKE ALL ON FUNCTION public.broker_operation_areas_are_valid(text[]) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.broker_operation_areas_are_valid(text[]) TO authenticated, service_role;

CREATE TABLE IF NOT EXISTS public.broker_public_details (
  broker_id uuid PRIMARY KEY REFERENCES public.profiles(id),
  agency_name text NULL,
  years_experience smallint NULL,
  areas_of_operation text[] NOT NULL DEFAULT ARRAY[]::text[],
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT broker_public_details_agency_name_valid CHECK (
    agency_name IS NULL
    OR (btrim(agency_name) <> '' AND char_length(agency_name) <= 160)
  ),
  CONSTRAINT broker_public_details_years_experience_valid CHECK (
    years_experience IS NULL OR years_experience >= 0
  ),
  CONSTRAINT broker_public_details_areas_of_operation_valid CHECK (
    public.broker_operation_areas_are_valid(areas_of_operation)
  )
);

-- `IF NOT EXISTS` is only for rerun safety. Validate the actual catalog shape,
-- not just object and constraint names, before touching an existing table.
DO $$
DECLARE
  details_oid oid := 'public.broker_public_details'::regclass;
  profiles_oid oid := 'public.profiles'::regclass;
  broker_id_attnum smallint;
  profiles_id_attnum smallint;
BEGIN
  SELECT a.attnum INTO broker_id_attnum
  FROM pg_attribute AS a
  WHERE a.attrelid = details_oid AND a.attname = 'broker_id'
    AND a.atttypid = 'uuid'::regtype AND a.attnotnull
    AND a.attnum > 0 AND NOT a.attisdropped;

  SELECT a.attnum INTO profiles_id_attnum
  FROM pg_attribute AS a
  WHERE a.attrelid = profiles_oid AND a.attname = 'id'
    AND a.atttypid = 'uuid'::regtype AND a.attnotnull
    AND a.attnum > 0 AND NOT a.attisdropped;

  IF broker_id_attnum IS NULL
     OR profiles_id_attnum IS NULL
     OR (SELECT count(*) FROM pg_attribute AS a
         WHERE a.attrelid = details_oid
           AND a.attnum > 0
           AND NOT a.attisdropped) <> 6
     OR NOT EXISTS (SELECT 1 FROM pg_attribute AS a WHERE a.attrelid = details_oid AND a.attname = 'agency_name' AND a.atttypid = 'text'::regtype AND NOT a.attnotnull AND a.attnum > 0 AND NOT a.attisdropped)
     OR NOT EXISTS (SELECT 1 FROM pg_attribute AS a WHERE a.attrelid = details_oid AND a.attname = 'years_experience' AND a.atttypid = 'int2'::regtype AND NOT a.attnotnull AND a.attnum > 0 AND NOT a.attisdropped)
     OR NOT EXISTS (SELECT 1 FROM pg_attribute AS a WHERE a.attrelid = details_oid AND a.attname = 'areas_of_operation' AND a.atttypid = 'text[]'::regtype AND a.attnotnull AND a.attnum > 0 AND NOT a.attisdropped)
     OR NOT EXISTS (SELECT 1 FROM pg_attribute AS a WHERE a.attrelid = details_oid AND a.attname = 'created_at' AND a.atttypid = 'timestamptz'::regtype AND a.attnotnull AND a.attnum > 0 AND NOT a.attisdropped)
     OR NOT EXISTS (SELECT 1 FROM pg_attribute AS a WHERE a.attrelid = details_oid AND a.attname = 'updated_at' AND a.atttypid = 'timestamptz'::regtype AND a.attnotnull AND a.attnum > 0 AND NOT a.attisdropped)
  THEN
    RAISE EXCEPTION 'public.broker_public_details exists with an incompatible column definition';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint AS c
    WHERE c.conrelid = details_oid
      AND c.contype = 'p'
      AND c.conkey = ARRAY[broker_id_attnum]::smallint[]
  ) THEN
    RAISE EXCEPTION 'public.broker_public_details must have broker_id as its only primary-key column';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint AS c
    WHERE c.conrelid = details_oid
      AND c.contype = 'f'
      AND c.conkey = ARRAY[broker_id_attnum]::smallint[]
      AND c.confrelid = profiles_oid
      AND c.confkey = ARRAY[profiles_id_attnum]::smallint[]
      AND c.confupdtype = 'a'
      AND c.confdeltype = 'a'
  ) THEN
    RAISE EXCEPTION 'public.broker_public_details must reference public.profiles(id) with NO ACTION';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint AS c
    WHERE c.conrelid = details_oid
      AND c.conname = 'broker_public_details_agency_name_valid'
      AND c.contype = 'c'
      AND pg_get_constraintdef(c.oid) LIKE '%btrim%'
      AND pg_get_constraintdef(c.oid) LIKE '%char_length%'
      AND pg_get_constraintdef(c.oid) LIKE '%160%'
  ) OR NOT EXISTS (
    SELECT 1 FROM pg_constraint AS c
    WHERE c.conrelid = details_oid
      AND c.conname = 'broker_public_details_years_experience_valid'
      AND c.contype = 'c'
      AND pg_get_constraintdef(c.oid) LIKE '%years_experience%'
      AND pg_get_constraintdef(c.oid) LIKE '%>= 0%'
  ) OR NOT EXISTS (
    SELECT 1 FROM pg_constraint AS c
    WHERE c.conrelid = details_oid
      AND c.conname = 'broker_public_details_areas_of_operation_valid'
      AND c.contype = 'c'
      AND pg_get_constraintdef(c.oid) LIKE '%broker_operation_areas_are_valid%'
  ) THEN
    RAISE EXCEPTION 'public.broker_public_details has incompatible CHECK constraints';
  END IF;
END;
$$;

-- Normalize future defaults even if a compatible table was created by a prior
-- interrupted run. Existing timestamps are never rewritten.
ALTER TABLE public.broker_public_details
  ALTER COLUMN created_at SET DEFAULT now(),
  ALTER COLUMN updated_at SET DEFAULT now();

-- A foreign key cannot ensure that the referenced profile remains a Broker.
-- The child trigger validates creation/ownership changes; the parent trigger
-- prevents a role change from leaving an invalid professional-detail record.
CREATE OR REPLACE FUNCTION public.enforce_broker_public_details_broker()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO pg_catalog, public
AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM public.profiles AS p
    WHERE p.id = NEW.broker_id
      AND p.role = 'Broker'
  ) THEN
    RAISE EXCEPTION 'broker_public_details requires a Broker profile';
  END IF;

  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION public.prevent_broker_role_change_with_public_details()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO pg_catalog, public
AS $$
BEGIN
  IF OLD.role = 'Broker'
     AND NEW.role IS DISTINCT FROM 'Broker'
     AND EXISTS (
       SELECT 1
       FROM public.broker_public_details AS d
       WHERE d.broker_id = OLD.id
     ) THEN
    RAISE EXCEPTION 'Remove broker_public_details before changing a Broker profile role';
  END IF;

  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION public.set_broker_public_details_updated_at()
RETURNS trigger
LANGUAGE plpgsql
SET search_path TO pg_catalog
AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.enforce_broker_public_details_broker() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.prevent_broker_role_change_with_public_details() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.set_broker_public_details_updated_at() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS trg_enforce_broker_public_details_broker ON public.broker_public_details;
CREATE TRIGGER trg_enforce_broker_public_details_broker
  BEFORE INSERT OR UPDATE OF broker_id ON public.broker_public_details
  FOR EACH ROW EXECUTE FUNCTION public.enforce_broker_public_details_broker();

DROP TRIGGER IF EXISTS trg_prevent_broker_role_change_with_public_details ON public.profiles;
CREATE TRIGGER trg_prevent_broker_role_change_with_public_details
  BEFORE UPDATE OF role ON public.profiles
  FOR EACH ROW EXECUTE FUNCTION public.prevent_broker_role_change_with_public_details();

DROP TRIGGER IF EXISTS trg_set_broker_public_details_updated_at ON public.broker_public_details;
CREATE TRIGGER trg_set_broker_public_details_updated_at
  BEFORE UPDATE ON public.broker_public_details
  FOR EACH ROW EXECUTE FUNCTION public.set_broker_public_details_updated_at();

-- Copy only safe, unambiguous legacy values. No profile row is updated and
-- the original JSON keys remain available for rollback/manual review.
WITH legacy_details AS (
  SELECT
    p.id AS broker_id,
    CASE
      WHEN jsonb_typeof(p.preferences -> 'agency') = 'string'
       AND char_length(btrim(p.preferences ->> 'agency')) BETWEEN 1 AND 160
      THEN btrim(p.preferences ->> 'agency')
      ELSE NULL
    END AS agency_name,
    CASE
      WHEN jsonb_typeof(p.preferences -> 'experience') IN ('number', 'string')
       AND btrim(p.preferences ->> 'experience') ~ '^[0-9]+$'
       AND char_length(btrim(p.preferences ->> 'experience')) <= 5
       AND (btrim(p.preferences ->> 'experience'))::integer BETWEEN 0 AND 32767
      THEN (btrim(p.preferences ->> 'experience'))::smallint
      ELSE NULL
    END AS years_experience,
    CASE
      -- Do not parse free text, comma-separated values, or legacy arrays.
      -- Only one complete, canonical legacy string is unambiguous.
      WHEN jsonb_typeof(p.preferences -> 'areas') = 'string'
       AND btrim(p.preferences ->> 'areas') IN ('Gurugram', 'Faridabad', 'Mumbai', 'Noida', 'Ghaziabad', 'Delhi')
      THEN ARRAY[btrim(p.preferences ->> 'areas')]::text[]
      ELSE ARRAY[]::text[]
    END AS areas_of_operation
  FROM public.profiles AS p
  WHERE p.role = 'Broker'
    AND jsonb_typeof(p.preferences) = 'object'
)
INSERT INTO public.broker_public_details AS target (
  broker_id,
  agency_name,
  years_experience,
  areas_of_operation
)
SELECT
  broker_id,
  agency_name,
  years_experience,
  areas_of_operation
FROM legacy_details
WHERE agency_name IS NOT NULL
   OR years_experience IS NOT NULL
   OR cardinality(areas_of_operation) > 0
ON CONFLICT (broker_id) DO UPDATE
SET
  agency_name = COALESCE(target.agency_name, EXCLUDED.agency_name),
  years_experience = COALESCE(target.years_experience, EXCLUDED.years_experience),
  areas_of_operation = CASE
    WHEN cardinality(target.areas_of_operation) = 0
     AND cardinality(EXCLUDED.areas_of_operation) > 0
    THEN EXCLUDED.areas_of_operation
    ELSE target.areas_of_operation
  END
WHERE (target.agency_name IS NULL AND EXCLUDED.agency_name IS NOT NULL)
   OR (target.years_experience IS NULL AND EXCLUDED.years_experience IS NOT NULL)
   OR (cardinality(target.areas_of_operation) = 0 AND cardinality(EXCLUDED.areas_of_operation) > 0);

ALTER TABLE public.broker_public_details ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.broker_public_details NO FORCE ROW LEVEL SECURITY;

-- A pre-existing unrecognised policy is not safe to retain or overwrite.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM pg_policies AS p
    WHERE p.schemaname = 'public'
      AND p.tablename = 'broker_public_details'
      AND p.policyname NOT IN (
        'broker_public_details_select_own',
        'broker_public_details_select_staff',
        'broker_public_details_insert_own',
        'broker_public_details_update_own'
      )
  ) THEN
    RAISE EXCEPTION 'public.broker_public_details has an unrecognised RLS policy; review it before applying this migration';
  END IF;
END;
$$;

DROP POLICY IF EXISTS broker_public_details_select_own ON public.broker_public_details;
DROP POLICY IF EXISTS broker_public_details_select_staff ON public.broker_public_details;
DROP POLICY IF EXISTS broker_public_details_insert_own ON public.broker_public_details;
DROP POLICY IF EXISTS broker_public_details_update_own ON public.broker_public_details;

CREATE POLICY broker_public_details_select_own
  ON public.broker_public_details
  FOR SELECT TO authenticated
  USING (broker_id = (SELECT auth.uid()) AND (SELECT public.is_broker()));

-- Existing Admin/Employee authorization is represented by is_staff(). This is
-- deliberately read-only: no staff editor is introduced in this phase.
CREATE POLICY broker_public_details_select_staff
  ON public.broker_public_details
  FOR SELECT TO authenticated
  USING ((SELECT public.is_staff()));

CREATE POLICY broker_public_details_insert_own
  ON public.broker_public_details
  FOR INSERT TO authenticated
  WITH CHECK (broker_id = (SELECT auth.uid()) AND (SELECT public.is_broker()));

CREATE POLICY broker_public_details_update_own
  ON public.broker_public_details
  FOR UPDATE TO authenticated
  USING (broker_id = (SELECT auth.uid()) AND (SELECT public.is_broker()))
  WITH CHECK (broker_id = (SELECT auth.uid()) AND (SELECT public.is_broker()));

-- Remove all inherited table and column grants before granting the exact
-- fields needed by the authenticated broker UI. RLS remains the row boundary.
REVOKE ALL ON TABLE public.broker_public_details FROM PUBLIC, anon, authenticated;
REVOKE ALL (
  broker_id,
  agency_name,
  years_experience,
  areas_of_operation,
  created_at,
  updated_at
) ON TABLE public.broker_public_details FROM PUBLIC, anon, authenticated;

GRANT SELECT (
  broker_id,
  agency_name,
  years_experience,
  areas_of_operation,
  created_at,
  updated_at
) ON TABLE public.broker_public_details TO authenticated;
GRANT INSERT (
  broker_id,
  agency_name,
  years_experience,
  areas_of_operation
) ON TABLE public.broker_public_details TO authenticated;
GRANT UPDATE (
  agency_name,
  years_experience,
  areas_of_operation
) ON TABLE public.broker_public_details TO authenticated;
GRANT ALL ON TABLE public.broker_public_details TO service_role;

NOTIFY pgrst, 'reload schema';

COMMIT;

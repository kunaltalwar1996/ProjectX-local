-- Project X — Top Brokers and Broker Identity Verification foundation
--
-- This is an additive, fail-closed migration. It does not change existing
-- profile, listing, messaging, professional-detail, or field-verification
-- workflows. It must be reviewed and executed manually against a verified
-- Supabase schema; creating this file does not deploy it.
--
-- Storage boundary:
--   * This migration creates the private bucket and denies direct browser
--     access to its objects.
--   * Edge Functions / trusted workers, not SQL RPCs, must generate signed
--     upload/download URLs and physically delete objects.
--   * Browser clients must never receive a service-role key or raw object key.

BEGIN;

-- ---------------------------------------------------------------------------
-- 0. Preflight: require the repository's existing role/profile/listing base.
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  profiles_oid oid := to_regclass('public.profiles');
  listings_oid oid := to_regclass('public.listings');
  listing_media_oid oid := to_regclass('public.listing_media');
  details_oid oid := to_regclass('public.broker_public_details');
  required_profile_column text;
  required_listing_column text;
BEGIN
  IF profiles_oid IS NULL OR listings_oid IS NULL OR listing_media_oid IS NULL OR details_oid IS NULL THEN
    RAISE EXCEPTION 'Top Brokers foundation requires public.profiles, public.listings, public.listing_media, and public.broker_public_details';
  END IF;

  FOREACH required_profile_column IN ARRAY ARRAY['id', 'role', 'employee_type', 'full_name', 'avatar_url'] LOOP
    IF NOT EXISTS (
      SELECT 1 FROM pg_attribute a
      WHERE a.attrelid = profiles_oid AND a.attname = required_profile_column
        AND a.attnum > 0 AND NOT a.attisdropped
    ) THEN
      RAISE EXCEPTION 'public.profiles is missing required column %', required_profile_column;
    END IF;
  END LOOP;

  IF NOT EXISTS (
    SELECT 1 FROM pg_attribute a
    WHERE a.attrelid = profiles_oid AND a.attname = 'id'
      AND a.atttypid = 'uuid'::regtype AND a.attnotnull
      AND a.attnum > 0 AND NOT a.attisdropped
  ) OR NOT EXISTS (
    SELECT 1 FROM pg_constraint c
    JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = ANY(c.conkey)
    WHERE c.conrelid = profiles_oid AND c.contype = 'p' AND a.attname = 'id'
  ) THEN
    RAISE EXCEPTION 'public.profiles.id must be a NOT NULL uuid primary key';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c
    WHERE c.conrelid = profiles_oid AND c.contype = 'c'
      AND pg_get_constraintdef(c.oid) LIKE '%Broker%'
      AND pg_get_constraintdef(c.oid) LIKE '%Buyer%'
      AND pg_get_constraintdef(c.oid) LIKE '%Employee%'
      AND pg_get_constraintdef(c.oid) LIKE '%Admin%'
  ) THEN
    RAISE EXCEPTION 'public.profiles must retain its controlled Broker/Buyer/Employee/Admin role constraint';
  END IF;

  FOREACH required_listing_column IN ARRAY ARRAY['id', 'broker_id', 'status', 'type'] LOOP
    IF NOT EXISTS (
      SELECT 1 FROM pg_attribute a
      WHERE a.attrelid = listings_oid AND a.attname = required_listing_column
        AND a.attnum > 0 AND NOT a.attisdropped
    ) THEN
      RAISE EXCEPTION 'public.listings is missing required column %', required_listing_column;
    END IF;
  END LOOP;
  IF NOT EXISTS (
    SELECT 1 FROM pg_attribute a
    WHERE a.attrelid = listing_media_oid AND a.attname = 'listing_id'
      AND a.attnum > 0 AND NOT a.attisdropped
  ) THEN
    RAISE EXCEPTION 'public.listing_media is missing required column listing_id';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_attribute a
    WHERE a.attrelid = details_oid AND a.attname = 'broker_id'
      AND a.atttypid = 'uuid'::regtype AND a.attnotnull
  ) OR NOT EXISTS (
    SELECT 1 FROM pg_attribute a
    WHERE a.attrelid = details_oid AND a.attname = 'agency_name'
      AND a.atttypid = 'text'::regtype
  ) OR NOT EXISTS (
    SELECT 1 FROM pg_attribute a
    WHERE a.attrelid = details_oid AND a.attname = 'years_experience'
      AND a.atttypid = 'int2'::regtype
  ) OR NOT EXISTS (
    SELECT 1 FROM pg_attribute a
    WHERE a.attrelid = details_oid AND a.attname = 'areas_of_operation'
      AND a.atttypid = 'text[]'::regtype
  ) THEN
    RAISE EXCEPTION 'public.broker_public_details has an incompatible shape';
  END IF;

  IF to_regprocedure('public.broker_operation_areas_are_valid(text[])') IS NULL THEN
    RAISE EXCEPTION 'public.broker_operation_areas_are_valid(text[]) must exist before this migration';
  END IF;
  IF to_regprocedure('public.is_staff()') IS NULL THEN
    RAISE EXCEPTION 'public.is_staff() must exist before this migration';
  END IF;
  IF to_regprocedure('gen_random_uuid()') IS NULL THEN
    RAISE EXCEPTION 'gen_random_uuid() must be available before this migration';
  END IF;
END;
$$;

-- ---------------------------------------------------------------------------
-- 1. Helpers. These deliberately do not broaden public.is_staff().
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.is_broker_identity_reviewer()
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO pg_catalog, public
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM public.profiles p
    WHERE p.id = auth.uid()
      AND (
        p.role = 'Admin'
        OR (p.role = 'Employee' AND p.employee_type = 'Employee 2')
      )
  );
$$;

CREATE OR REPLACE FUNCTION public.is_broker_identity_owner(p_broker_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO pg_catalog, public
AS $$
  SELECT auth.uid() = p_broker_id
     AND EXISTS (
       SELECT 1 FROM public.profiles p
       WHERE p.id = auth.uid() AND p.role = 'Broker'
     );
$$;

REVOKE ALL ON FUNCTION public.is_broker_identity_reviewer() FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.is_broker_identity_owner(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.is_broker_identity_reviewer() TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.is_broker_identity_owner(uuid) TO authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 2. Rating foundation. There is intentionally no client write policy or RPC.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.broker_ratings (
  broker_id uuid NOT NULL REFERENCES public.profiles(id) ON DELETE RESTRICT,
  buyer_id uuid NOT NULL REFERENCES public.profiles(id) ON DELETE RESTRICT,
  rating smallint NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT broker_ratings_pkey PRIMARY KEY (broker_id, buyer_id),
  CONSTRAINT broker_ratings_value_check CHECK (rating BETWEEN 1 AND 5),
  CONSTRAINT broker_ratings_distinct_participants_check CHECK (broker_id <> buyer_id)
);

CREATE OR REPLACE FUNCTION public.enforce_broker_rating_participants()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO pg_catalog, public
AS $$
BEGIN
  IF NEW.broker_id = NEW.buyer_id THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'A buyer cannot rate themselves';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.profiles p WHERE p.id = NEW.broker_id AND p.role = 'Broker') THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'broker_id must identify a Broker profile';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.profiles p WHERE p.id = NEW.buyer_id AND p.role = 'Buyer') THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'buyer_id must identify a Buyer profile';
  END IF;
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION public.prevent_rating_participant_role_change()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO pg_catalog, public
AS $$
BEGIN
  IF OLD.role IS DISTINCT FROM NEW.role
     AND EXISTS (
       SELECT 1 FROM public.broker_ratings r
       WHERE r.broker_id = OLD.id OR r.buyer_id = OLD.id
     ) THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'Cannot change a profile role while Broker rating records reference it';
  END IF;
  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.enforce_broker_rating_participants() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.prevent_rating_participant_role_change() FROM PUBLIC, anon, authenticated;
DROP TRIGGER IF EXISTS trg_enforce_broker_rating_participants ON public.broker_ratings;
CREATE TRIGGER trg_enforce_broker_rating_participants
  BEFORE INSERT OR UPDATE OF broker_id, buyer_id, rating ON public.broker_ratings
  FOR EACH ROW EXECUTE FUNCTION public.enforce_broker_rating_participants();
DROP TRIGGER IF EXISTS trg_prevent_rating_participant_role_change ON public.profiles;
CREATE TRIGGER trg_prevent_rating_participant_role_change
  BEFORE UPDATE OF role ON public.profiles
  FOR EACH ROW EXECUTE FUNCTION public.prevent_rating_participant_role_change();

ALTER TABLE public.broker_ratings ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.broker_ratings NO FORCE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.broker_ratings FROM PUBLIC, anon, authenticated;
GRANT ALL ON TABLE public.broker_ratings TO service_role;

-- ---------------------------------------------------------------------------
-- 3. Broker identity verification data. Object keys are private metadata.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.broker_verification_status (
  broker_id uuid PRIMARY KEY REFERENCES public.profiles(id) ON DELETE RESTRICT,
  current_approved_submission_id uuid NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.broker_verification_upload_sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  broker_id uuid NOT NULL REFERENCES public.profiles(id) ON DELETE RESTRICT,
  document_type text NOT NULL,
  expected_object_key text NOT NULL UNIQUE,
  expires_at timestamptz NOT NULL,
  used_at timestamptz NULL,
  abandoned_at timestamptz NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT broker_verification_upload_sessions_document_type_check
    CHECK (document_type IN ('Aadhaar', 'Passport')),
  CONSTRAINT broker_verification_upload_sessions_expected_key_check
    CHECK (btrim(expected_object_key) <> ''),
  CONSTRAINT broker_verification_upload_sessions_expiry_check
    CHECK (expires_at > created_at)
);

CREATE TABLE IF NOT EXISTS public.broker_verification_submissions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  broker_id uuid NOT NULL REFERENCES public.profiles(id) ON DELETE RESTRICT,
  upload_session_id uuid NOT NULL UNIQUE REFERENCES public.broker_verification_upload_sessions(id) ON DELETE RESTRICT,
  document_type text NOT NULL,
  object_key text NOT NULL UNIQUE,
  review_status text NOT NULL DEFAULT 'Pending',
  submitted_at timestamptz NOT NULL DEFAULT now(),
  reviewed_at timestamptz NULL,
  reviewed_by uuid NULL REFERENCES public.profiles(id) ON DELETE RESTRICT,
  rejection_reason text NULL,
  replaces_submission_id uuid NULL REFERENCES public.broker_verification_submissions(id) ON DELETE RESTRICT,
  superseded_by_submission_id uuid NULL REFERENCES public.broker_verification_submissions(id) ON DELETE RESTRICT,
  superseded_at timestamptz NULL,
  withdrawn_at timestamptz NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT broker_verification_submissions_document_type_check
    CHECK (document_type IN ('Aadhaar', 'Passport')),
  CONSTRAINT broker_verification_submissions_review_status_check
    CHECK (review_status IN ('Pending', 'Approved', 'Rejected')),
  CONSTRAINT broker_verification_submissions_object_key_check
    CHECK (btrim(object_key) <> ''),
  CONSTRAINT broker_verification_submissions_review_metadata_check
    CHECK (
      (review_status = 'Pending' AND reviewed_at IS NULL AND reviewed_by IS NULL AND rejection_reason IS NULL)
      OR (review_status = 'Approved' AND reviewed_at IS NOT NULL AND reviewed_by IS NOT NULL AND rejection_reason IS NULL)
      OR (review_status = 'Rejected' AND reviewed_at IS NOT NULL AND reviewed_by IS NOT NULL
          AND NULLIF(btrim(rejection_reason), '') IS NOT NULL)
    ),
  CONSTRAINT broker_verification_submissions_supersession_check
    CHECK (
      (superseded_at IS NULL AND superseded_by_submission_id IS NULL)
      OR (superseded_at IS NOT NULL AND superseded_by_submission_id IS NOT NULL)
    )
);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.broker_verification_status'::regclass
      AND conname = 'broker_verification_status_current_submission_fkey'
  ) THEN
    ALTER TABLE public.broker_verification_status
      ADD CONSTRAINT broker_verification_status_current_submission_fkey
      FOREIGN KEY (current_approved_submission_id)
      REFERENCES public.broker_verification_submissions(id)
      ON DELETE RESTRICT;
  END IF;
END;
$$;

CREATE TABLE IF NOT EXISTS public.broker_verification_audit_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  broker_id uuid NOT NULL REFERENCES public.profiles(id) ON DELETE RESTRICT,
  submission_id uuid NULL REFERENCES public.broker_verification_submissions(id) ON DELETE RESTRICT,
  actor_id uuid NULL REFERENCES public.profiles(id) ON DELETE RESTRICT,
  event_type text NOT NULL,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT broker_verification_audit_events_type_check CHECK (event_type IN (
    'upload_prepared', 'submission_finalized', 'pending_withdrawn',
    'review_url_requested', 'review_url_issued', 'approved', 'rejected',
    'cleanup_enqueued', 'cleanup_claimed', 'cleanup_completed', 'cleanup_failed'
  )),
  CONSTRAINT broker_verification_audit_events_metadata_object_check CHECK (jsonb_typeof(metadata) = 'object')
);

CREATE TABLE IF NOT EXISTS public.broker_verification_cleanup_jobs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  submission_id uuid NULL UNIQUE REFERENCES public.broker_verification_submissions(id) ON DELETE RESTRICT,
  upload_session_id uuid NULL UNIQUE REFERENCES public.broker_verification_upload_sessions(id) ON DELETE RESTRICT,
  job_type text NOT NULL,
  state text NOT NULL DEFAULT 'queued',
  attempt_count integer NOT NULL DEFAULT 0,
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  locked_at timestamptz NULL,
  locked_by text NULL,
  last_error text NULL,
  completed_at timestamptz NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT broker_verification_cleanup_jobs_target_check CHECK (
    (submission_id IS NOT NULL AND upload_session_id IS NULL)
    OR (submission_id IS NULL AND upload_session_id IS NOT NULL)
  ),
  CONSTRAINT broker_verification_cleanup_jobs_type_check CHECK (
    (job_type = 'delete_obsolete_submission_document' AND submission_id IS NOT NULL)
    OR (job_type = 'delete_abandoned_upload' AND upload_session_id IS NOT NULL)
  ),
  CONSTRAINT broker_verification_cleanup_jobs_state_check CHECK (state IN (
    'queued', 'processing', 'retryable_failure', 'completed', 'terminal_failure'
  )),
  CONSTRAINT broker_verification_cleanup_jobs_attempt_count_check CHECK (attempt_count >= 0),
  CONSTRAINT broker_verification_cleanup_jobs_error_check CHECK (last_error IS NULL OR char_length(last_error) <= 1000)
);

CREATE UNIQUE INDEX IF NOT EXISTS broker_verification_one_active_pending_per_broker
  ON public.broker_verification_submissions (broker_id)
  WHERE review_status = 'Pending' AND withdrawn_at IS NULL AND superseded_at IS NULL;
CREATE INDEX IF NOT EXISTS broker_verification_submissions_review_queue_idx
  ON public.broker_verification_submissions (submitted_at, id)
  WHERE review_status = 'Pending' AND withdrawn_at IS NULL AND superseded_at IS NULL;
CREATE INDEX IF NOT EXISTS broker_verification_audit_events_broker_created_idx
  ON public.broker_verification_audit_events (broker_id, created_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS broker_verification_cleanup_jobs_ready_idx
  ON public.broker_verification_cleanup_jobs (next_attempt_at, id)
  WHERE state IN ('queued', 'retryable_failure');

-- Fail closed if a same-named object was created with an unexpected core shape.
DO $$
DECLARE required_column text;
BEGIN
  FOREACH required_column IN ARRAY ARRAY['broker_id', 'current_approved_submission_id', 'created_at', 'updated_at'] LOOP
    IF NOT EXISTS (
      SELECT 1 FROM pg_attribute a
      WHERE a.attrelid = 'public.broker_verification_status'::regclass
        AND a.attname = required_column AND a.attnum > 0 AND NOT a.attisdropped
    ) THEN RAISE EXCEPTION 'broker_verification_status lacks required column %', required_column; END IF;
  END LOOP;
  FOREACH required_column IN ARRAY ARRAY['broker_id', 'upload_session_id', 'document_type', 'object_key', 'review_status'] LOOP
    IF NOT EXISTS (
      SELECT 1 FROM pg_attribute a
      WHERE a.attrelid = 'public.broker_verification_submissions'::regclass
        AND a.attname = required_column AND a.attnum > 0 AND NOT a.attisdropped
    ) THEN RAISE EXCEPTION 'broker_verification_submissions lacks required column %', required_column; END IF;
  END LOOP;
END;
$$;

-- Keep profile-role and cross-table record integrity enforceable after insert.
CREATE OR REPLACE FUNCTION public.enforce_broker_verification_record_broker()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO pg_catalog, public
AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.profiles p WHERE p.id = NEW.broker_id AND p.role = 'Broker') THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'Verification records require a Broker profile';
  END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION public.enforce_broker_verification_submission_integrity()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO pg_catalog, public
AS $$
DECLARE
  session_row public.broker_verification_upload_sessions%ROWTYPE;
BEGIN
  SELECT * INTO session_row
  FROM public.broker_verification_upload_sessions
  WHERE id = NEW.upload_session_id;
  IF NOT FOUND OR session_row.broker_id IS DISTINCT FROM NEW.broker_id
     OR session_row.document_type IS DISTINCT FROM NEW.document_type
     OR session_row.expected_object_key IS DISTINCT FROM NEW.object_key THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'Submission must use its Broker-owned upload session and expected object key';
  END IF;
  IF NEW.replaces_submission_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM public.broker_verification_submissions s
    WHERE s.id = NEW.replaces_submission_id AND s.broker_id = NEW.broker_id
  ) THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'Replacement must reference a prior submission for the same Broker';
  END IF;
  IF NEW.superseded_by_submission_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM public.broker_verification_submissions s
    WHERE s.id = NEW.superseded_by_submission_id AND s.broker_id = NEW.broker_id
  ) THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'Supersession must reference a submission for the same Broker';
  END IF;
  IF NEW.reviewed_by IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM public.profiles p
    WHERE p.id = NEW.reviewed_by
      AND (p.role = 'Admin' OR (p.role = 'Employee' AND p.employee_type = 'Employee 2'))
  ) THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'Identity verification reviewer must be an Admin or Employee 2';
  END IF;
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION public.enforce_broker_verification_status_reference()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO pg_catalog, public
AS $$
BEGIN
  IF NEW.current_approved_submission_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM public.broker_verification_submissions s
    WHERE s.id = NEW.current_approved_submission_id
      AND s.broker_id = NEW.broker_id
      AND s.review_status = 'Approved'
      AND s.superseded_at IS NULL
  ) THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'Current approved verification must be an unsuperseded approved submission for the same Broker';
  END IF;
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION public.prevent_broker_verification_role_change()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO pg_catalog, public
AS $$
BEGIN
  IF OLD.role IS DISTINCT FROM NEW.role
     AND (
       EXISTS (SELECT 1 FROM public.broker_verification_status s WHERE s.broker_id = OLD.id)
       OR EXISTS (SELECT 1 FROM public.broker_verification_submissions s WHERE s.broker_id = OLD.id)
     ) THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'Cannot change a Broker role while identity verification records exist';
  END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION public.prevent_broker_verification_audit_mutation()
RETURNS trigger
LANGUAGE plpgsql
SET search_path TO pg_catalog
AS $$
BEGIN
  RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'Broker verification audit events are immutable';
END;
$$;

CREATE OR REPLACE FUNCTION public.set_broker_verification_updated_at()
RETURNS trigger
LANGUAGE plpgsql
SET search_path TO pg_catalog
AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.enforce_broker_verification_record_broker() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.enforce_broker_verification_submission_integrity() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.enforce_broker_verification_status_reference() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.prevent_broker_verification_role_change() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.prevent_broker_verification_audit_mutation() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.set_broker_verification_updated_at() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS trg_verification_status_requires_broker ON public.broker_verification_status;
CREATE TRIGGER trg_verification_status_requires_broker
  BEFORE INSERT OR UPDATE OF broker_id ON public.broker_verification_status
  FOR EACH ROW EXECUTE FUNCTION public.enforce_broker_verification_record_broker();
DROP TRIGGER IF EXISTS trg_verification_submission_requires_broker ON public.broker_verification_submissions;
CREATE TRIGGER trg_verification_submission_requires_broker
  BEFORE INSERT OR UPDATE OF broker_id ON public.broker_verification_submissions
  FOR EACH ROW EXECUTE FUNCTION public.enforce_broker_verification_record_broker();
DROP TRIGGER IF EXISTS trg_verification_submission_integrity ON public.broker_verification_submissions;
CREATE TRIGGER trg_verification_submission_integrity
  BEFORE INSERT OR UPDATE ON public.broker_verification_submissions
  FOR EACH ROW EXECUTE FUNCTION public.enforce_broker_verification_submission_integrity();
DROP TRIGGER IF EXISTS trg_verification_status_reference ON public.broker_verification_status;
CREATE TRIGGER trg_verification_status_reference
  BEFORE INSERT OR UPDATE ON public.broker_verification_status
  FOR EACH ROW EXECUTE FUNCTION public.enforce_broker_verification_status_reference();
DROP TRIGGER IF EXISTS trg_prevent_broker_verification_role_change ON public.profiles;
CREATE TRIGGER trg_prevent_broker_verification_role_change
  BEFORE UPDATE OF role ON public.profiles
  FOR EACH ROW EXECUTE FUNCTION public.prevent_broker_verification_role_change();
DROP TRIGGER IF EXISTS trg_prevent_broker_verification_audit_update ON public.broker_verification_audit_events;
CREATE TRIGGER trg_prevent_broker_verification_audit_update
  BEFORE UPDATE OR DELETE ON public.broker_verification_audit_events
  FOR EACH ROW EXECUTE FUNCTION public.prevent_broker_verification_audit_mutation();
DROP TRIGGER IF EXISTS trg_set_verification_status_updated_at ON public.broker_verification_status;
CREATE TRIGGER trg_set_verification_status_updated_at
  BEFORE UPDATE ON public.broker_verification_status
  FOR EACH ROW EXECUTE FUNCTION public.set_broker_verification_updated_at();
DROP TRIGGER IF EXISTS trg_set_verification_cleanup_updated_at ON public.broker_verification_cleanup_jobs;
CREATE TRIGGER trg_set_verification_cleanup_updated_at
  BEFORE UPDATE ON public.broker_verification_cleanup_jobs
  FOR EACH ROW EXECUTE FUNCTION public.set_broker_verification_updated_at();

-- ---------------------------------------------------------------------------
-- 4. RLS and grants: browser clients have no direct table access.
-- ---------------------------------------------------------------------------
ALTER TABLE public.broker_verification_status ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.broker_verification_upload_sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.broker_verification_submissions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.broker_verification_audit_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.broker_verification_cleanup_jobs ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE public.broker_verification_status FROM PUBLIC, anon, authenticated;
REVOKE ALL ON TABLE public.broker_verification_upload_sessions FROM PUBLIC, anon, authenticated;
REVOKE ALL ON TABLE public.broker_verification_submissions FROM PUBLIC, anon, authenticated;
REVOKE ALL ON TABLE public.broker_verification_audit_events FROM PUBLIC, anon, authenticated;
REVOKE ALL ON TABLE public.broker_verification_cleanup_jobs FROM PUBLIC, anon, authenticated;
GRANT ALL ON TABLE public.broker_verification_status TO service_role;
GRANT ALL ON TABLE public.broker_verification_upload_sessions TO service_role;
GRANT ALL ON TABLE public.broker_verification_submissions TO service_role;
GRANT ALL ON TABLE public.broker_verification_audit_events TO service_role;
GRANT ALL ON TABLE public.broker_verification_cleanup_jobs TO service_role;

-- The current repository's later rental migration makes eligible rented
-- listings public. The Top Brokers product contract is stricter: anonymous
-- users and Buyers may see only Active listings/media, while Brokers and
-- already-authorized staff retain their non-Active workflows. Restrictive
-- policies layer on top of existing policies and therefore cannot grant a
-- row that an existing policy does not already allow.
DROP POLICY IF EXISTS top_brokers_anon_active_listings_only ON public.listings;
CREATE POLICY top_brokers_anon_active_listings_only
  ON public.listings AS RESTRICTIVE
  FOR SELECT TO anon
  USING (btrim(status) = 'Active');
DROP POLICY IF EXISTS top_brokers_authenticated_active_listings_only ON public.listings;
CREATE POLICY top_brokers_authenticated_active_listings_only
  ON public.listings AS RESTRICTIVE
  FOR SELECT TO authenticated
  USING (
    btrim(status) = 'Active'
    OR (
      auth.uid() IS NOT NULL AND (
        EXISTS (
          SELECT 1 FROM public.profiles p
          WHERE p.id = auth.uid() AND p.role = 'Broker' AND p.id = listings.broker_id
        )
        OR public.is_staff()
      )
    )
  );
DROP POLICY IF EXISTS top_brokers_anon_active_listing_media_only ON public.listing_media;
CREATE POLICY top_brokers_anon_active_listing_media_only
  ON public.listing_media AS RESTRICTIVE
  FOR SELECT TO anon
  USING (EXISTS (
    SELECT 1 FROM public.listings l
    WHERE l.id = listing_media.listing_id AND btrim(l.status) = 'Active'
  ));
DROP POLICY IF EXISTS top_brokers_authenticated_active_listing_media_only ON public.listing_media;
CREATE POLICY top_brokers_authenticated_active_listing_media_only
  ON public.listing_media AS RESTRICTIVE
  FOR SELECT TO authenticated
  USING (EXISTS (
    SELECT 1 FROM public.listings l
    WHERE l.id = listing_media.listing_id
      AND (
        btrim(l.status) = 'Active'
        OR (l.broker_id = auth.uid() AND EXISTS (
          SELECT 1 FROM public.profiles p WHERE p.id = auth.uid() AND p.role = 'Broker'
        ))
        OR public.is_staff()
      )
  ));

-- ---------------------------------------------------------------------------
-- 5. SQL RPCs. Edge Functions remain responsible for signed URL operations.
-- ---------------------------------------------------------------------------
-- Service-role helper for the Edge upload endpoint. It creates the only
-- browser-usable upload context and generates the opaque object key itself.
-- The Edge Function must validate its caller's JWT before using this helper,
-- then return only session_id and a signed upload URL to the browser.
CREATE OR REPLACE FUNCTION public.create_broker_identity_upload_session(
  p_broker_id uuid,
  p_document_type text,
  p_ttl_seconds integer DEFAULT 900
)
RETURNS TABLE (upload_session_id uuid, object_key text, expires_at timestamptz)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO pg_catalog, public
AS $$
DECLARE new_session_id uuid := gen_random_uuid();
DECLARE generated_object_key text;
DECLARE status_row public.broker_verification_status%ROWTYPE;
BEGIN
  IF auth.role() <> 'service_role' THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'IDENTITY_UPLOAD_PREPARER_REQUIRED';
  END IF;
  IF p_document_type NOT IN ('Aadhaar', 'Passport') THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'IDENTITY_DOCUMENT_TYPE_INVALID';
  END IF;
  IF p_ttl_seconds NOT BETWEEN 60 AND 3600 THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'IDENTITY_UPLOAD_TTL_INVALID';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.profiles p WHERE p.id = p_broker_id AND p.role = 'Broker') THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'IDENTITY_BROKER_NOT_FOUND';
  END IF;
  INSERT INTO public.broker_verification_status (broker_id)
  VALUES (p_broker_id) ON CONFLICT (broker_id) DO NOTHING;
  SELECT * INTO status_row FROM public.broker_verification_status
  WHERE broker_id = p_broker_id FOR UPDATE;
  IF EXISTS (
    SELECT 1 FROM public.broker_verification_submissions s
    WHERE s.broker_id = p_broker_id AND s.review_status = 'Pending'
      AND s.withdrawn_at IS NULL AND s.superseded_at IS NULL
  ) THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'IDENTITY_PENDING_SUBMISSION_EXISTS';
  END IF;
  IF EXISTS (
    SELECT 1 FROM public.broker_verification_upload_sessions s
    WHERE s.broker_id = p_broker_id AND s.used_at IS NULL
      AND s.abandoned_at IS NULL AND s.expires_at > now()
  ) THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'IDENTITY_UPLOAD_SESSION_EXISTS';
  END IF;
  generated_object_key := format('broker/%s/%s/document', p_broker_id, new_session_id);
  INSERT INTO public.broker_verification_upload_sessions (
    id, broker_id, document_type, expected_object_key, expires_at
  ) VALUES (
    new_session_id, p_broker_id, p_document_type, generated_object_key,
    now() + make_interval(secs => p_ttl_seconds)
  );
  INSERT INTO public.broker_verification_audit_events (broker_id, actor_id, event_type)
  VALUES (p_broker_id, NULL, 'upload_prepared');
  RETURN QUERY SELECT new_session_id, generated_object_key, now() + make_interval(secs => p_ttl_seconds);
END;
$$;

CREATE OR REPLACE FUNCTION public.finalize_broker_identity_submission(p_upload_session_id uuid)
RETURNS TABLE (submission_id uuid, verification_status text, submitted_at timestamptz)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO pg_catalog, public, storage
AS $$
DECLARE
  upload_row public.broker_verification_upload_sessions%ROWTYPE;
  status_row public.broker_verification_status%ROWTYPE;
  object_metadata jsonb;
  object_size bigint;
  object_mime text;
  new_submission_id uuid;
BEGIN
  IF auth.uid() IS NULL OR NOT public.is_broker_identity_owner(auth.uid()) THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'Only the authenticated Broker may finalize identity verification';
  END IF;

  SELECT * INTO upload_row
  FROM public.broker_verification_upload_sessions
  WHERE id = p_upload_session_id AND broker_id = auth.uid()
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'IDENTITY_UPLOAD_SESSION_NOT_FOUND';
  END IF;
  IF upload_row.used_at IS NOT NULL OR upload_row.abandoned_at IS NOT NULL THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'IDENTITY_UPLOAD_SESSION_ALREADY_CONSUMED';
  END IF;
  IF upload_row.expires_at <= now() THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'IDENTITY_UPLOAD_SESSION_EXPIRED';
  END IF;

  SELECT o.metadata INTO object_metadata
  FROM storage.objects o
  WHERE o.bucket_id = 'broker-identity-documents'
    AND o.name = upload_row.expected_object_key;
  IF object_metadata IS NULL THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'IDENTITY_DOCUMENT_NOT_UPLOADED';
  END IF;
  object_mime := coalesce(object_metadata ->> 'mimetype', '');
  object_size := CASE WHEN coalesce(object_metadata ->> 'size', '') ~ '^[0-9]+$'
    THEN (object_metadata ->> 'size')::bigint ELSE NULL END;
  IF object_mime NOT IN ('application/pdf', 'image/jpeg', 'image/png')
     OR object_size IS NULL OR object_size > 10485760 THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'IDENTITY_DOCUMENT_METADATA_INVALID';
  END IF;

  INSERT INTO public.broker_verification_status (broker_id)
  VALUES (auth.uid())
  ON CONFLICT (broker_id) DO NOTHING;
  SELECT * INTO status_row FROM public.broker_verification_status
  WHERE broker_id = auth.uid() FOR UPDATE;

  IF EXISTS (
    SELECT 1 FROM public.broker_verification_submissions s
    WHERE s.broker_id = auth.uid() AND s.review_status = 'Pending'
      AND s.withdrawn_at IS NULL AND s.superseded_at IS NULL
  ) THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'IDENTITY_PENDING_SUBMISSION_EXISTS';
  END IF;

  INSERT INTO public.broker_verification_submissions (
    broker_id, upload_session_id, document_type, object_key, replaces_submission_id
  ) VALUES (
    auth.uid(), upload_row.id, upload_row.document_type, upload_row.expected_object_key,
    status_row.current_approved_submission_id
  ) RETURNING id INTO new_submission_id;

  UPDATE public.broker_verification_upload_sessions SET used_at = now()
  WHERE id = upload_row.id;
  INSERT INTO public.broker_verification_audit_events (broker_id, submission_id, actor_id, event_type)
  VALUES (auth.uid(), new_submission_id, auth.uid(), 'submission_finalized');

  RETURN QUERY SELECT new_submission_id,
    CASE WHEN status_row.current_approved_submission_id IS NOT NULL THEN 'Verified' ELSE 'Pending Verification' END,
    now();
END;
$$;

CREATE OR REPLACE FUNCTION public.withdraw_pending_broker_identity_submission(p_submission_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO pg_catalog, public
AS $$
DECLARE submission_row public.broker_verification_submissions%ROWTYPE;
BEGIN
  IF auth.uid() IS NULL OR NOT public.is_broker_identity_owner(auth.uid()) THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'Only the authenticated Broker may withdraw a submission';
  END IF;
  SELECT * INTO submission_row FROM public.broker_verification_submissions
  WHERE id = p_submission_id AND broker_id = auth.uid() FOR UPDATE;
  IF NOT FOUND OR submission_row.review_status <> 'Pending'
     OR submission_row.withdrawn_at IS NOT NULL OR submission_row.superseded_at IS NOT NULL THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'IDENTITY_SUBMISSION_NOT_WITHDRAWABLE';
  END IF;
  UPDATE public.broker_verification_submissions SET withdrawn_at = now()
  WHERE id = submission_row.id;
  INSERT INTO public.broker_verification_audit_events (broker_id, submission_id, actor_id, event_type)
  VALUES (auth.uid(), submission_row.id, auth.uid(), 'pending_withdrawn');
  INSERT INTO public.broker_verification_cleanup_jobs (submission_id, job_type)
  VALUES (submission_row.id, 'delete_obsolete_submission_document')
  ON CONFLICT (submission_id) DO NOTHING;
  INSERT INTO public.broker_verification_audit_events (broker_id, submission_id, actor_id, event_type)
  VALUES (auth.uid(), submission_row.id, auth.uid(), 'cleanup_enqueued');
END;
$$;

CREATE OR REPLACE FUNCTION public.get_own_broker_verification_status()
RETURNS TABLE (
  verification_status text,
  is_verified boolean,
  pending_submission_id uuid,
  pending_document_type text,
  pending_submitted_at timestamptz,
  last_rejection_reason text,
  last_rejected_at timestamptz
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO pg_catalog, public
AS $$
  WITH own_status AS (
    SELECT s.current_approved_submission_id
    FROM public.broker_verification_status s
    WHERE s.broker_id = auth.uid()
  ), pending AS (
    SELECT s.id, s.document_type, s.submitted_at
    FROM public.broker_verification_submissions s
    WHERE s.broker_id = auth.uid() AND s.review_status = 'Pending'
      AND s.withdrawn_at IS NULL AND s.superseded_at IS NULL
    ORDER BY s.submitted_at DESC, s.id DESC LIMIT 1
  ), rejected AS (
    SELECT s.rejection_reason, s.reviewed_at
    FROM public.broker_verification_submissions s
    WHERE s.broker_id = auth.uid() AND s.review_status = 'Rejected'
    ORDER BY s.reviewed_at DESC, s.id DESC LIMIT 1
  )
  SELECT
    CASE WHEN p.id IS NOT NULL THEN 'Pending Verification'
         WHEN os.current_approved_submission_id IS NOT NULL THEN 'Verified'
         WHEN r.reviewed_at IS NOT NULL THEN 'Rejected'
         ELSE 'Not Submitted' END,
    os.current_approved_submission_id IS NOT NULL,
    p.id, p.document_type, p.submitted_at, r.rejection_reason, r.reviewed_at
  FROM (SELECT 1) seed
  LEFT JOIN own_status os ON true
  LEFT JOIN pending p ON true
  LEFT JOIN rejected r ON true
  WHERE public.is_broker_identity_owner(auth.uid());
$$;

CREATE OR REPLACE FUNCTION public.get_identity_review_queue()
RETURNS TABLE (
  submission_id uuid,
  broker_id uuid,
  broker_name text,
  broker_avatar_url text,
  document_type text,
  submitted_at timestamptz,
  is_replacement boolean
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO pg_catalog, public
AS $$
  SELECT s.id, s.broker_id, p.full_name, p.avatar_url, s.document_type,
         s.submitted_at, s.replaces_submission_id IS NOT NULL
  FROM public.broker_verification_submissions s
  JOIN public.profiles p ON p.id = s.broker_id
  WHERE public.is_broker_identity_reviewer()
    AND s.review_status = 'Pending'
    AND s.withdrawn_at IS NULL
    AND s.superseded_at IS NULL
  ORDER BY s.submitted_at ASC, s.id ASC;
$$;

CREATE OR REPLACE FUNCTION public.get_broker_verification_history(p_broker_id uuid)
RETURNS TABLE (
  submission_id uuid,
  document_type text,
  review_status text,
  submitted_at timestamptz,
  reviewed_at timestamptz,
  rejection_reason text,
  is_current_approved boolean,
  is_superseded boolean,
  is_withdrawn boolean
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO pg_catalog, public
AS $$
  SELECT s.id, s.document_type, s.review_status, s.submitted_at, s.reviewed_at,
    s.rejection_reason, vs.current_approved_submission_id = s.id,
    s.superseded_at IS NOT NULL, s.withdrawn_at IS NOT NULL
  FROM public.broker_verification_submissions s
  LEFT JOIN public.broker_verification_status vs ON vs.broker_id = s.broker_id
  WHERE s.broker_id = p_broker_id
    AND (public.is_broker_identity_owner(p_broker_id) OR public.is_broker_identity_reviewer())
  ORDER BY s.submitted_at DESC, s.id DESC;
$$;

CREATE OR REPLACE FUNCTION public.approve_broker_identity_submission(p_submission_id uuid)
RETURNS TABLE (broker_id uuid, is_verified boolean, approved_at timestamptz)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO pg_catalog, public
AS $$
DECLARE submission_row public.broker_verification_submissions%ROWTYPE;
DECLARE status_row public.broker_verification_status%ROWTYPE;
DECLARE obsolete_submission_id uuid;
BEGIN
  IF auth.uid() IS NULL OR NOT public.is_broker_identity_reviewer() THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'IDENTITY_REVIEWER_REQUIRED';
  END IF;
  SELECT * INTO submission_row FROM public.broker_verification_submissions
  WHERE id = p_submission_id FOR UPDATE;
  IF NOT FOUND OR submission_row.review_status <> 'Pending'
     OR submission_row.withdrawn_at IS NOT NULL OR submission_row.superseded_at IS NOT NULL THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'IDENTITY_SUBMISSION_STALE_OR_NOT_PENDING';
  END IF;
  INSERT INTO public.broker_verification_status (broker_id)
  VALUES (submission_row.broker_id) ON CONFLICT (broker_id) DO NOTHING;
  SELECT * INTO status_row FROM public.broker_verification_status
  WHERE broker_id = submission_row.broker_id FOR UPDATE;
  UPDATE public.broker_verification_submissions
  SET review_status = 'Approved', reviewed_at = now(), reviewed_by = auth.uid()
  WHERE id = submission_row.id;
  UPDATE public.broker_verification_status
  SET current_approved_submission_id = submission_row.id
  WHERE broker_id = submission_row.broker_id;

  -- Once a replacement is approved, every older rejected, withdrawn, or
  -- formerly approved document becomes obsolete. Metadata/history remains;
  -- only its private object is queued for trusted-worker deletion.
  FOR obsolete_submission_id IN
    UPDATE public.broker_verification_submissions
    SET superseded_at = now(), superseded_by_submission_id = submission_row.id
    WHERE broker_id = submission_row.broker_id
      AND id <> submission_row.id
      AND superseded_at IS NULL
      AND (
        review_status IN ('Approved', 'Rejected')
        OR withdrawn_at IS NOT NULL
      )
    RETURNING id
  LOOP
    INSERT INTO public.broker_verification_cleanup_jobs (submission_id, job_type)
    VALUES (obsolete_submission_id, 'delete_obsolete_submission_document')
    ON CONFLICT (submission_id) DO NOTHING;
    INSERT INTO public.broker_verification_audit_events (broker_id, submission_id, actor_id, event_type)
    VALUES (submission_row.broker_id, obsolete_submission_id, auth.uid(), 'cleanup_enqueued');
  END LOOP;
  INSERT INTO public.broker_verification_audit_events (broker_id, submission_id, actor_id, event_type)
  VALUES (submission_row.broker_id, submission_row.id, auth.uid(), 'approved');
  RETURN QUERY SELECT submission_row.broker_id, true, now();
END;
$$;

CREATE OR REPLACE FUNCTION public.reject_broker_identity_submission(
  p_submission_id uuid,
  p_rejection_reason text
)
RETURNS TABLE (broker_id uuid, is_verified boolean, rejected_at timestamptz)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO pg_catalog, public
AS $$
DECLARE submission_row public.broker_verification_submissions%ROWTYPE;
DECLARE is_currently_verified boolean;
BEGIN
  IF auth.uid() IS NULL OR NOT public.is_broker_identity_reviewer() THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'IDENTITY_REVIEWER_REQUIRED';
  END IF;
  IF NULLIF(btrim(p_rejection_reason), '') IS NULL OR char_length(btrim(p_rejection_reason)) > 1000 THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'IDENTITY_REJECTION_REASON_REQUIRED';
  END IF;
  SELECT * INTO submission_row FROM public.broker_verification_submissions
  WHERE id = p_submission_id FOR UPDATE;
  IF NOT FOUND OR submission_row.review_status <> 'Pending'
     OR submission_row.withdrawn_at IS NOT NULL OR submission_row.superseded_at IS NOT NULL THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'IDENTITY_SUBMISSION_STALE_OR_NOT_PENDING';
  END IF;
  SELECT EXISTS (
    SELECT 1 FROM public.broker_verification_status s
    WHERE s.broker_id = submission_row.broker_id
      AND s.current_approved_submission_id IS NOT NULL
  ) INTO is_currently_verified;
  UPDATE public.broker_verification_submissions
  SET review_status = 'Rejected', reviewed_at = now(), reviewed_by = auth.uid(),
      rejection_reason = btrim(p_rejection_reason)
  WHERE id = submission_row.id;
  INSERT INTO public.broker_verification_audit_events (broker_id, submission_id, actor_id, event_type)
  VALUES (submission_row.broker_id, submission_row.id, auth.uid(), 'rejected');
  RETURN QUERY SELECT submission_row.broker_id, is_currently_verified, now();
END;
$$;

-- Service-role-only worker helpers. They do not access Storage themselves.
CREATE OR REPLACE FUNCTION public.enqueue_expired_broker_verification_upload_cleanup()
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO pg_catalog, public
AS $$
DECLARE inserted_count integer;
BEGIN
  IF auth.role() <> 'service_role' THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'IDENTITY_CLEANUP_WORKER_REQUIRED';
  END IF;
  WITH expired AS (
    SELECT s.id, s.broker_id
    FROM public.broker_verification_upload_sessions s
    WHERE s.used_at IS NULL AND s.abandoned_at IS NULL AND s.expires_at <= now()
    FOR UPDATE SKIP LOCKED
  ), marked AS (
    UPDATE public.broker_verification_upload_sessions s
    SET abandoned_at = now()
    FROM expired e WHERE s.id = e.id
    RETURNING s.id, s.broker_id
  ), jobs AS (
    INSERT INTO public.broker_verification_cleanup_jobs (upload_session_id, job_type)
    SELECT id, 'delete_abandoned_upload' FROM marked
    ON CONFLICT (upload_session_id) DO NOTHING
    RETURNING upload_session_id
  ), audit AS (
    INSERT INTO public.broker_verification_audit_events (broker_id, actor_id, event_type)
    SELECT broker_id, NULL, 'cleanup_enqueued' FROM marked
    RETURNING id
  )
  SELECT count(*)::integer INTO inserted_count FROM jobs;
  RETURN COALESCE(inserted_count, 0);
END;
$$;

CREATE OR REPLACE FUNCTION public.claim_broker_verification_cleanup_jobs(p_limit integer DEFAULT 10)
RETURNS TABLE (job_id uuid, submission_id uuid, upload_session_id uuid, object_key text)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO pg_catalog, public
AS $$
BEGIN
  IF auth.role() <> 'service_role' THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'IDENTITY_CLEANUP_WORKER_REQUIRED';
  END IF;
  RETURN QUERY
  WITH candidates AS (
    SELECT j.id
    FROM public.broker_verification_cleanup_jobs j
    WHERE j.state IN ('queued', 'retryable_failure') AND j.next_attempt_at <= now()
    ORDER BY j.next_attempt_at, j.id
    FOR UPDATE SKIP LOCKED
    LIMIT GREATEST(1, LEAST(p_limit, 100))
  ), claimed AS (
    UPDATE public.broker_verification_cleanup_jobs j
    SET state = 'processing', locked_at = now(), locked_by = 'edge-worker',
        attempt_count = attempt_count + 1
    FROM candidates c WHERE j.id = c.id
    RETURNING j.id, j.submission_id, j.upload_session_id
  )
  SELECT c.id, c.submission_id, c.upload_session_id,
    COALESCE(s.object_key, u.expected_object_key)
  FROM claimed c
  LEFT JOIN public.broker_verification_submissions s ON s.id = c.submission_id
  LEFT JOIN public.broker_verification_upload_sessions u ON u.id = c.upload_session_id;
END;
$$;

CREATE OR REPLACE FUNCTION public.complete_broker_verification_cleanup_job(
  p_job_id uuid,
  p_succeeded boolean,
  p_error text DEFAULT NULL
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO pg_catalog, public
AS $$
DECLARE job_row public.broker_verification_cleanup_jobs%ROWTYPE;
DECLARE event_name text;
BEGIN
  IF auth.role() <> 'service_role' THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'IDENTITY_CLEANUP_WORKER_REQUIRED';
  END IF;
  SELECT * INTO job_row FROM public.broker_verification_cleanup_jobs WHERE id = p_job_id FOR UPDATE;
  IF NOT FOUND OR job_row.state <> 'processing' THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'IDENTITY_CLEANUP_JOB_NOT_PROCESSING';
  END IF;
  IF p_succeeded THEN
    UPDATE public.broker_verification_cleanup_jobs
    SET state = 'completed', completed_at = now(), last_error = NULL, locked_at = NULL, locked_by = NULL
    WHERE id = p_job_id;
    event_name := 'cleanup_completed';
  ELSE
    UPDATE public.broker_verification_cleanup_jobs
    SET state = CASE WHEN attempt_count >= 10 THEN 'terminal_failure' ELSE 'retryable_failure' END,
        next_attempt_at = CASE WHEN attempt_count >= 10 THEN next_attempt_at
          ELSE now() + make_interval(mins => LEAST(1440, 2 ^ LEAST(attempt_count, 10))::integer) END,
        last_error = left(NULLIF(btrim(p_error), ''), 1000), locked_at = NULL, locked_by = NULL
    WHERE id = p_job_id;
    event_name := 'cleanup_failed';
  END IF;
  INSERT INTO public.broker_verification_audit_events (broker_id, submission_id, event_type)
  SELECT s.broker_id, s.id, event_name
  FROM public.broker_verification_submissions s WHERE s.id = job_row.submission_id
  UNION ALL
  SELECT u.broker_id, NULL, event_name
  FROM public.broker_verification_upload_sessions u WHERE u.id = job_row.upload_session_id;
END;
$$;

-- ---------------------------------------------------------------------------
-- 6. Safe public broker projections. No private verification metadata leaks.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.get_public_broker_verification_status(p_broker_id uuid)
RETURNS TABLE (broker_id uuid, is_verified boolean)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO pg_catalog, public
AS $$
  SELECT p.id, COALESCE(s.current_approved_submission_id IS NOT NULL, false)
  FROM public.profiles p
  LEFT JOIN public.broker_verification_status s ON s.broker_id = p.id
  WHERE p.id = p_broker_id AND p.role = 'Broker';
$$;

CREATE OR REPLACE FUNCTION public.get_public_top_brokers(
  p_areas text[] DEFAULT NULL,
  p_property_type text DEFAULT NULL,
  p_min_rating smallint DEFAULT NULL
)
RETURNS TABLE (
  broker_id uuid,
  full_name text,
  avatar_url text,
  agency_name text,
  years_experience smallint,
  areas_of_operation text[],
  is_verified boolean,
  average_rating numeric,
  rating_count bigint,
  active_listing_count bigint,
  total_listing_count bigint
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO pg_catalog, public
AS $$
BEGIN
  IF p_areas IS NOT NULL AND cardinality(p_areas) > 0
     AND NOT public.broker_operation_areas_are_valid(p_areas) THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'TOP_BROKERS_AREAS_INVALID';
  END IF;
  IF p_min_rating IS NOT NULL AND p_min_rating NOT BETWEEN 1 AND 5 THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'TOP_BROKERS_MINIMUM_RATING_INVALID';
  END IF;
  RETURN QUERY
  WITH rating_stats AS (
    SELECT r.broker_id, avg(r.rating)::numeric AS average_rating, count(*)::bigint AS rating_count
    FROM public.broker_ratings r GROUP BY r.broker_id
  ), listing_stats AS (
    SELECT l.broker_id,
      count(*) FILTER (WHERE btrim(l.status) = 'Active')::bigint AS active_listing_count,
      count(*) FILTER (WHERE btrim(l.status) IN ('Active', 'Pending', 'Sold'))::bigint AS total_listing_count,
      bool_or(
        btrim(l.status) = 'Active'
        AND NULLIF(btrim(l.type), '') = NULLIF(btrim(p_property_type), '')
      ) AS has_matching_property_type
    FROM public.listings l
    WHERE l.broker_id IS NOT NULL
    GROUP BY l.broker_id
  )
  SELECT p.id, p.full_name, p.avatar_url, d.agency_name, d.years_experience,
    COALESCE(d.areas_of_operation, ARRAY[]::text[]),
    COALESCE(v.current_approved_submission_id IS NOT NULL, false),
    r.average_rating, COALESCE(r.rating_count, 0::bigint),
    COALESCE(l.active_listing_count, 0::bigint), COALESCE(l.total_listing_count, 0::bigint)
  FROM public.profiles p
  LEFT JOIN public.broker_public_details d ON d.broker_id = p.id
  LEFT JOIN public.broker_verification_status v ON v.broker_id = p.id
  LEFT JOIN rating_stats r ON r.broker_id = p.id
  LEFT JOIN listing_stats l ON l.broker_id = p.id
  WHERE p.role = 'Broker'
    AND (p_areas IS NULL OR cardinality(p_areas) = 0 OR d.areas_of_operation && p_areas)
    AND (NULLIF(btrim(p_property_type), '') IS NULL OR COALESCE(l.has_matching_property_type, false))
    AND (p_min_rating IS NULL OR r.average_rating >= p_min_rating)
  ORDER BY
    COALESCE(l.active_listing_count, 0) DESC,
    r.average_rating DESC NULLS LAST,
    COALESCE(r.rating_count, 0) DESC,
    COALESCE(l.total_listing_count, 0) DESC,
    p.full_name ASC NULLS LAST,
    p.id ASC;
END;
$$;

CREATE OR REPLACE FUNCTION public.get_public_broker_property_types()
RETURNS TABLE (property_type text)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO pg_catalog, public
AS $$
  SELECT DISTINCT btrim(l.type)
  FROM public.listings l
  WHERE btrim(l.status) = 'Active' AND NULLIF(btrim(l.type), '') IS NOT NULL
  ORDER BY btrim(l.type);
$$;

CREATE OR REPLACE FUNCTION public.get_public_broker_profile(p_broker_id uuid)
RETURNS TABLE (
  broker_id uuid,
  full_name text,
  avatar_url text,
  agency_name text,
  years_experience smallint,
  areas_of_operation text[],
  is_verified boolean,
  average_rating numeric,
  rating_count bigint,
  active_listing_count bigint,
  total_listing_count bigint
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO pg_catalog, public
AS $$
  SELECT *
  FROM public.get_public_top_brokers(NULL, NULL, NULL)
  WHERE broker_id = p_broker_id;
$$;

-- Public functions return deliberately narrow fields. Rating records and
-- document metadata remain inaccessible through tables and public RPCs.
REVOKE ALL ON FUNCTION public.finalize_broker_identity_submission(uuid) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.create_broker_identity_upload_session(uuid, text, integer) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.withdraw_pending_broker_identity_submission(uuid) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.get_own_broker_verification_status() FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.get_identity_review_queue() FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.get_broker_verification_history(uuid) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.approve_broker_identity_submission(uuid) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.reject_broker_identity_submission(uuid, text) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.enqueue_expired_broker_verification_upload_cleanup() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.claim_broker_verification_cleanup_jobs(integer) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.complete_broker_verification_cleanup_job(uuid, boolean, text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.get_public_broker_verification_status(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.get_public_top_brokers(text[], text, smallint) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.get_public_broker_property_types() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.get_public_broker_profile(uuid) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION public.finalize_broker_identity_submission(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.create_broker_identity_upload_session(uuid, text, integer) TO service_role;
GRANT EXECUTE ON FUNCTION public.withdraw_pending_broker_identity_submission(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.get_own_broker_verification_status() TO authenticated;
GRANT EXECUTE ON FUNCTION public.get_identity_review_queue() TO authenticated;
GRANT EXECUTE ON FUNCTION public.get_broker_verification_history(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.approve_broker_identity_submission(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.reject_broker_identity_submission(uuid, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.enqueue_expired_broker_verification_upload_cleanup() TO service_role;
GRANT EXECUTE ON FUNCTION public.claim_broker_verification_cleanup_jobs(integer) TO service_role;
GRANT EXECUTE ON FUNCTION public.complete_broker_verification_cleanup_job(uuid, boolean, text) TO service_role;
GRANT EXECUTE ON FUNCTION public.get_public_broker_verification_status(uuid) TO anon, authenticated;
GRANT EXECUTE ON FUNCTION public.get_public_top_brokers(text[], text, smallint) TO anon, authenticated;
GRANT EXECUTE ON FUNCTION public.get_public_broker_property_types() TO anon, authenticated;
GRANT EXECUTE ON FUNCTION public.get_public_broker_profile(uuid) TO anon, authenticated;

-- ---------------------------------------------------------------------------
-- 7. Private identity-document bucket. Edge Functions own URL generation.
-- ---------------------------------------------------------------------------
INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES (
  'broker-identity-documents', 'broker-identity-documents', false, 10485760,
  ARRAY['application/pdf', 'image/jpeg', 'image/png']::text[]
)
ON CONFLICT (id) DO NOTHING;

DO $$
DECLARE bucket_row storage.buckets%ROWTYPE;
BEGIN
  SELECT * INTO bucket_row FROM storage.buckets WHERE id = 'broker-identity-documents';
  IF NOT FOUND OR bucket_row.public IS DISTINCT FROM false
     OR bucket_row.file_size_limit IS DISTINCT FROM 10485760
     OR bucket_row.allowed_mime_types IS DISTINCT FROM ARRAY['application/pdf', 'image/jpeg', 'image/png']::text[] THEN
    RAISE EXCEPTION 'broker-identity-documents bucket exists with incompatible privacy, size, or MIME settings';
  END IF;
END;
$$;

-- Defense in depth: these restrictive policies deny browser role access even
-- if unrelated permissive Storage policies exist. Signed URLs and service-role
-- Edge/worker calls remain the only supported document-object access path.
DROP POLICY IF EXISTS broker_identity_documents_no_direct_anon_access ON storage.objects;
CREATE POLICY broker_identity_documents_no_direct_anon_access
  ON storage.objects AS RESTRICTIVE FOR ALL TO anon
  USING (bucket_id <> 'broker-identity-documents')
  WITH CHECK (bucket_id <> 'broker-identity-documents');
DROP POLICY IF EXISTS broker_identity_documents_no_direct_authenticated_access ON storage.objects;
CREATE POLICY broker_identity_documents_no_direct_authenticated_access
  ON storage.objects AS RESTRICTIVE FOR ALL TO authenticated
  USING (bucket_id <> 'broker-identity-documents')
  WITH CHECK (bucket_id <> 'broker-identity-documents');

NOTIFY pgrst, 'reload schema';

-- ---------------------------------------------------------------------------
-- Edge/worker contract (not implemented by this SQL migration):
--
-- prepare_broker_identity_upload (Edge): verify user JWT is a Broker; create
-- an upload session/object key via trusted DB access; generate a one-time
-- signed upload URL; return session id and URL but never the raw object key.
--
-- request_identity_document_access (Edge): verify Admin or Employee 2 from
-- the user JWT/profile, audit request/issuance, then generate a <=5 minute
-- signed URL for a still-authorized submission. URL issuance is not proof of
-- document viewing.
--
-- process_identity_cleanup_jobs (scheduled Edge/worker): claim jobs through
-- the service-role helper, remove the named object from the private bucket,
-- then call complete_broker_verification_cleanup_job. It must never change an
-- approved verification state when deletion retries fail.
-- ---------------------------------------------------------------------------

COMMIT;

-- Employee remains the canonical role. Employee 1 / Employee 2 belong in
-- employee_type; this migration leaves profiles.role within its existing check.

DROP TRIGGER IF  EXISTS aaa_capture_admin_employee_type_request ON public.profiles;
DROP TRIGGER IF  EXISTS zzz_admin_assign_employee_type_guard ON public.profiles;
DROP TRIGGER IF  EXISTS aaa_capture_admin_employee_role_request ON public.profiles;
DROP TRIGGER IF  EXISTS zzz_admin_assign_employee_role_guard ON public.profiles;
DROP FUNCTION IF EXISTS public.admin_assign_employee_role(text, text);
DROP FUNCTION IF EXISTS public.admin_assign_employee_role_guard();
DROP FUNCTION IF EXISTS public.capture_admin_employee_role_request();
DROP FUNCTION IF EXISTS public.admin_assign_employee_type(text, text);
DROP TRIGGER IF  EXISTS zzzz_bootstrap_first_admin_role_guard ON public.profiles;
DROP FUNCTION IF EXISTS public.bootstrap_first_admin_role_guard();
DROP FUNCTION IF EXISTS public.bootstrap_first_admin(text);
-- Employee 1 handles virtual verification and staff listing intake.
-- Employee 2 performs field verification and controls final publication.

CREATE OR REPLACE FUNCTION public.is_staff()
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO pg_catalog, public AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.profiles
    WHERE id = auth.uid() AND role IN ('Admin', 'Employee')
      AND (role = 'Admin' OR employee_type IN ('Employee 1', 'Employee 2'))
  );
$$;

CREATE OR REPLACE FUNCTION public.employee1_create_listing(
  p_title text, p_location text, p_price numeric, p_intent text DEFAULT 'Buy', p_type text DEFAULT NULL
)
RETURNS bigint
LANGUAGE plpgsql SECURITY DEFINER
SET search_path TO pg_catalog, public
AS $$
DECLARE new_id bigint; field_agent uuid;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.profiles WHERE id = auth.uid() AND (role = 'Employee' AND employee_type = 'Employee 1')) THEN
    RAISE EXCEPTION 'virtual_verifier role required';
  END IF;
  IF NULLIF(trim(p_title), '') IS NULL OR NULLIF(trim(p_location), '') IS NULL OR p_price IS NULL OR p_price <= 0 THEN
    RAISE EXCEPTION 'Title, location, and a positive price are required';
  END IF;
  SELECT id INTO field_agent FROM public.profiles WHERE (role = 'Employee' AND employee_type = 'Employee 2') ORDER BY updated_at LIMIT 1;
  INSERT INTO public.listings (title, location, price, intent, type, status, broker_id, created_by, assigned_field_agent_id, virtually_verified, field_verified)
  VALUES (trim(p_title), trim(p_location), p_price, COALESCE(NULLIF(p_intent, ''), 'Buy'), NULLIF(trim(p_type), ''), 'Pending', NULL, auth.uid(), field_agent, false, false)
  RETURNING id INTO new_id;
  RETURN new_id;
END;
$$;

CREATE OR REPLACE FUNCTION public.employee1_mark_virtual_verified(p_listing_id bigint)
RETURNS void
LANGUAGE plpgsql SECURITY DEFINER
SET search_path TO pg_catalog, public
AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.profiles WHERE id = auth.uid() AND (role = 'Employee' AND employee_type = 'Employee 1')) THEN
    RAISE EXCEPTION 'virtual_verifier role required';
  END IF;
  UPDATE public.listings
  SET virtually_verified = true, virtually_verified_by = auth.uid()
  WHERE id = p_listing_id AND broker_id IS NOT NULL
    AND (assigned_virtual_verifier_id IS NULL OR assigned_virtual_verifier_id = auth.uid());
  IF NOT FOUND THEN RAISE EXCEPTION 'Listing is not available for your virtual review'; END IF;
END;
$$;

CREATE OR REPLACE FUNCTION public.employee2_record_field_verification(
  p_listing_id bigint, p_photo_url text, p_lat double precision, p_lng double precision
)
RETURNS void
LANGUAGE plpgsql SECURITY DEFINER
SET search_path TO pg_catalog, public
AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.profiles WHERE id = auth.uid() AND (role = 'Employee' AND employee_type = 'Employee 2')) THEN
    RAISE EXCEPTION 'field_agent role required';
  END IF;
  IF p_photo_url IS NULL OR p_photo_url NOT LIKE auth.uid()::text || '/%'
     OR p_lat IS NULL OR p_lng IS NULL OR p_lat NOT BETWEEN -90 AND 90 OR p_lng NOT BETWEEN -180 AND 180 THEN
    RAISE EXCEPTION 'A valid field photo and device location are required';
  END IF;
  UPDATE public.listings
  SET field_verified = true, field_verified_by = auth.uid(), field_verification_photo_url = p_photo_url,
      field_verification_lat = p_lat, field_verification_lng = p_lng, field_verified_at = timezone('utc', now())
  WHERE id = p_listing_id AND (assigned_field_agent_id IS NULL OR assigned_field_agent_id = auth.uid());
  IF NOT FOUND THEN RAISE EXCEPTION 'Listing is not assigned for your field visit'; END IF;
END;
$$;

CREATE OR REPLACE FUNCTION public.employee2_approve_listing(p_listing_id bigint)
RETURNS void
LANGUAGE plpgsql SECURITY DEFINER
SET search_path TO pg_catalog, public
AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.profiles WHERE id = auth.uid() AND (role = 'Employee' AND employee_type = 'Employee 2')) THEN
    RAISE EXCEPTION 'field_agent role required';
  END IF;
  UPDATE public.listings SET status = 'Active'
  WHERE id = p_listing_id AND field_verified = true AND field_verified_by = auth.uid()
    AND (assigned_field_agent_id IS NULL OR assigned_field_agent_id = auth.uid());
  IF NOT FOUND THEN RAISE EXCEPTION 'Complete your field verification before approving this listing'; END IF;
END;
$$;

-- Broker and Employee 1 submissions must begin in the moderation queue even
-- when the listings table default is Active or a client tampers with status.
CREATE OR REPLACE FUNCTION public.enforce_listing_submission_workflow()
RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER
SET search_path TO pg_catalog, public
AS $$
DECLARE submitter_role text; assigned_agent uuid;
BEGIN
  IF auth.role() = 'service_role' THEN RETURN NEW; END IF;
  SELECT CASE WHEN role = 'Employee' THEN employee_type ELSE role END INTO submitter_role FROM public.profiles WHERE id = auth.uid();

  IF submitter_role = 'Broker' THEN
    NEW.broker_id := auth.uid();
    NEW.created_by := NULL;
    NEW.assigned_virtual_verifier_id := NULL;
    NEW.assigned_field_agent_id := NULL;
  ELSIF submitter_role = 'Employee 1' THEN
    NEW.broker_id := NULL;
    NEW.created_by := auth.uid();
    NEW.assigned_virtual_verifier_id := NULL;
    SELECT id INTO assigned_agent FROM public.profiles WHERE (role = 'Employee' AND employee_type = 'Employee 2') ORDER BY updated_at LIMIT 1;
    NEW.assigned_field_agent_id := assigned_agent;
  ELSE
    RAISE EXCEPTION 'Only brokers and virtual_verifier employees can submit listings';
  END IF;

  NEW.status := 'Pending';
  NEW.virtually_verified := false;
  NEW.virtually_verified_by := NULL;
  NEW.field_verified := false;
  NEW.field_verified_by := NULL;
  NEW.field_verification_photo_url := NULL;
  NEW.field_verification_lat := NULL;
  NEW.field_verification_lng := NULL;
  NEW.field_verified_at := NULL;
  RETURN NEW;
END;
$$;
ALTER TABLE public.listings ALTER COLUMN status SET DEFAULT 'Pending';
DROP TRIGGER IF EXISTS trg_enforce_listing_submission_workflow ON public.listings;
CREATE TRIGGER trg_enforce_listing_submission_workflow
  BEFORE INSERT ON public.listings
  FOR EACH ROW EXECUTE FUNCTION public.enforce_listing_submission_workflow();

CREATE OR REPLACE FUNCTION public.require_employee2_for_listing_publication()
RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER
SET search_path TO pg_catalog, public
AS $$
BEGIN
  IF NEW.status = 'Active' AND OLD.status IS DISTINCT FROM 'Active'
     AND NOT EXISTS (
       SELECT 1 FROM public.profiles
       WHERE id = auth.uid() AND (role = 'Employee' AND employee_type = 'Employee 2')
     ) THEN
    RAISE EXCEPTION 'Only field_agent can approve and publish a listing';
  END IF;
  IF NEW.status = 'Active' AND OLD.status IS DISTINCT FROM 'Active'
     AND (NEW.field_verified IS DISTINCT FROM true OR NEW.field_verified_by IS DISTINCT FROM auth.uid()
       OR (NEW.assigned_field_agent_id IS NOT NULL AND NEW.assigned_field_agent_id IS DISTINCT FROM auth.uid())) THEN
    RAISE EXCEPTION 'Field verification by the approving field_agent is required';
  END IF;
  RETURN NEW;
END;
$$;

-- The staff-creation Edge Function creates a base Employee account. This
-- Admin-only RPC assigns the selected Employee 1 / Employee 2 subtype.
CREATE OR REPLACE FUNCTION public.admin_assign_employee_type(p_email text, p_employee_type text)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path TO pg_catalog, public AS $$
BEGIN
  IF NOT public.is_admin() THEN RAISE EXCEPTION 'Admin access required'; END IF;
  IF p_employee_type NOT IN ('Employee 1', 'Employee 2') THEN RAISE EXCEPTION 'Invalid employee type'; END IF;
  PERFORM set_config('estatepro.employee_type_target', p_employee_type, true);
  UPDATE public.profiles AS p SET employee_type = p_employee_type
  FROM auth.users AS u
  WHERE p.id = u.id AND lower(COALESCE(p.email, u.email)) = lower(trim(p_email)) AND p.role = 'Employee';
  IF NOT FOUND THEN RAISE EXCEPTION 'Staff profile not found for that email'; END IF;
END;
$$;

CREATE OR REPLACE FUNCTION public.capture_admin_employee_type_request()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path TO pg_catalog, public AS $$
BEGIN
  IF public.is_admin() AND NEW.employee_type IS DISTINCT FROM OLD.employee_type THEN
    IF NEW.employee_type NOT IN ('Employee 1', 'Employee 2') THEN RAISE EXCEPTION 'Invalid employee type'; END IF;
    PERFORM set_config('estatepro.employee_type_target', NEW.employee_type, true);
  END IF;
  RETURN NEW;
END;
$$;

-- Permit ordinary Auth + profile registration to create the first Admin;
-- the trigger serializes and rejects any later public self-assignment.
CREATE OR REPLACE FUNCTION public.protect_profile_sensitive_columns()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path TO pg_catalog, public AS $$
BEGIN
  IF auth.role() = 'service_role' THEN RETURN NEW; END IF;

  IF TG_OP = 'INSERT' THEN
    IF NEW.id IS DISTINCT FROM auth.uid() THEN
      RAISE EXCEPTION 'Cannot create a profile for another user';
    END IF;
    IF NEW.role = 'Admin' THEN
      -- This is a normal profile INSERT, serialized so only one public signup
      -- can claim the initial Admin role. Later Admin accounts are provisioned
      -- through the authenticated Admin workflow.
      PERFORM pg_advisory_xact_lock(hashtext('projectx:first-admin-profile'));
      IF EXISTS (SELECT 1 FROM public.profiles WHERE role = 'Admin') THEN
        RAISE EXCEPTION 'An Admin account already exists. Ask an Admin to provision staff access.';
      END IF;
      NEW.employee_type := NULL;
      RETURN NEW;
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

  IF NEW.id IS DISTINCT FROM OLD.id THEN RAISE EXCEPTION 'Cannot change profile id'; END IF;
  IF NEW.id IS DISTINCT FROM auth.uid() THEN
    IF NOT public.is_staff() THEN RAISE EXCEPTION 'Cannot update another profile'; END IF;
    NEW.full_name := OLD.full_name;
    NEW.role := OLD.role;
    NEW.phone := OLD.phone;
    NEW.city := OLD.city;
    NEW.preferences := OLD.preferences;
    NEW.avatar_url := OLD.avatar_url;
    NEW.referred_by := OLD.referred_by;
    NEW.email := OLD.email;
    NEW.employee_type := COALESCE(current_setting('estatepro.employee_type_target', true), OLD.employee_type);
    NEW."resetOtp" := OLD."resetOtp";
    NEW."expireOtp" := OLD."expireOtp";
    NEW.referal_points := OLD.referal_points;
    NEW.wishlist := OLD.wishlist;
    RETURN NEW;
  END IF;

  IF NEW.role = 'Admin' AND NEW.role IS DISTINCT FROM OLD.role AND NEW.id = auth.uid() THEN
    PERFORM pg_advisory_xact_lock(hashtext('projectx:first-admin-profile'));
    IF EXISTS (SELECT 1 FROM public.profiles WHERE role = 'Admin') THEN
      RAISE EXCEPTION 'An Admin account already exists. Ask an Admin to provision staff access.';
    END IF;
  ELSE
    NEW.role := OLD.role;
  END IF;
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

-- Keep registration as the ordinary Auth + profile insert flow. The trigger
-- above enforces that public signup can assign Admin only when none exists.
DROP POLICY IF EXISTS profiles_insert_own ON public.profiles;
CREATE POLICY profiles_insert_own
  ON public.profiles FOR INSERT TO authenticated
  WITH CHECK (id = auth.uid() AND role IN ('Buyer', 'Broker', 'Guest', 'Admin') AND employee_type IS NULL);

-- Employee verification pages need only the signed-in employee's own profile.
-- Admin keeps full profile visibility for user and staff management.
DROP POLICY IF EXISTS profiles_select_staff ON public.profiles;
CREATE POLICY profiles_select_staff ON public.profiles
  FOR SELECT TO authenticated USING (public.is_admin());

CREATE OR REPLACE FUNCTION public.admin_assign_employee_type_guard()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path TO pg_catalog, public AS $$
DECLARE requested_type text;
BEGIN
  requested_type := current_setting('estatepro.employee_type_target', true);
  IF NEW.role = 'Admin' AND NEW.role IS DISTINCT FROM OLD.role AND NEW.id = auth.uid() THEN
    PERFORM pg_advisory_xact_lock(hashtext('projectx:first-admin-profile'));
    IF EXISTS (SELECT 1 FROM public.profiles WHERE role = 'Admin') THEN
      RAISE EXCEPTION 'An Admin account already exists. Ask an Admin to provision staff access.';
    END IF;
    RETURN NEW;
  END IF;
  IF public.is_admin() AND requested_type IN ('Employee 1', 'Employee 2') THEN
    NEW.role := 'Employee';
    NEW.employee_type := requested_type;
    RETURN NEW;
  END IF;
  NEW.role := OLD.role;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS aaa_capture_admin_employee_role_request ON public.profiles;
DROP TRIGGER IF EXISTS zzz_admin_assign_employee_role_guard ON public.profiles;
DROP TRIGGER IF EXISTS aaa_capture_admin_employee_type_request ON public.profiles;
CREATE TRIGGER aaa_capture_admin_employee_type_request BEFORE UPDATE OF employee_type ON public.profiles
FOR EACH ROW EXECUTE FUNCTION public.capture_admin_employee_type_request();
DROP TRIGGER IF EXISTS zzz_admin_assign_employee_type_guard ON public.profiles;
CREATE TRIGGER zzz_admin_assign_employee_type_guard BEFORE UPDATE OF employee_type ON public.profiles
FOR EACH ROW EXECUTE FUNCTION public.admin_assign_employee_type_guard();

DROP TRIGGER IF EXISTS trg_require_employee2_for_listing_publication ON public.listings;
CREATE TRIGGER trg_require_employee2_for_listing_publication
  BEFORE UPDATE OF status ON public.listings
  FOR EACH ROW EXECUTE FUNCTION public.require_employee2_for_listing_publication();

CREATE OR REPLACE FUNCTION public.guard_listing_verification_fields()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path TO pg_catalog, public AS $$
DECLARE virtual_assignment_changed boolean; field_assignment_changed boolean;
BEGIN
  virtual_assignment_changed := NEW.assigned_virtual_verifier_id IS DISTINCT FROM OLD.assigned_virtual_verifier_id;
  field_assignment_changed := NEW.assigned_field_agent_id IS DISTINCT FROM OLD.assigned_field_agent_id;
  IF virtual_assignment_changed OR field_assignment_changed THEN
    IF NOT public.is_admin() THEN RAISE EXCEPTION 'Only an admin can assign listing verifiers'; END IF;
  END IF;
  IF NEW.virtually_verified IS DISTINCT FROM OLD.virtually_verified
     OR NEW.virtually_verified_by IS DISTINCT FROM OLD.virtually_verified_by THEN
    IF virtual_assignment_changed AND public.is_admin()
       AND NEW.virtually_verified IS FALSE AND NEW.virtually_verified_by IS NULL THEN
      NULL;
    ELSIF NOT EXISTS (SELECT 1 FROM public.profiles WHERE id = auth.uid() AND (role = 'Employee' AND employee_type = 'Employee 1'))
       OR NEW.virtually_verified_by IS DISTINCT FROM auth.uid()
       OR NEW.broker_id IS NULL
       OR (NEW.assigned_virtual_verifier_id IS NOT NULL AND NEW.assigned_virtual_verifier_id IS DISTINCT FROM auth.uid()) THEN
      RAISE EXCEPTION 'virtual_verifier role required for virtual verification';
    END IF;
  END IF;
  IF NEW.field_verified IS DISTINCT FROM OLD.field_verified
     OR NEW.field_verified_by IS DISTINCT FROM OLD.field_verified_by
     OR NEW.field_verification_photo_url IS DISTINCT FROM OLD.field_verification_photo_url
     OR NEW.field_verification_lat IS DISTINCT FROM OLD.field_verification_lat
     OR NEW.field_verification_lng IS DISTINCT FROM OLD.field_verification_lng
     OR NEW.field_verified_at IS DISTINCT FROM OLD.field_verified_at THEN
    IF field_assignment_changed AND public.is_admin()
       AND NEW.field_verified IS FALSE AND NEW.field_verified_by IS NULL
       AND NEW.field_verification_photo_url IS NULL
       AND NEW.field_verification_lat IS NULL AND NEW.field_verification_lng IS NULL
       AND NEW.field_verified_at IS NULL THEN
      NULL;
    ELSIF NOT EXISTS (SELECT 1 FROM public.profiles WHERE id = auth.uid() AND (role = 'Employee' AND employee_type = 'Employee 2'))
       OR NEW.field_verified_by IS DISTINCT FROM auth.uid()
       OR NEW.field_verified IS DISTINCT FROM true
       OR (NEW.assigned_field_agent_id IS NOT NULL AND NEW.assigned_field_agent_id IS DISTINCT FROM auth.uid())
       OR NEW.field_verification_photo_url IS NULL
       OR NEW.field_verification_photo_url NOT LIKE auth.uid()::text || '/%'
       OR NEW.field_verification_lat IS NULL OR NEW.field_verification_lng IS NULL
       OR NEW.field_verification_lat NOT BETWEEN -90 AND 90
       OR NEW.field_verification_lng NOT BETWEEN -180 AND 180 THEN
      RAISE EXCEPTION 'field_agent role required for field verification';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS zzz_guard_listing_verification_fields ON public.listings;
CREATE TRIGGER zzz_guard_listing_verification_fields BEFORE UPDATE ON public.listings
FOR EACH ROW EXECUTE FUNCTION public.guard_listing_verification_fields();

REVOKE ALL ON FUNCTION public.employee1_create_listing(text, text, numeric, text, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.employee1_mark_virtual_verified(bigint) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.employee2_record_field_verification(bigint, text, double precision, double precision) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.employee2_approve_listing(bigint) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.enforce_listing_submission_workflow() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.require_employee2_for_listing_publication() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.admin_assign_employee_type(text, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.admin_assign_employee_type_guard() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.capture_admin_employee_type_request() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.guard_listing_verification_fields() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.employee1_create_listing(text, text, numeric, text, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.employee1_mark_virtual_verified(bigint) TO authenticated;
GRANT EXECUTE ON FUNCTION public.employee2_record_field_verification(bigint, text, double precision, double precision) TO authenticated;
GRANT EXECUTE ON FUNCTION public.employee2_approve_listing(bigint) TO authenticated;
GRANT EXECUTE ON FUNCTION public.admin_assign_employee_type(text, text) TO authenticated;

INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES ('field-verification', 'field-verification', false, 10485760, ARRAY['image/jpeg','image/png','image/webp'])
ON CONFLICT (id) DO NOTHING;

DROP POLICY IF EXISTS "Employee 2 uploads own field evidence" ON storage.objects;
CREATE POLICY "Employee 2 uploads own field evidence"
ON storage.objects FOR INSERT TO authenticated
WITH CHECK (bucket_id = 'field-verification' AND (storage.foldername(name))[1] = auth.uid()::text AND EXISTS (
  SELECT 1 FROM public.profiles p WHERE p.id = auth.uid() AND (p.role = 'Employee' AND p.employee_type = 'Employee 2')
));

DROP POLICY IF EXISTS "Staff reads field evidence" ON storage.objects;
CREATE POLICY "Staff reads field evidence"
ON storage.objects FOR SELECT TO authenticated
USING (bucket_id = 'field-verification' AND (
  EXISTS (SELECT 1 FROM public.profiles p WHERE p.id = auth.uid() AND p.role = 'Admin')
  OR ((storage.foldername(name))[1] = auth.uid()::text
    AND EXISTS (SELECT 1 FROM public.profiles p WHERE p.id = auth.uid() AND (p.role = 'Employee' AND p.employee_type = 'Employee 2')))
));

-- Apply listing access in the database as well as in the page router. The
-- restrictive policies narrow any older permissive policies already present.
ALTER TABLE public.listings ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.listings NO FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS listings_role_scope_select ON public.listings;
CREATE POLICY listings_role_scope_select ON public.listings AS RESTRICTIVE
FOR SELECT TO authenticated USING (
  status = 'Active'
  OR EXISTS (SELECT 1 FROM public.profiles p WHERE p.id = auth.uid() AND p.role = 'Admin')
  OR EXISTS (SELECT 1 FROM public.profiles p WHERE p.id = auth.uid() AND p.role = 'Broker' AND p.id = listings.broker_id)
  OR EXISTS (SELECT 1 FROM public.profiles p WHERE p.id = auth.uid() AND (p.role = 'Employee' AND p.employee_type = 'Employee 1')
    AND ((listings.broker_id IS NOT NULL AND (listings.assigned_virtual_verifier_id IS NULL OR listings.assigned_virtual_verifier_id = auth.uid()))
      OR listings.created_by = auth.uid()))
  OR EXISTS (SELECT 1 FROM public.profiles p WHERE p.id = auth.uid() AND (p.role = 'Employee' AND p.employee_type = 'Employee 2')
    AND (listings.assigned_field_agent_id IS NULL OR listings.assigned_field_agent_id = auth.uid()))
);
DROP POLICY IF EXISTS listings_role_read ON public.listings;
CREATE POLICY listings_role_read ON public.listings AS PERMISSIVE
FOR SELECT TO authenticated USING (
  status = 'Active'
  OR EXISTS (SELECT 1 FROM public.profiles p WHERE p.id = auth.uid() AND p.role = 'Admin')
  OR EXISTS (SELECT 1 FROM public.profiles p WHERE p.id = auth.uid() AND p.role = 'Broker' AND p.id = listings.broker_id)
  OR EXISTS (SELECT 1 FROM public.profiles p WHERE p.id = auth.uid() AND (p.role = 'Employee' AND p.employee_type = 'Employee 1')
    AND ((listings.broker_id IS NOT NULL AND (listings.assigned_virtual_verifier_id IS NULL OR listings.assigned_virtual_verifier_id = auth.uid()))
      OR listings.created_by = auth.uid()))
  OR EXISTS (SELECT 1 FROM public.profiles p WHERE p.id = auth.uid() AND (p.role = 'Employee' AND p.employee_type = 'Employee 2')
    AND (listings.assigned_field_agent_id IS NULL OR listings.assigned_field_agent_id = auth.uid()))
);
DROP POLICY IF EXISTS listings_public_active_scope ON public.listings;
CREATE POLICY listings_public_active_scope ON public.listings AS RESTRICTIVE
FOR SELECT TO anon USING (status = 'Active');
DROP POLICY IF EXISTS listings_public_active_read ON public.listings;
CREATE POLICY listings_public_active_read ON public.listings AS PERMISSIVE
FOR SELECT TO anon USING (status = 'Active');

DROP POLICY IF EXISTS listings_role_scope_insert ON public.listings;
CREATE POLICY listings_role_scope_insert ON public.listings AS RESTRICTIVE
FOR INSERT TO authenticated WITH CHECK (
  status = 'Pending' AND (
    (broker_id = auth.uid() AND EXISTS (SELECT 1 FROM public.profiles p WHERE p.id = auth.uid() AND p.role = 'Broker'))
    OR (broker_id IS NULL AND created_by = auth.uid()
      AND EXISTS (SELECT 1 FROM public.profiles p WHERE p.id = auth.uid() AND (p.role = 'Employee' AND p.employee_type = 'Employee 1')))
  )
);
DROP POLICY IF EXISTS listings_role_insert ON public.listings;
CREATE POLICY listings_role_insert ON public.listings AS PERMISSIVE
FOR INSERT TO authenticated WITH CHECK (
  status = 'Pending' AND (
    (broker_id = auth.uid() AND EXISTS (SELECT 1 FROM public.profiles p WHERE p.id = auth.uid() AND p.role = 'Broker'))
    OR (broker_id IS NULL AND created_by = auth.uid()
      AND EXISTS (SELECT 1 FROM public.profiles p WHERE p.id = auth.uid() AND (p.role = 'Employee' AND p.employee_type = 'Employee 1')))
  )
);

DROP POLICY IF EXISTS listings_role_scope_update ON public.listings;
CREATE POLICY listings_role_scope_update ON public.listings AS RESTRICTIVE
FOR UPDATE TO authenticated USING (
  EXISTS (SELECT 1 FROM public.profiles p WHERE p.id = auth.uid() AND p.role = 'Admin')
  OR EXISTS (SELECT 1 FROM public.profiles p WHERE p.id = auth.uid() AND p.role = 'Broker' AND p.id = listings.broker_id)
) WITH CHECK (
  EXISTS (SELECT 1 FROM public.profiles p WHERE p.id = auth.uid() AND p.role = 'Admin')
  OR EXISTS (SELECT 1 FROM public.profiles p WHERE p.id = auth.uid() AND p.role = 'Broker' AND p.id = listings.broker_id)
);
DROP POLICY IF EXISTS listings_role_update ON public.listings;
CREATE POLICY listings_role_update ON public.listings AS PERMISSIVE
FOR UPDATE TO authenticated USING (
  EXISTS (SELECT 1 FROM public.profiles p WHERE p.id = auth.uid() AND p.role = 'Admin')
  OR EXISTS (SELECT 1 FROM public.profiles p WHERE p.id = auth.uid() AND p.role = 'Broker' AND p.id = listings.broker_id)
) WITH CHECK (
  EXISTS (SELECT 1 FROM public.profiles p WHERE p.id = auth.uid() AND p.role = 'Admin')
  OR EXISTS (SELECT 1 FROM public.profiles p WHERE p.id = auth.uid() AND p.role = 'Broker' AND p.id = listings.broker_id)
);

DROP POLICY IF EXISTS listings_role_scope_delete ON public.listings;
CREATE POLICY listings_role_scope_delete ON public.listings AS RESTRICTIVE
FOR DELETE TO authenticated USING (
  EXISTS (SELECT 1 FROM public.profiles p WHERE p.id = auth.uid() AND p.role = 'Admin')
  OR EXISTS (SELECT 1 FROM public.profiles p WHERE p.id = auth.uid() AND p.role = 'Broker' AND p.id = listings.broker_id)
);
DROP POLICY IF EXISTS listings_role_delete ON public.listings;
CREATE POLICY listings_role_delete ON public.listings AS PERMISSIVE
FOR DELETE TO authenticated USING (
  EXISTS (SELECT 1 FROM public.profiles p WHERE p.id = auth.uid() AND p.role = 'Admin')
  OR EXISTS (SELECT 1 FROM public.profiles p WHERE p.id = auth.uid() AND p.role = 'Broker' AND p.id = listings.broker_id)
);

NOTIFY pgrst, 'reload schema';


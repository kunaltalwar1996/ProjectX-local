-- Enforce the complete listing review path:
-- Broker -> assigned Employee 1 -> assigned Employee 2 -> Active
-- Employee 1 submission -> auto virtual verification -> assigned Employee 2 -> Active

CREATE OR REPLACE FUNCTION public.listing_verification_distance_meters(
  p_listing_lat double precision,
  p_listing_lng double precision,
  p_visit_lat double precision,
  p_visit_lng double precision
)
RETURNS double precision
LANGUAGE sql IMMUTABLE STRICT
SET search_path TO pg_catalog, public
AS $$
  SELECT 6371000.0 * 2.0 * asin(sqrt(least(1.0, greatest(0.0,
    power(sin(radians(p_visit_lat - p_listing_lat) / 2.0), 2)
    + cos(radians(p_listing_lat)) * cos(radians(p_visit_lat))
      * power(sin(radians(p_visit_lng - p_listing_lng) / 2.0), 2)
  ))));
$$;
REVOKE ALL ON FUNCTION public.listing_verification_distance_meters(double precision, double precision, double precision, double precision) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.listing_verification_distance_meters(double precision, double precision, double precision, double precision) TO authenticated;

-- Route new submissions to one named reviewer. Employee 1 submissions are
-- treated as virtually verified by their creator and go directly to Employee 2.
CREATE OR REPLACE FUNCTION public.enforce_listing_submission_workflow()
RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER
SET search_path TO pg_catalog, public
AS $$
DECLARE submitter_role text; assigned_virtual uuid; assigned_field uuid;
BEGIN
  IF auth.role() = 'service_role' THEN RETURN NEW; END IF;
  SELECT CASE WHEN role = 'Employee' THEN employee_type ELSE role END
    INTO submitter_role FROM public.profiles WHERE id = auth.uid();

  IF NEW.lat IS NULL OR NEW.lng IS NULL THEN
    RAISE EXCEPTION 'A listing map location is required for field verification';
  END IF;

  IF submitter_role = 'Broker' THEN
    SELECT id INTO assigned_virtual FROM public.profiles
      WHERE role = 'Employee' AND employee_type = 'Employee 1'
      ORDER BY updated_at NULLS FIRST, id LIMIT 1;
    IF assigned_virtual IS NULL THEN RAISE EXCEPTION 'No Employee 1 is available for virtual verification'; END IF;
    NEW.broker_id := auth.uid();
    NEW.created_by := NULL;
    NEW.status := 'Pending';
    NEW.assigned_virtual_verifier_id := assigned_virtual;
    NEW.assigned_field_agent_id := NULL;
    NEW.virtually_verified := false;
    NEW.virtually_verified_by := NULL;
  ELSIF submitter_role = 'Employee 1' THEN
    SELECT id INTO assigned_field FROM public.profiles
      WHERE role = 'Employee' AND employee_type = 'Employee 2'
      ORDER BY updated_at NULLS FIRST, id LIMIT 1;
    IF assigned_field IS NULL THEN RAISE EXCEPTION 'No Employee 2 is available for field verification'; END IF;
    NEW.broker_id := NULL;
    NEW.created_by := auth.uid();
    NEW.status := 'Under Review';
    NEW.assigned_virtual_verifier_id := auth.uid();
    NEW.assigned_field_agent_id := assigned_field;
    NEW.virtually_verified := true;
    NEW.virtually_verified_by := auth.uid();
  ELSE
    RAISE EXCEPTION 'Only brokers and Employee 1 can submit listings';
  END IF;

  NEW.field_verified := false;
  NEW.field_verified_by := NULL;
  NEW.field_verification_photo_url := NULL;
  NEW.field_verification_lat := NULL;
  NEW.field_verification_lng := NULL;
  NEW.field_verified_at := NULL;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS trg_enforce_listing_submission_workflow ON public.listings;
CREATE TRIGGER trg_enforce_listing_submission_workflow
  BEFORE INSERT ON public.listings
  FOR EACH ROW EXECUTE FUNCTION public.enforce_listing_submission_workflow();

CREATE OR REPLACE FUNCTION public.employee1_mark_virtual_verified(p_listing_id bigint)
RETURNS void
LANGUAGE plpgsql SECURITY DEFINER
SET search_path TO pg_catalog, public
AS $$
DECLARE assigned_field uuid;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.profiles WHERE id = auth.uid() AND role = 'Employee' AND employee_type = 'Employee 1') THEN
    RAISE EXCEPTION 'Employee 1 access required';
  END IF;
  SELECT id INTO assigned_field FROM public.profiles
    WHERE role = 'Employee' AND employee_type = 'Employee 2'
    ORDER BY updated_at NULLS FIRST, id LIMIT 1;
  IF assigned_field IS NULL THEN RAISE EXCEPTION 'No Employee 2 is available for field verification'; END IF;

  UPDATE public.listings
  SET virtually_verified = true,
      virtually_verified_by = auth.uid(),
      assigned_field_agent_id = assigned_field,
      status = 'Under Review'
  WHERE id = p_listing_id
    AND broker_id IS NOT NULL
    AND status = 'Pending'
    AND virtually_verified IS FALSE
    AND assigned_virtual_verifier_id = auth.uid();
  IF NOT FOUND THEN RAISE EXCEPTION 'This listing is not assigned to you for virtual verification'; END IF;

  INSERT INTO public.listing_status_history (listing_id, changed_by, old_status, new_status, reason)
  VALUES (p_listing_id, auth.uid(), 'Pending', 'Under Review', 'Employee 1 approved virtual verification; assigned to Employee 2.');
END;
$$;

CREATE OR REPLACE FUNCTION public.employee1_reject_listing(p_listing_id bigint, p_reason text)
RETURNS void
LANGUAGE plpgsql SECURITY DEFINER
SET search_path TO pg_catalog, public
AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.profiles WHERE id = auth.uid() AND role = 'Employee' AND employee_type = 'Employee 1') THEN
    RAISE EXCEPTION 'Employee 1 access required';
  END IF;
  IF NULLIF(trim(p_reason), '') IS NULL THEN RAISE EXCEPTION 'Provide a reason for rejection'; END IF;
  UPDATE public.listings SET status = 'Rejected'
  WHERE id = p_listing_id AND broker_id IS NOT NULL AND status = 'Pending'
    AND virtually_verified IS FALSE AND assigned_virtual_verifier_id = auth.uid();
  IF NOT FOUND THEN RAISE EXCEPTION 'This listing is not assigned to you for virtual verification'; END IF;
  INSERT INTO public.listing_status_history (listing_id, changed_by, old_status, new_status, reason)
  VALUES (p_listing_id, auth.uid(), 'Pending', 'Rejected', trim(p_reason));
END;
$$;

CREATE OR REPLACE FUNCTION public.employee2_record_field_verification(
  p_listing_id bigint, p_photo_url text, p_lat double precision, p_lng double precision
)
RETURNS void
LANGUAGE plpgsql SECURITY DEFINER
SET search_path TO pg_catalog, public
AS $$
DECLARE listing_lat double precision; listing_lng double precision; distance_m double precision;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.profiles WHERE id = auth.uid() AND role = 'Employee' AND employee_type = 'Employee 2') THEN
    RAISE EXCEPTION 'Employee 2 access required';
  END IF;
  IF p_photo_url IS NULL OR p_photo_url NOT LIKE auth.uid()::text || '/%'
     OR p_lat IS NULL OR p_lng IS NULL OR p_lat NOT BETWEEN -90 AND 90 OR p_lng NOT BETWEEN -180 AND 180 THEN
    RAISE EXCEPTION 'A valid field photo and device location are required';
  END IF;

  SELECT lat, lng INTO listing_lat, listing_lng FROM public.listings
  WHERE id = p_listing_id AND assigned_field_agent_id = auth.uid()
    AND virtually_verified IS TRUE AND status = 'Under Review';
  IF NOT FOUND THEN RAISE EXCEPTION 'This virtually verified listing is not assigned to you'; END IF;
  IF listing_lat IS NULL OR listing_lng IS NULL THEN RAISE EXCEPTION 'The listing has no map coordinates'; END IF;
  IF NOT EXISTS (SELECT 1 FROM storage.objects WHERE bucket_id = 'field-verification' AND name = p_photo_url) THEN
    RAISE EXCEPTION 'Upload the field photo before saving verification';
  END IF;

  distance_m := public.listing_verification_distance_meters(listing_lat, listing_lng, p_lat, p_lng);
  IF distance_m > 200 THEN
    RAISE EXCEPTION 'You are % meters from the listing. Field verification must be within 200 meters.', round(distance_m::numeric);
  END IF;

  UPDATE public.listings
  SET field_verified = true, field_verified_by = auth.uid(), field_verification_photo_url = p_photo_url,
      field_verification_lat = p_lat, field_verification_lng = p_lng, field_verified_at = timezone('utc', now())
  WHERE id = p_listing_id AND assigned_field_agent_id = auth.uid()
    AND virtually_verified IS TRUE AND status = 'Under Review';
  IF NOT FOUND THEN RAISE EXCEPTION 'Field verification could not be saved'; END IF;
END;
$$;

CREATE OR REPLACE FUNCTION public.employee2_approve_listing(p_listing_id bigint)
RETURNS void
LANGUAGE plpgsql SECURITY DEFINER
SET search_path TO pg_catalog, public
AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.profiles WHERE id = auth.uid() AND role = 'Employee' AND employee_type = 'Employee 2') THEN
    RAISE EXCEPTION 'Employee 2 access required';
  END IF;
  UPDATE public.listings SET status = 'Active'
  WHERE id = p_listing_id AND status = 'Under Review'
    AND virtually_verified IS TRUE
    AND field_verified IS TRUE AND field_verified_by = auth.uid()
    AND assigned_field_agent_id = auth.uid()
    AND public.listing_verification_distance_meters(lat, lng, field_verification_lat, field_verification_lng) <= 200;
  IF NOT FOUND THEN RAISE EXCEPTION 'Complete the assigned virtual and field verification before publishing'; END IF;
  INSERT INTO public.listing_status_history (listing_id, changed_by, old_status, new_status, reason)
  VALUES (p_listing_id, auth.uid(), 'Under Review', 'Active', 'Employee 2 completed field verification and approved publication.');
END;
$$;

CREATE OR REPLACE FUNCTION public.employee2_reject_listing(p_listing_id bigint, p_reason text)
RETURNS void
LANGUAGE plpgsql SECURITY DEFINER
SET search_path TO pg_catalog, public
AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.profiles WHERE id = auth.uid() AND role = 'Employee' AND employee_type = 'Employee 2') THEN
    RAISE EXCEPTION 'Employee 2 access required';
  END IF;
  IF NULLIF(trim(p_reason), '') IS NULL THEN RAISE EXCEPTION 'Provide a reason for rejection'; END IF;
  UPDATE public.listings SET status = 'Rejected'
  WHERE id = p_listing_id AND status = 'Under Review' AND virtually_verified IS TRUE
    AND assigned_field_agent_id = auth.uid();
  IF NOT FOUND THEN RAISE EXCEPTION 'This listing is not assigned to you for field review'; END IF;
  INSERT INTO public.listing_status_history (listing_id, changed_by, old_status, new_status, reason)
  VALUES (p_listing_id, auth.uid(), 'Under Review', 'Rejected', trim(p_reason));
END;
$$;

CREATE OR REPLACE FUNCTION public.require_employee2_for_listing_publication()
RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER
SET search_path TO pg_catalog, public
AS $$
BEGIN
  IF NEW.status = 'Active' AND OLD.status IS DISTINCT FROM 'Active'
     AND NOT (auth.role() = 'service_role' OR EXISTS (
       SELECT 1 FROM public.profiles WHERE id = auth.uid() AND role = 'Employee' AND employee_type = 'Employee 2'
     )) THEN
    RAISE EXCEPTION 'Only the assigned Employee 2 can approve and publish a listing';
  END IF;
  IF NEW.status = 'Active' AND OLD.status IS DISTINCT FROM 'Active'
     AND (NEW.status IS DISTINCT FROM 'Active' OR NEW.virtually_verified IS DISTINCT FROM true
       OR NEW.field_verified IS DISTINCT FROM true OR NEW.field_verified_by IS DISTINCT FROM auth.uid()
       OR NEW.assigned_field_agent_id IS DISTINCT FROM auth.uid()
       OR NEW.field_verification_photo_url IS NULL
       OR NEW.lat IS NULL OR NEW.lng IS NULL
       OR NEW.field_verification_lat IS NULL OR NEW.field_verification_lng IS NULL
       OR public.listing_verification_distance_meters(NEW.lat, NEW.lng, NEW.field_verification_lat, NEW.field_verification_lng) > 200) THEN
    RAISE EXCEPTION 'Virtual approval and field evidence within 200 meters are required before publication';
  END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS trg_require_employee2_for_listing_publication ON public.listings;
CREATE TRIGGER trg_require_employee2_for_listing_publication
  BEFORE UPDATE OF status ON public.listings
  FOR EACH ROW EXECUTE FUNCTION public.require_employee2_for_listing_publication();

-- Protect verifier assignment and evidence fields while allowing only the
-- explicit Employee 1 and Employee 2 handoff transitions above.
CREATE OR REPLACE FUNCTION public.guard_listing_verification_fields()
RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER
SET search_path TO pg_catalog, public
AS $$
DECLARE actor_role text; distance_m double precision;
BEGIN
  SELECT CASE WHEN role = 'Employee' THEN employee_type ELSE role END INTO actor_role
  FROM public.profiles WHERE id = auth.uid();

  IF NEW.assigned_virtual_verifier_id IS DISTINCT FROM OLD.assigned_virtual_verifier_id
     OR NEW.assigned_field_agent_id IS DISTINCT FROM OLD.assigned_field_agent_id THEN
    IF actor_role = 'Admin' THEN
      NULL;
    ELSIF actor_role = 'Employee 1'
      AND OLD.broker_id IS NOT NULL AND OLD.status = 'Pending'
      AND OLD.assigned_virtual_verifier_id = auth.uid()
      AND OLD.virtually_verified IS FALSE
      AND NEW.virtually_verified IS TRUE AND NEW.virtually_verified_by = auth.uid()
      AND NEW.status = 'Under Review'
      AND NEW.assigned_virtual_verifier_id IS NOT DISTINCT FROM OLD.assigned_virtual_verifier_id
      AND NEW.assigned_field_agent_id IS NOT NULL
      AND EXISTS (SELECT 1 FROM public.profiles p WHERE p.id = NEW.assigned_field_agent_id AND p.role = 'Employee' AND p.employee_type = 'Employee 2') THEN
      NULL;
    ELSE
      RAISE EXCEPTION 'Only Admin or the assigned Employee 1 handoff can change verifier assignments';
    END IF;
  END IF;

  IF NEW.virtually_verified IS DISTINCT FROM OLD.virtually_verified
     OR NEW.virtually_verified_by IS DISTINCT FROM OLD.virtually_verified_by THEN
    IF NOT (actor_role = 'Employee 1' AND OLD.broker_id IS NOT NULL AND OLD.status = 'Pending'
      AND OLD.assigned_virtual_verifier_id = auth.uid() AND OLD.virtually_verified IS FALSE
      AND NEW.virtually_verified IS TRUE AND NEW.virtually_verified_by = auth.uid()
      AND NEW.status = 'Under Review' AND NEW.assigned_field_agent_id IS NOT NULL) THEN
      RAISE EXCEPTION 'Only the assigned Employee 1 can approve virtual verification';
    END IF;
  END IF;

  IF NEW.field_verified IS DISTINCT FROM OLD.field_verified
     OR NEW.field_verified_by IS DISTINCT FROM OLD.field_verified_by
     OR NEW.field_verification_photo_url IS DISTINCT FROM OLD.field_verification_photo_url
     OR NEW.field_verification_lat IS DISTINCT FROM OLD.field_verification_lat
     OR NEW.field_verification_lng IS DISTINCT FROM OLD.field_verification_lng
     OR NEW.field_verified_at IS DISTINCT FROM OLD.field_verified_at THEN
    IF actor_role = 'Admin' AND NEW.field_verified IS FALSE AND NEW.field_verified_by IS NULL
       AND NEW.field_verification_photo_url IS NULL AND NEW.field_verification_lat IS NULL
       AND NEW.field_verification_lng IS NULL AND NEW.field_verified_at IS NULL THEN
      NULL;
    ELSIF actor_role = 'Employee 2' AND OLD.assigned_field_agent_id = auth.uid()
       AND OLD.virtually_verified IS TRUE AND OLD.status = 'Under Review'
       AND NEW.field_verified IS TRUE AND NEW.field_verified_by = auth.uid()
       AND NEW.field_verification_photo_url LIKE auth.uid()::text || '/%'
       AND NEW.field_verification_lat BETWEEN -90 AND 90
       AND NEW.field_verification_lng BETWEEN -180 AND 180 THEN
      distance_m := public.listing_verification_distance_meters(NEW.lat, NEW.lng, NEW.field_verification_lat, NEW.field_verification_lng);
      IF distance_m IS NULL OR distance_m > 200 THEN RAISE EXCEPTION 'Field verification must be within 200 meters of the listing'; END IF;
    ELSE
      RAISE EXCEPTION 'Only the assigned Employee 2 can save valid field verification evidence';
    END IF;
  END IF;

  IF NEW.status IS DISTINCT FROM OLD.status THEN
    IF NEW.status = 'Under Review' AND actor_role = 'Employee 1'
       AND OLD.status = 'Pending' AND OLD.broker_id IS NOT NULL
       AND OLD.assigned_virtual_verifier_id = auth.uid()
       AND NEW.virtually_verified IS TRUE AND NEW.virtually_verified_by = auth.uid()
       AND NEW.assigned_field_agent_id IS NOT NULL THEN
      NULL;
    ELSIF NEW.status = 'Active' AND actor_role = 'Employee 2'
       AND OLD.status = 'Under Review' AND OLD.virtually_verified IS TRUE
       AND NEW.field_verified IS TRUE AND NEW.field_verified_by = auth.uid()
       AND OLD.assigned_field_agent_id = auth.uid() THEN
      NULL;
    ELSIF NEW.status = 'Rejected' AND (
      (actor_role = 'Employee 1' AND OLD.status = 'Pending' AND OLD.broker_id IS NOT NULL AND OLD.assigned_virtual_verifier_id = auth.uid())
      OR (actor_role = 'Employee 2' AND OLD.status = 'Under Review' AND OLD.virtually_verified IS TRUE AND OLD.assigned_field_agent_id = auth.uid())
      OR actor_role = 'Admin'
    ) THEN
      NULL;
    ELSIF actor_role = 'Admin' THEN
      NULL;
    ELSE
      RAISE EXCEPTION 'This role cannot make the requested listing status transition';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.employee1_mark_virtual_verified(bigint) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.employee1_reject_listing(bigint, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.employee2_record_field_verification(bigint, text, double precision, double precision) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.employee2_approve_listing(bigint) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.employee2_reject_listing(bigint, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.employee1_mark_virtual_verified(bigint) TO authenticated;
GRANT EXECUTE ON FUNCTION public.employee1_reject_listing(bigint, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.employee2_record_field_verification(bigint, text, double precision, double precision) TO authenticated;
GRANT EXECUTE ON FUNCTION public.employee2_approve_listing(bigint) TO authenticated;
GRANT EXECUTE ON FUNCTION public.employee2_reject_listing(bigint, text) TO authenticated;

-- Employees only see work explicitly assigned to them. NULL assignments no
-- longer make a queue item visible to every employee of that type.
DROP POLICY IF EXISTS listings_role_scope_select ON public.listings;
CREATE POLICY listings_role_scope_select ON public.listings AS RESTRICTIVE
FOR SELECT TO authenticated USING (
  status = 'Active'
  OR EXISTS (SELECT 1 FROM public.profiles p WHERE p.id = auth.uid() AND p.role = 'Admin')
  OR EXISTS (SELECT 1 FROM public.profiles p WHERE p.id = auth.uid() AND p.role = 'Broker' AND p.id = listings.broker_id)
  OR EXISTS (SELECT 1 FROM public.profiles p WHERE p.id = auth.uid() AND p.role = 'Employee' AND p.employee_type = 'Employee 1'
    AND (listings.assigned_virtual_verifier_id = auth.uid() OR listings.created_by = auth.uid()))
  OR EXISTS (SELECT 1 FROM public.profiles p WHERE p.id = auth.uid() AND p.role = 'Employee' AND p.employee_type = 'Employee 2'
    AND listings.assigned_field_agent_id = auth.uid() AND listings.virtually_verified IS TRUE)
);
DROP POLICY IF EXISTS listings_role_read ON public.listings;
CREATE POLICY listings_role_read ON public.listings AS PERMISSIVE
FOR SELECT TO authenticated USING (
  status = 'Active'
  OR EXISTS (SELECT 1 FROM public.profiles p WHERE p.id = auth.uid() AND p.role = 'Admin')
  OR EXISTS (SELECT 1 FROM public.profiles p WHERE p.id = auth.uid() AND p.role = 'Broker' AND p.id = listings.broker_id)
  OR EXISTS (SELECT 1 FROM public.profiles p WHERE p.id = auth.uid() AND p.role = 'Employee' AND p.employee_type = 'Employee 1'
    AND (listings.assigned_virtual_verifier_id = auth.uid() OR listings.created_by = auth.uid()))
  OR EXISTS (SELECT 1 FROM public.profiles p WHERE p.id = auth.uid() AND p.role = 'Employee' AND p.employee_type = 'Employee 2'
    AND listings.assigned_field_agent_id = auth.uid() AND listings.virtually_verified IS TRUE)
);

DROP POLICY IF EXISTS listings_role_scope_insert ON public.listings;
CREATE POLICY listings_role_scope_insert ON public.listings AS RESTRICTIVE
FOR INSERT TO authenticated WITH CHECK (
  (status = 'Pending' AND broker_id = auth.uid() AND EXISTS (SELECT 1 FROM public.profiles p WHERE p.id = auth.uid() AND p.role = 'Broker'))
  OR (status = 'Under Review' AND broker_id IS NULL AND created_by = auth.uid()
    AND virtually_verified IS TRUE AND virtually_verified_by = auth.uid()
    AND EXISTS (SELECT 1 FROM public.profiles p WHERE p.id = auth.uid() AND p.role = 'Employee' AND p.employee_type = 'Employee 1')
    AND EXISTS (SELECT 1 FROM public.profiles p WHERE p.id = listings.assigned_field_agent_id AND p.role = 'Employee' AND p.employee_type = 'Employee 2'))
);
DROP POLICY IF EXISTS listings_role_insert ON public.listings;
CREATE POLICY listings_role_insert ON public.listings AS PERMISSIVE
FOR INSERT TO authenticated WITH CHECK (
  (status = 'Pending' AND broker_id = auth.uid() AND EXISTS (SELECT 1 FROM public.profiles p WHERE p.id = auth.uid() AND p.role = 'Broker'))
  OR (status = 'Under Review' AND broker_id IS NULL AND created_by = auth.uid()
    AND virtually_verified IS TRUE AND virtually_verified_by = auth.uid()
    AND EXISTS (SELECT 1 FROM public.profiles p WHERE p.id = auth.uid() AND p.role = 'Employee' AND p.employee_type = 'Employee 1')
    AND EXISTS (SELECT 1 FROM public.profiles p WHERE p.id = listings.assigned_field_agent_id AND p.role = 'Employee' AND p.employee_type = 'Employee 2'))
);

-- Reassign already queued listings from the old NULL-means-unassigned model.
-- Keep published listings unchanged; reset only non-public work in progress.
ALTER TABLE public.listings DISABLE TRIGGER zzz_guard_listing_verification_fields;
UPDATE public.listings AS l
SET assigned_virtual_verifier_id = COALESCE(l.assigned_virtual_verifier_id, (
      SELECT p.id FROM public.profiles p WHERE p.role = 'Employee' AND p.employee_type = 'Employee 1'
      ORDER BY p.updated_at NULLS FIRST, p.id LIMIT 1)),
    assigned_field_agent_id = CASE WHEN l.virtually_verified IS TRUE THEN COALESCE(l.assigned_field_agent_id, (
      SELECT p.id FROM public.profiles p WHERE p.role = 'Employee' AND p.employee_type = 'Employee 2'
      ORDER BY p.updated_at NULLS FIRST, p.id LIMIT 1)) ELSE NULL END,
    virtually_verified = COALESCE(l.virtually_verified, false),
    status = CASE WHEN l.virtually_verified IS TRUE THEN 'Under Review' ELSE 'Pending' END
WHERE l.broker_id IS NOT NULL AND l.status IN ('Pending', 'Under Review');

UPDATE public.listings AS l
SET assigned_virtual_verifier_id = l.created_by,
    assigned_field_agent_id = (SELECT p.id FROM public.profiles p
      WHERE p.role = 'Employee' AND p.employee_type = 'Employee 2'
      ORDER BY p.updated_at NULLS FIRST, p.id LIMIT 1),
    virtually_verified = true,
    virtually_verified_by = l.created_by,
    field_verified = false,
    field_verified_by = NULL,
    field_verification_photo_url = NULL,
    field_verification_lat = NULL,
    field_verification_lng = NULL,
    field_verified_at = NULL,
    status = 'Under Review'
WHERE l.broker_id IS NULL AND l.created_by IN (
  SELECT p.id FROM public.profiles p WHERE p.role = 'Employee' AND p.employee_type = 'Employee 1'
) AND l.status IN ('Pending', 'Under Review');
ALTER TABLE public.listings ENABLE TRIGGER zzz_guard_listing_verification_fields;

NOTIFY pgrst, 'reload schema';

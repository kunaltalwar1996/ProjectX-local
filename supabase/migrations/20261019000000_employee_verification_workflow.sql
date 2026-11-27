-- Employee 1 handles virtual verification and staff listing intake.
-- Employee 2 performs field verification and controls final publication.

CREATE OR REPLACE FUNCTION public.is_staff()
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO pg_catalog, public AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.profiles
    WHERE id = auth.uid() AND role IN ('Admin', 'Employee', 'virtual_verifier', 'field_agent')
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
  IF NOT EXISTS (SELECT 1 FROM public.profiles WHERE id = auth.uid() AND role = 'virtual_verifier') THEN
    RAISE EXCEPTION 'virtual_verifier role required';
  END IF;
  IF NULLIF(trim(p_title), '') IS NULL OR NULLIF(trim(p_location), '') IS NULL OR p_price IS NULL OR p_price <= 0 THEN
    RAISE EXCEPTION 'Title, location, and a positive price are required';
  END IF;
  SELECT id INTO field_agent FROM public.profiles WHERE role = 'field_agent' ORDER BY updated_at LIMIT 1;
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
  IF NOT EXISTS (SELECT 1 FROM public.profiles WHERE id = auth.uid() AND role = 'virtual_verifier') THEN
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
  IF NOT EXISTS (SELECT 1 FROM public.profiles WHERE id = auth.uid() AND role = 'field_agent') THEN
    RAISE EXCEPTION 'field_agent role required';
  END IF;
  IF p_photo_url IS NULL OR p_photo_url NOT LIKE auth.uid()::text || '/%' OR p_lat NOT BETWEEN -90 AND 90 OR p_lng NOT BETWEEN -180 AND 180 THEN
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
  IF NOT EXISTS (SELECT 1 FROM public.profiles WHERE id = auth.uid() AND role = 'field_agent') THEN
    RAISE EXCEPTION 'field_agent role required';
  END IF;
  UPDATE public.listings SET status = 'Active'
  WHERE id = p_listing_id AND field_verified = true AND field_verified_by = auth.uid()
    AND (assigned_field_agent_id IS NULL OR assigned_field_agent_id = auth.uid());
  IF NOT FOUND THEN RAISE EXCEPTION 'Complete your field verification before approving this listing'; END IF;
END;
$$;

CREATE OR REPLACE FUNCTION public.require_employee2_for_listing_publication()
RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER
SET search_path TO pg_catalog, public
AS $$
BEGIN
  IF NEW.status = 'Active' AND OLD.status IS DISTINCT FROM 'Active'
     AND NOT EXISTS (
       SELECT 1 FROM public.profiles
       WHERE id = auth.uid() AND role = 'field_agent'
     ) THEN
    RAISE EXCEPTION 'Only field_agent can approve and publish a listing';
  END IF;
  IF NEW.status = 'Active' AND OLD.status IS DISTINCT FROM 'Active'
     AND (NEW.field_verified IS DISTINCT FROM true OR NEW.field_verified_by IS DISTINCT FROM auth.uid()) THEN
    RAISE EXCEPTION 'Field verification by the approving field_agent is required';
  END IF;
  RETURN NEW;
END;
$$;

-- The staff-creation Edge Function creates a base Employee account. This
-- Admin-only RPC upgrades that profile to the exact database role selected.
CREATE OR REPLACE FUNCTION public.admin_assign_employee_role(p_email text, p_role text)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path TO pg_catalog, public AS $$
BEGIN
  IF NOT public.is_admin() THEN RAISE EXCEPTION 'Admin access required'; END IF;
  IF p_role NOT IN ('virtual_verifier', 'field_agent') THEN RAISE EXCEPTION 'Invalid employee role'; END IF;
  PERFORM set_config('estatepro.employee_role_target', p_role, true);
  UPDATE public.profiles AS p SET role = p_role
  FROM auth.users AS u
  WHERE p.id = u.id AND lower(COALESCE(p.email, u.email)) = lower(trim(p_email)) AND p.role IN ('Employee', 'virtual_verifier', 'field_agent');
  IF NOT FOUND THEN RAISE EXCEPTION 'Staff profile not found for that email'; END IF;
END;
$$;

CREATE OR REPLACE FUNCTION public.capture_admin_employee_role_request()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path TO pg_catalog, public AS $$
BEGIN
  IF public.is_admin() AND NEW.role IS DISTINCT FROM OLD.role THEN
    IF NEW.role NOT IN ('virtual_verifier', 'field_agent') THEN RAISE EXCEPTION 'Invalid employee role'; END IF;
    PERFORM set_config('estatepro.employee_role_target', NEW.role, true);
  END IF;
  RETURN NEW;
END;
$$;
CREATE OR REPLACE FUNCTION public.admin_assign_employee_role_guard()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path TO pg_catalog, public AS $$
DECLARE requested_role text;
BEGIN
  requested_role := current_setting('estatepro.employee_role_target', true);
  IF public.is_admin() AND requested_role IN ('virtual_verifier', 'field_agent') THEN
    NEW.role := requested_role;
    NEW.employee_type := NULL;
    RETURN NEW;
  END IF;
  NEW.role := OLD.role;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS aaa_capture_admin_employee_role_request ON public.profiles;
CREATE TRIGGER aaa_capture_admin_employee_role_request BEFORE UPDATE OF role ON public.profiles
FOR EACH ROW EXECUTE FUNCTION public.capture_admin_employee_role_request();
DROP TRIGGER IF EXISTS zzz_admin_assign_employee_role_guard ON public.profiles;
CREATE TRIGGER zzz_admin_assign_employee_role_guard BEFORE UPDATE OF role ON public.profiles
FOR EACH ROW EXECUTE FUNCTION public.admin_assign_employee_role_guard();

DROP TRIGGER IF EXISTS trg_require_employee2_for_listing_publication ON public.listings;
CREATE TRIGGER trg_require_employee2_for_listing_publication
  BEFORE UPDATE OF status ON public.listings
  FOR EACH ROW EXECUTE FUNCTION public.require_employee2_for_listing_publication();

CREATE OR REPLACE FUNCTION public.guard_listing_verification_fields()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path TO pg_catalog, public AS $$
BEGIN
  IF NEW.assigned_virtual_verifier_id IS DISTINCT FROM OLD.assigned_virtual_verifier_id
     OR NEW.assigned_field_agent_id IS DISTINCT FROM OLD.assigned_field_agent_id THEN
    IF NOT public.is_admin() THEN RAISE EXCEPTION 'Only an admin can assign listing verifiers'; END IF;
  END IF;
  IF NEW.virtually_verified IS DISTINCT FROM OLD.virtually_verified
     OR NEW.virtually_verified_by IS DISTINCT FROM OLD.virtually_verified_by THEN
    IF NOT EXISTS (SELECT 1 FROM public.profiles WHERE id = auth.uid() AND role = 'virtual_verifier')
       OR NEW.virtually_verified_by IS DISTINCT FROM auth.uid() THEN
      RAISE EXCEPTION 'virtual_verifier role required for virtual verification';
    END IF;
  END IF;
  IF NEW.field_verified IS DISTINCT FROM OLD.field_verified
     OR NEW.field_verified_by IS DISTINCT FROM OLD.field_verified_by
     OR NEW.field_verification_photo_url IS DISTINCT FROM OLD.field_verification_photo_url
     OR NEW.field_verification_lat IS DISTINCT FROM OLD.field_verification_lat
     OR NEW.field_verification_lng IS DISTINCT FROM OLD.field_verification_lng
     OR NEW.field_verified_at IS DISTINCT FROM OLD.field_verified_at THEN
    IF NOT EXISTS (SELECT 1 FROM public.profiles WHERE id = auth.uid() AND role = 'field_agent')
       OR NEW.field_verified_by IS DISTINCT FROM auth.uid()
       OR NEW.field_verified IS DISTINCT FROM true THEN
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
REVOKE ALL ON FUNCTION public.require_employee2_for_listing_publication() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.admin_assign_employee_role(text, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.admin_assign_employee_role_guard() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.capture_admin_employee_role_request() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.guard_listing_verification_fields() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.employee1_create_listing(text, text, numeric, text, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.employee1_mark_virtual_verified(bigint) TO authenticated;
GRANT EXECUTE ON FUNCTION public.employee2_record_field_verification(bigint, text, double precision, double precision) TO authenticated;
GRANT EXECUTE ON FUNCTION public.employee2_approve_listing(bigint) TO authenticated;
GRANT EXECUTE ON FUNCTION public.admin_assign_employee_role(text, text) TO authenticated;

INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES ('field-verification', 'field-verification', false, 10485760, ARRAY['image/jpeg','image/png','image/webp'])
ON CONFLICT (id) DO NOTHING;

DROP POLICY IF EXISTS "Employee 2 uploads own field evidence" ON storage.objects;
CREATE POLICY "Employee 2 uploads own field evidence"
ON storage.objects FOR INSERT TO authenticated
WITH CHECK (bucket_id = 'field-verification' AND (storage.foldername(name))[1] = auth.uid()::text AND EXISTS (
  SELECT 1 FROM public.profiles p WHERE p.id = auth.uid() AND p.role = 'field_agent'
));

DROP POLICY IF EXISTS "Staff reads field evidence" ON storage.objects;
CREATE POLICY "Staff reads field evidence"
ON storage.objects FOR SELECT TO authenticated
USING (bucket_id = 'field-verification' AND public.is_staff());

NOTIFY pgrst, 'reload schema';

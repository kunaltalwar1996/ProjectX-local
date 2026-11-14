-- Allow admins to publish listings through the audited admin status RPC.
-- Employee 2 publication still requires assigned virtual and field verification.
CREATE OR REPLACE FUNCTION public.require_employee2_for_listing_publication()
RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER
SET search_path TO pg_catalog, public
AS $$
BEGIN
  IF NEW.status = 'Active' AND OLD.status IS DISTINCT FROM 'Active'
     AND NOT (auth.role() = 'service_role' OR EXISTS (
       SELECT 1 FROM public.profiles
       WHERE id = auth.uid()
         AND (role = 'Admin' OR (role = 'Employee' AND employee_type = 'Employee 2'))
     )) THEN
    RAISE EXCEPTION 'Only an administrator or the assigned Employee 2 can approve and publish a listing';
  END IF;

  IF NEW.status = 'Active' AND OLD.status IS DISTINCT FROM 'Active'
     AND NOT EXISTS (
       SELECT 1 FROM public.profiles WHERE id = auth.uid() AND role = 'Admin'
     )
     AND (NEW.virtually_verified IS DISTINCT FROM true
       OR NEW.field_verified IS DISTINCT FROM true
       OR NEW.field_verified_by IS DISTINCT FROM auth.uid()
       OR NEW.assigned_field_agent_id IS DISTINCT FROM auth.uid()
       OR NEW.field_verification_photo_url IS NULL
       OR NEW.lat IS NULL OR NEW.lng IS NULL
       OR NEW.field_verification_lat IS NULL OR NEW.field_verification_lng IS NULL
       OR public.listing_verification_distance_meters(
         NEW.lat, NEW.lng, NEW.field_verification_lat, NEW.field_verification_lng
       ) > 200) THEN
    RAISE EXCEPTION 'Virtual approval and field evidence within 200 meters are required before publication';
  END IF;

  RETURN NEW;
END;
$$;

NOTIFY pgrst, 'reload schema';

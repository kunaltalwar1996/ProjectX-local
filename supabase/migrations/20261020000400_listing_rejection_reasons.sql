-- Persist rejection reasons on the listing so uploaders and Employee 1 can
-- see them directly in their listing views.
ALTER TABLE public.listings
  ADD COLUMN IF NOT EXISTS rejection_reason text;

-- Preserve reasons that were previously captured only in the moderation log.
UPDATE public.listings AS l
SET rejection_reason = (
  SELECT h.reason
  FROM public.listing_status_history AS h
  WHERE h.listing_id = l.id AND h.new_status = 'Rejected'
  ORDER BY h.created_at DESC
  LIMIT 1
)
WHERE l.status = 'Rejected'
  AND l.rejection_reason IS NULL
  AND EXISTS (
    SELECT 1 FROM public.listing_status_history AS h
    WHERE h.listing_id = l.id AND h.new_status = 'Rejected'
      AND NULLIF(trim(h.reason), '') IS NOT NULL
  );

CREATE OR REPLACE FUNCTION public.guard_listing_rejection_reason()
RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER
SET search_path TO pg_catalog, public
AS $$
DECLARE actor_role text;
BEGIN
  IF NEW.rejection_reason IS NOT DISTINCT FROM OLD.rejection_reason THEN
    RETURN NEW;
  END IF;

  IF auth.role() = 'service_role' THEN
    RETURN NEW;
  END IF;

  SELECT CASE WHEN role = 'Employee' THEN employee_type ELSE role END
    INTO actor_role FROM public.profiles WHERE id = auth.uid();

  IF actor_role = 'Admin' THEN
    RETURN NEW;
  END IF;

  IF actor_role = 'Employee 1'
     AND OLD.status = 'Pending'
     AND OLD.broker_id IS NOT NULL
     AND OLD.assigned_virtual_verifier_id = auth.uid()
     AND NEW.status = 'Rejected'
     AND NULLIF(trim(NEW.rejection_reason), '') IS NOT NULL THEN
    RETURN NEW;
  END IF;

  IF actor_role = 'Employee 2'
     AND OLD.status = 'Under Review'
     AND OLD.virtually_verified IS TRUE
     AND OLD.assigned_field_agent_id = auth.uid()
     AND NEW.status = 'Rejected'
     AND NULLIF(trim(NEW.rejection_reason), '') IS NOT NULL THEN
    RETURN NEW;
  END IF;

  RAISE EXCEPTION 'Only the assigned reviewer can set a rejection reason while rejecting a listing';
END;
$$;

REVOKE ALL ON FUNCTION public.guard_listing_rejection_reason() FROM PUBLIC;
DROP TRIGGER IF EXISTS trg_guard_listing_rejection_reason ON public.listings;
CREATE TRIGGER trg_guard_listing_rejection_reason
  BEFORE UPDATE OF rejection_reason ON public.listings
  FOR EACH ROW EXECUTE FUNCTION public.guard_listing_rejection_reason();

CREATE OR REPLACE FUNCTION public.employee1_reject_listing(p_listing_id bigint, p_reason text)
RETURNS void
LANGUAGE plpgsql SECURITY DEFINER
SET search_path TO pg_catalog, public
AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM public.profiles
    WHERE id = auth.uid() AND role = 'Employee' AND employee_type = 'Employee 1'
  ) THEN
    RAISE EXCEPTION 'Employee 1 access required';
  END IF;
  IF NULLIF(trim(p_reason), '') IS NULL THEN
    RAISE EXCEPTION 'Provide a reason for rejection';
  END IF;

  UPDATE public.listings
  SET status = 'Rejected', rejection_reason = trim(p_reason)
  WHERE id = p_listing_id AND broker_id IS NOT NULL AND status = 'Pending'
    AND virtually_verified IS FALSE AND assigned_virtual_verifier_id = auth.uid();
  IF NOT FOUND THEN
    RAISE EXCEPTION 'This listing is not assigned to you for virtual verification';
  END IF;

  INSERT INTO public.listing_status_history (listing_id, changed_by, old_status, new_status, reason)
  VALUES (p_listing_id, auth.uid(), 'Pending', 'Rejected', trim(p_reason));
END;
$$;

CREATE OR REPLACE FUNCTION public.employee2_reject_listing(p_listing_id bigint, p_reason text)
RETURNS void
LANGUAGE plpgsql SECURITY DEFINER
SET search_path TO pg_catalog, public
AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM public.profiles
    WHERE id = auth.uid() AND role = 'Employee' AND employee_type = 'Employee 2'
  ) THEN
    RAISE EXCEPTION 'Employee 2 access required';
  END IF;
  IF NULLIF(trim(p_reason), '') IS NULL THEN
    RAISE EXCEPTION 'Provide a reason for rejection';
  END IF;

  UPDATE public.listings
  SET status = 'Rejected', rejection_reason = trim(p_reason)
  WHERE id = p_listing_id AND status = 'Under Review' AND virtually_verified IS TRUE
    AND assigned_field_agent_id = auth.uid();
  IF NOT FOUND THEN
    RAISE EXCEPTION 'This listing is not assigned to you for field review';
  END IF;

  INSERT INTO public.listing_status_history (listing_id, changed_by, old_status, new_status, reason)
  VALUES (p_listing_id, auth.uid(), 'Under Review', 'Rejected', trim(p_reason));
END;
$$;

REVOKE ALL ON FUNCTION public.employee1_reject_listing(bigint, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.employee2_reject_listing(bigint, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.employee1_reject_listing(bigint, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.employee2_reject_listing(bigint, text) TO authenticated;

NOTIFY pgrst, 'reload schema';

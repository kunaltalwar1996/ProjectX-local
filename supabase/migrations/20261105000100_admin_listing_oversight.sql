-- Give administrators an audited, atomic status update path for listing moderation.
CREATE OR REPLACE FUNCTION public.admin_update_listing_status(
  p_listing_id bigint,
  p_new_status text,
  p_reason text DEFAULT NULL
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO pg_catalog, public
AS $$
DECLARE
  prior_status text;
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM public.profiles WHERE id = auth.uid() AND role = 'Admin'
  ) THEN
    RAISE EXCEPTION 'Administrator access required';
  END IF;

  IF p_new_status NOT IN ('Draft', 'Pending', 'Under Review', 'Active', 'Rejected', 'Suspended', 'Sold', 'Flagged') THEN
    RAISE EXCEPTION 'Unsupported listing status';
  END IF;
  IF p_new_status IN ('Rejected', 'Suspended') AND NULLIF(trim(p_reason), '') IS NULL THEN
    RAISE EXCEPTION 'A reason is required for this status';
  END IF;

  SELECT status INTO prior_status
  FROM public.listings WHERE id = p_listing_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Listing not found'; END IF;
  IF prior_status = p_new_status THEN RETURN; END IF;

  UPDATE public.listings
  SET status = p_new_status,
      rejection_reason = CASE WHEN p_new_status = 'Rejected' THEN trim(p_reason)
                              WHEN prior_status = 'Rejected' THEN NULL
                              ELSE rejection_reason END,
      updated_at = now()
  WHERE id = p_listing_id;

  INSERT INTO public.listing_status_history (listing_id, changed_by, old_status, new_status, reason)
  VALUES (p_listing_id, auth.uid(), prior_status, p_new_status, NULLIF(trim(p_reason), ''));
END;
$$;

REVOKE ALL ON FUNCTION public.admin_update_listing_status(bigint, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.admin_update_listing_status(bigint, text, text) TO authenticated;

-- Status history is operationally sensitive; only admins may read it directly.
DROP POLICY IF EXISTS "Admins can read listing status history" ON public.listing_status_history;
CREATE POLICY "Admins can read listing status history"
  ON public.listing_status_history FOR SELECT TO authenticated
  USING (EXISTS (SELECT 1 FROM public.profiles p WHERE p.id = auth.uid() AND p.role = 'Admin'));

NOTIFY pgrst, 'reload schema';

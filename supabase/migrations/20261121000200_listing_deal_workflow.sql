-- Broker sale/rental proposal -> buyer decision -> Employee 1 confirmation.
ALTER TABLE public.listing_deals
  ADD COLUMN IF NOT EXISTS cancellation_note text
    CHECK (cancellation_note IS NULL OR length(cancellation_note) <= 2000);

CREATE INDEX IF NOT EXISTS listing_deals_conversation_recent
  ON public.listing_deals (conversation_id, created_at);

CREATE OR REPLACE FUNCTION public.broker_propose_listing_deal(
  p_listing_id bigint,
  p_buyer_id uuid,
  p_transaction_type text,
  p_rental_months smallint DEFAULT NULL,
  p_proposed_amount numeric DEFAULT NULL,
  p_broker_note text DEFAULT NULL
)
RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER
SET search_path TO pg_catalog, public
AS $$
DECLARE
  listing_row public.listings%ROWTYPE;
  conversation_uuid uuid;
  deal_uuid uuid;
  price_basis text;
BEGIN
  IF auth.uid() IS NULL OR NOT EXISTS (
    SELECT 1 FROM public.profiles p WHERE p.id = auth.uid() AND p.role = 'Broker'
  ) THEN
    RAISE EXCEPTION 'Only a signed-in broker can propose a deal';
  END IF;
  IF p_buyer_id IS NULL OR p_buyer_id = auth.uid()
     OR NOT EXISTS (SELECT 1 FROM public.profiles p WHERE p.id = p_buyer_id AND p.role = 'Buyer') THEN
    RAISE EXCEPTION 'Select a valid buyer';
  END IF;
  IF p_transaction_type IS NULL OR p_transaction_type NOT IN ('sale', 'rent') THEN
    RAISE EXCEPTION 'Choose sale or rent';
  END IF;
  IF p_proposed_amount IS NOT NULL AND p_proposed_amount <= 0 THEN
    RAISE EXCEPTION 'The proposed amount must be greater than zero';
  END IF;
  IF length(COALESCE(p_broker_note, '')) > 2000 THEN
    RAISE EXCEPTION 'Broker note must be 2,000 characters or fewer';
  END IF;
  IF (p_transaction_type = 'rent' AND (p_rental_months IS NULL OR p_rental_months NOT BETWEEN 1 AND 12))
     OR (p_transaction_type = 'sale' AND p_rental_months IS NOT NULL) THEN
    RAISE EXCEPTION 'Rent terms must be 1–12 months; sale deals do not have a rental term';
  END IF;

  SELECT * INTO listing_row FROM public.listings
  WHERE id = p_listing_id AND broker_id = auth.uid()
  FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'This listing does not belong to your account'; END IF;
  IF listing_row.status <> 'Active' THEN
    RAISE EXCEPTION 'Only an active listing can be used for a new deal';
  END IF;
  IF NOT (
    EXISTS (SELECT 1 FROM public.inquiries i
      WHERE i.listing_id = p_listing_id AND i.broker_id = auth.uid() AND i.buyer_id = p_buyer_id)
    OR EXISTS (SELECT 1 FROM public.conversations c
      WHERE c.broker_id = auth.uid() AND c.buyer_id = p_buyer_id)
  ) THEN
    RAISE EXCEPTION 'The buyer must have an existing inquiry or chat with you';
  END IF;

  SELECT c.id INTO conversation_uuid
  FROM public.conversations c
  WHERE c.broker_id = auth.uid() AND c.buyer_id = p_buyer_id
  ORDER BY c.last_message_at DESC NULLS LAST, c.created_at DESC
  LIMIT 1;

  IF conversation_uuid IS NULL THEN
    INSERT INTO public.conversations (buyer_id, broker_id, listing_id)
    VALUES (p_buyer_id, auth.uid(), NULL)
    RETURNING id INTO conversation_uuid;
    IF conversation_uuid IS NULL THEN
      SELECT c.id INTO conversation_uuid FROM public.conversations c
      WHERE c.buyer_id = p_buyer_id AND c.broker_id = auth.uid()
      LIMIT 1;
    END IF;
  END IF;

  price_basis := CASE WHEN p_transaction_type = 'rent' THEN 'monthly' ELSE 'total' END;
  INSERT INTO public.listing_deals (
    listing_id, broker_id, buyer_id, conversation_id, transaction_type,
    status, proposed_amount, amount_basis, rental_months, broker_note
  ) VALUES (
    p_listing_id, auth.uid(), p_buyer_id, conversation_uuid, p_transaction_type,
    'awaiting_buyer', p_proposed_amount, price_basis, p_rental_months,
    NULLIF(trim(p_broker_note), '')
  ) RETURNING id INTO deal_uuid;

  INSERT INTO public.listing_deal_events
    (deal_id, actor_id, actor_name_snapshot, event_type, new_status, details)
  SELECT deal_uuid, p.id, p.full_name, 'broker_proposed', 'awaiting_buyer',
    jsonb_build_object('transaction_type', p_transaction_type,
      'rental_months', p_rental_months, 'proposed_amount', p_proposed_amount,
      'amount_basis', price_basis, 'listing_title', listing_row.title)
  FROM public.profiles p WHERE p.id = auth.uid();

  RETURN deal_uuid;
EXCEPTION WHEN unique_violation THEN
  RAISE EXCEPTION 'There is already an open deal for this listing';
END;
$$;

-- Return every registered Buyer this broker may assign: chat participants are
-- valid for any of the broker's listings, while inquiry-only leads stay scoped
-- to the listing they asked about.
DROP FUNCTION IF EXISTS public.get_broker_deal_buyers();
CREATE FUNCTION public.get_broker_deal_buyers()
RETURNS TABLE (id uuid, full_name text, avatar_url text, listing_id bigint, is_deal_eligible boolean)
LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path TO pg_catalog, public
AS $$
BEGIN
  IF auth.uid() IS NULL OR NOT EXISTS (
    SELECT 1 FROM public.profiles p WHERE p.id = auth.uid() AND p.role = 'Broker'
  ) THEN
    RAISE EXCEPTION 'Only a signed-in broker can view deal buyers';
  END IF;

  RETURN QUERY
  SELECT DISTINCT p.id, p.full_name, p.avatar_url, rel.listing_id, (p.role = 'Buyer')
  FROM (
    SELECT c.buyer_id AS id, NULL::bigint AS listing_id
    FROM public.conversations c
    WHERE c.broker_id = auth.uid()
    UNION
    SELECT i.buyer_id AS id, i.listing_id
    FROM public.inquiries i
    WHERE i.broker_id = auth.uid() AND i.buyer_id IS NOT NULL
  ) AS rel
  JOIN public.profiles p ON p.id = rel.id;
END;
$$;
REVOKE ALL ON FUNCTION public.get_broker_deal_buyers() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_broker_deal_buyers() TO authenticated;

CREATE OR REPLACE FUNCTION public.buyer_respond_to_listing_deal(
  p_deal_id uuid,
  p_accept boolean,
  p_note text DEFAULT NULL
)
RETURNS void
LANGUAGE plpgsql SECURITY DEFINER
SET search_path TO pg_catalog, public
AS $$
DECLARE deal_row public.listing_deals%ROWTYPE; next_status text; event_name text;
BEGIN
  SELECT * INTO deal_row FROM public.listing_deals WHERE id = p_deal_id FOR UPDATE;
  IF NOT FOUND OR deal_row.buyer_id IS DISTINCT FROM auth.uid() THEN
    RAISE EXCEPTION 'Deal not found for this buyer';
  END IF;
  IF deal_row.status <> 'awaiting_buyer' THEN RAISE EXCEPTION 'This deal is no longer awaiting your response'; END IF;
  IF length(COALESCE(p_note, '')) > 2000 THEN RAISE EXCEPTION 'Your note must be 2,000 characters or fewer'; END IF;

  next_status := CASE WHEN p_accept THEN 'awaiting_employee' ELSE 'declined' END;
  event_name := CASE WHEN p_accept THEN 'buyer_accepted' ELSE 'buyer_declined' END;
  UPDATE public.listing_deals SET status = next_status,
    buyer_note = NULLIF(trim(p_note), ''), buyer_responded_at = now(),
    closed_at = CASE WHEN p_accept THEN NULL ELSE now() END, updated_at = now()
  WHERE id = p_deal_id;
  INSERT INTO public.listing_deal_events
    (deal_id, actor_id, actor_name_snapshot, event_type, old_status, new_status, details)
  SELECT p_deal_id, p.id, p.full_name, event_name, 'awaiting_buyer', next_status,
    jsonb_build_object('note', NULLIF(trim(p_note), ''))
  FROM public.profiles p WHERE p.id = auth.uid();
END;
$$;

CREATE OR REPLACE FUNCTION public.broker_cancel_listing_deal(
  p_deal_id uuid,
  p_reason text DEFAULT NULL
)
RETURNS void
LANGUAGE plpgsql SECURITY DEFINER
SET search_path TO pg_catalog, public
AS $$
DECLARE deal_row public.listing_deals%ROWTYPE;
BEGIN
  SELECT * INTO deal_row FROM public.listing_deals WHERE id = p_deal_id FOR UPDATE;
  IF NOT FOUND OR deal_row.broker_id IS DISTINCT FROM auth.uid() THEN
    RAISE EXCEPTION 'Deal not found for this broker';
  END IF;
  IF deal_row.status NOT IN ('awaiting_buyer', 'awaiting_employee') THEN
    RAISE EXCEPTION 'Only an open deal can be cancelled';
  END IF;
  IF length(COALESCE(p_reason, '')) > 2000 THEN RAISE EXCEPTION 'Reason must be 2,000 characters or fewer'; END IF;

  UPDATE public.listing_deals SET status = 'cancelled', closed_at = now(),
    cancellation_note = NULLIF(trim(p_reason), ''), updated_at = now()
  WHERE id = p_deal_id;
  INSERT INTO public.listing_deal_events
    (deal_id, actor_id, actor_name_snapshot, event_type, old_status, new_status, details)
  SELECT p_deal_id, p.id, p.full_name, 'broker_cancelled', deal_row.status, 'cancelled',
    jsonb_build_object('reason', NULLIF(trim(p_reason), ''))
  FROM public.profiles p WHERE p.id = auth.uid();
END;
$$;

CREATE OR REPLACE FUNCTION public.employee1_review_listing_deal(
  p_deal_id uuid,
  p_confirm boolean,
  p_note text DEFAULT NULL
)
RETURNS text
LANGUAGE plpgsql SECURITY DEFINER
SET search_path TO pg_catalog, public
AS $$
DECLARE
  deal_row public.listing_deals%ROWTYPE;
  listing_row public.listings%ROWTYPE;
  final_listing_status text;
  final_deal_status text;
  event_name text;
  lease_start date;
  lease_end date;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.profiles p
    WHERE p.id = auth.uid() AND p.role = 'Employee' AND p.employee_type = 'Employee 1') THEN
    RAISE EXCEPTION 'Only Employee 1 can review accepted deals';
  END IF;
  IF p_confirm IS NULL THEN RAISE EXCEPTION 'Choose confirm or reject'; END IF;
  IF NOT p_confirm AND NULLIF(trim(p_note), '') IS NULL THEN
    RAISE EXCEPTION 'Add a reason when rejecting a deal';
  END IF;
  IF length(COALESCE(p_note, '')) > 2000 THEN RAISE EXCEPTION 'Note must be 2,000 characters or fewer'; END IF;

  SELECT * INTO deal_row FROM public.listing_deals WHERE id = p_deal_id FOR UPDATE;
  IF NOT FOUND OR deal_row.status <> 'awaiting_employee' THEN
    RAISE EXCEPTION 'Accepted deal not found in the Employee 1 review queue';
  END IF;
  SELECT * INTO listing_row FROM public.listings WHERE id = deal_row.listing_id FOR UPDATE;
  IF NOT FOUND OR listing_row.status <> 'Active' THEN
    RAISE EXCEPTION 'The listing is no longer available for confirmation';
  END IF;
  IF listing_row.assigned_virtual_verifier_id IS NOT NULL
     AND listing_row.assigned_virtual_verifier_id <> auth.uid() THEN
    RAISE EXCEPTION 'Only the Employee 1 assigned to this listing can review it';
  END IF;

  IF NOT p_confirm THEN
    UPDATE public.listing_deals SET status = 'rejected', reviewed_by = auth.uid(),
      reviewed_at = now(), employee_note = NULLIF(trim(p_note), ''),
      closed_at = now(), updated_at = now() WHERE id = p_deal_id;
    INSERT INTO public.listing_deal_events
      (deal_id, actor_id, actor_name_snapshot, event_type, old_status, new_status, details)
    SELECT p_deal_id, p.id, p.full_name, 'employee_rejected', 'awaiting_employee', 'rejected',
      jsonb_build_object('note', NULLIF(trim(p_note), ''))
    FROM public.profiles p WHERE p.id = auth.uid();
    RETURN 'rejected';
  END IF;

  final_listing_status := CASE deal_row.transaction_type WHEN 'sale' THEN 'Sold' ELSE 'Rented' END;
  final_deal_status := 'confirmed';
  event_name := 'employee_confirmed';
  IF deal_row.transaction_type = 'rent' THEN
    lease_start := (now() AT TIME ZONE 'Asia/Kolkata')::date;
    lease_end := (lease_start + make_interval(months => deal_row.rental_months))::date;
  END IF;

  UPDATE public.listing_deals SET status = final_deal_status,
    reviewed_by = auth.uid(), reviewed_at = now(), closed_at = now(),
    employee_note = NULLIF(trim(p_note), ''), lease_start_on = lease_start,
    lease_end_on = lease_end, updated_at = now()
  WHERE id = p_deal_id;

  PERFORM set_config('projectx.deal_confirmation_id', p_deal_id::text, true);
  UPDATE public.listings SET status = final_listing_status, updated_at = now()
  WHERE id = deal_row.listing_id;

  INSERT INTO public.listing_status_history (listing_id, changed_by, old_status, new_status, reason)
  VALUES (deal_row.listing_id, auth.uid(), listing_row.status, final_listing_status,
    format('Confirmed %s deal %s for buyer %s', deal_row.transaction_type, p_deal_id, deal_row.buyer_id));
  INSERT INTO public.listing_deal_events
    (deal_id, actor_id, actor_name_snapshot, event_type, old_status, new_status, details)
  SELECT p_deal_id, p.id, p.full_name, event_name, 'awaiting_employee', 'confirmed',
    jsonb_build_object('listing_status', final_listing_status,
      'lease_start_on', lease_start, 'lease_end_on', lease_end,
      'note', NULLIF(trim(p_note), ''))
  FROM public.profiles p WHERE p.id = auth.uid();
  RETURN final_listing_status;
END;
$$;

REVOKE ALL ON FUNCTION public.broker_propose_listing_deal(bigint, uuid, text, smallint, numeric, text) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.buyer_respond_to_listing_deal(uuid, boolean, text) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.broker_cancel_listing_deal(uuid, text) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.employee1_review_listing_deal(uuid, boolean, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.broker_propose_listing_deal(bigint, uuid, text, smallint, numeric, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.buyer_respond_to_listing_deal(uuid, boolean, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.broker_cancel_listing_deal(uuid, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.employee1_review_listing_deal(uuid, boolean, text) TO authenticated;

-- Employee 1 may move an Active listing to Sold/Rented only while the
-- matching, buyer-accepted deal is being confirmed by the secured RPC above.
CREATE OR REPLACE FUNCTION public.guard_listing_verification_fields()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER
SET search_path TO pg_catalog, public
AS $$
DECLARE actor_role text; distance_m double precision; confirmation_id text;
BEGIN
  SELECT CASE WHEN role = 'Employee' THEN employee_type ELSE role END INTO actor_role
  FROM public.profiles WHERE id = auth.uid();

  IF NEW.assigned_virtual_verifier_id IS DISTINCT FROM OLD.assigned_virtual_verifier_id
     OR NEW.assigned_field_agent_id IS DISTINCT FROM OLD.assigned_field_agent_id THEN
    IF actor_role = 'Admin' THEN NULL;
    ELSIF actor_role = 'Employee 1'
      AND OLD.broker_id IS NOT NULL AND OLD.status = 'Pending'
      AND OLD.assigned_virtual_verifier_id = auth.uid()
      AND OLD.virtually_verified IS FALSE
      AND NEW.virtually_verified IS TRUE AND NEW.virtually_verified_by = auth.uid()
      AND NEW.status = 'Under Review'
      AND NEW.assigned_virtual_verifier_id IS NOT DISTINCT FROM OLD.assigned_virtual_verifier_id
      AND NEW.assigned_field_agent_id IS NOT NULL
      AND EXISTS (SELECT 1 FROM public.profiles p WHERE p.id = NEW.assigned_field_agent_id
        AND p.role = 'Employee' AND p.employee_type = 'Employee 2') THEN NULL;
    ELSE RAISE EXCEPTION 'Only Admin or the assigned Employee 1 handoff can change verifier assignments';
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
       AND NEW.field_verification_lng IS NULL AND NEW.field_verified_at IS NULL THEN NULL;
    ELSIF actor_role = 'Employee 2' AND OLD.assigned_field_agent_id = auth.uid()
       AND OLD.virtually_verified IS TRUE AND OLD.status = 'Under Review'
       AND NEW.field_verified IS TRUE AND NEW.field_verified_by = auth.uid()
       AND NEW.field_verification_photo_url LIKE auth.uid()::text || '/%'
       AND NEW.field_verification_lat BETWEEN -90 AND 90
       AND NEW.field_verification_lng BETWEEN -180 AND 180 THEN
      distance_m := public.listing_verification_distance_meters(
        NEW.lat, NEW.lng, NEW.field_verification_lat, NEW.field_verification_lng);
      IF distance_m IS NULL OR distance_m > 200 THEN
        RAISE EXCEPTION 'Field verification must be within 200 meters of the listing';
      END IF;
    ELSE RAISE EXCEPTION 'Only the assigned Employee 2 can save valid field verification evidence';
    END IF;
  END IF;

  IF NEW.status IS DISTINCT FROM OLD.status THEN
    IF NEW.status IN ('Sold', 'Rented') AND actor_role = 'Employee 1' THEN
      confirmation_id := current_setting('projectx.deal_confirmation_id', true);
      IF confirmation_id IS NULL OR NOT EXISTS (
        SELECT 1 FROM public.listing_deals d
        WHERE d.id::text = confirmation_id AND d.listing_id = OLD.id
          AND d.reviewed_by = auth.uid() AND d.status = 'confirmed'
          AND ((NEW.status = 'Sold' AND d.transaction_type = 'sale')
            OR (NEW.status = 'Rented' AND d.transaction_type = 'rent'))
      ) THEN
        RAISE EXCEPTION 'A buyer-accepted deal must be confirmed through the Employee 1 review action';
      END IF;
    ELSIF NEW.status = 'Under Review' AND actor_role = 'Employee 1'
       AND OLD.status = 'Pending' AND OLD.broker_id IS NOT NULL
       AND OLD.assigned_virtual_verifier_id = auth.uid()
       AND NEW.virtually_verified IS TRUE AND NEW.virtually_verified_by = auth.uid()
       AND NEW.assigned_field_agent_id IS NOT NULL THEN NULL;
    ELSIF NEW.status = 'Active' AND actor_role = 'Employee 2'
       AND OLD.status = 'Under Review' AND OLD.virtually_verified IS TRUE
       AND NEW.field_verified IS TRUE AND NEW.field_verified_by = auth.uid()
       AND OLD.assigned_field_agent_id = auth.uid() THEN NULL;
    ELSIF NEW.status = 'Rejected' AND (
      (actor_role = 'Employee 1' AND OLD.status = 'Pending' AND OLD.broker_id IS NOT NULL
        AND OLD.assigned_virtual_verifier_id = auth.uid())
      OR (actor_role = 'Employee 2' AND OLD.status = 'Under Review'
        AND OLD.virtually_verified IS TRUE AND OLD.assigned_field_agent_id = auth.uid())
      OR actor_role = 'Admin'
    ) THEN NULL;
    ELSIF actor_role = 'Admin' THEN NULL;
    ELSE RAISE EXCEPTION 'This role cannot make the requested listing status transition';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

-- Employee 1 can see the listing only while it is in the assigned deal queue;
-- deal participants retain access to transaction listings after sale/rental.
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
  OR EXISTS (SELECT 1 FROM public.listing_deals d WHERE d.listing_id = listings.id
    AND ((d.buyer_id = auth.uid() AND d.status = 'confirmed') OR (d.status = 'awaiting_employee'
      AND (listings.assigned_virtual_verifier_id IS NULL OR listings.assigned_virtual_verifier_id = auth.uid()))))
);
DROP POLICY IF EXISTS listing_deal_participant_read ON public.listings;
CREATE POLICY listing_deal_participant_read ON public.listings
FOR SELECT TO authenticated USING (EXISTS (
  SELECT 1 FROM public.listing_deals d
  WHERE d.listing_id = listings.id
    AND ((d.buyer_id = auth.uid() AND d.status = 'confirmed') OR d.broker_id = auth.uid()
      OR (d.status = 'awaiting_employee'
        AND (listings.assigned_virtual_verifier_id IS NULL OR listings.assigned_virtual_verifier_id = auth.uid())
        AND EXISTS (SELECT 1 FROM public.profiles p WHERE p.id = auth.uid()
          AND p.role = 'Employee' AND p.employee_type = 'Employee 1')))
));

-- Preserve the existing administrative status endpoint and allow the new
-- terminal rental state in the admin dashboard.
CREATE OR REPLACE FUNCTION public.admin_update_listing_status(
  p_listing_id bigint, p_new_status text, p_reason text DEFAULT NULL
)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path TO pg_catalog, public AS $$
DECLARE prior_status text;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.profiles WHERE id = auth.uid() AND role = 'Admin') THEN
    RAISE EXCEPTION 'Administrator access required';
  END IF;
  IF p_new_status NOT IN ('Draft', 'Pending', 'Under Review', 'Active', 'Rejected', 'Suspended', 'Sold', 'Rented', 'Flagged') THEN
    RAISE EXCEPTION 'Unsupported listing status';
  END IF;
  IF p_new_status IN ('Rejected', 'Suspended') AND NULLIF(trim(p_reason), '') IS NULL THEN
    RAISE EXCEPTION 'A reason is required for this status';
  END IF;
  SELECT status INTO prior_status FROM public.listings WHERE id = p_listing_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Listing not found'; END IF;
  IF prior_status = p_new_status THEN RETURN; END IF;
  UPDATE public.listings SET status = p_new_status,
    rejection_reason = CASE WHEN p_new_status = 'Rejected' THEN trim(p_reason)
      WHEN prior_status = 'Rejected' THEN NULL ELSE rejection_reason END,
    updated_at = now() WHERE id = p_listing_id;
  INSERT INTO public.listing_status_history (listing_id, changed_by, old_status, new_status, reason)
  VALUES (p_listing_id, auth.uid(), prior_status, p_new_status, NULLIF(trim(p_reason), ''));
END;
$$;
REVOKE ALL ON FUNCTION public.admin_update_listing_status(bigint, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.admin_update_listing_status(bigint, text, text) TO authenticated;

-- Let counterparties and assigned Employee 1 resolve deal participants without
-- granting broad profile-table reads.
CREATE OR REPLACE FUNCTION public.get_related_profile_identities(p_ids uuid[])
RETURNS TABLE (id uuid, full_name text, avatar_url text)
LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path TO pg_catalog, public
AS $$
BEGIN
  IF auth.uid() IS NULL OR p_ids IS NULL THEN RETURN; END IF;
  RETURN QUERY
  SELECT p.id, p.full_name, p.avatar_url
  FROM public.profiles p
  WHERE p.id = ANY (p_ids) AND p.id IS DISTINCT FROM auth.uid()
    AND (
      EXISTS (SELECT 1 FROM public.messages m WHERE
        (m.broker_id = auth.uid() AND m.buyer_id = p.id)
        OR (m.buyer_id = auth.uid() AND m.broker_id = p.id))
      OR EXISTS (SELECT 1 FROM public.inquiries i WHERE
        (i.broker_id = auth.uid() AND i.buyer_id = p.id)
        OR (i.buyer_id = auth.uid() AND i.broker_id = p.id))
      OR EXISTS (SELECT 1 FROM public.conversations c WHERE
        (c.broker_id = auth.uid() AND c.buyer_id = p.id)
        OR (c.buyer_id = auth.uid() AND c.broker_id = p.id))
      OR EXISTS (SELECT 1 FROM public.listing_deals d WHERE
        ((d.broker_id = auth.uid() OR d.buyer_id = auth.uid())
          AND (d.broker_id = p.id OR d.buyer_id = p.id))
        OR (d.status = 'awaiting_employee'
          AND (d.broker_id = p.id OR d.buyer_id = p.id)
          AND EXISTS (SELECT 1 FROM public.profiles staff
            WHERE staff.id = auth.uid() AND staff.role = 'Employee'
              AND staff.employee_type = 'Employee 1')
          AND EXISTS (SELECT 1 FROM public.listings l WHERE l.id = d.listing_id
            AND (l.assigned_virtual_verifier_id IS NULL OR l.assigned_virtual_verifier_id = auth.uid())))
      )
    );
END;
$$;
REVOKE ALL ON FUNCTION public.get_related_profile_identities(uuid[]) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_related_profile_identities(uuid[]) TO authenticated;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_publication_tables WHERE pubname = 'supabase_realtime'
    AND schemaname = 'public' AND tablename = 'listing_deals') THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE public.listing_deals;
  END IF;
END;
$$;

NOTIFY pgrst, 'reload schema';

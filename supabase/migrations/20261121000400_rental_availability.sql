-- Keep successfully rented homes visible to buyers with their next availability
-- date. Sold homes remain private from public listing search.
ALTER TABLE public.listings
  ADD COLUMN IF NOT EXISTS available_from date;

WITH latest_confirmed_rent AS (
  SELECT DISTINCT ON (listing_id) listing_id, lease_end_on
  FROM public.listing_deals
  WHERE status = 'confirmed' AND transaction_type = 'rent' AND lease_end_on IS NOT NULL
  ORDER BY listing_id, reviewed_at DESC NULLS LAST, created_at DESC, id DESC
)
UPDATE public.listings l
SET available_from = r.lease_end_on
FROM latest_confirmed_rent r
WHERE r.listing_id = l.id AND l.status = 'Rented' AND l.available_from IS NULL;

CREATE OR REPLACE FUNCTION public.guard_listing_rental_availability()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER
SET search_path TO pg_catalog, public
AS $$
DECLARE confirmation_id text;
BEGIN
  IF NEW.available_from IS NOT DISTINCT FROM OLD.available_from THEN RETURN NEW; END IF;
  IF EXISTS (SELECT 1 FROM public.profiles p WHERE p.id = auth.uid() AND p.role = 'Admin') THEN RETURN NEW; END IF;
  confirmation_id := current_setting('projectx.deal_confirmation_id', true);
  IF confirmation_id IS NOT NULL AND EXISTS (
    SELECT 1 FROM public.listing_deals d
    WHERE d.id::text = confirmation_id AND d.listing_id = OLD.id
      AND d.reviewed_by = auth.uid() AND d.status = 'confirmed'
      AND ((d.transaction_type = 'rent' AND NEW.status = 'Rented' AND NEW.available_from = d.lease_end_on)
        OR (d.transaction_type = 'sale' AND NEW.status = 'Sold' AND NEW.available_from IS NULL))
  ) THEN RETURN NEW; END IF;
  RAISE EXCEPTION 'Rental availability can only be changed by a confirmed deal';
END;
$$;
DROP TRIGGER IF EXISTS guard_listing_rental_availability ON public.listings;
CREATE TRIGGER guard_listing_rental_availability
BEFORE UPDATE OF available_from ON public.listings
FOR EACH ROW EXECUTE FUNCTION public.guard_listing_rental_availability();

DROP POLICY IF EXISTS listings_public_active_scope ON public.listings;
CREATE POLICY listings_public_active_scope ON public.listings AS RESTRICTIVE
FOR SELECT TO anon USING (
  status = 'Active' OR (status = 'Rented' AND available_from IS NOT NULL)
);
DROP POLICY IF EXISTS listings_public_active_read ON public.listings;
CREATE POLICY listings_public_active_read ON public.listings AS PERMISSIVE
FOR SELECT TO anon USING (
  status = 'Active' OR (status = 'Rented' AND available_from IS NOT NULL)
);

DROP POLICY IF EXISTS listings_role_scope_select ON public.listings;
CREATE POLICY listings_role_scope_select ON public.listings AS RESTRICTIVE
FOR SELECT TO authenticated USING (
  status = 'Active' OR (status = 'Rented' AND available_from IS NOT NULL)
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
DROP POLICY IF EXISTS listings_role_read ON public.listings;
CREATE POLICY listings_role_read ON public.listings AS PERMISSIVE
FOR SELECT TO authenticated USING (
  status = 'Active' OR (status = 'Rented' AND available_from IS NOT NULL)
  OR EXISTS (SELECT 1 FROM public.profiles p WHERE p.id = auth.uid() AND p.role = 'Admin')
  OR EXISTS (SELECT 1 FROM public.profiles p WHERE p.id = auth.uid() AND p.role = 'Broker' AND p.id = listings.broker_id)
  OR EXISTS (SELECT 1 FROM public.profiles p WHERE p.id = auth.uid() AND p.role = 'Employee' AND p.employee_type = 'Employee 1'
    AND (listings.assigned_virtual_verifier_id = auth.uid() OR listings.created_by = auth.uid()))
  OR EXISTS (SELECT 1 FROM public.profiles p WHERE p.id = auth.uid() AND p.role = 'Employee' AND p.employee_type = 'Employee 2'
    AND listings.assigned_field_agent_id = auth.uid() AND listings.virtually_verified IS TRUE)
);

-- Listing galleries follow the same buyer-visible inventory rule as listing
-- rows, so rented properties retain their photos in public search and details.
DROP POLICY IF EXISTS listing_media_select_active ON public.listing_media;
CREATE POLICY listing_media_select_active ON public.listing_media
FOR SELECT TO anon, authenticated USING (EXISTS (
  SELECT 1 FROM public.listings l
  WHERE l.id = listing_media.listing_id
    AND (trim(l.status) = 'Active' OR (trim(l.status) = 'Rented' AND l.available_from IS NOT NULL))
));

-- A broker can prepare another rental offer for a rented home, but only once
-- its stored availability date has arrived. Sold inventory is never reusable.
CREATE OR REPLACE FUNCTION public.broker_propose_listing_deal(
  p_listing_id bigint, p_buyer_id uuid, p_transaction_type text,
  p_rental_months smallint DEFAULT NULL, p_proposed_amount numeric DEFAULT NULL,
  p_broker_note text DEFAULT NULL
)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path TO pg_catalog, public AS $$
DECLARE
  listing_row public.listings%ROWTYPE;
  conversation_uuid uuid;
  deal_uuid uuid;
  price_basis text;
BEGIN
  IF auth.uid() IS NULL OR NOT EXISTS (SELECT 1 FROM public.profiles p WHERE p.id = auth.uid() AND p.role = 'Broker') THEN
    RAISE EXCEPTION 'Only a signed-in broker can propose a deal';
  END IF;
  IF p_buyer_id IS NULL OR p_buyer_id = auth.uid()
     OR NOT EXISTS (SELECT 1 FROM public.profiles p WHERE p.id = p_buyer_id AND p.role = 'Buyer') THEN
    RAISE EXCEPTION 'Select a valid buyer';
  END IF;
  IF p_transaction_type IS NULL OR p_transaction_type NOT IN ('sale', 'rent') THEN RAISE EXCEPTION 'Choose sale or rent'; END IF;
  IF p_proposed_amount IS NOT NULL AND p_proposed_amount <= 0 THEN RAISE EXCEPTION 'The proposed amount must be greater than zero'; END IF;
  IF length(COALESCE(p_broker_note, '')) > 2000 THEN RAISE EXCEPTION 'Broker note must be 2,000 characters or fewer'; END IF;
  IF (p_transaction_type = 'rent' AND (p_rental_months IS NULL OR p_rental_months NOT BETWEEN 1 AND 12))
     OR (p_transaction_type = 'sale' AND p_rental_months IS NOT NULL) THEN
    RAISE EXCEPTION 'Rent terms must be 1-12 months; sale deals do not have a rental term';
  END IF;
  SELECT * INTO listing_row FROM public.listings WHERE id = p_listing_id AND broker_id = auth.uid() FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'This listing does not belong to your account'; END IF;
  IF listing_row.status <> 'Active' AND NOT (
    listing_row.status = 'Rented' AND listing_row.available_from IS NOT NULL
    AND listing_row.available_from <= (now() AT TIME ZONE 'Asia/Kolkata')::date
  ) THEN RAISE EXCEPTION 'This listing is not currently available for a new deal'; END IF;
  IF NOT (EXISTS (SELECT 1 FROM public.inquiries i WHERE i.listing_id = p_listing_id AND i.broker_id = auth.uid() AND i.buyer_id = p_buyer_id)
    OR EXISTS (SELECT 1 FROM public.conversations c WHERE c.broker_id = auth.uid() AND c.buyer_id = p_buyer_id)) THEN
    RAISE EXCEPTION 'The buyer must have an existing inquiry or chat with you';
  END IF;
  SELECT c.id INTO conversation_uuid FROM public.conversations c
  WHERE c.broker_id = auth.uid() AND c.buyer_id = p_buyer_id
  ORDER BY c.last_message_at DESC NULLS LAST, c.created_at DESC LIMIT 1;
  IF conversation_uuid IS NULL THEN
    INSERT INTO public.conversations (buyer_id, broker_id, listing_id) VALUES (p_buyer_id, auth.uid(), NULL)
    RETURNING id INTO conversation_uuid;
    IF conversation_uuid IS NULL THEN
      SELECT c.id INTO conversation_uuid FROM public.conversations c WHERE c.buyer_id = p_buyer_id AND c.broker_id = auth.uid() LIMIT 1;
    END IF;
  END IF;
  price_basis := CASE WHEN p_transaction_type = 'rent' THEN 'monthly' ELSE 'total' END;
  INSERT INTO public.listing_deals (listing_id, broker_id, buyer_id, conversation_id, transaction_type,
    status, proposed_amount, amount_basis, rental_months, broker_note)
  VALUES (p_listing_id, auth.uid(), p_buyer_id, conversation_uuid, p_transaction_type,
    'awaiting_buyer', p_proposed_amount, price_basis, p_rental_months, NULLIF(trim(p_broker_note), ''))
  RETURNING id INTO deal_uuid;
  INSERT INTO public.listing_deal_events (deal_id, actor_id, actor_name_snapshot, event_type, new_status, details)
  SELECT deal_uuid, p.id, p.full_name, 'broker_proposed', 'awaiting_buyer',
    jsonb_build_object('transaction_type', p_transaction_type, 'rental_months', p_rental_months,
      'proposed_amount', p_proposed_amount, 'amount_basis', price_basis, 'listing_title', listing_row.title)
  FROM public.profiles p WHERE p.id = auth.uid();
  RETURN deal_uuid;
EXCEPTION WHEN unique_violation THEN RAISE EXCEPTION 'There is already an open deal for this listing';
END;
$$;

CREATE OR REPLACE FUNCTION public.employee1_review_listing_deal(p_deal_id uuid, p_confirm boolean, p_note text DEFAULT NULL)
RETURNS text LANGUAGE plpgsql SECURITY DEFINER SET search_path TO pg_catalog, public AS $$
DECLARE
  deal_row public.listing_deals%ROWTYPE;
  listing_row public.listings%ROWTYPE;
  final_listing_status text;
  lease_start date;
  lease_end date;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.profiles p WHERE p.id = auth.uid() AND p.role = 'Employee' AND p.employee_type = 'Employee 1') THEN
    RAISE EXCEPTION 'Only Employee 1 can review accepted deals';
  END IF;
  IF p_confirm IS NULL THEN RAISE EXCEPTION 'Choose confirm or reject'; END IF;
  IF NOT p_confirm AND NULLIF(trim(p_note), '') IS NULL THEN RAISE EXCEPTION 'Add a reason when rejecting a deal'; END IF;
  IF length(COALESCE(p_note, '')) > 2000 THEN RAISE EXCEPTION 'Note must be 2,000 characters or fewer'; END IF;
  SELECT * INTO deal_row FROM public.listing_deals WHERE id = p_deal_id FOR UPDATE;
  IF NOT FOUND OR deal_row.status <> 'awaiting_employee' THEN RAISE EXCEPTION 'Accepted deal not found in the Employee 1 review queue'; END IF;
  SELECT * INTO listing_row FROM public.listings WHERE id = deal_row.listing_id FOR UPDATE;
  IF NOT FOUND OR NOT (listing_row.status = 'Active' OR (listing_row.status = 'Rented' AND listing_row.available_from IS NOT NULL
    AND listing_row.available_from <= (now() AT TIME ZONE 'Asia/Kolkata')::date)) THEN
    RAISE EXCEPTION 'The listing is not available for confirmation';
  END IF;
  IF listing_row.assigned_virtual_verifier_id IS NOT NULL AND listing_row.assigned_virtual_verifier_id <> auth.uid() THEN
    RAISE EXCEPTION 'Only the Employee 1 assigned to this listing can review it';
  END IF;
  IF NOT p_confirm THEN
    UPDATE public.listing_deals SET status = 'rejected', reviewed_by = auth.uid(), reviewed_at = now(),
      employee_note = NULLIF(trim(p_note), ''), closed_at = now(), updated_at = now() WHERE id = p_deal_id;
    INSERT INTO public.listing_deal_events (deal_id, actor_id, actor_name_snapshot, event_type, old_status, new_status, details)
    SELECT p_deal_id, p.id, p.full_name, 'employee_rejected', 'awaiting_employee', 'rejected', jsonb_build_object('note', NULLIF(trim(p_note), ''))
    FROM public.profiles p WHERE p.id = auth.uid();
    RETURN 'rejected';
  END IF;
  final_listing_status := CASE deal_row.transaction_type WHEN 'sale' THEN 'Sold' ELSE 'Rented' END;
  IF deal_row.transaction_type = 'rent' THEN
    lease_start := GREATEST((now() AT TIME ZONE 'Asia/Kolkata')::date, COALESCE(listing_row.available_from, (now() AT TIME ZONE 'Asia/Kolkata')::date));
    lease_end := (lease_start + make_interval(months => deal_row.rental_months))::date;
  END IF;
  UPDATE public.listing_deals SET status = 'confirmed', reviewed_by = auth.uid(), reviewed_at = now(), closed_at = now(),
    employee_note = NULLIF(trim(p_note), ''), lease_start_on = lease_start, lease_end_on = lease_end, updated_at = now()
  WHERE id = p_deal_id;
  PERFORM set_config('projectx.deal_confirmation_id', p_deal_id::text, true);
  UPDATE public.listings SET status = final_listing_status,
    intent = CASE WHEN deal_row.transaction_type = 'rent' THEN 'Rent' ELSE 'Buy' END,
    available_from = CASE WHEN deal_row.transaction_type = 'rent' THEN lease_end ELSE NULL END, updated_at = now()
  WHERE id = deal_row.listing_id;
  IF listing_row.status IS DISTINCT FROM final_listing_status THEN
    INSERT INTO public.listing_status_history (listing_id, changed_by, old_status, new_status, reason)
    VALUES (deal_row.listing_id, auth.uid(), listing_row.status, final_listing_status,
      format('Confirmed %s deal %s for buyer %s', deal_row.transaction_type, p_deal_id, deal_row.buyer_id));
  END IF;
  INSERT INTO public.listing_deal_events (deal_id, actor_id, actor_name_snapshot, event_type, old_status, new_status, details)
  SELECT p_deal_id, p.id, p.full_name, 'employee_confirmed', 'awaiting_employee', 'confirmed',
    jsonb_build_object('listing_status', final_listing_status, 'lease_start_on', lease_start, 'lease_end_on', lease_end,
      'note', NULLIF(trim(p_note), '')) FROM public.profiles p WHERE p.id = auth.uid();
  RETURN final_listing_status;
END;
$$;

REVOKE ALL ON FUNCTION public.broker_propose_listing_deal(bigint, uuid, text, smallint, numeric, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.broker_propose_listing_deal(bigint, uuid, text, smallint, numeric, text) TO authenticated;
REVOKE ALL ON FUNCTION public.employee1_review_listing_deal(uuid, boolean, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.employee1_review_listing_deal(uuid, boolean, text) TO authenticated;

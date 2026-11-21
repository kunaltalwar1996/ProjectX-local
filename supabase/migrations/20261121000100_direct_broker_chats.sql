-- Listing-free conversations are direct messages started from a broker profile.
ALTER TABLE public.conversations ALTER COLUMN listing_id DROP NOT NULL;
ALTER TABLE public.messages ALTER COLUMN listing_id DROP NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS conversations_direct_pair_unique
  ON public.conversations (buyer_id, broker_id) WHERE listing_id IS NULL;

DROP POLICY IF EXISTS "broker can start conversation from inquiry" ON public.conversations;
CREATE POLICY "participants can start conversations"
ON public.conversations FOR INSERT TO authenticated
WITH CHECK (
  (broker_id = auth.uid() AND EXISTS (
    SELECT 1 FROM public.profiles p WHERE p.id = auth.uid() AND p.role = 'Broker'
  ) AND EXISTS (
    SELECT 1 FROM public.listings l WHERE l.id = listing_id AND l.broker_id = auth.uid()
  ) AND EXISTS (
    SELECT 1 FROM public.inquiries i
    WHERE i.buyer_id = public.conversations.buyer_id
      AND i.broker_id = auth.uid() AND i.listing_id = public.conversations.listing_id
  ))
  OR
  (buyer_id = auth.uid() AND listing_id IS NULL AND EXISTS (
    SELECT 1 FROM public.profiles p WHERE p.id = auth.uid() AND p.role = 'Buyer'
  ) AND EXISTS (
    SELECT 1 FROM public.profiles p WHERE p.id = public.conversations.broker_id AND p.role = 'Broker'
  ))
);

DROP POLICY IF EXISTS "conversation participants can read messages" ON public.messages;
CREATE POLICY "conversation participants can read messages"
ON public.messages FOR SELECT TO authenticated
USING (EXISTS (
  SELECT 1 FROM public.conversations c
  WHERE c.buyer_id = messages.buyer_id AND c.broker_id = messages.broker_id
    AND c.listing_id IS NOT DISTINCT FROM messages.listing_id
    AND (c.buyer_id = auth.uid() OR c.broker_id = auth.uid())
));

DROP POLICY IF EXISTS "participants can send conversation messages" ON public.messages;
CREATE POLICY "participants can send conversation messages"
ON public.messages FOR INSERT TO authenticated
WITH CHECK (
  sender_id = auth.uid() AND EXISTS (
    SELECT 1 FROM public.conversations c
    WHERE c.buyer_id = messages.buyer_id AND c.broker_id = messages.broker_id
      AND c.listing_id IS NOT DISTINCT FROM messages.listing_id
      AND (c.buyer_id = auth.uid() OR c.broker_id = auth.uid())
  )
);

CREATE OR REPLACE FUNCTION public.start_direct_broker_chat(p_broker_id uuid)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE conversation_uuid uuid;
BEGIN
  IF auth.uid() IS NULL OR auth.uid() = p_broker_id THEN
    RAISE EXCEPTION 'A signed-in buyer must select another user';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.profiles p WHERE p.id = auth.uid() AND p.role = 'Buyer') THEN
    RAISE EXCEPTION 'Only buyers can start a direct broker chat';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.profiles p WHERE p.id = p_broker_id AND p.role = 'Broker') THEN
    RAISE EXCEPTION 'Broker not found';
  END IF;
  INSERT INTO public.conversations (buyer_id, broker_id, listing_id)
  VALUES (auth.uid(), p_broker_id, NULL)
  ON CONFLICT (buyer_id, broker_id) WHERE listing_id IS NULL DO NOTHING
  RETURNING id INTO conversation_uuid;
  IF conversation_uuid IS NULL THEN
    SELECT c.id INTO conversation_uuid FROM public.conversations c
    WHERE c.buyer_id = auth.uid() AND c.broker_id = p_broker_id AND c.listing_id IS NULL;
  END IF;
  RETURN conversation_uuid;
END;
$$;
REVOKE ALL ON FUNCTION public.start_direct_broker_chat(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.start_direct_broker_chat(uuid) TO authenticated;

CREATE OR REPLACE FUNCTION public.sync_conversation_after_message()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  UPDATE public.conversations
  SET last_message_at = GREATEST(COALESCE(last_message_at, NEW.created_at), NEW.created_at),
      last_message_preview = CASE
        WHEN NEW.created_at >= COALESCE(last_message_at, '-infinity'::timestamptz)
          THEN left(NEW.content, 160) ELSE last_message_preview END,
      updated_at = GREATEST(COALESCE(updated_at, NEW.created_at), NEW.created_at)
  WHERE buyer_id = NEW.buyer_id AND broker_id = NEW.broker_id
    AND listing_id IS NOT DISTINCT FROM NEW.listing_id;
  RETURN NEW;
END;
$$;

NOTIFY pgrst, 'reload schema';

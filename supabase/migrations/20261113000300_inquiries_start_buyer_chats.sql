-- Turn registered buyers' submitted inquiries into the first message in chat.
-- Guest inquiries remain in the broker's inquiry workflow without a buyer chat.

ALTER TABLE public.conversations ENABLE ROW LEVEL SECURITY;
GRANT SELECT, INSERT ON public.conversations TO authenticated;
REVOKE UPDATE ON public.conversations FROM authenticated;
GRANT UPDATE (buyer_last_read_at, broker_last_read_at)
  ON public.conversations TO authenticated;

DROP POLICY IF EXISTS "conversation participants can read" ON public.conversations;
CREATE POLICY "conversation participants can read"
ON public.conversations FOR SELECT TO authenticated
USING (buyer_id = (SELECT auth.uid()) OR broker_id = (SELECT auth.uid()));

DROP POLICY IF EXISTS "broker can start conversation from inquiry" ON public.conversations;
CREATE POLICY "broker can start conversation from inquiry"
ON public.conversations FOR INSERT TO authenticated
WITH CHECK (
  broker_id = (SELECT auth.uid())
  AND EXISTS (
    SELECT 1 FROM public.profiles p
    WHERE p.id = auth.uid() AND p.role = 'Broker'
  )
  AND EXISTS (
    SELECT 1 FROM public.listings l
    WHERE l.id = public.conversations.listing_id
      AND l.broker_id = auth.uid()
  )
  AND EXISTS (
    SELECT 1 FROM public.inquiries i
    WHERE i.buyer_id = public.conversations.buyer_id
      AND i.broker_id = auth.uid()
      AND i.listing_id = public.conversations.listing_id
  )
);

DROP POLICY IF EXISTS "participants can update conversation metadata" ON public.conversations;
CREATE POLICY "participants can update conversation metadata"
ON public.conversations FOR UPDATE TO authenticated
USING (buyer_id = (SELECT auth.uid()) OR broker_id = (SELECT auth.uid()))
WITH CHECK (buyer_id = (SELECT auth.uid()) OR broker_id = (SELECT auth.uid()));

ALTER TABLE public.messages ENABLE ROW LEVEL SECURITY;
GRANT SELECT, INSERT ON public.messages TO authenticated;
DO $$
DECLARE policy_row record;
BEGIN
  FOR policy_row IN
    SELECT policyname FROM pg_policies
    WHERE schemaname = 'public' AND tablename = 'messages'
  LOOP
    EXECUTE format('DROP POLICY %I ON public.messages', policy_row.policyname);
  END LOOP;
END;
$$;

CREATE POLICY "conversation participants can read messages"
ON public.messages FOR SELECT TO authenticated
USING (EXISTS (
  SELECT 1 FROM public.conversations c
  WHERE c.buyer_id = messages.buyer_id
    AND c.broker_id = messages.broker_id
    AND c.listing_id = messages.listing_id
    AND (c.buyer_id = auth.uid() OR c.broker_id = auth.uid())
));

CREATE POLICY "participants can send conversation messages"
ON public.messages FOR INSERT TO authenticated
WITH CHECK (
  sender_id = auth.uid()
  AND EXISTS (
    SELECT 1 FROM public.conversations c
    WHERE c.buyer_id = messages.buyer_id
      AND c.broker_id = messages.broker_id
      AND c.listing_id = messages.listing_id
      AND (c.buyer_id = auth.uid() OR c.broker_id = auth.uid())
  )
);

CREATE OR REPLACE FUNCTION public.sync_conversation_after_message()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  UPDATE public.conversations
  SET last_message_at = GREATEST(
        COALESCE(last_message_at, NEW.created_at),
        NEW.created_at
      ),
      last_message_preview = CASE
        WHEN NEW.created_at >= COALESCE(last_message_at, '-infinity'::timestamptz)
          THEN left(NEW.content, 160)
        ELSE last_message_preview
      END,
      updated_at = GREATEST(
        COALESCE(updated_at, NEW.created_at),
        NEW.created_at
      )
  WHERE buyer_id = NEW.buyer_id
    AND broker_id = NEW.broker_id
    AND listing_id = NEW.listing_id;
  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.sync_conversation_after_message() FROM PUBLIC, anon, authenticated;
DROP TRIGGER IF EXISTS sync_conversation_after_message ON public.messages;
CREATE TRIGGER sync_conversation_after_message
AFTER INSERT ON public.messages
FOR EACH ROW EXECUTE FUNCTION public.sync_conversation_after_message();

CREATE OR REPLACE FUNCTION public.start_chat_for_buyer_inquiry()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  conversation_uuid uuid;
BEGIN
  IF NEW.buyer_id IS NULL OR NEW.broker_id IS NULL OR NEW.listing_id IS NULL THEN
    RETURN NEW;
  END IF;

  IF auth.uid() IS NULL OR auth.uid() IS DISTINCT FROM NEW.buyer_id THEN
    RETURN NEW;
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM public.listings l
    WHERE l.id = NEW.listing_id
      AND l.broker_id = NEW.broker_id
  ) THEN
    RAISE EXCEPTION 'Inquiry broker does not own the referenced listing';
  END IF;

  INSERT INTO public.conversations (buyer_id, broker_id, listing_id)
  VALUES (NEW.buyer_id, NEW.broker_id, NEW.listing_id)
  ON CONFLICT (buyer_id, broker_id, listing_id) DO NOTHING
  RETURNING id INTO conversation_uuid;

  IF conversation_uuid IS NULL THEN
    SELECT c.id INTO conversation_uuid
    FROM public.conversations c
    WHERE c.buyer_id = NEW.buyer_id
      AND c.broker_id = NEW.broker_id
      AND c.listing_id = NEW.listing_id;
  END IF;

  INSERT INTO public.messages
    (buyer_id, broker_id, listing_id, sender_id, content, created_at)
  VALUES
    (NEW.buyer_id, NEW.broker_id, NEW.listing_id, NEW.buyer_id,
     NEW.message, COALESCE(NEW.created_at, now()));

  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.start_chat_for_buyer_inquiry() FROM PUBLIC, anon, authenticated;
DROP TRIGGER IF EXISTS start_chat_for_buyer_inquiry ON public.inquiries;
CREATE TRIGGER start_chat_for_buyer_inquiry
AFTER INSERT ON public.inquiries
FOR EACH ROW EXECUTE FUNCTION public.start_chat_for_buyer_inquiry();

-- Backfill registered buyers' existing inquiries so they appear in both chat lists.
INSERT INTO public.conversations (buyer_id, broker_id, listing_id)
SELECT DISTINCT i.buyer_id, i.broker_id, i.listing_id
FROM public.inquiries i
JOIN public.listings l ON l.id = i.listing_id AND l.broker_id = i.broker_id
WHERE i.buyer_id IS NOT NULL
  AND i.broker_id IS NOT NULL
  AND i.listing_id IS NOT NULL
ON CONFLICT (buyer_id, broker_id, listing_id) DO NOTHING;

INSERT INTO public.messages
  (buyer_id, broker_id, listing_id, sender_id, content, created_at)
SELECT i.buyer_id, i.broker_id, i.listing_id, i.buyer_id,
       i.message, COALESCE(i.created_at, now())
FROM public.inquiries i
JOIN public.listings l ON l.id = i.listing_id AND l.broker_id = i.broker_id
WHERE i.buyer_id IS NOT NULL
  AND i.broker_id IS NOT NULL
  AND i.listing_id IS NOT NULL
  AND NOT EXISTS (
    SELECT 1
    FROM public.messages m
    WHERE m.buyer_id = i.buyer_id
      AND m.broker_id = i.broker_id
      AND m.listing_id = i.listing_id
      AND m.sender_id = i.buyer_id
      AND m.content = i.message
      AND m.created_at = COALESCE(i.created_at, now())
  );

-- Keep the broker's atomic reply endpoint available if the earlier feature
-- migration stopped before creating its RPC.
CREATE OR REPLACE FUNCTION public.broker_reply_to_inquiry(p_inquiry_id text, p_reply text)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  inquiry_row public.inquiries%rowtype;
  conversation_uuid uuid;
BEGIN
  IF auth.uid() IS NULL OR NOT EXISTS (
    SELECT 1 FROM public.profiles p
    WHERE p.id = auth.uid() AND p.role = 'Broker'
  ) THEN
    RAISE EXCEPTION 'Only the assigned broker can reply to this inquiry';
  END IF;
  IF p_reply IS NULL OR length(trim(p_reply)) = 0 OR length(p_reply) > 4000 THEN
    RAISE EXCEPTION 'Reply must contain between 1 and 4000 characters';
  END IF;

  SELECT i.* INTO inquiry_row
  FROM public.inquiries i
  JOIN public.listings l ON l.id = i.listing_id AND l.broker_id = auth.uid()
  WHERE i.id::text = p_inquiry_id AND i.broker_id = auth.uid()
  FOR UPDATE OF i;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Inquiry not found for this broker';
  END IF;

  IF inquiry_row.buyer_id IS NOT NULL THEN
    IF NOT EXISTS (
      SELECT 1 FROM public.profiles p
      WHERE p.id = inquiry_row.buyer_id AND p.role = 'Buyer'
    ) THEN
      RAISE EXCEPTION 'Inquiry is not linked to a buyer account';
    END IF;

    INSERT INTO public.conversations (buyer_id, broker_id, listing_id)
    VALUES (inquiry_row.buyer_id, auth.uid(), inquiry_row.listing_id)
    ON CONFLICT (buyer_id, broker_id, listing_id) DO NOTHING
    RETURNING id INTO conversation_uuid;
    IF conversation_uuid IS NULL THEN
      SELECT c.id INTO conversation_uuid
      FROM public.conversations c
      WHERE c.buyer_id = inquiry_row.buyer_id
        AND c.broker_id = auth.uid()
        AND c.listing_id = inquiry_row.listing_id;
    END IF;

    IF NOT EXISTS (
      SELECT 1 FROM public.messages m
      WHERE m.buyer_id = inquiry_row.buyer_id
        AND m.broker_id = auth.uid()
        AND m.listing_id = inquiry_row.listing_id
        AND m.sender_id = inquiry_row.buyer_id
    ) THEN
      INSERT INTO public.messages
        (buyer_id, broker_id, listing_id, sender_id, content, created_at)
      VALUES
        (inquiry_row.buyer_id, auth.uid(), inquiry_row.listing_id,
         inquiry_row.buyer_id, inquiry_row.message,
         COALESCE(inquiry_row.created_at, now()));
    END IF;

    INSERT INTO public.messages
      (buyer_id, broker_id, listing_id, sender_id, content)
    VALUES
      (inquiry_row.buyer_id, auth.uid(), inquiry_row.listing_id,
       auth.uid(), trim(p_reply));
  END IF;

  UPDATE public.inquiries
  SET broker_reply = trim(p_reply), read = true
  WHERE id::text = p_inquiry_id AND broker_id = auth.uid();
  RETURN conversation_uuid;
END;
$$;

REVOKE ALL ON FUNCTION public.broker_reply_to_inquiry(text, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.broker_reply_to_inquiry(text, text) TO authenticated;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_publication_tables
    WHERE pubname = 'supabase_realtime'
      AND schemaname = 'public'
      AND tablename = 'messages'
  ) THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE public.messages;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_publication_tables
    WHERE pubname = 'supabase_realtime'
      AND schemaname = 'public'
      AND tablename = 'conversations'
  ) THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE public.conversations;
  END IF;
END;
$$;

NOTIFY pgrst, 'reload schema';

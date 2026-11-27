-- Keep one durable chat thread per buyer/broker pair, regardless of how it began.
ALTER TABLE public.conversations
  ADD COLUMN IF NOT EXISTS buyer_archived_at timestamptz,
  ADD COLUMN IF NOT EXISTS broker_archived_at timestamptz;

ALTER TABLE public.messages
  ADD COLUMN IF NOT EXISTS conversation_id uuid REFERENCES public.conversations(id) ON DELETE CASCADE;

CREATE INDEX IF NOT EXISTS messages_conversation_created
  ON public.messages (conversation_id, created_at, id);

-- Ensure every legacy message has a conversation row before consolidating pairs.
INSERT INTO public.conversations (buyer_id, broker_id, listing_id)
SELECT DISTINCT ON (m.buyer_id, m.broker_id)
  m.buyer_id, m.broker_id, m.listing_id
FROM public.messages m
WHERE m.buyer_id IS NOT NULL AND m.broker_id IS NOT NULL
  AND NOT EXISTS (SELECT 1 FROM public.conversations c
    WHERE c.buyer_id = m.buyer_id AND c.broker_id = m.broker_id)
ORDER BY m.buyer_id, m.broker_id, m.created_at ASC, m.id
ON CONFLICT DO NOTHING;

-- Repoint deal records and all existing messages to the selected canonical
-- conversation for each pair. Keep the context (listing or direct) that started first.
WITH canonical AS (
  SELECT DISTINCT ON (buyer_id, broker_id)
    buyer_id, broker_id, id AS conversation_id
  FROM public.conversations
  ORDER BY buyer_id, broker_id, created_at ASC, id
)
UPDATE public.messages m
SET conversation_id = canonical.conversation_id
FROM canonical
WHERE m.buyer_id = canonical.buyer_id AND m.broker_id = canonical.broker_id;

UPDATE public.listing_deals d
SET conversation_id = canonical.conversation_id
FROM (
  SELECT DISTINCT ON (buyer_id, broker_id)
    buyer_id, broker_id, id AS conversation_id
  FROM public.conversations
  ORDER BY buyer_id, broker_id, created_at ASC, id
) canonical
WHERE d.buyer_id = canonical.buyer_id AND d.broker_id = canonical.broker_id;

WITH read_state AS (
  SELECT buyer_id, broker_id,
    max(buyer_last_read_at) AS buyer_last_read_at,
    max(broker_last_read_at) AS broker_last_read_at
  FROM public.conversations GROUP BY buyer_id, broker_id
), canonical AS (
  SELECT DISTINCT ON (buyer_id, broker_id) id, buyer_id, broker_id
  FROM public.conversations
  ORDER BY buyer_id, broker_id, created_at ASC, id
)
UPDATE public.conversations c
SET buyer_last_read_at = state.buyer_last_read_at,
    broker_last_read_at = state.broker_last_read_at
FROM canonical can
JOIN read_state state USING (buyer_id, broker_id)
WHERE c.id = can.id;

WITH ranked AS (
  SELECT c.id,
    first_value(c.id) OVER pair_order AS canonical_id,
    row_number() OVER pair_order AS pair_rank
  FROM public.conversations c
  WINDOW pair_order AS (
    PARTITION BY c.buyer_id, c.broker_id
    ORDER BY c.created_at ASC, c.id
  )
)
DELETE FROM public.conversations c
USING ranked r
WHERE c.id = r.id AND r.pair_rank > 1;

UPDATE public.conversations c
SET last_message_at = COALESCE((SELECT max(m.created_at) FROM public.messages m
      WHERE m.conversation_id = c.id), c.last_message_at),
    last_message_preview = COALESCE((SELECT left(m.content, 160) FROM public.messages m
      WHERE m.conversation_id = c.id ORDER BY m.created_at DESC, m.id DESC LIMIT 1), c.last_message_preview)
WHERE c.listing_id IS NOT NULL OR EXISTS (
  SELECT 1 FROM public.messages m WHERE m.conversation_id = c.id
);

DROP INDEX IF EXISTS public.conversations_direct_pair_unique;
CREATE UNIQUE INDEX IF NOT EXISTS conversations_one_per_buyer_broker
  ON public.conversations (buyer_id, broker_id);

-- All message reads/writes are now scoped to the canonical conversation ID.
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
  WHERE c.id = messages.conversation_id
    AND ((c.buyer_id = auth.uid() AND c.buyer_archived_at IS NULL)
      OR (c.broker_id = auth.uid() AND c.broker_archived_at IS NULL))
));

CREATE POLICY "participants can send conversation messages"
ON public.messages FOR INSERT TO authenticated
WITH CHECK (
  sender_id = auth.uid() AND EXISTS (
    SELECT 1 FROM public.conversations c
    WHERE c.id = messages.conversation_id
      AND c.buyer_id = messages.buyer_id AND c.broker_id = messages.broker_id
      AND ((c.buyer_id = auth.uid() AND c.buyer_archived_at IS NULL)
        OR (c.broker_id = auth.uid() AND c.broker_archived_at IS NULL))
  )
);

-- Backfill the new FK before making it mandatory.
ALTER TABLE public.messages ALTER COLUMN conversation_id SET NOT NULL;

CREATE OR REPLACE FUNCTION public.attach_message_to_conversation()
RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER
SET search_path TO pg_catalog, public
AS $$
DECLARE pair_conversation_id uuid;
BEGIN
  IF NEW.conversation_id IS NULL THEN
    SELECT c.id INTO pair_conversation_id
    FROM public.conversations c
    WHERE c.buyer_id = NEW.buyer_id AND c.broker_id = NEW.broker_id
    LIMIT 1;
    NEW.conversation_id := pair_conversation_id;
  END IF;
  IF NEW.conversation_id IS NULL OR NOT EXISTS (
    SELECT 1 FROM public.conversations c
    WHERE c.id = NEW.conversation_id
      AND c.buyer_id = NEW.buyer_id AND c.broker_id = NEW.broker_id
  ) THEN
    RAISE EXCEPTION 'Message must belong to an existing buyer/broker conversation';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS attach_message_to_conversation ON public.messages;
CREATE TRIGGER attach_message_to_conversation
BEFORE INSERT ON public.messages
FOR EACH ROW EXECUTE FUNCTION public.attach_message_to_conversation();
REVOKE ALL ON FUNCTION public.attach_message_to_conversation() FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.sync_conversation_after_message()
RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER
SET search_path TO pg_catalog, public
AS $$
BEGIN
  UPDATE public.conversations c
  SET last_message_at = GREATEST(COALESCE(c.last_message_at, NEW.created_at), NEW.created_at),
      last_message_preview = CASE
        WHEN NEW.created_at >= COALESCE(c.last_message_at, '-infinity'::timestamptz)
          THEN left(NEW.content, 160) ELSE c.last_message_preview END,
      updated_at = GREATEST(COALESCE(c.updated_at, NEW.created_at), NEW.created_at),
      buyer_archived_at = CASE WHEN NEW.sender_id = c.broker_id THEN NULL ELSE c.buyer_archived_at END,
      broker_archived_at = CASE WHEN NEW.sender_id = c.buyer_id THEN NULL ELSE c.broker_archived_at END
  WHERE c.id = NEW.conversation_id;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION public.start_direct_broker_chat(p_broker_id uuid)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path TO pg_catalog, public AS $$
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

  SELECT c.id INTO conversation_uuid FROM public.conversations c
  WHERE c.buyer_id = auth.uid() AND c.broker_id = p_broker_id;
  IF conversation_uuid IS NULL THEN
    INSERT INTO public.conversations (buyer_id, broker_id, listing_id)
    VALUES (auth.uid(), p_broker_id, NULL)
    ON CONFLICT (buyer_id, broker_id) DO NOTHING
    RETURNING id INTO conversation_uuid;
  END IF;
  IF conversation_uuid IS NULL THEN
    SELECT c.id INTO conversation_uuid FROM public.conversations c
    WHERE c.buyer_id = auth.uid() AND c.broker_id = p_broker_id;
  END IF;
  UPDATE public.conversations c
  SET buyer_archived_at = NULL
  WHERE c.id = conversation_uuid AND c.buyer_id = auth.uid();
  RETURN conversation_uuid;
END;
$$;
REVOKE ALL ON FUNCTION public.start_direct_broker_chat(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.start_direct_broker_chat(uuid) TO authenticated;

-- Inquiry-created conversations also use the canonical pair thread.
CREATE OR REPLACE FUNCTION public.start_chat_for_buyer_inquiry()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path TO pg_catalog, public AS $$
DECLARE conversation_uuid uuid;
BEGIN
  IF NEW.buyer_id IS NULL OR NEW.broker_id IS NULL OR NEW.listing_id IS NULL
     OR auth.uid() IS DISTINCT FROM NEW.buyer_id THEN
    RETURN NEW;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.listings l
    WHERE l.id = NEW.listing_id AND l.broker_id = NEW.broker_id) THEN
    RAISE EXCEPTION 'Inquiry broker does not own the referenced listing';
  END IF;
  INSERT INTO public.conversations (buyer_id, broker_id, listing_id)
  VALUES (NEW.buyer_id, NEW.broker_id, NEW.listing_id)
  ON CONFLICT (buyer_id, broker_id) DO NOTHING
  RETURNING id INTO conversation_uuid;
  IF conversation_uuid IS NULL THEN
    SELECT c.id INTO conversation_uuid FROM public.conversations c
    WHERE c.buyer_id = NEW.buyer_id AND c.broker_id = NEW.broker_id;
  END IF;
  INSERT INTO public.messages (buyer_id, broker_id, listing_id, conversation_id, sender_id, content, created_at)
  VALUES (NEW.buyer_id, NEW.broker_id, NEW.listing_id, conversation_uuid,
    NEW.buyer_id, NEW.message, COALESCE(NEW.created_at, now()));
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION public.start_chat_for_buyer_inquiry() FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.broker_reply_to_inquiry(p_inquiry_id text, p_reply text)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path TO pg_catalog, public AS $$
DECLARE inquiry_row public.inquiries%ROWTYPE; conversation_uuid uuid;
BEGIN
  IF auth.uid() IS NULL OR NOT EXISTS (
    SELECT 1 FROM public.profiles p WHERE p.id = auth.uid() AND p.role = 'Broker'
  ) THEN RAISE EXCEPTION 'Only the assigned broker can reply to this inquiry'; END IF;
  IF p_reply IS NULL OR length(trim(p_reply)) = 0 OR length(p_reply) > 4000 THEN
    RAISE EXCEPTION 'Reply must contain between 1 and 4000 characters';
  END IF;
  SELECT i.* INTO inquiry_row
  FROM public.inquiries i JOIN public.listings l ON l.id = i.listing_id AND l.broker_id = auth.uid()
  WHERE i.id::text = p_inquiry_id AND i.broker_id = auth.uid() FOR UPDATE OF i;
  IF NOT FOUND THEN RAISE EXCEPTION 'Inquiry not found for this broker'; END IF;

  IF inquiry_row.buyer_id IS NOT NULL THEN
    IF NOT EXISTS (SELECT 1 FROM public.profiles p
      WHERE p.id = inquiry_row.buyer_id AND p.role = 'Buyer') THEN
      RAISE EXCEPTION 'Inquiry is not linked to a buyer account';
    END IF;
    SELECT c.id INTO conversation_uuid FROM public.conversations c
    WHERE c.buyer_id = inquiry_row.buyer_id AND c.broker_id = auth.uid();
    IF conversation_uuid IS NULL THEN
      INSERT INTO public.conversations (buyer_id, broker_id, listing_id)
      VALUES (inquiry_row.buyer_id, auth.uid(), inquiry_row.listing_id)
      ON CONFLICT (buyer_id, broker_id) DO NOTHING RETURNING id INTO conversation_uuid;
    END IF;
    IF conversation_uuid IS NULL THEN
      SELECT c.id INTO conversation_uuid FROM public.conversations c
      WHERE c.buyer_id = inquiry_row.buyer_id AND c.broker_id = auth.uid();
    END IF;
    IF NOT EXISTS (SELECT 1 FROM public.messages m WHERE m.conversation_id = conversation_uuid
      AND m.sender_id = inquiry_row.buyer_id) THEN
      INSERT INTO public.messages (buyer_id, broker_id, listing_id, conversation_id, sender_id, content, created_at)
      VALUES (inquiry_row.buyer_id, auth.uid(), inquiry_row.listing_id, conversation_uuid,
        inquiry_row.buyer_id, inquiry_row.message, COALESCE(inquiry_row.created_at, now()));
    END IF;
    INSERT INTO public.messages (buyer_id, broker_id, listing_id, conversation_id, sender_id, content)
    VALUES (inquiry_row.buyer_id, auth.uid(), inquiry_row.listing_id, conversation_uuid, auth.uid(), trim(p_reply));
  END IF;
  UPDATE public.inquiries SET broker_reply = trim(p_reply), read = true
  WHERE id::text = p_inquiry_id AND broker_id = auth.uid();
  RETURN conversation_uuid;
END;
$$;
REVOKE ALL ON FUNCTION public.broker_reply_to_inquiry(text, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.broker_reply_to_inquiry(text, text) TO authenticated;

-- Buyers create direct threads; inquiry and broker workflow RPCs use definer rights.
DROP POLICY IF EXISTS "broker can start conversation from inquiry" ON public.conversations;
DROP POLICY IF EXISTS "participants can start conversations" ON public.conversations;
CREATE POLICY "participants can start conversations"
ON public.conversations FOR INSERT TO authenticated
WITH CHECK (
  buyer_id = auth.uid() AND listing_id IS NULL
  AND EXISTS (SELECT 1 FROM public.profiles p WHERE p.id = auth.uid() AND p.role = 'Buyer')
  AND EXISTS (SELECT 1 FROM public.profiles p WHERE p.id = broker_id AND p.role = 'Broker')
);

-- Per-user deletion is an archive. The other participant keeps their history.
CREATE OR REPLACE FUNCTION public.archive_conversation_for_self(p_conversation_id uuid)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path TO pg_catalog, public AS $$
BEGIN
  UPDATE public.conversations c
  SET buyer_archived_at = CASE WHEN c.buyer_id = auth.uid() THEN now() ELSE c.buyer_archived_at END,
      broker_archived_at = CASE WHEN c.broker_id = auth.uid() THEN now() ELSE c.broker_archived_at END,
      updated_at = now()
  WHERE c.id = p_conversation_id AND (c.buyer_id = auth.uid() OR c.broker_id = auth.uid());
  IF NOT FOUND THEN RAISE EXCEPTION 'Conversation not found for this account'; END IF;
END;
$$;
REVOKE ALL ON FUNCTION public.archive_conversation_for_self(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.archive_conversation_for_self(uuid) TO authenticated;

DROP POLICY IF EXISTS "conversation participants can read" ON public.conversations;
CREATE POLICY "conversation participants can read"
ON public.conversations FOR SELECT TO authenticated
USING ((buyer_id = auth.uid() AND buyer_archived_at IS NULL)
  OR (broker_id = auth.uid() AND broker_archived_at IS NULL));

-- Keep only the read-marker updates available directly to participants.
REVOKE UPDATE ON public.conversations FROM authenticated;
GRANT UPDATE (buyer_last_read_at, broker_last_read_at) ON public.conversations TO authenticated;

NOTIFY pgrst, 'reload schema';

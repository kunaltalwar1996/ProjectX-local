-- Buyer/broker conversations are created when the broker replies to an inquiry.
-- This migration expects public.conversations to have been created with the
-- schema shared for this feature, and the existing messages/inquiries columns
-- used by the application.

create index if not exists conversations_buyer_recent_idx
  on public.conversations (buyer_id, last_message_at desc nulls last);
create index if not exists conversations_broker_recent_idx
  on public.conversations (broker_id, last_message_at desc nulls last);

-- Preserve chats that were already active before conversations were introduced.
insert into public.conversations (buyer_id, broker_id, listing_id, created_at, updated_at, last_message_at, last_message_preview)
select m.buyer_id, m.broker_id, m.listing_id,
       min(m.created_at), max(m.created_at), max(m.created_at),
       (array_agg(left(m.content, 160) order by m.created_at desc))[1]
from public.messages m
where m.buyer_id is not null and m.broker_id is not null and m.listing_id is not null
group by m.buyer_id, m.broker_id, m.listing_id
on conflict (buyer_id, broker_id, listing_id) do update
set last_message_at = greatest(public.conversations.last_message_at, excluded.last_message_at),
    last_message_preview = case when excluded.last_message_at >= coalesce(public.conversations.last_message_at, '-infinity'::timestamptz)
      then excluded.last_message_preview else public.conversations.last_message_preview end,
    updated_at = greatest(public.conversations.updated_at, excluded.updated_at);

-- Also convert already-replied registered leads that did not yet have message
-- rows, preserving the original inquiry and the broker's recorded reply.
insert into public.conversations (buyer_id, broker_id, listing_id, created_at, updated_at, last_message_at, last_message_preview)
select i.buyer_id, i.broker_id, i.listing_id, i.created_at, i.created_at,
       i.created_at + interval '1 microsecond', left(i.broker_reply, 160)
from public.inquiries i
where i.buyer_id is not null and i.broker_id is not null and i.listing_id is not null
  and nullif(trim(i.broker_reply), '') is not null
on conflict (buyer_id, broker_id, listing_id) do nothing;

insert into public.messages (buyer_id, broker_id, listing_id, sender_id, content, created_at)
select i.buyer_id, i.broker_id, i.listing_id, i.buyer_id, i.message, coalesce(i.created_at, now())
from public.inquiries i
where i.buyer_id is not null and i.broker_id is not null and i.listing_id is not null
  and nullif(trim(i.broker_reply), '') is not null
  and not exists (select 1 from public.messages m where m.buyer_id = i.buyer_id
    and m.broker_id = i.broker_id and m.listing_id = i.listing_id);

insert into public.messages (buyer_id, broker_id, listing_id, sender_id, content, created_at)
select i.buyer_id, i.broker_id, i.listing_id, i.broker_id, trim(i.broker_reply), coalesce(i.created_at, now()) + interval '1 microsecond'
from public.inquiries i
where i.buyer_id is not null and i.broker_id is not null and i.listing_id is not null
  and nullif(trim(i.broker_reply), '') is not null
  and not exists (select 1 from public.messages m where m.buyer_id = i.buyer_id
    and m.broker_id = i.broker_id and m.listing_id = i.listing_id
    and m.sender_id = i.broker_id and m.content = trim(i.broker_reply));

alter table public.conversations enable row level security;
grant select, insert on public.conversations to authenticated;
drop policy if exists "conversation participants can read" on public.conversations;
create policy "conversation participants can read"
on public.conversations for select to authenticated
using (buyer_id = (select auth.uid()) or broker_id = (select auth.uid()));

drop policy if exists "broker can start conversation from inquiry" on public.conversations;
create policy "broker can start conversation from inquiry"
on public.conversations for insert to authenticated
with check (
  broker_id = (select auth.uid())
  and exists (select 1 from public.profiles p where p.id = auth.uid() and p.role = 'Broker')
  and exists (select 1 from public.profiles p where p.id = public.conversations.buyer_id and p.role = 'Buyer')
  and exists (
    select 1 from public.listings l
    where l.id = listing_id and l.broker_id = auth.uid()
  )
  and exists (
    select 1 from public.inquiries i
    where i.buyer_id = public.conversations.buyer_id
      and i.broker_id = auth.uid()
      and i.listing_id = public.conversations.listing_id
  )
);

drop policy if exists "participants can update conversation metadata" on public.conversations;
create policy "participants can update conversation metadata"
on public.conversations for update to authenticated
using (buyer_id = (select auth.uid()) or broker_id = (select auth.uid()))
with check (buyer_id = (select auth.uid()) or broker_id = (select auth.uid()));
revoke update on public.conversations from authenticated;
grant update (buyer_last_read_at, broker_last_read_at) on public.conversations to authenticated;

-- Keep the existing messages table and its IDs intact. Restrict message reads
-- and writes to people who have an established conversation for that listing.
alter table public.messages enable row level security;
grant select, insert on public.messages to authenticated;
do $$
declare p record;
begin
  for p in select policyname from pg_policies where schemaname = 'public' and tablename = 'messages'
  loop
    execute format('drop policy %I on public.messages', p.policyname);
  end loop;
end $$;
drop policy if exists "conversation participants can read messages" on public.messages;
create policy "conversation participants can read messages"
on public.messages for select to authenticated
using (exists (
  select 1 from public.conversations c
  where c.buyer_id = messages.buyer_id
    and c.broker_id = messages.broker_id
    and c.listing_id = messages.listing_id
    and (c.buyer_id = auth.uid() or c.broker_id = auth.uid())
));

drop policy if exists "participants can send conversation messages" on public.messages;
create policy "participants can send conversation messages"
on public.messages for insert to authenticated
with check (
  sender_id = auth.uid()
  and exists (
    select 1 from public.conversations c
    where c.buyer_id = messages.buyer_id
      and c.broker_id = messages.broker_id
      and c.listing_id = messages.listing_id
      and (c.buyer_id = auth.uid() or c.broker_id = auth.uid())
  )
);

-- Ensure inserts through the existing messages API keep conversation previews
-- and ordering in sync. SECURITY DEFINER is limited to this metadata update.
create or replace function public.sync_conversation_after_message()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  update public.conversations
  set last_message_at = new.created_at,
      last_message_preview = left(new.content, 160),
      updated_at = new.created_at
  where buyer_id = new.buyer_id
    and broker_id = new.broker_id
    and listing_id = new.listing_id;
  return new;
end;
$$;

revoke all on function public.sync_conversation_after_message() from public, anon, authenticated;
drop trigger if exists sync_conversation_after_message on public.messages;
create trigger sync_conversation_after_message
after insert on public.messages
for each row execute function public.sync_conversation_after_message();

-- Convert a registered buyer's inquiry into a chat as one atomic operation.
-- The SECURITY DEFINER function copies the inquiry with the buyer as sender
-- only after verifying the broker, listing, and inquiry relationship.
create or replace function public.broker_reply_to_inquiry(p_inquiry_id text, p_reply text)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  inquiry_row public.inquiries%rowtype;
  conversation_uuid uuid;
begin
  if auth.uid() is null or not exists (
    select 1 from public.profiles p where p.id = auth.uid() and p.role = 'Broker'
  ) then
    raise exception 'Only the assigned broker can reply to this inquiry';
  end if;
  if p_reply is null or length(trim(p_reply)) = 0 or length(p_reply) > 4000 then
    raise exception 'Reply must contain between 1 and 4000 characters';
  end if;

  select i.* into inquiry_row
  from public.inquiries i
  join public.listings l on l.id = i.listing_id and l.broker_id = auth.uid()
  where i.id::text = p_inquiry_id and i.broker_id = auth.uid()
  for update of i;
  if not found then raise exception 'Inquiry not found for this broker'; end if;

  if inquiry_row.buyer_id is not null then
    if not exists (select 1 from public.profiles p where p.id = inquiry_row.buyer_id and p.role = 'Buyer') then
      raise exception 'Inquiry is not linked to a buyer account';
    end if;
    insert into public.conversations (buyer_id, broker_id, listing_id)
    values (inquiry_row.buyer_id, auth.uid(), inquiry_row.listing_id)
    on conflict (buyer_id, broker_id, listing_id) do nothing
    returning id into conversation_uuid;
    if conversation_uuid is null then
      select c.id into conversation_uuid from public.conversations c
      where c.buyer_id = inquiry_row.buyer_id and c.broker_id = auth.uid()
        and c.listing_id = inquiry_row.listing_id;
    end if;

    if not exists (
      select 1 from public.messages m where m.buyer_id = inquiry_row.buyer_id
        and m.broker_id = auth.uid() and m.listing_id = inquiry_row.listing_id
    ) then
      insert into public.messages (buyer_id, broker_id, listing_id, sender_id, content, created_at)
      values (inquiry_row.buyer_id, auth.uid(), inquiry_row.listing_id, inquiry_row.buyer_id,
        inquiry_row.message, coalesce(inquiry_row.created_at, now()));
    end if;

    insert into public.messages (buyer_id, broker_id, listing_id, sender_id, content)
    values (inquiry_row.buyer_id, auth.uid(), inquiry_row.listing_id, auth.uid(), trim(p_reply));
  end if;

  update public.inquiries set broker_reply = trim(p_reply), read = true
  where id::text = p_inquiry_id and broker_id = auth.uid();
  return conversation_uuid;
end;
$$;

revoke all on function public.broker_reply_to_inquiry(text, text) from public, anon;
grant execute on function public.broker_reply_to_inquiry(text, text) to authenticated;

-- Realtime is used for message delivery in the buyer and broker clients.
do $$
begin
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'messages'
  ) then
    alter publication supabase_realtime add table public.messages;
  end if;
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'conversations'
  ) then
    alter publication supabase_realtime add table public.conversations;
  end if;
end $$;

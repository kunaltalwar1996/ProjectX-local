-- listings.id is bigint, so profiles.wishlist must use the same element type.
-- Stop instead of silently discarding entries if the incompatible UUID array
-- already contains values; those UUIDs cannot be mapped back to bigint IDs.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM public.profiles
    WHERE cardinality(COALESCE(wishlist, '{}'::uuid[])) > 0
  ) THEN
    RAISE EXCEPTION 'profiles.wishlist contains UUID values and cannot be converted automatically to listing bigint IDs';
  END IF;
END;
$$;

ALTER TABLE public.profiles
  ALTER COLUMN wishlist TYPE bigint[] USING '{}'::bigint[],
  ALTER COLUMN wishlist SET DEFAULT '{}'::bigint[];

NOTIFY pgrst, 'reload schema';

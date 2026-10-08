import { supabase } from './supabase.js';

let cachedUserId = null;
let cachedIds = new Set();
let cacheLoaded = false;

function publishWishlist(userId, ids) {
  if (typeof window === 'undefined') return;
  window.dispatchEvent(new CustomEvent('projectx:wishlist-changed', {
    detail: { userId, ids: [...ids] }
  }));
}

function setCachedWishlist(userId, ids, notify = false) {
  cachedUserId = userId;
  cachedIds = new Set((Array.isArray(ids) ? ids : []).map(String));
  cacheLoaded = true;
  if (notify) publishWishlist(userId, cachedIds);
  return [...cachedIds];
}

export function clearWishlistCache() {
  cachedUserId = null;
  cachedIds = new Set();
  cacheLoaded = false;
  publishWishlist(null, cachedIds);
}

export async function getWishlistIds({ refresh = false } = {}) {
  const { data: { session }, error: sessionError } = await supabase.auth.getSession();
  if (sessionError) throw sessionError;
  if (!session?.user?.id) {
    clearWishlistCache();
    return [];
  }

  const userId = session.user.id;
  if (cachedUserId !== userId) {
    cachedUserId = userId;
    cachedIds = new Set();
    cacheLoaded = false;
  }
  if (cacheLoaded && !refresh) return [...cachedIds];

  const { data, error } = await supabase
    .from('profiles')
    .select('wishlist')
    .eq('id', userId)
    .maybeSingle();
  if (error) throw error;
  return setCachedWishlist(userId, data?.wishlist || []);
}

export async function setWishlistListing(listingId, wishlisted) {
  if (!listingId) throw new Error('A listing ID is required.');
  const { data: { session }, error: sessionError } = await supabase.auth.getSession();
  if (sessionError) throw sessionError;
  if (!session?.user?.id) {
    const error = new Error('Sign in to save listings to your wishlist.');
    error.code = 'AUTH_REQUIRED';
    throw error;
  }

  const id = String(listingId);

  // The profiles.wishlist UUID[] column is the source of truth. Read it fresh
  // for every change so clicks on different pages/tabs cannot use stale state.
  const { data: profile, error: readError } = await supabase
    .from('profiles')
    .select('wishlist')
    .eq('id', session.user.id)
    .maybeSingle();
  if (readError) throw readError;
  if (!profile) throw new Error('Your user profile could not be found.');

  const currentIds = Array.isArray(profile.wishlist) ? profile.wishlist.map(String) : [];
  const nextIds = wishlisted
    ? [...new Set([...currentIds, id])]
    : currentIds.filter(savedId => savedId !== id);

  if (nextIds.length === currentIds.length && nextIds.every((savedId, index) => savedId === currentIds[index])) {
    return setCachedWishlist(session.user.id, currentIds);
  }

  const { data: updatedProfile, error: updateError } = await supabase
    .from('profiles')
    .update({ wishlist: nextIds })
    .eq('id', session.user.id)
    .select('wishlist')
    .maybeSingle();
  if (updateError) throw updateError;
  if (!updatedProfile) {
    throw new Error('Your wishlist could not be saved. Check that your profile allows updates to its wishlist.');
  }

  return setCachedWishlist(session.user.id, updatedProfile.wishlist || [], true);
}

export async function getWishlistListings() {
  const ids = await getWishlistIds({ refresh: true });
  if (!ids.length) return [];

  const { data, error } = await supabase
    .from('listings')
    .select('*')
    .in('id', ids);
  if (error) throw error;

  const byId = new Map((data || []).map(listing => [String(listing.id), listing]));
  const missingIds = ids.filter(id => !byId.has(String(id)));
  for (const id of missingIds) {
    await setWishlistListing(id, false);
  }
  return ids.map(id => byId.get(String(id))).filter(Boolean);
}

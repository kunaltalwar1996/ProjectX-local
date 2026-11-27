import { supabase } from './supabase.js';

export const CANONICAL_AREAS = [
  'Gurugram',
  'Faridabad',
  'Mumbai',
  'Noida',
  'Ghaziabad',
  'Delhi'
];

export const PROPERTY_TYPE_OPTIONS = [
  'Apartment/ High Rise',
  'Builder Floor/ Low Rise',
  'Bungalow/ Villa',
  'Office/Commercial'
];

export function normalizePropertyType(type) {
  if (!type) return '';
  const cleaned = String(type).trim().toLowerCase().replace(/\s*\/\s*/g, '/');
  const mapping = {
    'apartment/high rise': 'Apartment/ High Rise',
    'apartment': 'Apartment/ High Rise',
    'builder floor/low rise': 'Builder Floor/ Low Rise',
    'builder floor': 'Builder Floor/ Low Rise',
    'bungalow/villa': 'Bungalow/ Villa',
    'villa': 'Bungalow/ Villa',
    'bungalow': 'Bungalow/ Villa',
    'office/commercial': 'Office/Commercial',
    'commercial': 'Office/Commercial'
  };
  return mapping[cleaned] || type;
}

/**
 * Checks public verification status of a broker using the safe public RPC contract.
 * Fails closed to false if the RPC is not deployed or returns an error.
 */
export async function getPublicBrokerVerificationStatus(brokerId) {
  if (!brokerId) return false;
  try {
    const { data, error } = await supabase.rpc('get_public_broker_verification_status', {
      p_broker_id: brokerId
    });
    if (error) {
      return false;
    }
    const row = Array.isArray(data) ? data[0] : data;
    return Boolean(row === true || (row && row.is_verified === true));
  } catch (err) {
    return false;
  }
}

/**
 * Fetch all eligible brokers and their associated public metrics.
 * Uses get_public_top_brokers if deployed, with a robust client-side fallback.
 */
export async function fetchTopBrokers() {
  // 1. Try public RPC if available
  try {
    const { data: rpcData, error: rpcErr } = await supabase.rpc('get_public_top_brokers');
    if (!rpcErr && Array.isArray(rpcData) && rpcData.length > 0) {
      return rpcData.map(item => ({
        id: item.broker_id,
        full_name: item.full_name || 'ProjectX Broker',
        avatar_url: item.avatar_url || '',
        agency_name: item.agency_name || '',
        years_experience: item.years_experience ?? null,
        areas_of_operation: Array.isArray(item.areas_of_operation) ? item.areas_of_operation : [],
        active_listing_count: Number(item.active_listing_count || 0),
        total_listing_count: Number(item.total_listing_count || 0),
        active_property_types: new Set(),
        rating: item.average_rating ? Number(item.average_rating) : null,
        rating_count: Number(item.rating_count || 0),
        is_verified: Boolean(item.is_verified)
      }));
    }
  } catch (e) {
    // Fall back to application-side query composition
  }

  // 2. Fallback: Fetch public brokers list
  let brokerProfiles = [];
  try {
    const { data, error } = await supabase.rpc('get_public_brokers');
    if (error) {
      const { data: directProfiles, error: directErr } = await supabase
        .from('profiles')
        .select('id, full_name, avatar_url')
        .eq('role', 'Broker');
      if (directErr) throw directErr;
      brokerProfiles = directProfiles || [];
    } else {
      brokerProfiles = data || [];
    }
  } catch (err) {
    console.warn('Failed to load broker profiles:', err);
    throw new Error('Unable to load broker directory. Please try again later.');
  }

  const validBrokers = brokerProfiles.filter(b => b && b.id);
  if (!validBrokers.length) {
    return [];
  }

  const brokerIds = validBrokers.map(b => b.id);

  // 3. Fetch public professional details in parallel
  let detailsMap = new Map();
  try {
    const { data: detailsData, error: detailsError } = await supabase
      .from('broker_public_details')
      .select('broker_id, agency_name, years_experience, areas_of_operation')
      .in('broker_id', brokerIds);

    if (!detailsError && Array.isArray(detailsData)) {
      detailsData.forEach(item => {
        if (item.broker_id) detailsMap.set(item.broker_id, item);
      });
    }
  } catch (err) {
    console.warn('Could not load broker_public_details:', err);
  }

  // 4. Fetch listings metrics for these brokers
  // Active = 'Active'
  // Total = 'Active' + 'Pending' + 'Sold' (exclude 'Rejected' and 'Suspended')
  const metricsMap = new Map();
  try {
    const { data: listingsData, error: listingsError } = await supabase
      .from('listings')
      .select('id, broker_id, status, type')
      .in('broker_id', brokerIds);

    if (!listingsError && Array.isArray(listingsData)) {
      listingsData.forEach(l => {
        if (!l.broker_id) return;
        const entry = metricsMap.get(l.broker_id) || {
          activeCount: 0,
          totalCount: 0,
          activePropertyTypes: new Set()
        };

        const status = (l.status || '').trim();
        const normType = normalizePropertyType(l.type);

        if (status === 'Active') {
          entry.activeCount += 1;
          if (normType) entry.activePropertyTypes.add(normType);
        }

        if (['Active', 'Pending', 'Sold'].includes(status)) {
          entry.totalCount += 1;
        }

        metricsMap.set(l.broker_id, entry);
      });
    }
  } catch (err) {
    console.warn('Could not load listings metrics:', err);
  }

  // 5. Verification statuses (checked via safe public RPC, fail-closed)
  const verificationMap = new Map();
  await Promise.all(
    brokerIds.map(async id => {
      const isVerified = await getPublicBrokerVerificationStatus(id);
      verificationMap.set(id, isVerified);
    })
  );

  // 6. Construct enriched broker records
  const enrichedBrokers = validBrokers.map(broker => {
    const details = detailsMap.get(broker.id) || {};
    const metrics = metricsMap.get(broker.id) || {
      activeCount: 0,
      totalCount: 0,
      activePropertyTypes: new Set()
    };
    const isVerified = verificationMap.get(broker.id) || false;

    let areas = [];
    if (Array.isArray(details.areas_of_operation)) {
      areas = details.areas_of_operation.filter(Boolean);
    }

    return {
      id: broker.id,
      full_name: broker.full_name || 'ProjectX Broker',
      avatar_url: broker.avatar_url || '',
      agency_name: details.agency_name || '',
      years_experience: details.years_experience ?? null,
      areas_of_operation: areas,
      active_listing_count: metrics.activeCount,
      total_listing_count: metrics.totalCount,
      active_property_types: metrics.activePropertyTypes,
      rating: null,
      rating_count: 0,
      is_verified: isVerified
    };
  });

  return sortBrokers(enrichedBrokers);
}

export function sortBrokers(brokers) {
  return [...brokers].sort((a, b) => {
    // 1. Active listing count DESC
    if (b.active_listing_count !== a.active_listing_count) {
      return b.active_listing_count - a.active_listing_count;
    }

    // 2. Broker rating DESC, NULL ratings last
    const aHasRating = a.rating !== null && a.rating !== undefined;
    const bHasRating = b.rating !== null && b.rating !== undefined;
    if (aHasRating && !bHasRating) return -1;
    if (!aHasRating && bHasRating) return 1;
    if (aHasRating && bHasRating && b.rating !== a.rating) {
      return b.rating - a.rating;
    }

    // 3. Rating count DESC
    if ((b.rating_count || 0) !== (a.rating_count || 0)) {
      return (b.rating_count || 0) - (a.rating_count || 0);
    }

    // 4. Total listing count DESC
    if (b.total_listing_count !== a.total_listing_count) {
      return b.total_listing_count - a.total_listing_count;
    }

    // 5. Broker name ASC
    return (a.full_name || '').localeCompare(b.full_name || '', undefined, { sensitivity: 'base' });
  });
}

/**
 * Filter brokers based on Area, Property Type, and Rating
 */
export function filterBrokers(brokers, { area = '', propertyType = '', minRating = '' } = {}) {
  return brokers.filter(broker => {
    // Area / City filter
    if (area && area !== 'all') {
      const hasArea = Array.isArray(broker.areas_of_operation) &&
        broker.areas_of_operation.some(a => a.toLowerCase() === area.toLowerCase());
      if (!hasArea) return false;
    }

    // Property type filter
    if (propertyType && propertyType !== 'all') {
      const normSelected = normalizePropertyType(propertyType);
      const hasType = broker.active_property_types &&
        broker.active_property_types.has(normSelected);
      if (!hasType) return false;
    }

    // Rating filter
    if (minRating && minRating !== 'all') {
      const threshold = parseFloat(minRating);
      if (!isNaN(threshold)) {
        if (broker.rating === null || broker.rating === undefined || broker.rating < threshold) {
          return false;
        }
      }
    }

    return true;
  });
}

/**
 * Load public broker profile details and active public listings
 */
export async function fetchPublicBrokerProfile(brokerId) {
  if (!brokerId) throw new Error('Broker ID is required.');

  // Try get_public_broker_profile RPC first if available
  let profile = null;
  try {
    const { data: rpcProfile, error: rpcErr } = await supabase.rpc('get_public_broker_profile', {
      p_broker_id: brokerId
    });
    if (!rpcErr && rpcProfile) {
      const row = Array.isArray(rpcProfile) ? rpcProfile[0] : rpcProfile;
      if (row) {
        profile = {
          id: row.broker_id,
          full_name: row.full_name || 'ProjectX Broker',
          avatar_url: row.avatar_url || '',
          agency_name: row.agency_name || '',
          years_experience: row.years_experience ?? null,
          areas_of_operation: Array.isArray(row.areas_of_operation) ? row.areas_of_operation : [],
          rating: row.average_rating ? Number(row.average_rating) : null,
          rating_count: Number(row.rating_count || 0),
          is_verified: Boolean(row.is_verified)
        };
      }
    }
  } catch (err) {
    // Fall back to individual lookups
  }

  if (!profile) {
    let broker = null;
    try {
      const { data: rpcData, error: rpcErr } = await supabase.rpc('get_public_broker_identity', {
        p_broker_id: brokerId
      });
      if (!rpcErr && rpcData) {
        broker = Array.isArray(rpcData) ? rpcData[0] : rpcData;
      } else {
        const { data: profileData, error: profileErr } = await supabase
          .from('profiles')
          .select('id, full_name, avatar_url, role')
          .eq('id', brokerId)
          .maybeSingle();
        if (!profileErr && profileData) {
          broker = profileData;
        }
      }
    } catch (err) {
      console.warn('Error loading public broker identity:', err);
    }

    if (!broker) {
      throw new Error('Broker profile not found.');
    }

    let details = {};
    try {
      const { data: profData } = await supabase
        .from('broker_public_details')
        .select('agency_name, years_experience, areas_of_operation')
        .eq('broker_id', brokerId)
        .maybeSingle();
      if (profData) details = profData;
    } catch (err) {
      console.warn('Error loading broker_public_details:', err);
    }

    const isVerified = await getPublicBrokerVerificationStatus(brokerId);

    profile = {
      id: broker.id,
      full_name: broker.full_name || 'ProjectX Broker',
      avatar_url: broker.avatar_url || '',
      agency_name: details.agency_name || '',
      years_experience: details.years_experience ?? null,
      areas_of_operation: Array.isArray(details.areas_of_operation) ? details.areas_of_operation : [],
      rating: null,
      rating_count: 0,
      is_verified: isVerified
    };
  }

  // Fetch Active public listings
  let activeListings = [];
  try {
    const { data: listingsData, error: listingsErr } = await supabase
      .from('listings')
      .select('*')
      .eq('broker_id', brokerId)
      .eq('status', 'Active')
      .order('created_at', { ascending: false });

    if (!listingsErr && listingsData) {
      activeListings = listingsData;
    }
  } catch (err) {
    console.warn('Error loading active broker listings:', err);
  }

  profile.active_listings = activeListings;
  return profile;
}

/**
 * Handle direct messaging click without bubbling to card navigation
 */
export async function startBrokerChat(brokerId, triggerBtn = null) {
  if (!brokerId) return;

  const { data: { user } } = await supabase.auth.getUser();
  if (!user) {
    if (window.navigateTo) {
      window.navigateTo('/login.html');
    } else {
      window.location.href = '/login.html';
    }
    return;
  }

  if (user.id === brokerId) {
    alert('You cannot start a chat with yourself.');
    return;
  }

  let originalText = '';
  if (triggerBtn) {
    originalText = triggerBtn.innerHTML;
    triggerBtn.disabled = true;
    triggerBtn.innerHTML = '<span class="material-symbols-outlined text-sm animate-spin">sync</span> Opening…';
  }

  try {
    const { data: conversationId, error } = await supabase.rpc('start_direct_broker_chat', {
      p_broker_id: brokerId
    });

    if (error || !conversationId) {
      const isMissing = /could not find the function|schema cache/i.test(error?.message || '');
      const msg = isMissing
        ? 'Direct messaging is not enabled on the server yet. Please check back soon.'
        : (error?.message || 'Unable to start chat.');
      alert(msg);
      if (triggerBtn) {
        triggerBtn.disabled = false;
        triggerBtn.innerHTML = originalText;
      }
      return;
    }

    const destination = `/chats.html?conversation=${encodeURIComponent(conversationId)}`;
    if (window.navigateTo) {
      window.navigateTo(destination);
    } else {
      window.location.href = destination;
    }
  } catch (err) {
    console.error('Chat error:', err);
    alert('Unable to start chat. Please try again.');
    if (triggerBtn) {
      triggerBtn.disabled = false;
      triggerBtn.innerHTML = originalText;
    }
  }
}

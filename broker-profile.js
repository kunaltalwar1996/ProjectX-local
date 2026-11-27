import { supabase } from './lib/supabase.js';
import { fetchPublicBrokerProfile, startBrokerChat, normalizePropertyType } from './lib/broker-service.js';

const avatarFallback = 'https://images.unsplash.com/photo-1560250097-0b93528c311a?auto=format&fit=crop&w=240&q=80';
const propertyImageFallback = 'https://images.unsplash.com/photo-1600596542815-ffad4c1539a9?auto=format&fit=crop&w=600&q=80';

const errorBox = document.getElementById('profile-error-box');
const loadingSkeleton = document.getElementById('profile-loading');
const heroSection = document.getElementById('broker-hero');
const listingsSection = document.getElementById('broker-listings-section');

const avatarImg = document.getElementById('broker-avatar');
const nameEl = document.getElementById('broker-name');
const verifiedBadge = document.getElementById('broker-verified-badge');
const agencyEl = document.getElementById('broker-agency');
const expContainer = document.getElementById('broker-experience');
const expText = document.getElementById('broker-experience-text');
const ratingContainer = document.getElementById('broker-rating-container');
const ratingScore = document.getElementById('broker-rating-score');
const ratingCount = document.getElementById('broker-rating-count');
const areasContainer = document.getElementById('broker-areas-container');
const messageBtn = document.getElementById('btn-message-broker');

const listingsGrid = document.getElementById('broker-listings-grid');
const listingsCount = document.getElementById('broker-listings-count');
const listingsEmpty = document.getElementById('broker-listings-empty');
const accountAction = document.getElementById('header-account-action');

function escapeHtml(value = '') {
  return String(value).replace(/[&<>"']/g, char => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  })[char]);
}

function formatPrice(val, intent) {
  const num = Number(val || 0);
  if (!num) return 'Price on Request';
  if (intent === 'Rent') {
    return `₹${num.toLocaleString('en-IN')} / mo`;
  }
  if (num >= 1) {
    return `₹${num.toFixed(2)} Cr`;
  }
  return `₹${(num * 100).toFixed(0)} Lac`;
}

function renderPropertyCard(listing) {
  const price = formatPrice(listing.price, listing.intent);
  const image = listing.img || propertyImageFallback;
  const propType = normalizePropertyType(listing.type || 'Property');
  const beds = listing.beds ? `${listing.beds} BHK` : 'Studio';
  const baths = listing.baths ? `${listing.baths} Baths` : '';
  const sqft = listing.sqft ? `${Number(listing.sqft).toLocaleString('en-IN')} sqft` : '';
  const intent = listing.intent || 'Sale';

  return `
    <article class="group overflow-hidden rounded-3xl border border-slate-200 bg-white shadow-sm transition-all duration-300 hover:-translate-y-1 hover:border-indigo-200 hover:shadow-xl flex flex-col justify-between">
      <div>
        <div class="relative aspect-[16/9] overflow-hidden bg-slate-100">
          <img src="${escapeHtml(image)}" alt="${escapeHtml(listing.title || 'Property')}" loading="lazy"
            class="h-full w-full object-cover transition-transform duration-500 group-hover:scale-105"
            onerror="this.onerror=null;this.src='${propertyImageFallback}'" />
          <span class="absolute left-3 top-3 rounded-full bg-slate-900/80 px-2.5 py-1 text-xs font-bold uppercase tracking-wider text-white backdrop-blur-sm">
            For ${escapeHtml(intent)}
          </span>
        </div>

        <a href="/property-details.html?id=${encodeURIComponent(listing.id)}" class="block p-5">
          <p class="text-xl font-black text-slate-900">${escapeHtml(price)}</p>
          <p class="mt-1 text-xs font-semibold uppercase tracking-wider text-slate-500">
            ${escapeHtml(propType)}
          </p>
          <h3 class="mt-2 truncate text-base font-bold text-slate-800 group-hover:text-indigo-700 transition-colors">
            ${escapeHtml(listing.title || 'Property')}
          </h3>
          <p class="mt-1 flex items-center gap-1 text-xs font-medium text-slate-500">
            <span class="material-symbols-outlined text-sm text-slate-400">location_on</span>
            <span class="truncate">${escapeHtml(listing.location || '')}</span>
          </p>

          <div class="mt-4 flex items-center gap-3 border-t border-slate-100 pt-3 text-xs font-bold text-slate-600">
            <span>${escapeHtml(beds)}</span>
            ${baths ? `<span>•</span><span>${escapeHtml(baths)}</span>` : ''}
            ${sqft ? `<span>•</span><span>${escapeHtml(sqft)}</span>` : ''}
          </div>
        </a>
      </div>
      <div class="px-5 pb-5">
        <a href="/property-details.html?id=${encodeURIComponent(listing.id)}"
          class="inline-flex w-full items-center justify-center gap-1.5 rounded-xl border border-slate-200 py-2.5 text-xs font-bold text-slate-700 transition hover:bg-slate-50 active:scale-95">
          <span>View Property Details</span>
          <span class="material-symbols-outlined text-sm">arrow_forward</span>
        </a>
      </div>
    </article>
  `;
}

async function updateAccountAction() {
  if (!accountAction) return;
  try {
    const { data: { session } } = await supabase.auth.getSession();
    if (!session) return;
    accountAction.href = '/profile.html';
    accountAction.setAttribute('aria-label', 'Your profile');
    accountAction.className = 'inline-flex h-10 w-10 items-center justify-center rounded-full text-slate-700 hover:bg-slate-100 focus:outline-none focus:ring-2 focus:ring-indigo-500';
    accountAction.innerHTML = '<span class="material-symbols-outlined text-2xl" aria-hidden="true">account_circle</span>';
  } catch (error) {
    console.warn('Could not check user sign-in state:', error);
  }
}

async function init() {
  updateAccountAction();

  const params = new URLSearchParams(window.location.search);
  const brokerId = params.get('id');

  if (!brokerId) {
    loadingSkeleton.classList.add('hidden');
    errorBox.textContent = 'No broker ID provided. Please select a broker from Top Brokers.';
    errorBox.classList.remove('hidden');
    return;
  }

  try {
    const profile = await fetchPublicBrokerProfile(brokerId);

    // Update document title
    document.title = `${profile.full_name} — Broker Profile | ProjectX`;

    // Populate Hero Section
    avatarImg.src = profile.avatar_url || avatarFallback;
    avatarImg.onerror = () => { avatarImg.src = avatarFallback; };
    nameEl.textContent = profile.full_name;

    if (profile.is_verified) {
      verifiedBadge.classList.remove('hidden');
    }

    if (profile.agency_name) {
      agencyEl.textContent = profile.agency_name;
    } else {
      agencyEl.textContent = 'Independent Real Estate Professional';
    }

    if (profile.years_experience !== null && profile.years_experience !== undefined) {
      expContainer.classList.remove('hidden');
      expText.textContent = `${profile.years_experience} Years Experience`;
    }

    if (profile.rating !== null && profile.rating !== undefined) {
      ratingContainer.classList.remove('hidden');
      ratingScore.textContent = Number(profile.rating).toFixed(1);
      ratingCount.textContent = `(${profile.rating_count || 0} reviews)`;
    }

    if (profile.areas_of_operation && profile.areas_of_operation.length) {
      areasContainer.innerHTML = profile.areas_of_operation.map(area =>
        `<span class="rounded-lg bg-slate-100 px-2.5 py-1 text-xs font-semibold text-slate-600">${escapeHtml(area)}</span>`
      ).join('');
    }

    // Wire message button
    messageBtn.addEventListener('click', () => {
      startBrokerChat(profile.id, messageBtn);
    });

    // Populate Active Listings Section
    const activeListings = profile.active_listings || [];
    listingsCount.textContent = `${activeListings.length} Active Propert${activeListings.length === 1 ? 'y' : 'ies'}`;

    if (activeListings.length) {
      listingsGrid.innerHTML = activeListings.map(renderPropertyCard).join('');
      listingsEmpty.classList.add('hidden');
    } else {
      listingsGrid.innerHTML = '';
      listingsEmpty.classList.remove('hidden');
    }

    loadingSkeleton.classList.add('hidden');
    heroSection.classList.remove('hidden');
    listingsSection.classList.remove('hidden');
  } catch (err) {
    console.error('Failed to load broker profile:', err);
    loadingSkeleton.classList.add('hidden');
    errorBox.textContent = err.message || 'Unable to load broker profile.';
    errorBox.classList.remove('hidden');
  }
}

init();

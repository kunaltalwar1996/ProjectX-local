import { supabase } from './lib/supabase.js';
import { fetchTopBrokers, filterBrokers, startBrokerChat } from './lib/broker-service.js';

const grid = document.getElementById('broker-directory-grid');
const resultCount = document.getElementById('broker-results-count');
const errorBox = document.getElementById('broker-directory-error');
const accountAction = document.getElementById('broker-account-action');

const filterSearch = document.getElementById('filter-search');
const filterArea = document.getElementById('filter-area');
const filterType = document.getElementById('filter-type');
const filterRating = document.getElementById('filter-rating');
const resetBtn = document.getElementById('btn-reset-filters');

const avatarFallback = 'https://images.unsplash.com/photo-1560250097-0b93528c311a?auto=format&fit=crop&w=240&q=80';

let allBrokers = [];

function escapeHtml(value = '') {
  return String(value).replace(/[&<>"']/g, char => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  })[char]);
}

function render(brokers) {
  resultCount.textContent = `${brokers.length} broker${brokers.length === 1 ? '' : 's'} found`;

  const hasActiveFilters = Boolean(
    (filterSearch?.value.trim()) ||
    (filterArea?.value && filterArea.value !== 'all') ||
    (filterType?.value && filterType.value !== 'all') ||
    (filterRating?.value && filterRating.value !== 'all')
  );
  if (resetBtn) resetBtn.classList.toggle('hidden', !hasActiveFilters);

  if (!brokers.length) {
    grid.innerHTML = `
      <div class="col-span-full rounded-2xl border border-dashed border-slate-300 bg-white p-12 text-center">
        <span class="material-symbols-outlined text-4xl text-slate-300">person_search</span>
        <p class="mt-3 text-base font-bold text-slate-800">No brokers match your criteria</p>
        <p class="mt-1 text-sm text-slate-500">Try adjusting your filters or search keywords.</p>
        <button id="btn-empty-reset" type="button" class="mt-4 inline-flex items-center gap-1.5 rounded-lg bg-indigo-50 px-4 py-2 text-xs font-bold text-indigo-700 hover:bg-indigo-100">
          <span class="material-symbols-outlined text-sm">restart_alt</span> Reset all filters
        </button>
      </div>`;
    document.getElementById('btn-empty-reset')?.addEventListener('click', resetFilters);
    return;
  }

  grid.innerHTML = brokers.map(broker => {
    const verifiedBadge = broker.is_verified
      ? `<span class="inline-flex items-center gap-1 rounded-full bg-emerald-50 px-2 py-0.5 text-[11px] font-bold text-emerald-700" title="Identity Verified Broker">
           <span class="material-symbols-outlined text-[13px] text-emerald-600">verified</span> Verified
         </span>`
      : '';

    const agencyHtml = broker.agency_name
      ? `<p class="truncate text-xs font-medium text-slate-500">${escapeHtml(broker.agency_name)}</p>`
      : '';

    const ratingHtml = (broker.rating !== null && broker.rating !== undefined)
      ? `<div class="flex items-center gap-1 text-xs font-bold text-amber-600">
           <span class="material-symbols-outlined text-[15px] text-amber-500">star</span>
           <span>${Number(broker.rating).toFixed(1)}</span>
           <span class="font-normal text-slate-400">(${broker.rating_count || 0})</span>
         </div>`
      : '';

    const areas = (broker.areas_of_operation || []).slice(0, 3);
    const areasHtml = areas.length
      ? `<div class="mt-3 flex flex-wrap gap-1.5">
           ${areas.map(a => `<span class="rounded-md bg-slate-100 px-2 py-0.5 text-[11px] font-medium text-slate-600">${escapeHtml(a)}</span>`).join('')}
           ${broker.areas_of_operation.length > 3 ? `<span class="text-[11px] font-bold text-slate-400">+${broker.areas_of_operation.length - 3}</span>` : ''}
         </div>`
      : '';

    return `
      <article data-broker-id="${escapeHtml(broker.id)}"
        class="broker-card group flex flex-col justify-between rounded-2xl border border-slate-200 bg-white p-5 shadow-sm transition-all duration-200 hover:-translate-y-1 hover:border-indigo-200 hover:shadow-md cursor-pointer">
        <div>
          <!-- Header: Avatar + Identity -->
          <div class="flex items-start gap-4">
            <img src="${escapeHtml(broker.avatar_url || avatarFallback)}" alt="${escapeHtml(broker.full_name)}"
              loading="lazy"
              class="h-16 w-16 shrink-0 rounded-full bg-slate-100 object-cover ring-2 ring-slate-100"
              onerror="this.onerror=null;this.src='${avatarFallback}'" />
            <div class="min-w-0 flex-1">
              <div class="flex items-center gap-1.5 flex-wrap">
                <h2 class="truncate text-base font-bold text-slate-900 group-hover:text-indigo-700 transition-colors">
                  ${escapeHtml(broker.full_name)}
                </h2>
                ${verifiedBadge}
              </div>
              ${agencyHtml}
              ${ratingHtml ? `<div class="mt-1">${ratingHtml}</div>` : ''}
            </div>
          </div>

          <!-- Listings metrics -->
          <div class="mt-4 grid grid-cols-2 gap-2 rounded-xl bg-slate-50 p-2.5 text-center">
            <div>
              <span class="block text-base font-black text-slate-900">${broker.active_listing_count}</span>
              <span class="block text-[11px] font-semibold text-slate-500 uppercase tracking-wider">Active</span>
            </div>
            <div class="border-l border-slate-200">
              <span class="block text-base font-black text-slate-700">${broker.total_listing_count}</span>
              <span class="block text-[11px] font-semibold text-slate-500 uppercase tracking-wider">Total</span>
            </div>
          </div>

          ${areasHtml}
        </div>

        <!-- Action footer -->
        <div class="mt-5 flex items-center justify-between border-t border-slate-100 pt-3">
          <span class="inline-flex items-center gap-1 text-xs font-bold text-indigo-700 group-hover:text-indigo-900">
            View profile <span class="material-symbols-outlined text-sm">arrow_forward</span>
          </span>
          <button type="button" data-action="chat" data-broker-id="${escapeHtml(broker.id)}"
            class="inline-flex items-center gap-1.5 rounded-lg border border-slate-200 bg-white px-3 py-1.5 text-xs font-bold text-slate-700 shadow-sm transition hover:border-slate-300 hover:bg-slate-50 active:scale-95 focus:outline-none focus:ring-2 focus:ring-indigo-500">
            <span class="material-symbols-outlined text-[16px] text-indigo-600">chat</span>
            <span>Message</span>
          </button>
        </div>
      </article>
    `;
  }).join('');

  // Wire card click navigation vs. Message button click
  grid.querySelectorAll('.broker-card').forEach(card => {
    card.addEventListener('click', (e) => {
      // If clicking message button, do not navigate card
      if (e.target.closest('button[data-action="chat"]')) return;
      const brokerId = card.getAttribute('data-broker-id');
      if (brokerId) {
        const url = `/broker-profile.html?id=${encodeURIComponent(brokerId)}`;
        if (window.navigateTo) {
          window.navigateTo(url);
        } else {
          window.location.href = url;
        }
      }
    });
  });

  // Wire message button click
  grid.querySelectorAll('button[data-action="chat"]').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      e.preventDefault();
      const brokerId = btn.getAttribute('data-broker-id');
      startBrokerChat(brokerId, btn);
    });
  });
}

function applyFilters() {
  const query = filterSearch?.value.trim().toLowerCase() || '';
  const area = filterArea?.value || 'all';
  const propertyType = filterType?.value || 'all';
  const minRating = filterRating?.value || 'all';

  let filtered = filterBrokers(allBrokers, { area, propertyType, minRating });

  if (query) {
    filtered = filtered.filter(b => {
      const name = (b.full_name || '').toLowerCase();
      const agency = (b.agency_name || '').toLowerCase();
      return name.includes(query) || agency.includes(query);
    });
  }

  render(filtered);
}

function resetFilters() {
  if (filterSearch) filterSearch.value = '';
  if (filterArea) filterArea.value = 'all';
  if (filterType) filterType.value = 'all';
  if (filterRating) filterRating.value = 'all';
  applyFilters();
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

  // Wire filters
  filterSearch?.addEventListener('input', applyFilters);
  filterArea?.addEventListener('change', applyFilters);
  filterType?.addEventListener('change', applyFilters);
  filterRating?.addEventListener('change', applyFilters);
  resetBtn?.addEventListener('click', resetFilters);

  try {
    errorBox.classList.add('hidden');
    allBrokers = await fetchTopBrokers();
    render(allBrokers);
  } catch (error) {
    console.error('Failed to load Top Brokers:', error);
    resultCount.textContent = 'Broker profiles unavailable';
    errorBox.textContent = error.message || 'We could not load broker profiles. Please refresh and try again.';
    errorBox.classList.remove('hidden');
    grid.innerHTML = '';
  }
}

init();

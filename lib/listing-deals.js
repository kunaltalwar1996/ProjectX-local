import { supabase } from './supabase.js';

const esc = value => String(value ?? '').replace(/[&<>"']/g, char => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
}[char]));

const money = (amount, currency = 'INR') => {
  if (amount == null || amount === '') return 'Not specified';
  try { return new Intl.NumberFormat('en-IN', { style: 'currency', currency }).format(Number(amount)); }
  catch { return `${currency} ${Number(amount).toLocaleString('en-IN')}`; }
};

const formatDate = value => value ? new Date(value).toLocaleDateString('en-IN', {
  day: 'numeric', month: 'short', year: 'numeric'
}) : '—';

const statusMeta = {
  awaiting_buyer: ['Awaiting buyer', 'bg-amber-50 text-amber-800'],
  awaiting_employee: ['Employee 1 review', 'bg-blue-50 text-blue-800'],
  confirmed: ['Confirmed', 'bg-emerald-50 text-emerald-800'],
  declined: ['Buyer declined', 'bg-rose-50 text-rose-800'],
  cancelled: ['Cancelled by broker', 'bg-slate-100 text-slate-700'],
  rejected: ['Not approved', 'bg-rose-50 text-rose-800']
};
let brokerDealChannel = null;
let employeeDealChannel = null;
const dealRenderVersions = new WeakMap();

function dealLabel(deal) {
  return deal.transaction_type === 'rent'
    ? `Rental · ${deal.rental_months} month${deal.rental_months === 1 ? '' : 's'}`
    : 'Sale';
}

async function getRelatedIdentities(ids) {
  const uniqueIds = [...new Set((ids || []).filter(Boolean))];
  if (!uniqueIds.length) return [];
  const { data, error } = await supabase.rpc('get_related_profile_identities', { p_ids: uniqueIds });
  if (error) throw error;
  return data || [];
}

async function refreshConversationDeals(conversationId, viewerId, container, pair = null) {
  if ((!conversationId && !pair?.buyerId) || !container) return;
  const version = (dealRenderVersions.get(container) || 0) + 1;
  dealRenderVersions.set(container, version);
  container.querySelectorAll('[data-listing-deal-card]').forEach(card => card.remove());
  let dealsQuery = supabase.from('listing_deals').select('*');
  dealsQuery = pair?.buyerId && pair?.brokerId
    ? dealsQuery.eq('buyer_id', pair.buyerId).eq('broker_id', pair.brokerId)
    : dealsQuery.eq('conversation_id', conversationId);
  const { data: deals, error } = await dealsQuery.order('created_at', { ascending: true });
  if (error) {
    console.warn('Could not load deal cards for this conversation:', error);
    return;
  }
  if (!deals?.length) return;

  const listingIds = [...new Set(deals.map(deal => deal.listing_id))];
  const buyerIds = [...new Set(deals.map(deal => deal.buyer_id))];
  const [listingResult, identities] = await Promise.all([
    supabase.from('listings').select('id,title,location,img,price,intent,status').in('id', listingIds),
    getRelatedIdentities(buyerIds).catch(error => {
      console.warn('Could not resolve deal counterpart names:', error);
      return [];
    })
  ]);
  if (dealRenderVersions.get(container) !== version) return;
  if (listingResult.error) console.warn('Could not load deal listing details:', listingResult.error);
  const listings = new Map((listingResult.data || []).map(listing => [String(listing.id), listing]));
  const names = new Map(identities.map(profile => [profile.id, profile.full_name || 'Buyer']));

  for (const deal of deals) {
    const listing = listings.get(String(deal.listing_id));
    const [label, tone] = statusMeta[deal.status] || ['In progress', 'bg-slate-100 text-slate-700'];
    const card = document.createElement('article');
    card.dataset.listingDealCard = deal.id;
    card.className = 'mx-auto my-3 w-full max-w-2xl min-w-0 flex-none overflow-hidden rounded-2xl border border-indigo-200 bg-white shadow-sm';
    const amount = deal.proposed_amount == null ? '' : `<p class="mt-2 text-sm font-semibold text-slate-800">${esc(money(deal.proposed_amount, deal.currency))}${deal.amount_basis === 'monthly' ? '<span class="font-normal text-slate-500"> / month</span>' : ''}</p>`;
    const rentDates = deal.status === 'confirmed' && deal.transaction_type === 'rent'
      ? `<p class="mt-2 text-xs text-slate-500">Rental term: ${esc(formatDate(deal.lease_start_on))} – ${esc(formatDate(deal.lease_end_on))}</p>` : '';
    const note = deal.status === 'cancelled' ? deal.cancellation_note
      : deal.status === 'rejected' ? deal.employee_note
        : deal.status === 'declined' ? deal.buyer_note : deal.broker_note;
    const actions = viewerId === deal.buyer_id && deal.status === 'awaiting_buyer'
      ? `<div class="mt-4 flex flex-wrap gap-2"><button type="button" data-deal-accept="${esc(deal.id)}" class="rounded-lg bg-emerald-700 px-4 py-2 text-sm font-bold text-white hover:bg-emerald-800">Accept</button><button type="button" data-deal-decline="${esc(deal.id)}" class="rounded-lg border border-rose-200 px-4 py-2 text-sm font-bold text-rose-700 hover:bg-rose-50">Decline</button></div>`
      : viewerId === deal.broker_id && ['awaiting_buyer', 'awaiting_employee'].includes(deal.status)
        ? `<div class="mt-4"><button type="button" data-deal-cancel="${esc(deal.id)}" class="rounded-lg border border-slate-300 px-3 py-2 text-xs font-bold text-slate-700 hover:bg-slate-50">Cancel proposal</button></div>` : '';

    card.innerHTML = `<div class="flex flex-wrap items-center justify-between gap-2 border-b border-slate-100 bg-indigo-50/60 px-4 py-3"><span class="text-xs font-black uppercase tracking-wider text-indigo-900">${esc(dealLabel(deal))}</span><span class="rounded-full px-2.5 py-1 text-[11px] font-bold ${tone}">${esc(label)}</span></div><div class="p-4"><div class="flex gap-3">${listing?.img ? `<img src="${esc(listing.img)}" alt="" class="h-16 w-20 rounded-lg bg-slate-100 object-cover">` : ''}<div class="min-w-0"><a href="/property-details.html?id=${encodeURIComponent(deal.listing_id)}" target="_blank" rel="noopener" class="font-bold text-slate-900 hover:underline">${esc(listing?.title || `Listing #${deal.listing_id}`)}</a><p class="mt-1 text-xs text-slate-500">${esc(listing?.location || 'Location unavailable')}</p>${viewerId === deal.broker_id ? `<p class="mt-1 text-xs text-slate-500">Buyer: ${esc(names.get(deal.buyer_id) || 'Buyer')}</p>` : ''}</div></div>${amount}${rentDates}${note ? `<p class="mt-3 rounded-lg bg-slate-50 p-3 text-sm text-slate-600">${esc(note)}</p>` : ''}<p class="mt-3 text-[11px] text-slate-400">Proposed ${esc(formatDate(deal.proposed_at))}</p>${actions}</div>`;
    container.appendChild(card);
    wireDealActions(card, deal, viewerId, conversationId, container, pair);
  }
}

function wireDealActions(host, deal, viewerId, conversationId, container, pair) {
  const submit = async (button, rpc, params, label) => {
    button.disabled = true;
    const oldText = button.textContent;
    button.textContent = 'Saving…';
    const { error } = await supabase.rpc(rpc, params);
    if (error) {
      window.showToast?.(`Could not ${label}: ${error.message}`, true);
      button.disabled = false;
      button.textContent = oldText;
      return false;
    }
    window.showToast?.(label === 'respond to the proposal' ? 'Your response has been sent.' : 'Deal proposal cancelled.');
    await refreshConversationDeals(conversationId, viewerId, container, pair);
    return true;
  };
  host.querySelector('[data-deal-accept]')?.addEventListener('click', async event => {
    const target = event.currentTarget;
    target.disabled = true;
    await submit(target, 'buyer_respond_to_listing_deal', { p_deal_id: deal.id, p_accept: true, p_note: null }, 'respond to the proposal');
  });
  host.querySelector('[data-deal-decline]')?.addEventListener('click', async event => {
    if (!window.confirm('Decline this sale/rental proposal? The listing will remain available.')) return;
    const target = event.currentTarget;
    target.disabled = true;
    await submit(target, 'buyer_respond_to_listing_deal', { p_deal_id: deal.id, p_accept: false, p_note: null }, 'respond to the proposal');
  });
  host.querySelector('[data-deal-cancel]')?.addEventListener('click', async event => {
    if (!window.confirm('Cancel this proposal? The listing will remain available.')) return;
    const target = event.currentTarget;
    target.disabled = true;
    await submit(target, 'broker_cancel_listing_deal', { p_deal_id: deal.id, p_reason: null }, 'cancel the proposal');
  });
}

window.renderListingDealCards = refreshConversationDeals;

function listingImage(listing) {
  return listing.img || listing.image_url || listing.cover_image || listing.image || listing.photo_url || '';
}

function dealStatusPill(deal) {
  const [label, tone] = statusMeta[deal.status] || ['In progress', 'bg-slate-100 text-slate-700'];
  return `<span class="rounded-full px-2.5 py-1 text-xs font-bold ${tone}">${esc(label)}</span>`;
}

function renderDealHistory(deals, identityById) {
  if (!deals.length) return '';
  const rows = deals.map(deal => {
    const buyer = identityById.get(deal.buyer_id)?.full_name || 'Buyer';
    const amount = deal.proposed_amount == null ? 'Amount not specified' : `${money(deal.proposed_amount, deal.currency)}${deal.amount_basis === 'monthly' ? ' / month' : ''}`;
    const term = deal.transaction_type === 'rent' ? ` · ${deal.rental_months} month${deal.rental_months === 1 ? '' : 's'}` : '';
    const note = deal.cancellation_note || deal.employee_note || deal.buyer_note || '';
    return `<li class="border-t border-slate-100 py-3"><div class="flex flex-wrap items-center justify-between gap-2"><span class="text-sm font-semibold text-slate-800">${esc(buyer)} · ${esc(deal.transaction_type === 'rent' ? 'Rental' : 'Sale')}${term}</span>${dealStatusPill(deal)}</div><p class="mt-1 text-xs text-slate-500">${esc(amount)} · Proposed ${esc(formatDate(deal.proposed_at))}</p>${deal.status === 'confirmed' && deal.transaction_type === 'rent' ? `<p class="mt-1 text-xs text-slate-500">Lease: ${esc(formatDate(deal.lease_start_on))} – ${esc(formatDate(deal.lease_end_on))}</p>` : ''}${note ? `<p class="mt-1 text-xs text-slate-500">${esc(note)}</p>` : ''}</li>`;
  }).join('');
  return `<details class="mt-3 rounded-xl border border-slate-200 px-3"><summary class="cursor-pointer py-3 text-xs font-bold text-slate-600">Deal history (${deals.length})</summary><ul class="pb-2">${rows}</ul></details>`;
}

function applyBrokerDealListingSearch() {
  const host = document.getElementById('broker-deals-list');
  const search = document.getElementById('deal-listing-search');
  if (!host || !search) return;
  const query = search.value.trim().toLocaleLowerCase();
  const cards = [...host.querySelectorAll('[data-deal-listing-card]')];
  let visibleCount = 0;
  cards.forEach(card => {
    const visible = !query || card.dataset.search.includes(query);
    card.classList.toggle('hidden', !visible);
    if (visible) visibleCount++;
  });
  const emptyState = host.querySelector('[data-deal-search-empty]');
  if (emptyState) {
    emptyState.classList.toggle('hidden', cards.length > 0 && visibleCount > 0);
    emptyState.textContent = cards.length === 0
      ? (host.dataset.hasListings === 'true' ? 'No active listings or open sale/rental proposals.' : 'You have no listings yet. Add a listing to start a deal.')
      : 'No listings match your search.';
  }
}

async function openProposalDialog(listing, eligibleBuyers) {
  let selectedBuyerId = '';
  const defaultType = String(listing.intent || '').toLowerCase() === 'rent' ? 'rent' : 'sale';
  const root = document.createElement('div');
  root.className = 'fixed inset-0 z-[600] flex items-center justify-center bg-slate-950/50 p-4';
  root.innerHTML = `<section role="dialog" aria-modal="true" aria-labelledby="listing-deal-dialog-title" class="max-h-[90vh] w-full max-w-lg overflow-y-auto rounded-2xl bg-white p-6 shadow-2xl"><div class="flex items-start justify-between gap-4"><div><p data-deal-heading class="text-xs font-bold uppercase tracking-wider text-indigo-700">${defaultType === 'rent' ? 'Rental proposal' : 'Sale proposal'}</p><h2 id="listing-deal-dialog-title" class="mt-1 text-xl font-bold text-slate-900">${esc(listing.title || 'Listing')}</h2><p class="mt-1 text-sm text-slate-500">${esc(listing.location || '')}</p></div><button type="button" data-close aria-label="Close" class="rounded-lg p-1 text-slate-500 hover:bg-slate-100"><span class="material-symbols-outlined">close</span></button></div><form class="mt-5 space-y-4"><div><label for="deal-type" class="mb-1 block text-xs font-bold uppercase tracking-wide text-slate-500">Deal type</label><select id="deal-type" required class="w-full rounded-lg border border-slate-300 px-3 py-2.5 text-sm"><option value="sale" ${defaultType === 'sale' ? 'selected' : ''}>Sold (sale)</option><option value="rent" ${defaultType === 'rent' ? 'selected' : ''}>Rented</option></select></div><div class="relative"><label for="deal-buyer-trigger" class="mb-1 block text-xs font-bold uppercase tracking-wide text-slate-500">Buyer / renter</label><button type="button" id="deal-buyer-trigger" aria-haspopup="listbox" aria-expanded="false" class="flex w-full items-center justify-between rounded-lg border border-slate-300 bg-white px-3 py-2.5 text-left text-sm text-slate-600 hover:border-indigo-400 focus:border-indigo-500 focus:outline-none focus:ring-2 focus:ring-indigo-100"><span data-buyer-selection>Select a buyer or renter</span><span class="material-symbols-outlined text-lg">expand_more</span></button><div id="deal-buyer-dropdown" class="absolute z-20 mt-1 hidden w-full overflow-hidden rounded-xl border border-slate-200 bg-white shadow-lg"><div class="border-b border-slate-100 p-2"><input id="deal-buyer-search" type="search" role="combobox" aria-autocomplete="list" aria-controls="deal-buyer-options" aria-expanded="true" autocomplete="off" placeholder="Search by name…" class="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm focus:border-indigo-500 focus:outline-none focus:ring-2 focus:ring-indigo-100"></div><div id="deal-buyer-options" role="listbox" class="max-h-44 overflow-y-auto p-1"></div></div></div><div data-rent-term class="${defaultType === 'rent' ? '' : 'hidden'}"><label for="deal-months" class="mb-1 block text-xs font-bold uppercase tracking-wide text-slate-500">Rental term</label><select id="deal-months" ${defaultType === 'rent' ? 'required' : ''} class="w-full rounded-lg border border-slate-300 px-3 py-2.5 text-sm"><option value="">Select months</option>${Array.from({ length: 12 }, (_, index) => `<option value="${index + 1}">${index + 1} month${index ? 's' : ''}</option>`).join('')}</select></div><div><label data-amount-label for="deal-amount" class="mb-1 block text-xs font-bold uppercase tracking-wide text-slate-500">${defaultType === 'rent' ? 'Monthly rent' : 'Proposed sale price'} (optional)</label><input id="deal-amount" type="number" min="0.01" step="0.01" class="w-full rounded-lg border border-slate-300 px-3 py-2.5 text-sm" placeholder="Optional"></div><div><label for="deal-note" class="mb-1 block text-xs font-bold uppercase tracking-wide text-slate-500">Message (optional)</label><textarea id="deal-note" maxlength="2000" rows="3" class="w-full rounded-lg border border-slate-300 px-3 py-2.5 text-sm" placeholder="Add details for the buyer"></textarea></div><p data-error class="hidden text-sm font-semibold text-rose-700"></p><div class="flex justify-end gap-2 border-t border-slate-100 pt-4"><button type="button" data-close class="rounded-lg border border-slate-300 px-4 py-2 text-sm font-semibold text-slate-700">Cancel</button><button type="submit" class="rounded-lg bg-primary px-4 py-2 text-sm font-semibold text-on-primary">Send proposal</button></div></form></section>`;
  const handleOutsideClick = event => {
    if (!root.contains(event.target)) hideBuyerDropdown();
  };
  const close = () => {
    document.removeEventListener('click', handleOutsideClick);
    root.remove();
  };
  root.addEventListener('click', event => { if (event.target === root || event.target.closest('[data-close]')) close(); });
  document.body.appendChild(root);
  const typeSelect = root.querySelector('#deal-type');
  const buyerTrigger = root.querySelector('#deal-buyer-trigger');
  const buyerSearch = root.querySelector('#deal-buyer-search');
  const buyerDropdown = root.querySelector('#deal-buyer-dropdown');
  const buyerOptions = root.querySelector('#deal-buyer-options');
  const hideBuyerDropdown = () => {
    buyerDropdown.classList.add('hidden');
    buyerTrigger.setAttribute('aria-expanded', 'false');
    buyerSearch.setAttribute('aria-expanded', 'false');
  };
  const drawBuyerOptions = query => {
    const normalizedQuery = query.trim().toLocaleLowerCase();
    const matches = eligibleBuyers.filter(profile => {
      const name = (profile.full_name || 'Buyer').toLocaleLowerCase();
      const eligibility = profile.is_deal_eligible === false ? 'not a buyer account' : '';
      return `${name} ${eligibility}`.includes(normalizedQuery);
    });
    buyerOptions.innerHTML = matches.length
      ? matches.map(profile => {
        const eligible = profile.is_deal_eligible !== false;
        return `<button type="button" role="option" aria-selected="${profile.id === selectedBuyerId}" ${eligible ? `data-buyer-id="${esc(profile.id)}"` : 'disabled aria-disabled="true"'} class="flex w-full items-center justify-between gap-3 rounded-lg px-3 py-2 text-left text-sm ${eligible ? 'text-slate-800 hover:bg-indigo-50 focus:bg-indigo-50' : 'cursor-not-allowed text-slate-400'} focus:outline-none"><span>${esc(profile.full_name || 'Buyer')}</span>${eligible ? '' : '<span class="text-[11px] font-medium">Buyer account required</span>'}</button>`;
      }).join('')
      : '<p class="px-3 py-2 text-sm text-slate-500">No matching buyers or renters.</p>';
    buyerDropdown.classList.remove('hidden');
    buyerTrigger.setAttribute('aria-expanded', 'true');
    buyerSearch.setAttribute('aria-expanded', 'true');
  };
  buyerTrigger.addEventListener('click', () => {
    if (buyerDropdown.classList.contains('hidden')) {
      drawBuyerOptions('');
      buyerSearch.value = '';
      buyerSearch.focus();
    } else hideBuyerDropdown();
  });
  buyerSearch.addEventListener('input', () => {
    selectedBuyerId = '';
    buyerSearch.setCustomValidity('Select a buyer or renter from the search results.');
    drawBuyerOptions(buyerSearch.value);
  });
  buyerSearch.addEventListener('keydown', event => {
    if (event.key === 'Escape') {
      hideBuyerDropdown();
    }
    if (event.key === 'Enter' && !buyerOptions.classList.contains('hidden')) {
      const firstOption = buyerOptions.querySelector('[data-buyer-id]');
      if (firstOption) { event.preventDefault(); firstOption.click(); }
    }
  });
  buyerOptions.addEventListener('click', event => {
    const option = event.target.closest('[data-buyer-id]');
    if (!option) return;
    const buyer = eligibleBuyers.find(profile => profile.id === option.dataset.buyerId);
    if (!buyer || buyer.is_deal_eligible === false) return;
    selectedBuyerId = buyer.id;
    root.querySelector('[data-buyer-selection]').textContent = buyer.full_name || 'Buyer';
    buyerDropdown.dataset.selectedName = buyer.full_name || 'Buyer';
    hideBuyerDropdown();
  });
  document.addEventListener('click', handleOutsideClick);
  const rentTerm = root.querySelector('[data-rent-term]');
  const monthsSelect = root.querySelector('#deal-months');
  const updateTypeFields = () => {
    const rent = typeSelect.value === 'rent';
    rentTerm.classList.toggle('hidden', !rent);
    monthsSelect.required = rent;
    root.querySelector('[data-deal-heading]').textContent = rent ? 'Rental proposal' : 'Sale proposal';
    root.querySelector('[data-amount-label]').textContent = `${rent ? 'Monthly rent' : 'Proposed sale price'} (optional)`;
  };
  typeSelect.addEventListener('change', updateTypeFields);
  root.querySelector('form').addEventListener('submit', async event => {
    event.preventDefault();
    const form = event.currentTarget;
    const submit = form.querySelector('[type="submit"]');
    const errorEl = form.querySelector('[data-error]');
    const buyerId = selectedBuyerId;
    const isRent = typeSelect.value === 'rent';
    const months = monthsSelect.value;
    const amount = form.querySelector('#deal-amount').value;
    if (!buyerId || (isRent && !months)) {
      if (!buyerId) {
        errorEl.textContent = 'Select a buyer or renter from the dropdown.';
        errorEl.classList.remove('hidden');
        buyerTrigger.focus();
        return;
      }
      errorEl.textContent = isRent ? 'Select a buyer and rental term.' : 'Select a buyer.';
      errorEl.classList.remove('hidden');
      return;
    }
    submit.disabled = true;
    submit.textContent = 'Sending…';
    const { error } = await supabase.rpc('broker_propose_listing_deal', {
      p_listing_id: listing.id,
      p_buyer_id: buyerId,
      p_transaction_type: typeSelect.value,
      p_rental_months: isRent ? Number(months) : null,
      p_proposed_amount: amount ? Number(amount) : null,
      p_broker_note: form.querySelector('#deal-note').value.trim() || null
    });
    if (error) {
      errorEl.textContent = error.message;
      errorEl.classList.remove('hidden');
      submit.disabled = false;
      submit.textContent = 'Send proposal';
      return;
    }
    close();
    window.showToast?.(`${isRent ? 'Rental' : 'Sale'} proposal sent to the buyer.`);
    await initBrokerListingDeals();
  });
}

export async function initBrokerListingDeals() {
  const host = document.getElementById('broker-deals-list');
  if (!host) return;
  const listingSearch = document.getElementById('deal-listing-search');
  if (listingSearch && !listingSearch.dataset.bound) {
    listingSearch.addEventListener('input', applyBrokerDealListingSearch);
    listingSearch.dataset.bound = 'true';
  }
  host.innerHTML = '<div class="p-8 text-center text-sm text-slate-500">Loading listings and deal activity…</div>';
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return;
  const [listingResult, dealResult, buyerResult] = await Promise.all([
    supabase.from('listings').select('*').eq('broker_id', user.id).order('created_at', { ascending: false }),
    supabase.from('listing_deals').select('*').eq('broker_id', user.id).order('created_at', { ascending: false }),
    supabase.rpc('get_broker_deal_buyers')
  ]);
  const firstError = listingResult.error || dealResult.error || buyerResult.error;
  if (firstError) {
    host.innerHTML = `<div class="p-6 text-sm font-semibold text-rose-700">Could not load deal workspace: ${esc(firstError.message)}</div>`;
    return;
  }
  const listings = listingResult.data || [];
  const deals = dealResult.data || [];
  const openCount = deals.filter(deal => ['awaiting_buyer', 'awaiting_employee'].includes(deal.status)).length;
  for (const badgeId of ['broker-deals-badge', 'mobile-broker-deals-badge']) {
    const badge = document.getElementById(badgeId);
    if (!badge) continue;
    badge.textContent = openCount;
    badge.classList.toggle('hidden', openCount === 0);
    if (badgeId === 'mobile-broker-deals-badge') badge.classList.toggle('flex', openCount > 0);
  }
  const candidatesByListing = new Map();
  const addCandidate = (listingId, buyerId) => {
    if (!listingId || !buyerId) return;
    if (!candidatesByListing.has(String(listingId))) candidatesByListing.set(String(listingId), new Set());
    candidatesByListing.get(String(listingId)).add(buyerId);
  };
  const buyerRows = buyerResult.data || [];
  const brokerChatBuyerIds = new Set();
  buyerRows.forEach(row => {
    if (row.listing_id == null) brokerChatBuyerIds.add(row.id);
    else addCandidate(row.listing_id, row.id);
  });
  // Chat participants can be selected for any listing. Inquiry-only buyers
  // remain scoped to the listing that produced the inquiry.
  brokerChatBuyerIds.forEach(buyerId => listings.forEach(listing => addCandidate(listing.id, buyerId)));
  const identityById = new Map(buyerRows.map(profile => [profile.id, profile]));
  const missingDealBuyerIds = [...new Set(deals.map(deal => deal.buyer_id).filter(id => !identityById.has(id)))];
  if (missingDealBuyerIds.length) {
    const pastDealIdentities = await getRelatedIdentities(missingDealBuyerIds).catch(error => {
      console.warn('Could not resolve previous deal buyer names:', error);
      return [];
    });
    pastDealIdentities.forEach(profile => identityById.set(profile.id, profile));
  }
  const dealsByListing = new Map();
  deals.forEach(deal => {
    const key = String(deal.listing_id);
    if (!dealsByListing.has(key)) dealsByListing.set(key, []);
    dealsByListing.get(key).push(deal);
  });
  const eligibleListings = listings.filter(listing => {
    const listingDeals = dealsByListing.get(String(listing.id)) || [];
    return listing.status === 'Active' || (listing.status === 'Rented' && Boolean(listing.available_from))
      || listingDeals.some(deal => ['awaiting_buyer', 'awaiting_employee'].includes(deal.status));
  });
  host.dataset.hasListings = listings.length ? 'true' : 'false';
  const listingCards = eligibleListings.map(listing => {
    const listingDeals = dealsByListing.get(String(listing.id)) || [];
    const openDeal = listingDeals.find(deal => ['awaiting_buyer', 'awaiting_employee'].includes(deal.status));
    const latestDeal = listingDeals[0];
    const rent = String(listing.intent || '').toLowerCase() === 'rent';
    const availableNow = listing.status === 'Rented' && listing.available_from
      && listing.available_from <= new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });
    const eligible = [...(candidatesByListing.get(String(listing.id)) || [])]
      .map(id => identityById.get(id)).filter(Boolean);
    const image = listingImage(listing);
    const canPropose = listing.status === 'Active' || availableNow;
    const action = canPropose && !openDeal && eligible.length
      ? `<button type="button" data-propose-deal="${esc(listing.id)}" class="mt-4 rounded-lg bg-primary px-4 py-2.5 text-sm font-bold text-on-primary hover:opacity-90">Propose deal</button>`
      : canPropose && !openDeal
        ? '<p class="mt-4 text-xs text-slate-500">A buyer needs an existing inquiry or chat before you can send a proposal.</p>'
        : listing.status === 'Rented' && listing.available_from && !openDeal
          ? `<p class="mt-4 text-xs font-semibold text-violet-800">${availableNow ? 'Available now for a new rental' : `Available from ${esc(formatDate(listing.available_from))}`}</p>`
        : '';
    const dealSummary = openDeal
      ? `<div class="mt-4 rounded-xl border border-indigo-100 bg-indigo-50/70 p-3"><div class="flex flex-wrap items-center justify-between gap-2"><span class="text-sm font-bold text-slate-800">${esc(dealLabel(openDeal))}</span>${dealStatusPill(openDeal)}</div><p class="mt-2 text-xs text-slate-600">${esc(identityById.get(openDeal.buyer_id)?.full_name || 'Buyer')} · ${openDeal.proposed_amount == null ? 'Amount not specified' : esc(money(openDeal.proposed_amount, openDeal.currency))}${openDeal.amount_basis === 'monthly' ? ' / month' : ''}</p>${openDeal.status === 'awaiting_buyer' ? '<p class="mt-1 text-xs text-slate-500">Waiting for the buyer to respond.</p>' : '<p class="mt-1 text-xs text-slate-500">Buyer accepted. Waiting for Employee 1 review.</p>'}<button type="button" data-cancel-deal="${esc(openDeal.id)}" class="mt-2 text-xs font-bold text-slate-600 underline">Cancel proposal</button></div>`
      : latestDeal ? `<div class="mt-3 flex flex-wrap items-center gap-2 text-xs text-slate-500">Latest: ${esc(dealLabel(latestDeal))} ${dealStatusPill(latestDeal)}${latestDeal.status === 'confirmed' && latestDeal.transaction_type === 'rent' ? `<span>${esc(formatDate(latestDeal.lease_start_on))} – ${esc(formatDate(latestDeal.lease_end_on))}</span>` : ''}</div>` : '';
    const propertyFacts = [listing.type, listing.beds != null ? `${listing.beds} bed` : null, listing.baths != null ? `${listing.baths} bath` : null, listing.sqft ? `${Number(listing.sqft).toLocaleString('en-IN')} sq ft` : null].filter(Boolean).join(' · ');
    const history = renderDealHistory(listingDeals, identityById);
    const searchText = [listing.title, listing.location, listing.intent, listing.status, listing.id].filter(Boolean).join(' ').toLocaleLowerCase();
    return `<article data-deal-listing-card data-search="${esc(searchText)}" class="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm sm:p-5"><div class="flex flex-col gap-4 sm:flex-row">${image ? `<img src="${esc(image)}" alt="" class="h-36 w-full rounded-xl bg-slate-100 object-cover sm:h-28 sm:w-40">` : '<div class="flex h-28 w-full items-center justify-center rounded-xl bg-slate-100 text-slate-400 sm:w-40"><span class="material-symbols-outlined text-3xl">home</span></div>'}<div class="min-w-0 flex-1"><div class="flex flex-wrap items-center gap-2"><h3 class="text-base font-bold text-slate-900">${esc(listing.title || 'Untitled listing')}</h3><span class="rounded-full bg-slate-100 px-2.5 py-1 text-xs font-bold text-slate-700">${esc(listing.status || 'Unknown')}</span><span class="rounded-full bg-indigo-50 px-2.5 py-1 text-xs font-bold text-indigo-800">${rent ? 'For rent' : 'For sale'}</span></div><p class="mt-1 text-sm text-slate-500">${esc(listing.location || 'Location not provided')}</p>${propertyFacts ? `<p class="mt-1 text-xs text-slate-500">${esc(propertyFacts)}</p>` : ''}${listing.status === 'Rented' && listing.available_from ? `<p class="mt-1 text-xs font-semibold text-violet-800">${availableNow ? 'Available now' : `Available from ${esc(formatDate(listing.available_from))}`}</p>` : ''}<p class="mt-2 text-sm font-semibold text-slate-800">${esc(money(listing.price))}${rent ? ' / month listing price' : ' asking price'}</p><p class="mt-1 text-xs text-slate-500">Listing #${esc(listing.id)} · ${listingDeals.length} deal record${listingDeals.length === 1 ? '' : 's'}</p>${dealSummary}${action}${history}</div></div></article>`;
  }).join('');
  host.innerHTML = `${listingCards}<div data-deal-search-empty class="${listingCards ? 'hidden ' : ''}rounded-xl border border-dashed border-slate-300 bg-white p-8 text-center text-sm text-slate-500"></div>`;
  applyBrokerDealListingSearch();

  host.querySelectorAll('[data-propose-deal]').forEach(button => {
    const listing = listings.find(item => String(item.id) === button.dataset.proposeDeal);
    const buyerIds = [...(candidatesByListing.get(String(listing?.id)) || [])];
    const buyers = buyerIds.map(id => identityById.get(id)).filter(Boolean);
    button.addEventListener('click', () => openProposalDialog(listing, buyers));
  });
  host.querySelectorAll('[data-cancel-deal]').forEach(button => button.addEventListener('click', async () => {
    if (!window.confirm('Cancel this open deal? The listing remains available.')) return;
    button.disabled = true;
    const { error } = await supabase.rpc('broker_cancel_listing_deal', { p_deal_id: button.dataset.cancelDeal, p_reason: null });
    if (error) { window.showToast?.(`Could not cancel proposal: ${error.message}`, true); button.disabled = false; return; }
    window.showToast?.('Proposal cancelled.');
    await initBrokerListingDeals();
  }));

  if (!brokerDealChannel) {
    brokerDealChannel = supabase.channel(`broker_deal_updates_${user.id}`)
      .on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'listing_deals', filter: `broker_id=eq.${user.id}` }, async payload => {
        const notices = {
          awaiting_employee: 'The buyer accepted your proposal. It is now in Employee 1 review.',
          declined: 'The buyer declined your deal proposal. The listing remains available.',
          confirmed: 'Employee 1 confirmed the deal. The listing status has been updated.',
          rejected: 'Employee 1 rejected the deal. The listing remains available.',
          cancelled: 'Your deal proposal was cancelled.'
        };
        if (payload.new.status !== payload.old?.status && notices[payload.new.status]) {
          window.showToast?.(notices[payload.new.status]);
        }
        const badge = document.getElementById('broker-deals-list');
        if (badge && !document.getElementById('tab-deals')?.classList.contains('hidden')) {
          await initBrokerListingDeals();
        }
      }).subscribe();
  }
}

export async function initEmployee1DealReview() {
  const host = document.getElementById('employee1-deal-queue');
  if (!host) return;
  host.innerHTML = '<div class="p-8 text-center text-sm text-slate-500">Loading accepted deals…</div>';
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return;
  if (!employeeDealChannel) {
    employeeDealChannel = supabase.channel(`employee1_deal_queue_${user.id}`)
      .on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'listing_deals' }, async payload => {
        if (['awaiting_employee', 'confirmed', 'rejected'].includes(payload.new.status)) {
          if (payload.new.status === 'awaiting_employee' && payload.old?.status !== 'awaiting_employee') window.showToast?.('A buyer accepted a sale or rental proposal. Review it in Deal review.');
          await initEmployee1DealReview();
        }
      }).subscribe();
  }
  const { data: deals, error } = await supabase.from('listing_deals').select('*')
    .eq('status', 'awaiting_employee').order('buyer_responded_at', { ascending: true });
  if (error) {
    host.innerHTML = `<div class="p-6 text-sm font-semibold text-rose-700">Could not load accepted deals: ${esc(error.message)}</div>`;
    return;
  }
  const rows = deals || [];
  document.querySelectorAll('#employee1-deal-count,#employee1-deal-count-mobile').forEach(countBadge => {
    countBadge.textContent = rows.length;
    countBadge.classList.toggle('hidden', rows.length === 0);
  });
  const ids = [...new Set(rows.map(deal => deal.listing_id))];
  const buyerIds = [...new Set(rows.map(deal => deal.buyer_id))];
  const [listingResult, identityRows] = await Promise.all([
    ids.length ? supabase.from('listings').select('*').in('id', ids) : Promise.resolve({ data: [], error: null }),
    getRelatedIdentities(buyerIds).catch(() => [])
  ]);
  if (listingResult.error) {
    host.innerHTML = `<div class="p-6 text-sm font-semibold text-rose-700">Could not load deal listings: ${esc(listingResult.error.message)}</div>`;
    return;
  }
  const listingMap = new Map((listingResult.data || []).map(item => [String(item.id), item]));
  const identityMap = new Map(identityRows.map(item => [item.id, item]));
  const queueDeals = rows.filter(deal => {
    const listing = listingMap.get(String(deal.listing_id));
    return listing && (!listing.assigned_virtual_verifier_id || listing.assigned_virtual_verifier_id === user.id);
  });
  if (!queueDeals.length) {
    host.innerHTML = '<div class="rounded-xl border border-dashed border-slate-300 bg-white p-8 text-center text-sm text-slate-500">No buyer-accepted sale or rental deals need your review.</div>';
    window.applyEmployee1ListingSearch?.();
    return;
  }
  host.innerHTML = queueDeals.map(deal => {
    const listing = listingMap.get(String(deal.listing_id));
    const buyer = identityMap.get(deal.buyer_id);
    const image = listingImage(listing || {});
    const amount = deal.proposed_amount == null ? 'Amount not specified' : `${money(deal.proposed_amount, deal.currency)}${deal.amount_basis === 'monthly' ? ' / month' : ''}`;
    const facts = [listing?.type, listing?.beds != null ? `${listing.beds} bed` : null, listing?.baths != null ? `${listing.baths} bath` : null, listing?.sqft ? `${Number(listing.sqft).toLocaleString('en-IN')} sq ft` : null].filter(Boolean).join(' · ');
    const listingPrice = listing?.price == null ? '' : `<p class="mt-1 text-xs text-slate-500">Listing price: ${esc(money(listing.price))}${deal.transaction_type === 'rent' ? ' / month' : ''}</p>`;
    return `<article data-created-at="${esc(listing?.created_at || '')}" data-available-from="${esc(listing?.available_from || '')}" class="rounded-xl border border-slate-200 bg-white p-4 shadow-sm sm:p-5"><div class="flex flex-col gap-4 sm:flex-row">${image ? `<img src="${esc(image)}" alt="" class="h-32 w-full rounded-xl bg-slate-100 object-cover sm:h-24 sm:w-32">` : ''}<div class="min-w-0 flex-1"><div class="flex flex-wrap items-center gap-2"><h3 class="font-bold text-slate-900">${esc(listing?.title || `Listing #${deal.listing_id}`)}</h3><span class="rounded-full bg-blue-50 px-2.5 py-1 text-xs font-bold text-blue-800">Buyer accepted · review required</span></div><p class="mt-1 text-sm text-slate-500">${esc(listing?.location || '')}</p>${facts ? `<p class="mt-1 text-xs text-slate-500">${esc(facts)}</p>` : ''}${listingPrice}<p class="mt-2 text-sm font-semibold text-slate-800">${esc(dealLabel(deal))} · ${esc(amount)}</p><p class="mt-1 text-xs text-slate-500">Buyer: ${esc(buyer?.full_name || 'Buyer')} · Accepted ${esc(formatDate(deal.buyer_responded_at))}</p>${deal.broker_note ? `<p class="mt-2 rounded-lg bg-slate-50 p-3 text-sm text-slate-600">Broker note: ${esc(deal.broker_note)}</p>` : ''}<div class="mt-4 flex flex-wrap gap-2"><button type="button" data-review-confirm="${esc(deal.id)}" class="rounded-lg bg-emerald-700 px-4 py-2 text-sm font-bold text-white hover:bg-emerald-800">Confirm ${deal.transaction_type === 'rent' ? 'rental' : 'sale'}</button><button type="button" data-review-reject="${esc(deal.id)}" class="rounded-lg border border-rose-200 px-4 py-2 text-sm font-bold text-rose-700 hover:bg-rose-50">Reject deal</button></div></div></div></article>`;
  }).join('');
  host.querySelectorAll('[data-review-confirm]').forEach(button => button.addEventListener('click', () => submitReview(button, true)));
  host.querySelectorAll('[data-review-reject]').forEach(button => button.addEventListener('click', () => submitReview(button, false)));
  window.applyEmployee1ListingSearch?.();

}

async function submitReview(button, confirmDeal) {
  const note = confirmDeal ? null : window.prompt('Add a reason for rejecting this accepted deal:')?.trim();
  if (!confirmDeal && !note) return;
  if (confirmDeal && !window.confirm('Confirm the buyer-accepted deal? This will mark the listing Sold or Rented and remove it from active search.')) return;
  button.disabled = true;
  const oldText = button.textContent;
  button.textContent = confirmDeal ? 'Confirming…' : 'Submitting…';
  const { data: result, error } = await supabase.rpc('employee1_review_listing_deal', {
    p_deal_id: button.dataset.reviewConfirm || button.dataset.reviewReject,
    p_confirm: confirmDeal,
    p_note: note || null
  });
  if (error) {
    window.showToast?.(`Could not update deal: ${error.message}`, true);
    button.disabled = false;
    button.textContent = oldText;
    return;
  }
  window.showToast?.(confirmDeal ? `Deal confirmed. Listing status: ${result}.` : 'Deal rejected. The listing remains available.');
  await initEmployee1DealReview();
}

import { supabase } from './lib/supabase.js';

const kind = document.body.dataset.employeeType;
const pageHeading = document.querySelector('[data-page-heading]');
const queue = document.getElementById('listing-queue');
const feedback = document.getElementById('workflow-feedback');
const esc = (value = '') => String(value).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const FIELD_VERIFICATION_RADIUS_METERS = 200;
const listingDetails = new Map();
const rowSkeleton = () => `<div class="flex animate-pulse items-center gap-4 p-5"><div class="h-20 w-24 rounded-xl bg-slate-200"></div><div class="flex-1 space-y-3"><div class="h-4 w-1/3 rounded bg-slate-200"></div><div class="h-3 w-2/3 rounded bg-slate-200"></div><div class="h-3 w-1/2 rounded bg-slate-200"></div></div></div>`;
const loadingRows = (count = 3) => Array.from({ length: count }, rowSkeleton).join('<div class="border-t border-slate-100"></div>');
document.querySelectorAll('#employee1-total,#employee1-approved,#employee1-pending,#employee1-rejected,#employee2-total,#employee2-pending,#employee2-ready,#employee2-rejected').forEach(el => {
  el.innerHTML = '<span class="block h-8 w-10 animate-pulse rounded bg-slate-200"></span>';
});

function renderStatusGroup(title, description, items, emptyText, renderItem) {
  return `<section class="rounded-2xl border border-slate-200 bg-slate-50/70 p-4 sm:p-5"><div class="mb-4 flex flex-wrap items-end justify-between gap-2"><div><h3 class="text-lg font-bold text-slate-900">${esc(title)}</h3><p class="mt-1 text-sm text-slate-500">${esc(description)}</p></div><span class="rounded-full bg-white px-3 py-1 text-sm font-bold text-slate-600 ring-1 ring-slate-200">${items.length}</span></div>${items.length ? `<div class="grid gap-3">${items.map(renderItem).join('')}</div>` : `<div class="rounded-xl border border-dashed border-slate-300 bg-white px-4 py-5 text-sm text-slate-500">${esc(emptyText)}</div>`}</section>`;
}

function renderSimpleListing(item, userId, rejected = false) {
  const status = item.status === 'Active' ? 'Published' : item.status || 'Pending';
  const badge = rejected ? 'bg-rose-50 text-rose-700' : item.status === 'Active' ? 'bg-emerald-50 text-emerald-700' : 'bg-amber-50 text-amber-800';
  return `<article class="grid gap-4 rounded-xl border border-slate-200 bg-white p-4 shadow-sm sm:grid-cols-[96px_minmax(0,1fr)_auto] sm:items-center sm:p-5"><img src="${esc(item.img || '')}" alt="Listing photo" class="h-24 w-full rounded-xl bg-slate-100 object-cover sm:w-24" onerror="this.style.display='none'"><div class="min-w-0"><div class="flex flex-wrap items-center gap-2"><h4 class="font-bold text-slate-900">${esc(item.title || 'Listing')}</h4><span class="rounded-full px-2.5 py-1 text-xs font-semibold ${badge}">${esc(status)}</span></div><p class="mt-1 text-sm text-slate-600">${esc(item.location || 'Location not provided')} · ₹${Number(item.price || 0).toLocaleString('en-IN')}</p><p class="mt-2 text-xs text-slate-500">${esc(item.intent || '')}${item.created_at ? ` · Submitted ${new Date(item.created_at).toLocaleDateString('en-IN')}` : ''}</p>${rejected && item.rejection_reason ? `<p class="mt-3 rounded-lg bg-rose-50 p-3 text-sm text-rose-800"><strong>Rejection reason:</strong> ${esc(item.rejection_reason)}</p>` : ''}${item.field_verification_lat != null && item.field_verification_lng != null ? `<a class="mt-2 inline-block text-xs font-semibold text-blue-700 underline" href="https://www.google.com/maps?q=${item.field_verification_lat},${item.field_verification_lng}" target="_blank" rel="noopener">View saved field visit location</a>` : ''}</div><button type="button" data-details="${esc(item.id)}" class="rounded-lg border border-slate-300 px-4 py-2 text-sm font-semibold text-slate-700 hover:bg-slate-50">View details</button></article>`;
}

function wireListingDetails(host, userId, selector = '[data-details]') {
  host.querySelectorAll(selector).forEach(button => button.addEventListener('click', () => showListingDetails(listingDetails.get(button.dataset.details), userId)));
}

function closeWorkflowDialog() {
  document.getElementById('workflow-dialog')?.remove();
}

function openWorkflowDialog(title, body, actions = '') {
  closeWorkflowDialog();
  const overlay = document.createElement('div');
  overlay.id = 'workflow-dialog';
  overlay.className = 'fixed inset-0 z-[500] flex items-center justify-center bg-slate-950/50 p-4';
  overlay.innerHTML = `<div role="dialog" aria-modal="true" aria-labelledby="workflow-dialog-title" class="max-h-[90vh] w-full max-w-xl overflow-y-auto rounded-2xl bg-white p-6 shadow-2xl">
    <div class="flex items-start justify-between gap-4"><h2 id="workflow-dialog-title" class="text-xl font-bold text-slate-900">${esc(title)}</h2><button type="button" data-dialog-close aria-label="Close" class="rounded-lg p-1 text-slate-500 hover:bg-slate-100"><span class="material-symbols-outlined">close</span></button></div>
    <div class="mt-4">${body}</div>${actions ? `<div class="mt-6 flex justify-end gap-3">${actions}</div>` : ''}</div>`;
  overlay.addEventListener('click', event => { if (event.target === overlay || event.target.closest('[data-dialog-close]')) closeWorkflowDialog(); });
  document.body.appendChild(overlay);
  return overlay;
}

async function showListingDetails(item, userId) {
  const { data: freshItem, error } = await supabase.from('listings').select('*').eq('id', item.id).single();
  if (error || !freshItem) {
    feedback.textContent = `Could not load listing details from the database: ${error?.message || 'Listing not found.'}`;
    feedback.className = 'mb-5 rounded-xl bg-rose-50 p-3 text-sm font-semibold text-rose-800';
    return;
  }
  item = freshItem;
  listingDetails.set(String(item.id), item);
  let fieldPhotoUrl = item.field_verification_photo_url || '';
  if (fieldPhotoUrl && !fieldPhotoUrl.startsWith('http')) {
    const { data: signed } = await supabase.storage.from('field-verification').createSignedUrl(fieldPhotoUrl, 3600);
    fieldPhotoUrl = signed?.signedUrl || '';
  }
  const fields = [
    ['Status', item.status], ['Location', item.location], ['Price', item.price != null ? `â‚¹${Number(item.price).toLocaleString('en-IN')}` : null],
    ['Intent', item.intent], ['Property type', item.type], ['Bedrooms', item.beds], ['Bathrooms', item.baths],
    ['Area', item.sqft != null ? `${item.sqft} sq ft` : null], ['Brokerage', item.brokerage],
    ['Brokerage type', item.brokerage_type], ['Deposit', item.deposit != null ? `â‚¹${Number(item.deposit).toLocaleString('en-IN')}` : null],
    ['Map coordinates', item.lat != null && item.lng != null ? `${item.lat}, ${item.lng}` : null],
    ['Description', item.description],
    ['Virtual verification', item.virtually_verified ? 'Verified' : 'Pending'], ['Field verification', item.field_verified ? 'Verified' : 'Pending'],
    ['Field visit coordinates', item.field_verification_lat != null && item.field_verification_lng != null ? `${item.field_verification_lat}, ${item.field_verification_lng}` : null],
    ['Field verified at', item.field_verified_at ? new Date(item.field_verified_at).toLocaleString('en-IN') : null],
    ['Rejection reason', item.rejection_reason]
  ].filter(([, value]) => value !== null && value !== undefined && value !== '');
  const body = `<div class="flex flex-col gap-4 sm:flex-row">${item.img ? `<img src="${esc(item.img)}" alt="Listing photo" class="h-40 w-full rounded-xl bg-slate-100 object-cover sm:w-52">` : ''}<div><h3 class="text-lg font-bold text-slate-900">${esc(item.title || 'Listing')}</h3><p class="mt-1 text-sm text-slate-500">Listing #${esc(item.id)}</p>${fieldPhotoUrl ? `<a href="${esc(fieldPhotoUrl)}" target="_blank" rel="noopener" class="mt-3 inline-block text-sm font-semibold text-blue-700 underline">View field verification photo</a>` : ''}</div></div>
    <dl class="mt-5 grid gap-3 sm:grid-cols-2">${fields.map(([label, value]) => `<div class="rounded-lg bg-slate-50 p-3 ${label === 'Description' || label === 'Rejection reason' ? 'sm:col-span-2' : ''}"><dt class="text-xs font-bold uppercase tracking-wide text-slate-500">${esc(label)}</dt><dd class="mt-1 whitespace-pre-wrap text-sm ${label === 'Rejection reason' ? 'font-semibold text-rose-700' : 'text-slate-800'}">${esc(value)}</dd></div>`).join('')}</dl>`;
  const canVirtualReview = kind === 'Employee 1' && item.status === 'Pending'
    && item.assigned_virtual_verifier_id === userId && item.virtually_verified === false;
  const canFieldReview = kind === 'Employee 2' && item.status === 'Under Review'
    && item.assigned_field_agent_id === userId && item.virtually_verified === true;
  let actions = '';
  if (canVirtualReview) {
    actions = '<button type="button" data-action="virtual" class="rounded-lg bg-slate-900 px-4 py-2 text-sm font-semibold text-white">Approve and send to Employee 2</button><button type="button" data-action="reject" class="rounded-lg bg-rose-700 px-4 py-2 text-sm font-semibold text-white">Reject</button>';
  } else if (canFieldReview && item.field_verified) {
    actions = '<button type="button" data-action="approve" class="rounded-lg bg-emerald-700 px-4 py-2 text-sm font-semibold text-white">Approve and publish</button><button type="button" data-action="reject" class="rounded-lg bg-rose-700 px-4 py-2 text-sm font-semibold text-white">Reject</button>';
  } else if (canFieldReview) {
    actions = '<label class="cursor-pointer rounded-lg border border-slate-300 px-4 py-2 text-sm font-semibold text-slate-700">Capture field photo<input data-photo type="file" accept="image/jpeg,image/png,image/webp" capture="environment" class="sr-only"></label><button type="button" data-action="field" class="rounded-lg bg-slate-900 px-4 py-2 text-sm font-semibold text-white">Verify location and photo</button><button type="button" data-action="reject" class="rounded-lg bg-rose-700 px-4 py-2 text-sm font-semibold text-white">Reject</button>';
  }
  const overlay = openWorkflowDialog('Listing details', body, actions);
  overlay.dataset.listing = String(item.id);
  overlay.dataset.lat = item.lat ?? '';
  overlay.dataset.lng = item.lng ?? '';
  overlay.querySelectorAll('[data-action]').forEach(button => button.addEventListener('click', () => act(button, userId)));
}

function requestRejectionReason(onSubmit) {
  const body = `<label for="workflow-rejection-reason" class="block text-sm font-semibold text-slate-700">Why are you rejecting this listing?</label><textarea id="workflow-rejection-reason" rows="4" maxlength="2000" required class="mt-2 w-full rounded-xl border border-slate-300 p-3 text-sm text-slate-900 outline-none focus:border-rose-500 focus:ring-2 focus:ring-rose-100" placeholder="Explain what needs to be corrected..."></textarea><p id="workflow-rejection-error" class="mt-2 hidden text-sm font-semibold text-rose-700"></p>`;
  const overlay = openWorkflowDialog('Reject listing', body, '<button type="button" data-dialog-close class="rounded-lg border border-slate-300 px-4 py-2 text-sm font-semibold text-slate-700">Cancel</button><button type="button" data-submit-rejection class="rounded-lg bg-rose-700 px-4 py-2 text-sm font-semibold text-white">Submit rejection</button>');
  overlay.querySelector('[data-submit-rejection]').addEventListener('click', async event => {
    const submit = event.currentTarget;
    const reason = overlay.querySelector('#workflow-rejection-reason').value.trim();
    const error = overlay.querySelector('#workflow-rejection-error');
    if (!reason) { error.textContent = 'Enter a rejection reason to continue.'; error.classList.remove('hidden'); return; }
    submit.disabled = true;
    submit.textContent = 'Submittingâ€¦';
    try { await onSubmit(reason); closeWorkflowDialog(); }
    catch (err) { error.textContent = err.message || 'Could not submit rejection.'; error.classList.remove('hidden'); submit.disabled = false; submit.textContent = 'Submit rejection'; }
  });
}

function distanceMeters(lat1, lng1, lat2, lng2) {
  const toRadians = degrees => degrees * Math.PI / 180;
  const dLat = toRadians(lat2 - lat1);
  const dLng = toRadians(lng2 - lng1);
  const a = Math.sin(dLat / 2) ** 2
    + Math.cos(toRadians(lat1)) * Math.cos(toRadians(lat2)) * Math.sin(dLng / 2) ** 2;
  return 6371000 * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

document.querySelectorAll('[data-create-listing]').forEach(button => {
  button.addEventListener('click', async event => {
    event.preventDefault();
    if (typeof window.openListingModal !== 'function') {
      if (feedback) {
        feedback.textContent = 'The listing form did not load. Refresh the page and try again.';
        feedback.className = 'mb-5 rounded-xl bg-rose-50 p-3 text-sm font-semibold text-rose-800';
      }
      return;
    }
    try {
      await window.openListingModal(null);
    } catch (error) {
      console.error('Could not open Employee 1 listing form:', error);
      if (feedback) {
        feedback.textContent = `Could not open the listing form: ${error.message || 'unexpected error'}`;
        feedback.className = 'mb-5 rounded-xl bg-rose-50 p-3 text-sm font-semibold text-rose-800';
      }
    }
  });
});

document.querySelectorAll('a[href="#my-listings"]').forEach(link => link.addEventListener('click', event => {
  const section = document.getElementById('my-listings');
  if (!section) return;
  event.preventDefault();
  history.replaceState(null, '', '#my-listings');
  section.scrollIntoView({ behavior: 'smooth', block: 'start' });
  section.classList.add('ring-2', 'ring-primary/30');
  window.setTimeout(() => section.classList.remove('ring-2', 'ring-primary/30'), 1200);
}));

async function boot() {
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return location.replace('/staff-login.html');
  const { data: profile, error } = await supabase.from('profiles').select('role, employee_type, full_name').eq('id', user.id).maybeSingle();
  if (error || !profile) {
    feedback.textContent = `Could not load your employee profile: ${error?.message || 'profile not found'}`;
    feedback.className = 'mb-5 rounded-xl bg-rose-50 p-3 text-sm font-semibold text-rose-800';
    return;
  }
  if (profile.role !== 'Employee' || profile.employee_type !== kind) {
    feedback.textContent = `This page requires Employee type ${kind}. Your profile is ${profile.role}${profile.employee_type ? ` / ${profile.employee_type}` : ' with no employee type assigned'}. Ask an Admin to assign the correct type.`;
    feedback.className = 'mb-5 rounded-xl bg-rose-50 p-3 text-sm font-semibold text-rose-800';
    return;
  }
  if (pageHeading) pageHeading.textContent = kind === 'Employee 1' ? 'Employee 1 Dashboard' : 'Employee 2 Dashboard';
  const staffName = document.getElementById('staff-name');
  if (staffName) staffName.textContent = profile.full_name || kind;
  if (kind === 'Employee 1') {
    window.refreshEmployee1Listings = () => loadEmployee1Listings(user.id);
    await Promise.all([loadEmployee1Listings(user.id), loadQueue(user.id)]);
  } else {
    window.refreshEmployee2Listings = () => loadEmployee2Dashboard(user.id);
    await Promise.all([loadEmployee2Dashboard(user.id), loadQueue(user.id)]);
  }
}

async function loadEmployee2Dashboard(userId) {
  const historyHost = document.getElementById('employee2-history');
  if (historyHost) historyHost.innerHTML = loadingRows(2);
  const { data, error } = await supabase.from('listings').select('*')
    .eq('assigned_field_agent_id', userId)
    .eq('virtually_verified', true)
    .order('created_at', { ascending: false });
  if (error) {
    const message = `Could not load Employee 2 listings from the database: ${error.message}`;
    if (historyHost) historyHost.innerHTML = `<div class="p-6 text-sm font-semibold text-rose-700">${esc(message)}</div>`;
    feedback.textContent = message;
    feedback.className = 'mb-5 rounded-xl bg-rose-50 p-3 text-sm font-semibold text-rose-800';
    ['employee2-total', 'employee2-pending', 'employee2-ready', 'employee2-rejected'].forEach(id => {
      const element = document.getElementById(id);
      if (element) element.textContent = 'â€”';
    });
    return;
  }
  const listings = data || [];
  const pending = listings.filter(item => item.status === 'Under Review' && !item.field_verified).length;
  const ready = listings.filter(item => item.status === 'Under Review' && item.field_verified).length;
  const rejected = listings.filter(item => item.status === 'Rejected').length;
  document.getElementById('employee2-total').textContent = listings.length;
  document.getElementById('employee2-pending').textContent = pending;
  document.getElementById('employee2-ready').textContent = ready;
  document.getElementById('employee2-rejected').textContent = rejected;
  listings.forEach(item => listingDetails.set(String(item.id), item));

  if (!historyHost) return;
  const published = listings.filter(item => item.status === 'Active');
  const rejectedItems = listings.filter(item => item.status === 'Rejected');
  historyHost.className = 'grid gap-5 p-4 sm:p-5';
  historyHost.innerHTML = renderStatusGroup('Published', 'Field verification is complete and the listing is live.', published, 'No published listings yet.', item => renderSimpleListing(item, userId))
    + renderStatusGroup('Rejected', 'Rejected listings and the reviewer’s reason.', rejectedItems, 'No rejected listings.', item => renderSimpleListing(item, userId, true));
  wireListingDetails(historyHost, userId);
}

async function loadEmployee1Listings(userId) {
  const listingHost = document.getElementById('employee1-listings');
  if (!listingHost) return;
  listingHost.innerHTML = loadingRows(2);
  const [createdResult, assignedResult] = await Promise.all([
    supabase.from('listings').select('*').eq('created_by', userId).order('created_at', { ascending: false }),
    supabase.from('listings').select('*').eq('assigned_virtual_verifier_id', userId).order('created_at', { ascending: false })
  ]);
  if (createdResult.error || assignedResult.error) {
    const message = createdResult.error?.message || assignedResult.error?.message;
    listingHost.innerHTML = `<div class="p-6 text-sm font-semibold text-rose-700">Could not load dashboard listings from the database: ${esc(message)}</div>`;
    feedback.textContent = `Dashboard data could not be loaded: ${message}`;
    feedback.className = 'mb-5 rounded-xl bg-rose-50 p-3 text-sm font-semibold text-rose-800';
    return;
  }
  const listings = createdResult.data || [];
  const workflowListings = new Map([...listings, ...(assignedResult.data || [])].map(item => [String(item.id), item]));
  const tracked = [...workflowListings.values()];
  const approved = tracked.filter(item => item.assigned_virtual_verifier_id === userId
    && item.virtually_verified === true && item.assigned_field_agent_id != null).length;
  const rejected = tracked.filter(item => item.status === 'Rejected').length;
  const pending = tracked.filter(item => !['Active', 'Rejected'].includes(item.status)).length;
  document.getElementById('employee1-total').textContent = tracked.length;
  document.getElementById('employee1-approved').textContent = approved;
  document.getElementById('employee1-pending').textContent = pending;
  document.getElementById('employee1-rejected').textContent = rejected;
  tracked.forEach(item => listingDetails.set(String(item.id), item));
  const rejectedItems = tracked.filter(item => item.status === 'Rejected');
  const sentToField = tracked.filter(item => item.virtually_verified === true && item.assigned_field_agent_id != null && item.status !== 'Rejected');
  const current = tracked.filter(item => !['Active', 'Rejected'].includes(item.status) && !(item.virtually_verified === true && item.assigned_field_agent_id != null));
  listingHost.className = 'grid gap-5 p-4 sm:p-5';
  listingHost.innerHTML = renderStatusGroup('Current listings', 'Waiting for review or field verification.', current, 'No listings currently in review.', item => renderSimpleListing(item, userId))
    + renderStatusGroup('Approved for field verification', 'Virtual review passed and assigned to Employee 2.', sentToField, 'No listings have been sent to field verification yet.', item => renderSimpleListing(item, userId))
    + renderStatusGroup('Rejected listings', 'Review the rejection reason and open listing details.', rejectedItems, 'No rejected listings.', item => renderSimpleListing(item, userId, true));
  wireListingDetails(listingHost, userId);
}

async function loadQueue(userId) {
  if (!queue) return;
  queue.innerHTML = loadingRows();
  const fields = '*';
  let data, error;
  if (kind === 'Employee 1') {
    const [pendingResult, rejectedResult] = await Promise.all([
      supabase.from('listings').select(fields).eq('assigned_virtual_verifier_id', userId).eq('virtually_verified', false).eq('status', 'Pending').order('created_at', { ascending: false }).limit(50),
      supabase.from('listings').select(fields).eq('assigned_virtual_verifier_id', userId).eq('status', 'Rejected').order('created_at', { ascending: false }).limit(50)
    ]);
    error = pendingResult.error || rejectedResult.error;
    data = [...(pendingResult.data || []), ...(rejectedResult.data || [])];
  } else {
    const result = await supabase.from('listings').select(fields).eq('assigned_field_agent_id', userId).eq('virtually_verified', true).eq('status', 'Under Review').order('created_at', { ascending: false }).limit(50);
    data = result.data; error = result.error;
  }
  if (error) {
    queue.innerHTML = `<p class="text-rose-700">Could not load assignments: ${esc(error.message)}</p>`;
    return;
  }
  if (!data?.length) {
    queue.className = 'grid gap-5 p-4 sm:p-5';
    queue.innerHTML = kind === 'Employee 1'
      ? renderStatusGroup('Needs virtual verification', 'Review each listing before forwarding it to field operations.', [], 'No listings are awaiting virtual review.', () => '') + renderStatusGroup('Rejected', 'Listings rejected during review.', [], 'No listings have been rejected.', () => '')
      : renderStatusGroup('Awaiting site visit', 'Capture a site photo and confirm your location within 200 m.', [], 'No listings are awaiting a site visit.', () => '') + renderStatusGroup('Ready to publish', 'Field visit saved; approve to make the listing live.', [], 'No listings are ready to publish.', () => '');
    return;
  }
  const displayItems = await Promise.all(data.map(async item => {
    if (item.field_verification_photo_url && !item.field_verification_photo_url.startsWith('http')) {
      const { data: signed } = await supabase.storage.from('field-verification').createSignedUrl(item.field_verification_photo_url, 3600);
      item.field_verification_photo_url = signed?.signedUrl || '';
    }
    return item;
  }));
  displayItems.forEach(item => listingDetails.set(String(item.id), item));
  const renderQueueCard = item => `<article class="rounded-xl border border-slate-200 bg-white p-4 shadow-sm sm:p-5" data-listing="${item.id}" data-lat="${item.lat ?? ''}" data-lng="${item.lng ?? ''}">
    <div class="flex flex-col gap-4 sm:flex-row"><img class="h-28 w-full rounded-xl bg-slate-100 object-cover sm:w-36" src="${esc(item.img || '')}" alt="Listing photo" onerror="this.style.display='none'">
    <div class="min-w-0 flex-1"><div class="flex flex-wrap items-center gap-2"><h2 class="text-lg font-bold text-slate-900">${esc(item.title)}</h2><span class="rounded-full bg-slate-100 px-3 py-1 text-xs font-bold text-slate-600">${esc(item.status || 'Pending')}</span></div>
    <p class="mt-1 text-sm text-slate-500">${esc(item.location)} Â· â‚¹${Number(item.price || 0).toLocaleString('en-IN')}</p>
    <p class="mt-3 text-xs font-semibold text-slate-600">Virtual: ${item.virtually_verified ? 'Verified' : 'Not verified'} Â· Field: ${item.field_verified ? 'Verified' : 'Not verified'}</p>
    ${kind === 'Employee 2' && item.field_verified && item.field_verification_lat != null ? `<p class="mt-2 text-xs font-semibold text-emerald-700">Field visit is within ${FIELD_VERIFICATION_RADIUS_METERS} m of listing location.</p>` : ''}
    ${item.field_verification_photo_url ? `<a class="mt-2 inline-block text-sm font-bold text-blue-700 underline" target="_blank" rel="noopener" href="${esc(item.field_verification_photo_url)}">View field photo</a>` : ''}
    ${item.field_verification_lat != null ? `<a class="ml-3 text-sm font-bold text-blue-700 underline" target="_blank" rel="noopener" href="https://www.google.com/maps?q=${item.field_verification_lat},${item.field_verification_lng}">View captured location</a>` : ''}
    ${item.status === 'Rejected' && item.rejection_reason ? `<p class="mt-4 rounded-lg bg-rose-50 p-3 text-sm text-rose-800"><strong>Field rejection reason:</strong> ${esc(item.rejection_reason)}</p>` : ''}
    </div></div><div class="mt-4 flex flex-wrap gap-2"><button type="button" class="rounded-xl border border-slate-300 px-4 py-2 text-sm font-bold text-slate-700" data-action="details">View all details</button>${item.status !== 'Rejected' && kind === 'Employee 1' ? `<button class="rounded-xl bg-slate-900 px-4 py-2 text-sm font-bold text-white" data-action="virtual">Approve virtual review &amp; send to Employee 2</button><button class="rounded-xl border border-rose-200 px-4 py-2 text-sm font-bold text-rose-700" data-action="reject">Reject</button>` : ''}${kind === 'Employee 2' && !item.field_verified ? `<label class="rounded-xl border border-slate-300 px-4 py-2 text-sm font-bold text-slate-700">Capture field photo<input data-photo type="file" accept="image/jpeg,image/png,image/webp" capture="environment" class="sr-only"></label><button class="rounded-xl bg-slate-900 px-4 py-2 text-sm font-bold text-white" data-action="field">Use my location &amp; save verification</button><button class="rounded-xl border border-rose-200 px-4 py-2 text-sm font-bold text-rose-700" data-action="reject">Reject</button>` : ''}${kind === 'Employee 2' && item.field_verified && item.status !== 'Active' ? `<button class="rounded-xl bg-emerald-700 px-4 py-2 text-sm font-bold text-white" data-action="approve">Approve and publish</button><button class="rounded-xl border border-rose-200 px-4 py-2 text-sm font-bold text-rose-700" data-action="reject">Reject</button>` : ''}</div>
    ${kind === 'Employee 2' && !item.field_verified ? `<p class="mt-2 text-xs text-slate-500">Capture a property photo and allow device location. The visit must be within ${FIELD_VERIFICATION_RADIUS_METERS} m of the listing pin.</p>` : ''}</article>`;
  const pending = displayItems.filter(item => kind === 'Employee 1' ? item.status !== 'Rejected' : !item.field_verified);
  const rejectedItems = displayItems.filter(item => item.status === 'Rejected');
  const ready = displayItems.filter(item => kind === 'Employee 2' && item.field_verified);
  queue.className = 'grid gap-5 p-4 sm:p-5';
  queue.innerHTML = kind === 'Employee 1'
    ? renderStatusGroup('Needs virtual verification', 'Review each listing before forwarding it to field operations.', pending, 'No listings are awaiting virtual review.', renderQueueCard)
      + renderStatusGroup('Rejected', 'Listings rejected during virtual review, with the reason saved in the database.', rejectedItems, 'No listings have been rejected.', renderQueueCard)
    : renderStatusGroup('Awaiting site visit', 'Capture a site photo and confirm your location within 200 m.', pending, 'No listings are awaiting a site visit.', renderQueueCard)
      + renderStatusGroup('Ready to publish', 'Field visit saved; approve to make the listing live.', ready, 'No listings are ready to publish.', renderQueueCard);
  queue.querySelectorAll('[data-action]').forEach(button => button.addEventListener('click', () => button.dataset.action === 'details' ? showListingDetails(listingDetails.get(button.closest('[data-listing]').dataset.listing), userId) : act(button, userId)));
}

async function act(button, userId) {
  const card = button.closest('[data-listing]');
  const id = Number(card.dataset.listing);
  button.disabled = true;
  try {
    let result;
    if (button.dataset.action === 'virtual') {
      result = await supabase.rpc('employee1_mark_virtual_verified', { p_listing_id: id });
    } else if (button.dataset.action === 'reject') {
      button.disabled = false;
      requestRejectionReason(async reason => {
        button.disabled = true;
        const rpc = kind === 'Employee 1' ? 'employee1_reject_listing' : 'employee2_reject_listing';
        const rejection = await supabase.rpc(rpc, { p_listing_id: id, p_reason: reason });
        if (rejection.error) throw rejection.error;
        feedback.textContent = 'Listing rejected. The uploader and relevant reviewers can see the reason in their listing views.';
        feedback.className = 'mb-5 rounded-xl bg-emerald-50 p-3 text-sm font-semibold text-emerald-800';
        await loadQueue(userId);
        if (kind === 'Employee 1') await loadEmployee1Listings(userId);
        else await loadEmployee2Dashboard(userId);
      });
      return;
    } else if (button.dataset.action === 'field') {
      const file = card.querySelector('[data-photo]')?.files?.[0];
      if (!file) throw new Error('Capture a site photo first.');
      if (!['image/jpeg', 'image/png', 'image/webp'].includes(file.type)) throw new Error('Use a JPG, PNG, or WebP photo.');
      if (!navigator.geolocation) throw new Error('Location is unavailable on this device.');
      const position = await new Promise((resolve, reject) => navigator.geolocation.getCurrentPosition(resolve, reject, { enableHighAccuracy: true, timeout: 20000 }));
      if (!card.dataset.lat || !card.dataset.lng) throw new Error('This listing has no saved map coordinates. Ask the broker to correct the listing location.');
      const listingLat = Number(card.dataset.lat);
      const listingLng = Number(card.dataset.lng);
      const visitDistance = distanceMeters(listingLat, listingLng, position.coords.latitude, position.coords.longitude);
      if (!Number.isFinite(visitDistance) || visitDistance > FIELD_VERIFICATION_RADIUS_METERS) {
        throw new Error(`You are ${Math.round(visitDistance)} m from the listing. Move within ${FIELD_VERIFICATION_RADIUS_METERS} m and retry.`);
      }
      const path = `${userId}/${id}/${Date.now()}-${file.name.replace(/[^a-zA-Z0-9._-]/g, '_')}`;
      const upload = await supabase.storage.from('field-verification').upload(path, file, { upsert: false, contentType: file.type });
      if (upload.error) throw upload.error;
      result = await supabase.rpc('employee2_record_field_verification', { p_listing_id: id, p_photo_url: path, p_lat: position.coords.latitude, p_lng: position.coords.longitude });
    } else {
      result = await supabase.rpc('employee2_approve_listing', { p_listing_id: id });
    }
    if (result.error) throw result.error;
    closeWorkflowDialog();
    feedback.textContent = button.dataset.action === 'approve' ? 'Listing approved and published.'
      : button.dataset.action === 'virtual' ? 'Virtual review approved. Listing assigned to Employee 2.'
      : 'Field photo and in-range location saved.';
    feedback.className = 'mb-5 rounded-xl bg-emerald-50 p-3 text-sm font-semibold text-emerald-800';
    await loadQueue(userId);
    if (kind === 'Employee 1') await loadEmployee1Listings(userId);
    else await loadEmployee2Dashboard(userId);
  } catch (error) {
    feedback.textContent = error.message || 'Action failed.';
    feedback.className = 'mb-5 rounded-xl bg-rose-50 p-3 text-sm font-semibold text-rose-800';
    button.disabled = false;
  }
}

if (kind === 'Employee 1' && feedback) {
  feedback.classList.remove('hidden');
  feedback.textContent = 'New listings are submitted for review. Track field verification and approval in My Listings.';
  feedback.className = 'mb-5 rounded-xl bg-blue-50 p-3 text-sm font-semibold text-blue-800';
}
boot();

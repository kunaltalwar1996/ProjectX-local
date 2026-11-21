import { supabase } from './lib/supabase.js';

const grid = document.getElementById('broker-directory-grid');
const resultCount = document.getElementById('broker-results-count');
const errorBox = document.getElementById('broker-directory-error');
const accountAction = document.getElementById('broker-account-action');
const avatarFallback = 'https://images.unsplash.com/photo-1560250097-0b93528c311a?auto=format&fit=crop&w=240&q=80';

function escapeHtml(value = '') {
  return String(value).replace(/[&<>"']/g, char => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  })[char]);
}

function render(brokers) {
  resultCount.textContent = `${brokers.length} broker${brokers.length === 1 ? '' : 's'}`;
  if (!brokers.length) {
    grid.innerHTML = `<div class="col-span-full rounded-2xl border border-dashed border-slate-300 bg-white p-10 text-center"><span class="material-symbols-outlined text-3xl text-slate-300">person_search</span><p class="mt-2 font-bold text-slate-800">No broker profiles to show</p><p class="mt-1 text-sm text-slate-500">Please check back later.</p></div>`;
    return;
  }
  grid.innerHTML = brokers.map(broker => `<a href="/profile.html?id=${encodeURIComponent(broker.id)}" class="group flex min-h-40 items-center gap-4 rounded-2xl border border-slate-200 bg-white p-5 shadow-sm transition hover:-translate-y-0.5 hover:border-indigo-200 hover:shadow-md focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:ring-offset-2">
    <img src="${escapeHtml(broker.avatar_url || avatarFallback)}" alt="" loading="lazy" class="h-16 w-16 shrink-0 rounded-full bg-slate-100 object-cover ring-1 ring-slate-200" onerror="this.onerror=null;this.src='${avatarFallback}'">
    <span class="min-w-0 flex-1"><span class="block truncate text-base font-bold text-slate-900 group-hover:text-indigo-800">${escapeHtml(broker.full_name || 'ProjectX Broker')}</span><span class="mt-1 block text-sm text-slate-500">Broker</span><span class="mt-3 inline-flex items-center gap-1 text-sm font-bold text-indigo-700">View profile <span class="material-symbols-outlined text-base">arrow_forward</span></span></span>
  </a>`).join('');
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
    console.warn('Could not check buyer sign-in state:', error);
  }
}

async function init() {
  updateAccountAction();
  try {
    let timeoutId;
    const result = await Promise.race([
      supabase.rpc('get_public_brokers'),
      new Promise((_, reject) => { timeoutId = setTimeout(() => reject(new Error('The broker directory request timed out. Please refresh and try again.')), 12000); })
    ]);
    clearTimeout(timeoutId);
    if (result.error) throw result.error;
    const brokers = (result.data || []).filter(profile => profile.id);
    errorBox.classList.add('hidden');
    render(brokers);
  } catch (error) {
    console.error('Broker directory failed to load:', error);
    resultCount.textContent = 'Broker profiles unavailable';
    const missingRpc = /get_public_brokers|schema cache|function/i.test(error.message || '');
    errorBox.textContent = missingRpc
      ? 'Broker profiles could not be loaded. Apply the public broker directory migration in Supabase, then reload this page.'
      : (error.message || 'We could not load broker profiles. Please refresh and try again.');
    errorBox.classList.remove('hidden');
    grid.innerHTML = '';
  }
}

init();

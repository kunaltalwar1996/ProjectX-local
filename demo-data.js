// demo-data.js — Realistic Mumbai & Delhi property listings (inspired by real market data)
// Automatically seeds the property grid on properties.html and map.html
import { listingAgeBadgeMarkup } from './lib/listing-card-presentation.js';

const DEMO_LISTINGS = [
  {
    id: 1, title: "Mehdi's house",
    address: "Bandra West, Mumbai",
    location: "Mumbai", type: "Apartment/ High Rise", beds: 1, baths: 1, price: 0.45, intent: "Rent",
    sqft: 4500, date: "2026-05-17", badge: "Premium", badgeColor: "bg-amber-500",
    img: "https://images.unsplash.com/photo-1600587771525-78b9dba3b914?w=800&auto=format&fit=crop",
    coords: [19.0596, 72.8295]
  }
];

// Utility: format price for display
function formatPrice(price, intent = "Buy") {
  if (intent === "Rent") {
    const p = parseFloat(price);
    if (isNaN(p)) return "—";
    return `₹${p.toLocaleString('en-IN')}<span class="text-[10px] font-normal text-slate-400">/mo</span>`;
  }
  const crore = parseFloat(price);
  if (isNaN(crore)) return "—";
  if (crore >= 1) return `₹${crore.toFixed(crore % 1 === 0 ? 0 : 1)} Cr`;
  return `₹${(crore * 100).toFixed(0)} L`;
}

// Keep the exact listing date in the card footer; the age appears on the image.
function getListingDateFooter(dateStr) {
  const listed = new Date(dateStr);
  const listedFormatted = listed.toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' }).toUpperCase();

  return `
    <div class="flex items-center mt-4 pt-3 border-t border-slate-100">
      <div class="flex items-center gap-1.5 text-slate-400">
        <span class="material-symbols-outlined text-[14px]">schedule</span>
        <span class="text-[10px] font-bold uppercase tracking-widest">Listed ${listedFormatted}</span>
      </div>
    </div>
  `;
}

// Build a card HTML string from a listing object
function buildCardHTML(l) {
  return `
    <div class="group cursor-pointer property-card bg-white rounded-3xl border border-slate-200 hover:shadow-xl overflow-hidden transition-all duration-300"
         data-id="${l.id}" data-title="${l.title}" data-location="${l.location}"
         data-type="${l.type}" data-beds="${l.beds}" data-baths="${l.baths}"
         data-price="${l.price}" data-date="${l.date}" data-intent="${l.intent}"
         onclick="window.location.href='/property-details.html?id=${l.id}'">
      <div class="aspect-[16/9] overflow-hidden relative bg-slate-100">
        <img loading="lazy" src="${l.img}"
             class="w-full h-full object-cover group-hover:scale-105 transition-transform duration-700"
             onerror="this.src='https://images.unsplash.com/photo-1560448204-e02f11c3d0e2?w=800&auto=format&fit=crop'">
        ${listingAgeBadgeMarkup(l.date)}
        <button aria-label="Save Property" class="save-property-btn absolute top-4 right-4 w-9 h-9 flex items-center justify-center bg-white/90 backdrop-blur rounded-full shadow text-slate-400 hover:text-red-500 transition-colors">
          <span class="material-symbols-outlined text-[20px]">favorite</span>
        </button>
        <button aria-label="Share Property" class="share-property-btn absolute top-4 right-[52px] w-9 h-9 flex items-center justify-center bg-white/90 backdrop-blur rounded-full shadow text-slate-400 hover:text-blue-500 transition-colors z-10" onclick="event.stopPropagation(); navigator.clipboard.writeText(window.location.origin+'/property-details.html?id=${l.id}').then(()=>{ const t=document.createElement('div'); t.className='fixed bottom-6 right-6 z-[200] bg-slate-900 text-white px-4 py-2 rounded-lg shadow-lg text-sm'; t.textContent='Link copied!'; document.body.appendChild(t); setTimeout(()=>t.remove(),2000); })">
          <span class="material-symbols-outlined text-[20px]">share</span>
        </button>
      </div>
      <div class="p-5">
        <h3 class="text-xl font-black text-slate-900">${formatPrice(l.price, l.intent)}</h3>
        <p class="mt-1 mb-3 text-xs font-semibold text-slate-500">${l.type} <span class="font-medium text-slate-400">· For ${l.intent}</span></p>
        <p class="text-slate-500 text-sm font-medium mb-4 truncate">${l.address}</p>
        <div class="flex flex-wrap items-center gap-y-2 gap-x-4 text-slate-400">
          ${l.beds > 0 ? `<div class="flex items-center gap-1.5"><span class="material-symbols-outlined text-[18px]">bed</span><span class="text-xs font-black text-slate-900">${l.beds >= 5 ? '5BHK+' : `${l.beds}BHK`}</span></div>` : ''}
          ${l.baths > 0 ? `<div class="flex items-center gap-1.5"><span class="material-symbols-outlined text-[18px]">bathtub</span><span class="text-xs font-black text-slate-900">${l.baths}</span></div>` : ''}
          <div class="flex items-center gap-1.5"><span class="material-symbols-outlined text-[18px]">square_foot</span><span class="text-xs font-black text-slate-900">${l.sqft.toLocaleString()} <span class="font-normal text-slate-400">sqft</span></span></div>
        </div>
        ${getListingDateFooter(l.date)}
      </div>
    </div>
  `;
}

// Inject into the property grid
function seedPropertyGrid() {
  const grid = document.getElementById('property-grid');
  if (!grid) return;

  // Clear existing static cards first
  grid.innerHTML = '';

  // Filter based on page if needed
  const urlParams = new URLSearchParams(window.location.search);
  const intentFilter = urlParams.get('intent');

  const filtered = intentFilter 
    ? DEMO_LISTINGS.filter(l => l.intent.toLowerCase() === intentFilter.toLowerCase())
    : DEMO_LISTINGS;

  // Render all demo listings
  filtered.forEach(l => {
    grid.insertAdjacentHTML('beforeend', buildCardHTML(l));
  });

  // Update count text
  const countText = document.getElementById('listings-count-text');
  if (countText) {
    countText.textContent = `Discover ${filtered.length} exceptional listings in Mumbai & Delhi`;
  }
}

// Export for use in other scripts
window.DEMO_LISTINGS = DEMO_LISTINGS;
window.buildCardHTML = buildCardHTML;
window.formatPrice = formatPrice;
window.seedPropertyGrid = seedPropertyGrid;

// Only seed on pages that don't load from Supabase
document.addEventListener('DOMContentLoaded', () => {
  const page = window.location.pathname.split('/').pop() || 'index.html';
  const supabasePages = ['properties.html', 'properties', 'index.html', 'index', 'map.html', 'map'];
  if (!supabasePages.some(p => page.includes(p))) {
    seedPropertyGrid();
  }
});


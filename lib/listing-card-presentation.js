function getListingAgeDays(createdAt) {
  if (!createdAt) return null;
  const created = new Date(createdAt);
  if (Number.isNaN(created.getTime())) return null;
  return Math.max(0, Math.floor((Date.now() - created.getTime()) / 86400000));
}

export function listingAgeBadgeMarkup(createdAt) {
  const days = getListingAgeDays(createdAt);
  if (days === null) {
    return '<span class="absolute top-3 left-3 z-10 rounded-full bg-slate-600/90 px-3 py-1 text-[9px] font-black uppercase tracking-wider text-white shadow-sm">Date unavailable</span>';
  }

  const label = `${days} day${days === 1 ? '' : 's'} old`;
  const colors = days <= 5
    ? 'bg-emerald-500 text-white'
    : days <= 10
      ? 'bg-amber-500 text-white'
      : 'bg-red-500 text-white';

  return `<span class="absolute top-3 left-3 z-10 rounded-full ${colors} px-3 py-1 text-[9px] font-black uppercase tracking-wider shadow-sm">${label}</span>`;
}

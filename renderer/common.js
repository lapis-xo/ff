// Shared helpers for the main window and the overlay.
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const pc = (slot) => (slot === 'me' ? 'pc-me' : slot ? `pc-${slot}` : '');
const img = (src, alt = '', attrs = '') => (src ? `<img src="${esc(src)}" alt="${esc(alt)}" ${attrs}>` : '');
const plural = (n, word) => `${n.toLocaleString()} ${word}${n === 1 ? '' : 's'}`;

function ago(ts) {
  if (!ts) return 'never';
  const m = Math.round((Date.now() - ts) / 60000);
  if (m < 1) return 'just now';
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  return h < 24 ? `${h} hr ago` : plural(Math.round(h / 24), 'day') + ' ago';
}

// Loading shimmer + broken-image fallback (CSP blocks inline onerror)
const SHIMMER = ['pcard__splash', 'skin-chip__img', 'tile', 'sc-art', 'ct-art', 'pstat__img'];
function watchImages(root) {
  root.querySelectorAll('img').forEach((im) => {
    const wrap = im.parentElement;
    if (!im.complete && SHIMMER.some((c) => wrap.classList.contains(c))) wrap.classList.add('is-loading');
    im.addEventListener('load', () => wrap.classList.remove('is-loading'), { once: true });
    im.addEventListener('error', () => { wrap.classList.remove('is-loading'); im.classList.add('is-broken'); }, { once: true });
  });
}

function emptyState(title, text, { warn = false, action = '' } = {}) {
  return `<div class="empty ${warn ? 'empty--warn' : ''}"><div class="empty__art"></div>
    <h2 class="empty__title">${esc(title)}</h2><p class="empty__text">${esc(text)}</p>${action}</div>`;
}

// My clickable skin. state: { equipped, pending, just }
function skinChip(skin, { small = false, equipped = false, pending = false, just = false } = {}) {
  const cls = ['skin-chip', small && 'skin-chip--sm', equipped && 'is-equipped', pending && 'is-pending', just && 'just-equipped'].filter(Boolean).join(' ');
  const state = pending ? 'Equipping...' : equipped ? 'Equipped' : '';
  return `<button class="${cls}" data-apply="${skin.id}" title="Equip ${esc(skin.name)}">
    <span class="skin-chip__img">${img(skin.tile)}</span>
    <span><span class="skin-chip__name">${esc(skin.name)}</span>${state ? `<span class="skin-chip__state">${state}</span>` : ''}</span></button>`;
}

// Equip flow shared by main window and overlay: pending -> just-equipped
const equipState = { pending: null, just: null };
function bindApply(root, rerender) {
  root.querySelectorAll('[data-apply]').forEach((b) => {
    b.onclick = async () => {
      const id = Number(b.dataset.apply);
      equipState.pending = id; rerender();
      const ok = await window.skinmatch.applySkin(id);
      equipState.pending = null;
      if (ok) { equipState.just = id; setTimeout(() => { equipState.just = null; }, 500); }
      rerender();
    };
  });
}

// Celebration: a group gets .is-new once when it forms or grows, then never replays
const seenGroups = new Set();
function groupIsNew(g) {
  const key = `${g.lineId}:${[...g.ids].sort().join(',')}`;
  if (seenGroups.has(key)) return false;
  seenGroups.add(key);
  return true;
}
function resetCelebrations() { seenGroups.clear(); }

// Arena / Mayhem augments as small icons, ringed by rarity
function augmentIcons(list, { size = 'sm', stats = false } = {}) {
  if (!list?.length) return '';
  return `<span class="augs augs--${size}">${list.map((a) => `<span class="aug aug--${a.rarity || 'silver'}" title="${esc(a.name)}${stats ? `: picked ${a.picks}x` : ''}">
    ${a.icon ? `<img src="${esc(a.icon)}" alt="${esc(a.name)}">` : ''}${stats ? `<i>${a.picks}</i>` : ''}</span>`).join('')}</span>`;
}

// Riot's official ranked emblem for a tier (IRON...CHALLENGER)
const rankEmblem = (tier, cls = 'rk__emblem') => {
  if (!tier) return '';
  const t = String(tier).toLowerCase();
  return `<img class="${cls}" src="${(window.__RANKS && window.__RANKS[t]) || `assets/ranks/${t}.png`}" alt="">`;
};

// Riot's position icons, in the colors of the player's rank tier (Emerald has no set, so it uses Platinum's)
function roleIcon(role, tier, cls = 'role__icon') {
  const r = { Top: 'top', Jungle: 'jungle', Mid: 'mid', ADC: 'adc', Support: 'support' }[role];
  if (!r) return '';
  let t = String(tier || 'silver').toLowerCase();
  if (t === 'emerald') t = 'platinum';
  const key = `${t}-${r}`;
  return `<img class="${cls}" src="${(window.__POS && window.__POS[key]) || `assets/positions/${key}.png`}" alt="">`;
}

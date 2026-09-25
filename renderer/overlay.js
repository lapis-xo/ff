document.getElementById('close').onclick = () => window.skinmatch.hideOverlay();
let last = null;

function render(s) {
  last = s;
  const cs = s.champSelect;
  const title = document.getElementById('title'), body = document.getElementById('body'), bench = document.getElementById('bench');
  bench.innerHTML = '';
  const picked = (cs.cards || []).filter((c) => c.champ);
  title.innerHTML = picked.length ? picked.map((c) => `<span class="${pc(c.slot)}">${esc(c.champ.name)}</span>`).join(' <em>&amp;</em> ') : 'ff';

  const emptyOv = (t, x) => (body.innerHTML = `<div class="ov-empty"><b>${esc(t)}</b>${esc(x)}</div>`);
  if (!cs.active) { resetCelebrations(); return emptyOv('Waiting for champ select', 'This window opens on its own when you get there.'); }
  if (!cs.mates.length) return emptyOv('No party members on your team', 'Matches show for friends in your party on your team.');

  let html = '';
  const everyone = cs.groups.length === 1 && cs.groups[0].ids.length === cs.cards.length;
  cs.groups.forEach((g, i) => {
    const members = cs.cards.filter((c) => g.ids.includes(c.id));
    const cls = ['ov-match', i === 1 && 'ov-match--b', everyone && 'ov-match--all', groupIsNew(g) && 'is-new'].filter(Boolean).join(' ');
    html += `<div class="${cls}"><div class="ov-match__tiles">${members.map((c) => `<span class="tile ${pc(c.slot)}" title="${esc(c.name)}">${img(c.skin?.tile, c.skin?.name)}</span>`).join('')}</div>
      <div class="ov-match__name">${esc(g.lineName)}</div></div>`;
  });

  if (cs.matches.length) {
    html += '<div class="ov-label">Switch to match</div>';
    html += cs.matches.map((m) => `<div class="ov-line"><div class="ov-line__name">${esc(m.lineName)}</div>
      <div class="ov-line__with">With ${m.members.map((x) => `<b>${esc(x.name)}</b>${x.wearing ? ' (wearing)' : ''}`).join(', ')}</div>
      <div class="chips">${m.mySkins.map((sk) => skinChip(sk, {
        small: true, equipped: sk.id === cs.mySelected, pending: sk.id === equipState.pending, just: sk.id === equipState.just,
      })).join('')}</div></div>`).join('');
  } else if (!cs.groups.length) {
    html += `<div class="ov-empty"><b>${cs.myChamp ? 'No shared skinlines' : 'Waiting for picks'}</b>${cs.myChamp ? 'Nothing to match on these champs.' : 'Matches show once champs are picked.'}</div>`;
  }
  body.innerHTML = html;

  if (cs.benchOptions.length) {
    bench.innerHTML = `<div class="ov-bench"><span class="ov-label">ARAM bench</span>${cs.benchOptions.map((b) =>
      `<span class="bench-chip">${img(b.champ.icon)}${esc(b.champ.name)} <span>up to ${b.most}</span></span>`).join('')}</div>`;
  }
  bindApply(body, () => render(last));
  watchImages(document.body);
}

window.skinmatch.onState(render);
window.skinmatch.getState().then(render);

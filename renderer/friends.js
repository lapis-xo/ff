// Friends tab: everyone you've added, click through to their profile.
async function renderFriends() {
  const list = await api.friends();
  const mode = { aram: 'ARAM', mayhem: 'ARAM: Mayhem', arena: 'Arena', rift: "Summoner's Rift", other: 'a game' };
  const status = (f) => f.inLobby ? '<span class="fstatus is-lobby">In your lobby</span>'
    : f.online ? '<span class="fstatus is-on">ff online</span>'
    : f.app ? '<span class="fstatus">ff offline</span>' : '<span class="fstatus">Riot ID only</span>';
  view.innerHTML = `<div class="friends">
    <div class="friends__head"><h2 class="h2">Friends <span class="muted">(${list.length})</span></h2>
      <div class="inline friends__add"><input class="input" id="addId" placeholder="Add by Riot ID, like Momo#NA1" aria-label="Add a friend by Riot ID" aria-describedby="addMsg">
        <button class="btn btn--match" id="addBtn">Add friend</button></div></div>
    <p class="msg" id="addMsg" role="status"></p>
    ${list.length ? `<div class="fgrid">${list.map((f) => `
      <div class="fcard ${pc(f.slot)}" data-open="${esc(f.puuid)}" role="button" tabindex="0" aria-label="Open ${esc(f.name)}'s profile">
        <button class="fcard__remove" data-remove="${esc(f.puuid)}" data-app="${f.app ? 1 : ''}" aria-label="Remove ${esc(f.name)}">×</button>
        <span class="fcard__icon">${f.icon ? `<img src="${esc(f.icon)}" alt="">` : ''}${f.level ? `<i>${f.level}</i>` : ''}</span>
        <div class="fcard__body">
          <div class="fcard__name">${esc(f.name)} <span>${esc(f.tag || '')}</span></div>
          ${status(f)}
          <div class="fcard__meta">${f.solo ? `<span class="rk t-${f.solo.tier.toLowerCase()}">${rankEmblem(f.solo.tier)}${f.solo.tier[0] + f.solo.tier.slice(1).toLowerCase()} ${['MASTER', 'GRANDMASTER', 'CHALLENGER'].includes(f.solo.tier) ? '' : f.solo.division} ${f.solo.lp} LP</span>` : '<span class="muted">Unranked</span>'}
            ${f.lastGame ? `<span class="muted">Last played ${mode[f.lastGame.mode] || 'a game'} ${ago(f.lastGame.start)}</span>` : ''}</div>
        </div>
      </div>`).join('')}</div>`
    : emptyState('No friends yet', 'Friends with ff are added when they join your League lobby. You can also add anyone by Riot ID above.')}
  </div>`;
  view.querySelectorAll('[data-open]').forEach((c) => {
    c.onclick = (e) => { if (!e.target.closest('[data-remove]')) openProfile(c.dataset.open); };
    c.onkeydown = (e) => { if (e.key === 'Enter') openProfile(c.dataset.open); };
  });
  view.querySelectorAll('[data-remove]').forEach((b) => (b.onclick = async () => {
    await (b.dataset.app ? api.removeFriend(b.dataset.remove) : api.removeWatch(b.dataset.remove));
    renderFriends();
  }));
  const add = async () => {
    const input = document.getElementById('addId'), msg = document.getElementById('addMsg');
    const id = input.value.trim();
    if (!id) return;
    msg.className = 'msg'; msg.textContent = 'Looking up...';
    const res = await api.addRiotId(id);
    if (!res.ok) { input.className = 'input is-error'; msg.className = 'msg msg--error'; msg.textContent = res.error; return; }
    msg.className = 'msg msg--ok'; msg.textContent = res.already ? `${res.name} is already on your list.` : `Added ${res.name}.`;
    input.value = ''; input.className = 'input';
    renderFriends();
  };
  document.getElementById('addBtn').onclick = add;
  document.getElementById('addId').onkeydown = (e) => { if (e.key === 'Enter') add(); };
  watchImages(view);
}

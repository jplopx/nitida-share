/* Nítida UI: navegação responsiva — não modifica sessões nem WebRTC. */
(() => {
  'use strict';
  const byId = id => document.getElementById(id);
  const body = document.body;
  const sidebar = byId('sidePanel');
  const backdrop = byId('mobileSidebarBackdrop');
  const menuButton = byId('mobileFriendsButton');
  const peopleNav = byId('mobilePeopleNav');
  const homeNav = byId('mobileHomeNav');
  const closeButton = byId('closeSidebarButton');
  const roomPanel = byId('roomPanel');
  const appView = byId('appView');
  const mobileQuery = window.matchMedia('(max-width: 850px)');

  function setMenu(open) {
    const active = Boolean(open && mobileQuery.matches && !appView.classList.contains('hidden'));
    body.classList.toggle('social-open', active);
    sidebar?.classList.toggle('social-open', active);
    if (backdrop) backdrop.hidden = !active;
    menuButton?.setAttribute('aria-expanded', String(active));
    peopleNav?.setAttribute('aria-expanded', String(active));
    peopleNav?.classList.toggle('selected', active);
    homeNav?.classList.toggle('selected', !active);
    if (active) closeButton?.focus();
  }
  function syncUI() {
    const inRoom = roomPanel && !roomPanel.classList.contains('hidden');
    body.classList.toggle('ui-in-room', Boolean(inRoom));
    body.classList.toggle('ui-auth', appView?.classList.contains('hidden') ?? false);
    if (!mobileQuery.matches || appView?.classList.contains('hidden')) setMenu(false);
    if (homeNav) {
      homeNav.setAttribute('aria-label', inRoom ? 'Voltar à tela da transmissão' : 'Voltar ao painel');
      const text = homeNav.querySelector('small');
      if (text) text.textContent = inRoom ? 'Sala' : 'Painel';
    }
  }
  menuButton?.addEventListener('click', () => setMenu(!body.classList.contains('social-open')));
  peopleNav?.addEventListener('click', () => setMenu(!body.classList.contains('social-open')));
  homeNav?.addEventListener('click', () => {
    setMenu(false);
    byId('mainContent')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  });
  closeButton?.addEventListener('click', () => setMenu(false));
  backdrop?.addEventListener('click', () => setMenu(false));
  document.addEventListener('keydown', event => {
    if (event.key === 'Escape' && body.classList.contains('social-open')) setMenu(false);
  });
  mobileQuery.addEventListener('change', syncUI);
  [roomPanel, appView].forEach(element => {
    if (element) new MutationObserver(syncUI).observe(element, { attributes: true, attributeFilter: ['class'] });
  });
  // Os contadores são preenchidos pelo cliente principal. Aqui só exibimos alertas no menu.
  ['requestsCount', 'invitesCount'].forEach(id => {
    const count = byId(id);
    if (count) new MutationObserver(() => {
      const requests = Number(byId('requestsCount')?.textContent) || 0;
      const invitations = Number(byId('invitesCount')?.textContent) || 0;
      byId('mobileSocialDot')?.classList.toggle('visible', requests + invitations > 0);
    }).observe(count, { childList: true, characterData: true, subtree: true });
  });
  syncUI();
})();

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


/* Nítida UI 2.1: abas sociais e controles de vídeo. Não altera WebRTC ou sockets. */
(() => {
  'use strict';
  const byId = id => document.getElementById(id);
  const room = byId('roomPanel');
  const stage = byId('videoStage');
  const toolbar = byId('roomToolbar');
  const settings = byId('toggleSettingsButton');
  const details = byId('toggleDetailsButton');
  if (!room || !stage || !toolbar) return;
  stage.appendChild(toolbar);
  let hideTimer;
  const isSharing = () => !byId('roomLiveDot')?.classList.contains('on') ? false : true;
  function reveal() {
    toolbar.classList.add('is-visible');
    clearTimeout(hideTimer);
    if (!isSharing() || toolbar.classList.contains('settings-open') || toolbar.classList.contains('details-open')) return;
    hideTimer = setTimeout(() => {
      if (!toolbar.matches(':hover') && !toolbar.matches(':focus-within')) toolbar.classList.remove('is-visible');
    }, 3600);
  }
  function togglePanel(name, button) {
    const opened = toolbar.classList.toggle(name);
    button.setAttribute('aria-expanded', String(opened));
    reveal();
  }
  settings?.addEventListener('click', () => togglePanel('settings-open', settings));
  details?.addEventListener('click', () => togglePanel('details-open', details));
  stage.addEventListener('pointermove', reveal, { passive: true });
  stage.addEventListener('pointerenter', reveal);
  stage.addEventListener('pointerdown', reveal);
  stage.addEventListener('focusin', reveal);
  stage.addEventListener('keydown', event => {
    reveal();
    if (event.key === 'Escape') {
      toolbar.classList.remove('settings-open', 'details-open');
      settings?.setAttribute('aria-expanded', 'false');
      details?.setAttribute('aria-expanded', 'false');
      reveal();
    }
  });
  toolbar.addEventListener('pointerleave', reveal);
  const live = byId('roomLiveDot');
  if (live) new MutationObserver(reveal).observe(live, { attributes: true, attributeFilter: ['class'] });
  const roomObserver = new MutationObserver(() => {
    if (!room.classList.contains('hidden')) reveal();
    else clearTimeout(hideTimer);
  });
  roomObserver.observe(room, { attributes: true, attributeFilter: ['class'] });
  document.querySelectorAll('[data-social-tab]').forEach(tab => {
    tab.addEventListener('click', () => {
      const section = tab.dataset.socialTab;
      document.querySelectorAll('[data-social-tab]').forEach(button => {
        const active = button === tab;
        button.classList.toggle('active', active);
        button.setAttribute('aria-selected', String(active));
      });
      document.querySelectorAll('[data-social-page]').forEach(page => page.classList.toggle('hidden', page.dataset.socialPage !== section));
    });
  });
  reveal();
})();

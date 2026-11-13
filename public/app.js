/* NÍTIDA — cliente WebRTC. Sem captura de microfone, sem chat. */
'use strict';

const PRESETS = Object.freeze({
  '480p30': { width: 854, height: 480, fps: 30, bitrate: 1_800_000 },
  '720p30': { width: 1280, height: 720, fps: 30, bitrate: 4_000_000 },
  '720p60': { width: 1280, height: 720, fps: 60, bitrate: 6_000_000 },
  '1080p30': { width: 1920, height: 1080, fps: 30, bitrate: 8_000_000 },
  '1080p60': { width: 1920, height: 1080, fps: 60, bitrate: 12_000_000 }
});
const $ = id => document.getElementById(id);
const initialRoomId = new URL(window.location.href).searchParams.get('room');
const state = {
  me: null, socket: null, config: { iceServers: [{ urls: 'stun:stun.l.google.com:19302' }], maxParticipants: 4 },
  social: { friends: [], incoming: [], outgoing: [], invitations: [] },
  room: null, participants: [], activeSharerId: null, localStream: null, peers: new Map(), pendingIce: new Map(),
  preset: '1080p60', audio: false, lastStats: null, statsTimer: null, connecting: null, joinVersion: 0
};

function notify(message, type = 'info') {
  const region = $('toastRegion');
  const node = document.createElement('div');
  node.className = `toast ${type}`;
  node.textContent = message;
  region.append(node);
  setTimeout(() => node.remove(), 5500);
}
function show(element, visible) { element.classList.toggle('hidden', !visible); }
function node(tag, className = '', text = '') {
  const result = document.createElement(tag);
  if (className) result.className = className;
  if (text !== '') result.textContent = text;
  return result;
}
function safeName(value) { return (value || 'N').trim().charAt(0).toUpperCase() || 'N'; }
function setRoomInAddress(roomId) {
  const url = new URL(location.href);
  if (roomId) url.searchParams.set('room', roomId);
  else url.searchParams.delete('room');
  history.replaceState(null, '', url.pathname + url.search + url.hash);
}
async function api(path, options = {}) {
  const response = await fetch(`/api${path}`, {
    credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json' },
    ...options
  });
  let body;
  try { body = await response.json(); } catch { body = {}; }
  if (!response.ok) throw new Error(body.error || `Não foi possível concluir (${response.status}).`);
  return body;
}
const post = (path, body = {}) => api(path, { method: 'POST', body: JSON.stringify(body) });
const del = path => api(path, { method: 'DELETE' });
function reportError(err) { notify(err?.message || 'Algo deu errado. Tente novamente.', 'error'); }
function formSubmitLock(form, locked) {
  const btn = form.querySelector('button[type="submit"]');
  if (btn) btn.disabled = locked;
}
function setAuthTab(tab) {
  for (const id of ['login', 'register', 'guest']) show($(`${id}Form`), id === tab);
  document.querySelectorAll('[data-auth-tab]').forEach(button => {
    const active = button.dataset.authTab === tab;
    button.classList.toggle('active', active);
    button.setAttribute('aria-selected', String(active));
  });
}
function showAuth() {
  show($('authView'), true);
  show($('appView'), false);
  show($('authInviteHint'), !!new URL(location.href).searchParams.get('room'));
}
function showApp() {
  show($('authView'), false);
  show($('appView'), true);
  $('accountAvatar').textContent = safeName(state.me.displayName);
  $('accountName').textContent = state.me.displayName;
  $('accountType').textContent = state.me.guest ? 'Convidado' : `@${state.me.username}`;
  show($('socialSection'), !state.me.guest);
  show($('guestSocial'), state.me.guest);
}

function avatar(person, online = false) {
  const element = node('div', 'person-avatar', safeName(person.displayName));
  if (online !== null) element.append(node('span', `online-ring ${online ? '' : 'offline'}`));
  return element;
}
function emptyMessage(target, message) { target.replaceChildren(node('div', 'empty-list', message)); }
function actionButton(label, cls, onClick, ariaLabel = label) {
  const button = node('button', `mini-btn ${cls}`, label);
  button.type = 'button';
  button.title = ariaLabel;
  button.setAttribute('aria-label', ariaLabel);
  button.addEventListener('click', async () => {
    button.disabled = true;
    try { await onClick(); } catch (err) { reportError(err); }
    finally { button.disabled = false; }
  });
  return button;
}
async function refreshSocial() {
  if (!state.me || state.me.guest) return;
  try {
    state.social = await api('/friends');
    renderSocial();
  } catch (err) {
    if (err.message.includes('Entre na sua conta')) return;
    reportError(err);
  }
}
function renderSocial() {
  const { friends, incoming, outgoing, invitations } = state.social;
  $('friendsCount').textContent = friends.length;
  $('requestsCount').textContent = incoming.length + outgoing.length;
  $('invitesCount').textContent = invitations.length;
  const friendsEl = $('friendList');
  friendsEl.replaceChildren();
  if (!friends.length) emptyMessage(friendsEl, 'Suas amizades vão aparecer aqui. Adicione alguém pelo nome de usuário.');
  for (const friend of friends) {
    const row = node('div', 'person-row');
    row.append(avatar(friend, friend.online));
    const info = node('div', 'person-info');
    info.append(node('strong', '', friend.displayName), node('small', '', `@${friend.username} · ${friend.online ? 'online' : 'offline'}`));
    row.append(info);
    if (state.room) row.append(actionButton('↗', 'positive', async () => {
      await post(`/rooms/${state.room.id}/invites`, { friendId: friend.id });
      notify(`Convite enviado a ${friend.displayName}.`, 'success');
    }, `Convidar ${friend.displayName} para esta sala`));
    else row.append(actionButton('×', '', async () => {
      if (!confirm(`Remover ${friend.displayName} da lista de amizades?`)) return;
      await del(`/friends/${friend.id}`);
      await refreshSocial();
    }, `Remover ${friend.displayName}`));
    friendsEl.append(row);
  }
  const requestsEl = $('requestsList');
  requestsEl.replaceChildren();
  if (!incoming.length && !outgoing.length) emptyMessage(requestsEl, 'Nenhum pedido pendente.');
  for (const req of incoming) {
    const row = node('div', 'request-row');
    row.append(avatar(req, null));
    const info = node('div', 'person-info');
    info.append(node('strong', '', req.displayName), node('small', '', 'Quer ser seu amigo'));
    row.append(info);
    const actions = node('div', 'request-buttons');
    actions.append(actionButton('✓', 'positive', async () => {
      await post(`/friends/requests/${req.id}/accept`);
      await refreshSocial();
      notify('Pedido de amizade aceito.', 'success');
    }, `Aceitar pedido de ${req.displayName}`));
    actions.append(actionButton('×', 'reject', async () => {
      await post(`/friends/requests/${req.id}/decline`);
      await refreshSocial();
    }, `Recusar pedido de ${req.displayName}`));
    row.append(actions);
    requestsEl.append(row);
  }
  for (const req of outgoing) {
    const row = node('div', 'request-row');
    row.append(avatar(req, null));
    const info = node('div', 'person-info');
    info.append(node('strong', '', req.displayName), node('small', '', 'Pedido enviado'));
    row.append(info, actionButton('×', '', async () => {
      await post(`/friends/requests/${req.id}/decline`);
      await refreshSocial();
    }, `Cancelar pedido enviado para ${req.displayName}`));
    requestsEl.append(row);
  }
  const invitationsEl = $('invitesList');
  invitationsEl.replaceChildren();
  if (!invitations.length) emptyMessage(invitationsEl, 'Nenhum convite para salas.');
  for (const invitation of invitations) {
    const row = node('div', 'invite-row');
    const info = node('div', 'person-info');
    info.append(node('strong', '', invitation.fromName), node('small', '', 'Convidou você para uma sala'));
    row.append(info, actionButton('Entrar', 'positive', async () => {
      await enterRoom(invitation.roomId);
      await del(`/invites/${invitation.id}`);
      await refreshSocial();
    }));
    row.append(actionButton('×', '', async () => {
      await del(`/invites/${invitation.id}`);
      await refreshSocial();
    }, 'Ignorar convite'));
    invitationsEl.append(row);
  }
}

function socketEmit(eventName, payload = {}, timeout = 9000) {
  return new Promise((resolve, reject) => {
    if (!state.socket?.connected) return reject(new Error('Servidor desconectado. Tente novamente.'));
    state.socket.timeout(timeout).emit(eventName, payload, (err, result) => {
      if (err) return reject(new Error('O servidor não respondeu.'));
      if (result?.error) return reject(new Error(result.error));
      resolve(result || {});
    });
  });
}
function connectSocket() {
  if (!state.socket) {
    const socket = io({ autoConnect: false });
    state.socket = socket;
    socket.on('data:refresh', refreshSocial);
    socket.on('room:presence', people => {
      if (!state.room) return;
      state.participants = people;
      renderParticipants();
    });
    socket.on('share:started', ({ socketId, displayName }) => {
      if (!state.room) return;
      state.activeSharerId = socketId;
      renderVideoState();
      renderParticipants();
      if (socketId !== socket.id) {
        notify(`${displayName} começou a compartilhar a tela.`, 'success');
        socket.emit('viewer:ready');
      }
    });
    socket.on('share:stopped', ({ socketId }) => {
      if (!state.room || state.activeSharerId !== socketId) return;
      state.activeSharerId = null;
      if (socketId === socket.id && state.localStream) disposeLocalStream();
      clearPeers();
      resetRemoteVideo();
      renderVideoState();
      renderParticipants();
    });
    socket.on('viewer:ready', async ({ socketId }) => {
      if (!state.localStream || state.activeSharerId !== socket.id) return;
      try { await makeOffer(socketId); } catch (err) { console.warn('Falha na oferta WebRTC:', err); }
    });
    socket.on('signal:offer', async ({ from, data }) => {
      if (!state.room || state.activeSharerId !== from) return;
      try {
        const pc = createPeer(from);
        await pc.setRemoteDescription(data);
        await flushCandidates(from, pc);
        const answer = await pc.createAnswer();
        await pc.setLocalDescription(answer);
        socket.emit('signal:answer', { to: from, data: pc.localDescription.toJSON() });
      } catch (err) { console.warn('Falha ao receber oferta:', err); notify('Falha ao conectar à tela compartilhada.', 'error'); }
    });
    socket.on('signal:answer', async ({ from, data }) => {
      const pc = state.peers.get(from);
      if (!pc || pc.signalingState !== 'have-local-offer') return;
      try { await pc.setRemoteDescription(data); await flushCandidates(from, pc); }
      catch (err) { console.warn('Falha na resposta WebRTC:', err); }
    });
    socket.on('signal:ice', async ({ from, data }) => {
      if (!state.room) return;
      const pc = state.peers.get(from);
      if (pc?.remoteDescription) {
        try { await pc.addIceCandidate(data); } catch (err) { console.warn('Candidato ICE ignorado:', err); }
      } else {
        const pending = state.pendingIce.get(from) || [];
        if (pending.length < 100) pending.push(data);
        state.pendingIce.set(from, pending);
      }
    });
    socket.on('peer:left', ({ socketId }) => {
      closePeer(socketId);
      if (state.activeSharerId === socketId) {
        state.activeSharerId = null;
        resetRemoteVideo();
        renderVideoState();
      }
    });
    socket.on('room:closed', () => {
      if (!state.room) return;
      leaveRoom({ notifyServer: false });
      notify('A sala foi encerrada por quem a criou, ou expirou.', 'info');
    });
    socket.on('disconnect', () => {
      if (!state.room) return;
      // A conexão de sinalização pode cair ao minimizar a janela ou trocar de rede.
      // Preservar a captura: desligar as tracks aqui faria o usuário autorizar a tela novamente.
      clearPeers();
      resetRemoteVideo();
      state.activeSharerId = null;
      renderVideoState();
      notify('Conexão temporariamente interrompida. Tentando restaurar a transmissão...', 'info');
    });
    socket.on('connect', async () => {
      if (!state.room) return;
      const roomId = state.room.id;
      const reconnectVersion = state.joinVersion;
      try {
        const result = await socketEmit('room:join', { roomId });
        if (!state.room || state.room.id !== roomId || state.joinVersion !== reconnectVersion) return;
        const videoTrack = state.localStream?.getVideoTracks()[0];
        if (state.localStream && videoTrack?.readyState === 'live') {
          // O socket tem um novo ID. Reanunciar a transmissão permite que os
          // espectadores restabeleçam as conexões WebRTC sem novo getDisplayMedia().
          const started = await socketEmit('share:start');
          if (!state.room || state.room.id !== roomId || state.joinVersion !== reconnectVersion) return;
          if (!started.ok) throw new Error('Não foi possível retomar a transmissão.');
          state.activeSharerId = socket.id;
          notify('Transmissão reconectada.', 'success');
        } else {
          if (state.localStream) disposeLocalStream();
          state.activeSharerId = result.sharerId;
          if (result.sharerId && result.sharerId !== socket.id) socket.emit('viewer:ready');
        }
        renderVideoState();
      } catch (err) {
        if (!state.room || state.room.id !== roomId || state.joinVersion !== reconnectVersion) return;
        reportError(err);
        // Não prender a interface num estado 'ao vivo' se a sala não aceitar o rejoin.
        leaveRoom({ notifyServer: false });
      }
    });
  }
  if (state.socket.connected) return Promise.resolve(state.socket);
  if (state.connecting) return state.connecting;
  state.connecting = new Promise((resolve, reject) => {
    const socket = state.socket;
    const timeout = setTimeout(() => { clean(); reject(new Error('Falha ao conectar com o servidor.')); }, 8000);
    function clean() { clearTimeout(timeout); socket.off('connect', success); socket.off('connect_error', failed); }
    function success() { clean(); resolve(socket); }
    function failed() { clean(); reject(new Error('Não foi possível conectar à plataforma.')); }
    socket.once('connect', success);
    socket.once('connect_error', failed);
    socket.connect();
  }).finally(() => { state.connecting = null; });
  return state.connecting;
}
function closePeer(id) {
  const pc = state.peers.get(id);
  if (pc) { pc.ontrack = null; pc.onicecandidate = null; pc.close(); }
  state.peers.delete(id);
  state.pendingIce.delete(id);
  state.lastStats = null;
}
function clearPeers() {
  for (const id of [...state.peers.keys()]) closePeer(id);
  state.pendingIce.clear();
}
async function flushCandidates(id, pc) {
  const pending = state.pendingIce.get(id) || [];
  state.pendingIce.delete(id);
  for (const candidate of pending) {
    try { await pc.addIceCandidate(candidate); } catch (err) { console.warn('ICE:', err); }
  }
}
function createPeer(id) {
  if (state.peers.has(id)) closePeer(id);
  const pc = new RTCPeerConnection({ iceServers: state.config.iceServers, iceCandidatePoolSize: 2 });
  state.peers.set(id, pc);
  pc.onicecandidate = event => {
    if (event.candidate && state.socket?.connected)
      state.socket.emit('signal:ice', { to: id, data: event.candidate.toJSON() });
  };
  pc.ontrack = event => {
    const stream = event.streams[0] || new MediaStream([event.track]);
    const video = $('remoteVideo');
    if (video.srcObject !== stream) video.srcObject = stream;
    video.muted = true;
    video.play().catch(() => {});
    show($('playAudioButton'), stream.getAudioTracks().length > 0);
    renderVideoState();
  };
  let warned = false;
  pc.onconnectionstatechange = () => {
    if (pc.connectionState === 'failed' && !warned) {
      warned = true;
      notify('Conexão de vídeo falhou. Redes restritivas podem exigir servidor TURN.', 'error');
    }
  };
  return pc;
}
async function configureVideoSender(sender) {
  try {
    const preset = PRESETS[state.preset];
    const params = sender.getParameters();
    if (!params.encodings?.length) params.encodings = [{}];
    params.encodings[0].maxBitrate = preset.bitrate;
    params.encodings[0].maxFramerate = preset.fps;
    params.degradationPreference = preset.fps === 30 ? 'maintain-resolution' : 'balanced';
    await sender.setParameters(params);
  } catch (err) { console.warn('O navegador não aceitou algum ajuste de encoding:', err); }
}
async function makeOffer(viewerId) {
  if (!state.localStream || !state.room || !state.socket?.connected) return;
  const pc = createPeer(viewerId);
  for (const track of state.localStream.getTracks()) {
    const sender = pc.addTrack(track, state.localStream);
    if (track.kind === 'video') configureVideoSender(sender);
  }
  const offer = await pc.createOffer();
  await pc.setLocalDescription(offer);
  state.socket.emit('signal:offer', { to: viewerId, data: pc.localDescription.toJSON() });
}
function resetRemoteVideo() {
  const video = $('remoteVideo');
  video.srcObject = null;
  video.muted = true;
  show($('playAudioButton'), false);
}
function disposeLocalStream() {
  const stream = state.localStream;
  state.localStream = null;
  if (!stream) return;
  for (const track of stream.getTracks()) { track.onended = null; track.stop(); }
  $('localVideo').srcObject = null;
}
async function startShare() {
  if (!state.room || state.localStream) return;
  if (state.activeSharerId && state.activeSharerId !== state.socket.id)
    return notify('Alguém já está compartilhando nesta sala.', 'error');
  if (!navigator.mediaDevices?.getDisplayMedia)
    return notify('Seu navegador não permite capturar tela aqui. Use HTTPS ou localhost em um computador.', 'error');
  const button = $('startShareButton');
  button.disabled = true;
  let stream;
  try {
    const preset = PRESETS[state.preset];
    stream = await navigator.mediaDevices.getDisplayMedia({
      video: {
        width: { ideal: preset.width, max: preset.width },
        height: { ideal: preset.height, max: preset.height },
        frameRate: { ideal: preset.fps, max: preset.fps }
      },
      audio: state.audio,
      systemAudio: state.audio ? 'include' : 'exclude',
      surfaceSwitching: 'include',
      selfBrowserSurface: 'exclude'
    });
    if (!state.room || !state.socket?.connected) throw new Error('Você saiu da sala antes de iniciar.');
    const result = await socketEmit('share:start');
    if (!result.ok) throw new Error('Não foi possível iniciar a transmissão.');
    state.localStream = stream;
    const videoTrack = stream.getVideoTracks()[0];
    if (videoTrack) {
      videoTrack.contentHint = preset.fps >= 60 ? 'motion' : 'detail';
      videoTrack.onended = () => stopShare();
    }
    $('localVideo').srcObject = stream;
    $('localVideo').play().catch(() => {});
    state.activeSharerId = state.socket.id;
    state.lastStats = null;
    renderVideoState();
    if (state.audio && stream.getAudioTracks().length === 0)
      notify('O navegador não disponibilizou áudio da fonte selecionada. A tela continua sendo transmitida.', 'info');
    notify('Sua tela está sendo compartilhada.', 'success');
  } catch (err) {
    if (stream) for (const track of stream.getTracks()) track.stop();
    if (err.name === 'NotAllowedError') notify('Captura cancelada. Você precisa escolher e autorizar uma tela.', 'info');
    else reportError(err);
  } finally { button.disabled = false; }
}
function stopShare() {
  if (!state.localStream) return;
  disposeLocalStream();
  clearPeers();
  if (state.socket?.connected) state.socket.emit('share:stop', {});
  state.activeSharerId = null;
  renderVideoState();
}
function renderVideoState() {
  const selfSharing = !!state.localStream;
  const otherSharing = !selfSharing && !!state.activeSharerId && state.activeSharerId !== state.socket?.id;
  const playingRemote = otherSharing && !!$('remoteVideo').srcObject;
  show($('localVideo'), selfSharing);
  show($('remoteVideo'), playingRemote);
  show($('videoPlaceholder'), !selfSharing && !playingRemote);
  show($('startShareButton'), !selfSharing && !otherSharing);
  show($('stopShareButton'), selfSharing);
  $('startShareButton').disabled = !state.room || !!state.activeSharerId;
  $('qualityPreset').disabled = otherSharing;
  $('shareAudio').disabled = selfSharing || otherSharing;
  $('roomLiveDot').classList.toggle('on', selfSharing || otherSharing);
  $('roomLiveText').textContent = selfSharing ? 'Transmitindo' : otherSharing ? 'Assistindo' : 'Aguardando';
  $('videoStageStatus').textContent = selfSharing ? 'SUA TRANSMISSÃO' : otherSharing ? 'TELA COMPARTILHADA' : 'EM ESPERA';
  $('roomLiveBadge').textContent = selfSharing || otherSharing ? 'AO VIVO' : 'PRIVADA';
  $('placeholderTitle').textContent = otherSharing ? 'Conectando à transmissão...' : 'A tela está em branco.';
  $('placeholderSubtitle').textContent = otherSharing ? 'Estabelecendo conexão criptografada entre os participantes.' : 'Escolha as opções abaixo e comece a transmitir.';
  $('qualityNote').textContent = selfSharing ? 'Você pode alterar a qualidade durante a transmissão; o resultado depende do navegador e da rede.' :
    otherSharing ? 'Há uma transmissão ativa. Aguarde até que ela termine para compartilhar sua própria tela.' :
    'Selecione resolução e FPS. A captura real depende do navegador, da fonte e da rede.';
  if (!selfSharing && !otherSharing) clearStats();
}
async function changePreset(presetName) {
  if (!PRESETS[presetName]) return;
  const oldPreset = state.preset;
  state.preset = presetName;
  if (!state.localStream) return;
  const preset = PRESETS[presetName];
  const track = state.localStream.getVideoTracks()[0];
  if (!track) return;
  try {
    await track.applyConstraints({ width: { ideal: preset.width, max: preset.width }, height: { ideal: preset.height, max: preset.height }, frameRate: { ideal: preset.fps, max: preset.fps } });
    track.contentHint = preset.fps >= 60 ? 'motion' : 'detail';
    await Promise.all([...state.peers.values()].flatMap(pc => pc.getSenders().filter(s => s.track?.kind === 'video').map(configureVideoSender)));
    state.lastStats = null;
    notify('Nova qualidade solicitada ao navegador.', 'success');
  } catch (err) {
    state.preset = oldPreset;
    $('qualityPreset').value = oldPreset;
    reportError(new Error('O navegador não permitiu essa mudança. Pare e inicie novamente para tentar.'));
  }
}
function clearStats() {
  $('statResolution').textContent = '—';
  $('statFps').textContent = '—';
  $('statBitrate').textContent = '—';
  state.lastStats = null;
}
async function updateStats() {
  if (!state.room) return;
  const video = state.localStream ? $('localVideo') : $('remoteVideo');
  const settings = state.localStream?.getVideoTracks()[0]?.getSettings();
  const width = settings?.width || video.videoWidth;
  const height = settings?.height || video.videoHeight;
  $('statResolution').textContent = width && height ? `${width}×${height}` : '—';
  $('statFps').textContent = settings?.frameRate ? `${Math.round(settings.frameRate)}` : '—';
  const pc = state.peers.values().next().value;
  if (!pc || pc.connectionState === 'closed') { $('statBitrate').textContent = '—'; return; }
  try {
    const stats = await pc.getStats();
    const target = [...stats.values()].find(s =>
      (s.type === (state.localStream ? 'outbound-rtp' : 'inbound-rtp')) &&
      (s.kind === 'video' || s.mediaType === 'video') && !s.isRemote);
    if (!target) return;
    if (typeof target.framesPerSecond === 'number') $('statFps').textContent = `${Math.round(target.framesPerSecond)}`;
    const bytes = state.localStream ? target.bytesSent : target.bytesReceived;
    if (Number.isFinite(bytes) && state.lastStats && state.lastStats.pc === pc) {
      const deltaTime = (target.timestamp - state.lastStats.time) / 1000;
      const deltaBytes = bytes - state.lastStats.bytes;
      if (deltaTime > 0 && deltaBytes >= 0) $('statBitrate').textContent = `${(deltaBytes * 8 / deltaTime / 1_000_000).toFixed(2)} Mb/s`;
    }
    state.lastStats = { pc, time: target.timestamp, bytes };
  } catch { /* Estatísticas não são obrigatórias para compartilhar */ }
}
function renderParticipants() {
  const container = $('participantsList');
  container.replaceChildren();
  $('statParticipants').textContent = String(state.participants.length);
  for (const person of state.participants) {
    const chip = node('div', 'participant-chip');
    chip.append(node('i', '', '●'), node('span', '', person.displayName));
    if (person.socketId === state.activeSharerId) chip.append(node('strong', 'chip-live', 'TELA'));
    if (person.socketId === state.socket?.id) chip.append(node('span', '', '(você)'));
    container.append(chip);
  }
}
async function enterRoom(roomId) {
  const version = ++state.joinVersion;
  if (state.room?.id === roomId) return;
  const { room } = await api(`/rooms/${encodeURIComponent(roomId)}`);
  await connectSocket();
  if (version !== state.joinVersion) return;
  if (state.room) leaveRoom();
  state.room = room;
  state.participants = [];
  state.activeSharerId = null;
  try {
    const result = await socketEmit('room:join', { roomId: room.id });
    if (!result.ok) throw new Error('Não foi possível entrar na sala.');
    state.activeSharerId = result.sharerId;
    show($('homePanel'), false);
    show($('roomPanel'), true);
    show($('closeRoomButton'), state.me.id === room.creatorId);
    $('roomLink').value = `${location.origin}${location.pathname}?room=${encodeURIComponent(room.id)}`;
    $('maxParticipants').textContent = state.config.maxParticipants;
    setRoomInAddress(room.id);
    renderVideoState();
    renderSocial();
    if (result.sharerId && result.sharerId !== state.socket.id) state.socket.emit('viewer:ready');
    window.scrollTo({ top: 0, behavior: 'auto' });
  } catch (err) {
    state.room = null;
    throw err;
  }
}
function leaveRoom({ notifyServer = true } = {}) {
  ++state.joinVersion;
  if (state.localStream) stopShare();
  clearPeers();
  resetRemoteVideo();
  if (notifyServer && state.socket?.connected) state.socket.emit('room:leave', {});
  state.room = null;
  state.participants = [];
  state.activeSharerId = null;
  clearStats();
  show($('roomPanel'), false);
  show($('homePanel'), true);
  setRoomInAddress(null);
  if (state.me && !state.me.guest) renderSocial();
  window.scrollTo({ top: 0, behavior: 'auto' });
}
async function afterAuth(user) {
  state.me = user;
  showApp();
  try { state.config = await api('/config'); } catch { /* fallback STUN */ }
  await connectSocket();
  if (!user.guest) await refreshSocial();
  const invite = new URL(location.href).searchParams.get('room');
  if (invite) {
    try { await enterRoom(invite); }
    catch (err) { reportError(err); setRoomInAddress(null); }
  }
  if (!state.statsTimer) state.statsTimer = setInterval(updateStats, 2200);
}
async function logOut() {
  if (state.room) leaveRoom();
  try { await post('/auth/logout'); } catch (err) { reportError(err); }
  state.socket?.disconnect();
  state.socket = null;
  state.me = null;
  state.connecting = null;
  state.social = { friends: [], incoming: [], outgoing: [], invitations: [] };
  clearInterval(state.statsTimer);
  state.statsTimer = null;
  showAuth();
  setAuthTab('login');
}
async function boot() {
  $('qualityPreset').value = state.preset;
  document.querySelectorAll('[data-auth-tab]').forEach(button =>
    button.addEventListener('click', () => setAuthTab(button.dataset.authTab)));
  for (const [id, endpoint, map] of [
    ['loginForm', '/auth/login', data => ({ identity: data.get('identity'), password: data.get('password') })],
    ['registerForm', '/auth/register', data => ({ username: data.get('username'), email: data.get('email'), password: data.get('password') })],
    ['guestForm', '/auth/guest', data => ({ displayName: data.get('displayName') })]
  ]) {
    $(id).addEventListener('submit', async event => {
      event.preventDefault();
      const form = event.currentTarget;
      formSubmitLock(form, true);
      try {
        const response = await post(endpoint, map(new FormData(form)));
        form.reset();
        await afterAuth(response.user);
      } catch (err) { reportError(err); }
      finally { formSubmitLock(form, false); }
    });
  }
  $('logoutButton').addEventListener('click', logOut);
  $('guestUpgrade').addEventListener('click', async () => { await logOut(); setAuthTab('register'); });
  $('friendSearchForm').addEventListener('submit', async event => {
    event.preventDefault();
    const username = $('friendUsername').value.trim();
    if (!username) return;
    try {
      await post('/friends/requests', { username });
      $('friendUsername').value = '';
      await refreshSocial();
      notify(`Pedido enviado para @${username}.`, 'success');
    } catch (err) { reportError(err); }
  });
  $('createRoomButton').addEventListener('click', async () => {
    $('createRoomButton').disabled = true;
    try {
      const { room } = await post('/rooms');
      await enterRoom(room.id);
      notify('Sala criada! Copie o link para convidar alguém.', 'success');
    } catch (err) { reportError(err); }
    finally { $('createRoomButton').disabled = false; }
  });
  $('backButton').addEventListener('click', () => leaveRoom());
  $('closeRoomButton').addEventListener('click', async () => {
    if (!state.room || !confirm('Encerrar esta sala para todas as pessoas?')) return;
    try { await del(`/rooms/${state.room.id}`); if (state.room) leaveRoom({ notifyServer: false }); }
    catch (err) { reportError(err); }
  });
  $('copyLinkButton').addEventListener('click', async () => {
    try { await navigator.clipboard.writeText($('roomLink').value); notify('Link copiado para a área de transferência!', 'success'); }
    catch { $('roomLink').focus(); $('roomLink').select(); notify('Copie o link selecionado (Ctrl+C).'); }
  });
  $('startShareButton').addEventListener('click', startShare);
  $('stopShareButton').addEventListener('click', stopShare);
  $('qualityPreset').addEventListener('change', event => changePreset(event.target.value));
  $('shareAudio').addEventListener('change', event => { state.audio = event.target.checked; });
  $('playAudioButton').addEventListener('click', async () => {
    const video = $('remoteVideo');
    video.muted = false;
    try { await video.play(); show($('playAudioButton'), false); }
    catch { notify('Não foi possível ativar o áudio. Verifique as permissões do navegador.', 'error'); }
  });
  $('fullscreenButton').addEventListener('click', async () => {
    try {
      if (document.fullscreenElement) await document.exitFullscreen();
      else await $('videoStage').requestFullscreen();
    } catch { notify('O navegador não permitiu usar tela cheia.', 'error'); }
  });
  window.addEventListener('beforeunload', () => {
    if (state.localStream) for (const track of state.localStream.getTracks()) track.stop();
  });
  try {
    const response = await api('/me');
    if (response.user) await afterAuth(response.user);
    else showAuth();
  } catch (err) { showAuth(); reportError(err); }
}
boot();

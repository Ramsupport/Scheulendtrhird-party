/* ═══════════════════════════════════════════
   TOKEN MANAGEMENT MASTER SYSTEM — v2
   Frontend JS: API · Socket.IO · UI Logic
════════════════════════════════════════════ */

// ── STATE ───────────────────────────────────
let currentUser     = null;
let currentTokenTab = 'active';
let currentChannel  = null;
let currentDmUser   = null;
let allChannels     = [];
let allUsers        = [];
let chUnreads       = {};
let dmUnreads       = {};
let refreshSecs     = 1800;
let refreshTimer    = null;
let socket          = null;
const SIDEBAR_IDS   = { discussion: 'discussion-sidebar', messages: 'messages-sidebar' };
let tokenCache      = {}; // id → token object, used by edit modal

// ── PAYMENT ALLOCATION STATE ─────────────────
// Loaded after login and refreshed after any allocation change.
// Shape: { [token_id]: { total_paid: number, is_fully_paid: boolean } }
let tokenPaidStatus = {};

// ── API ─────────────────────────────────────
async function api(method, path, body) {
  const opts = { method, headers: {'Content-Type':'application/json'}, credentials:'include' };
  if (body) opts.body = JSON.stringify(body);
  const res = await fetch('/api' + path, opts);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || 'Request failed');
  return data;
}
async function apiUpload(path, formData) {
  const res = await fetch('/api' + path, { method:'POST', body:formData, credentials:'include' });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || 'Upload failed');
  return data;
}

// ── AUTH ────────────────────────────────────
async function doLogin() {
  const btn      = document.getElementById('login-btn');
  const username = document.getElementById('login-user').value.trim();
  const password = document.getElementById('login-pass').value;
  const errEl    = document.getElementById('auth-error');
  errEl.style.display = 'none';
  btn.textContent = 'Signing in…';
  btn.disabled = true;
  try {
    const d = await api('POST', '/auth/login', { username, password });
    currentUser = d.user;
    onLoginSuccess();
  } catch(err) {
    errEl.textContent = err.message;
    errEl.style.display = 'block';
  } finally {
    btn.textContent = 'Sign In  →';
    btn.disabled = false;
  }
}

async function doLogout() {
  await api('POST', '/auth/logout').catch(() => {});
  currentUser     = null;
  currentChannel  = null;
  currentDmUser   = null;
  allChannels     = [];
  allUsers        = [];
  chUnreads       = {};
  dmUnreads       = {};
  tokenPaidStatus = {};
  if (socket) { socket.disconnect(); socket = null; }
  clearInterval(refreshTimer);
  refreshTimer = null;
  document.getElementById('tab-admin').style.display = 'none';
  payScreenshotFile = null;
  const kycBanners = document.getElementById('kyc-banners');
  if (kycBanners) kycBanners.innerHTML = '';
  document.getElementById('tab-settings').classList.remove('active');
  document.getElementById('tab-about').classList.remove('active');
  document.getElementById('tab-tracker').classList.add('active');
  document.querySelectorAll('.panel').forEach(p => p.classList.remove('active'));
  document.getElementById('panel-tracker').classList.add('active');
  document.getElementById('auth-screen').style.display = 'flex';
  document.getElementById('app').style.display = 'none';
  document.getElementById('login-pass').value = '';
  document.getElementById('auth-error').style.display = 'none';
}

async function checkSession() {
  try {
    currentUser = await api('GET', '/auth/me');
    onLoginSuccess();
  } catch(_) {
    document.getElementById('auth-screen').style.display = 'flex';
  }
}

function onLoginSuccess() {
  const isAdmin = currentUser.role === 'admin';

  document.getElementById('auth-screen').style.display = 'none';
  document.getElementById('app').style.display = 'block';

  document.getElementById('nav-avatar').textContent = currentUser.name[0].toUpperCase();
  document.getElementById('nav-name').textContent   = currentUser.name;
  document.getElementById('nav-role').textContent   = currentUser.role.toUpperCase();

  document.getElementById('tab-admin').style.display = isAdmin ? 'flex' : 'none';

  const newChBtn = document.getElementById('new-channel-btn');
  if (newChBtn) newChBtn.style.display = isAdmin ? 'flex' : 'none';

  const filterAgent = document.getElementById('filter-agent');
  if (filterAgent) filterAgent.style.display = isAdmin ? 'block' : 'none';

  const dmPickMsg = document.getElementById('dm-pick-msg');
  if (dmPickMsg) dmPickMsg.textContent = isAdmin
    ? 'Select a conversation to start messaging'
    : 'Your conversation with Admin';

  document.querySelectorAll('.panel').forEach(p => p.classList.remove('active'));
  document.querySelectorAll('.nav-tab').forEach(t => t.classList.remove('active'));
  document.getElementById('panel-tracker').classList.add('active');
  document.getElementById('tab-tracker').classList.add('active');

  const kycContainer = document.getElementById('kyc-banners');
  if (kycContainer) kycContainer.innerHTML = '';

  syncMobileUser();
  initSocket();
  loadUsers().then(() => {
    // Load paid status alongside tokens so badges show on first render
    loadTokenPaidStatus().then(() => loadTokens());
    loadChannels().then(() => {
      if (allChannels.length) selectChannel(allChannels[0]);
    });
    loadDmConversations();
    if (isAdmin) { loadAdminSummary(); loadAdminUsers(); }
  });
  startRefreshTimer();
}

document.getElementById('login-pass').addEventListener('keydown', e => {
  if (e.key === 'Enter') doLogin();
});

// ── SOCKET ──────────────────────────────────
function initSocket() {
  socket = io({ withCredentials: true });

  socket.on('new_message', msg => {
    if (currentChannel && msg.channel_id == currentChannel.id) {
      const author = allUsers.find(u => u.id == msg.author_id);
      appendMsg('messages-area', { ...msg, author_color: author?.color || 'var(--teal)' });
      scrollEl('messages-area');
    } else {
      chUnreads[msg.channel_id] = (chUnreads[msg.channel_id] || 0) + 1;
      renderChannelList();
      updateNavBadges();
    }
  });

  socket.on('dm_message', msg => {
    if (currentDmUser && buildDmKey(currentUser.id, currentDmUser.id) === msg.dm_key) {
      const author = allUsers.find(u => u.id == msg.sender_id);
      msg = { ...msg, author_color: author?.color || 'var(--teal)' };
      appendMsg('dm-messages-area', msg);
      scrollEl('dm-messages-area');
    }
  });

  socket.on('new_token', (token) => {
    if (!currentUser || currentUser.role !== 'admin') return;
    playNotifSound();
    showToast(`🎫 New token ${token.token_ref} added by ${token.author_name}`, 'success');
    if (document.getElementById('panel-tracker').classList.contains('active')) {
      loadTokens();
    }
  });

  socket.on('message_deleted', ({ message_id }) => {
    const el = document.querySelector(`.msg-row[data-msg-id="${message_id}"]`);
    if (el) el.remove();
  });

  socket.on('dm_notification', data => {
    if (!currentDmUser || currentDmUser.id !== data.from_id) {
      dmUnreads[data.from_id] = (dmUnreads[data.from_id] || 0) + 1;
      loadDmConversations();
      updateNavBadges();
    }
  });

  socket.on('kyc_uploaded', data => {
    showKycBanner(data);
    loadTokens();
  });
}

function buildDmKey(a, b) { return [a, b].sort((x,y) => x-y).join(':'); }

// ── PANEL SWITCH ────────────────────────────
function switchPanel(name) {
  document.querySelectorAll('.panel').forEach(p => p.classList.remove('active'));
  document.querySelectorAll('.nav-tab').forEach(t => t.classList.remove('active'));
  document.getElementById('panel-' + name).classList.add('active');
  document.getElementById('tab-' + name).classList.add('active');
  if (name === 'discussion') {
    if (currentChannel) { chUnreads[currentChannel.id] = 0; renderChannelList(); updateNavBadges(); }
    setTimeout(() => scrollEl('messages-area'), 80);
  }
  if (name === 'messages') {
    loadDmConversations();
    if (currentUser.role === 'agent') {
      const admin = allUsers.find(u => u.role === 'admin');
      if (admin) openDm(admin);
    }
  }
  if (name === 'admin')    { loadAdminSummary(); loadAdminUsers(); }
  if (name === 'settings') { initSettings(); }
  if (name === 'payments') { initPayments(); }
  syncMobileNav(name);
  closeMobileSidebar();
}

// ── TOKEN TRACKER ────────────────────────────
function playNotifSound() {
  try {
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    [[880, 0, 0.12], [660, 0.15, 0.18]].forEach(([freq, start, end]) => {
      const osc  = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.connect(gain); gain.connect(ctx.destination);
      osc.type = 'sine';
      osc.frequency.value = freq;
      gain.gain.setValueAtTime(0, ctx.currentTime + start);
      gain.gain.linearRampToValueAtTime(0.25, ctx.currentTime + start + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + end);
      osc.start(ctx.currentTime + start);
      osc.stop(ctx.currentTime + end + 0.05);
    });
  } catch(_) {}
}

async function addToken() {
  const details = document.getElementById('token-details').value.trim();
  const charge  = 0;
  if (!details) { showToast('Please enter token details', 'error'); return; }
  try {
    await api('POST', '/tokens', { details, charge });
    document.getElementById('token-details').value = '';
    showToast('Token added successfully!', 'success');
    loadTokens();
  } catch(err) { showToast(err.message, 'error'); }
}

async function loadTokens() {
  const from   = document.getElementById('filter-from').value;
  const to     = document.getElementById('filter-to').value;
  const agEl   = document.getElementById('filter-agent');
  const agent  = agEl.style.display !== 'none' ? agEl.value : '';
  const search = document.getElementById('filter-search').value;

  document.getElementById('token-loading').style.display = 'block';
  document.getElementById('token-empty').style.display   = 'none';
  document.getElementById('token-tbody').innerHTML = '';
  try {
    const p = new URLSearchParams();
    if (from)   p.set('from', from);
    if (to)     p.set('to', to);
    if (agent)  p.set('author_id', agent);
    if (search) p.set('search', search);
    const tokens = await api('GET', '/tokens?' + p);
    // Refresh paid status silently so badges are always current
    await loadTokenPaidStatus();
    renderTokenTable(tokens);
  } catch(err) { showToast('Failed to load: ' + err.message, 'error'); }
  finally { document.getElementById('token-loading').style.display = 'none'; }
}

// ── PAID STATUS ──────────────────────────────
async function loadTokenPaidStatus() {
  try {
    const map = await api('GET', '/payments/token-paid-status');
    tokenPaidStatus = map || {};
  } catch(_) { tokenPaidStatus = {}; }
}

// Returns HTML badge string for a token's charge cell
function renderTokenBadge(tokenId, charge) {
  const ps = tokenPaidStatus[tokenId];
  if (!ps || ps.total_paid <= 0) return '';
  if (ps.is_fully_paid) {
    return `<span class="paid-badge">Paid</span>`;
  }
  const outstanding = (parseFloat(charge) - ps.total_paid).toFixed(2);
  return `<span class="partial-paid-badge">₹${outstanding} due</span>`;
}

function renderTokenTable(tokens) {
  const active    = tokens.filter(t => t.status === 'active');
  const completed = tokens.filter(t => t.status === 'completed');
  const display   = currentTokenTab === 'active' ? active : completed;

  document.getElementById('count-active').textContent    = active.length;
  document.getElementById('count-completed').textContent = completed.length;
  document.getElementById('stat-active').textContent     = active.length;
  document.getElementById('stat-completed').textContent  = completed.length;

  // Total Due = completed charges minus what has already been paid
  const totalDue = completed.reduce((s, t) => {
    const paid = tokenPaidStatus[t.id]?.total_paid || 0;
    return s + Math.max(0, parseFloat(t.charge || 0) - paid);
  }, 0);

  const today = new Date().toDateString();
  const todayCount = tokens.filter(t => new Date(t.created_at).toDateString() === today).length;
  document.getElementById('stat-today').textContent = todayCount;

  const tbody  = document.getElementById('token-tbody');
  const empty  = document.getElementById('token-empty');
  const isAdmin = currentUser.role === 'admin';

  if (!display.length) { tbody.innerHTML = ''; empty.style.display = 'block'; return; }
  empty.style.display = 'none';

  display.forEach(t => { tokenCache[t.id] = t; });

  tbody.innerHTML = display.map(t => {
    const date    = new Date(t.created_at).toLocaleString('en-IN', { timeZone:'Asia/Kolkata', day:'2-digit', month:'short', year:'numeric', hour:'2-digit', minute:'2-digit' });
    const isOwn   = currentUser.id == t.author_id;
    const canEdit = isOwn || isAdmin;

    // KYC column
    let kycCell = '';
    if (isAdmin && t.status === 'completed') {
      kycCell = t.kyc_image_url
        ? `<img src="${t.kyc_image_url}" class="kyc-thumb" onclick="openLightbox('${t.kyc_image_url}')" title="View KYC Document">
           <button class="act-btn act-delete" style="margin-top:5px;font-size:10px" onclick="removeKyc(${t.id})">Remove</button>`
        : `<label class="kyc-upload-label" id="kyc-label-${t.id}">📎 Upload KYC<input type="file" accept="image/*" style="display:none" onchange="uploadKyc(${t.id},this)"></label>`;
    } else if (!isAdmin) {
      kycCell = t.kyc_image_url
        ? `<img src="${t.kyc_image_url}" class="kyc-thumb" onclick="openLightbox('${t.kyc_image_url}')" title="View your KYC document"><span class="kyc-badge">✅ KYC Verified</span>`
        : `<span style="font-size:12px;color:var(--text-3)">—</span>`;
    } else {
      kycCell = `<span style="font-size:11px;color:var(--gold)">⏳ Pending</span>`;
    }

    const completeBtn = isAdmin
      ? (t.status === 'active'
        ? `<button class="act-btn act-complete" onclick="updateTokenStatus(${t.id},'completed')">✓ Complete</button>`
        : `<button class="act-btn act-reactivate" onclick="updateTokenStatus(${t.id},'active')">↩ Reactivate</button>`)
      : '';
    const deleteBtn = canEdit ? `<button class="act-btn act-delete" onclick="deleteToken(${t.id})">🗑</button>` : '';
    const editBtn   = canEdit ? `<button class="act-btn" style="background:rgba(124,92,252,0.12);color:var(--violet);border:1px solid rgba(124,92,252,0.25)" onclick="openEditToken(${t.id})">✏️ Edit</button>` : '';

    return `<tr>
      <td class="cell-ref" data-label="Token">${t.token_ref}</td>
      <td class="cell-author" data-label="Agent">${escHtml(t.author_name)}</td>
      <td class="cell-date" data-label="Date">${date}</td>
      <td data-label="Details"><div class="cell-details">${escHtml(t.details)}</div></td>
      <td class="cell-charge" data-label="Charge">₹${parseFloat(t.charge||0).toFixed(2)}${renderTokenBadge(t.id, t.charge)}</td>
      <td data-label="KYC" style="min-width:110px">${kycCell}</td>
      <td style="white-space:nowrap">${editBtn}${completeBtn}${deleteBtn}</td>
    </tr>`;
  }).join('');
}

function switchTokenTab(tab) {
  currentTokenTab = tab;
  document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
  document.getElementById('ttab-' + tab).classList.add('active');
  loadTokens();
}

async function updateTokenStatus(id, status) {
  try {
    await api('PATCH', `/tokens/${id}/status`, { status });
    loadTokens();
    showToast(status === 'completed' ? '✅ Token marked complete' : '↩ Token reactivated');
  } catch(err) { showToast(err.message, 'error'); }
}

// ── EDIT TOKEN ──────────────────────────────
function openEditToken(tokenId) {
  const token = tokenCache[tokenId];
  if (!token) { showToast('Token not found — please refresh', 'error'); return; }
  document.getElementById('edit-token-id').value      = token.id;
  document.getElementById('edit-token-details').value = token.details;
  document.getElementById('edit-token-charge').value  = parseFloat(token.charge || 0).toFixed(2);
  document.getElementById('edit-token-modal').classList.add('open');
}

async function saveTokenEdit() {
  const id      = document.getElementById('edit-token-id').value;
  const details = document.getElementById('edit-token-details').value.trim();
  const charge  = document.getElementById('edit-token-charge').value;
  if (!details) { showToast('Details cannot be empty', 'error'); return; }
  try {
    await api('PATCH', `/tokens/${id}`, { details, charge });
    closeModal('edit-token-modal');
    showToast('✅ Token updated successfully!', 'success');
    loadTokens();
  } catch(err) { showToast(err.message, 'error'); }
}

async function deleteToken(id) {
  if (!confirm('Delete this token? This cannot be undone.')) return;
  try { await api('DELETE', `/tokens/${id}`); loadTokens(); showToast('Token deleted'); }
  catch(err) { showToast(err.message, 'error'); }
}

function clearFilters() {
  ['filter-from','filter-to','filter-search'].forEach(id => document.getElementById(id).value = '');
  const ag = document.getElementById('filter-agent');
  if (ag) ag.value = '';
  loadTokens();
}

function downloadReport(e) {
  e.preventDefault();
  const from  = document.getElementById('filter-from').value;
  const to    = document.getElementById('filter-to').value;
  const agEl  = document.getElementById('filter-agent');
  const agent = agEl.style.display !== 'none' ? agEl.value : '';
  const p = new URLSearchParams();
  if (from)  p.set('from', from);
  if (to)    p.set('to', to);
  if (agent) p.set('author_id', agent);
  p.set('status', currentTokenTab);
  window.location = '/api/tokens/export?' + p;
}

// ── KYC ─────────────────────────────────────
async function uploadKyc(tokenId, input) {
  const file = input.files[0];
  if (!file) return;
  const label = document.getElementById('kyc-label-' + tokenId);
  if (label) label.innerHTML = '<span style="font-size:11px;color:var(--text-2)">Uploading…</span>';
  try {
    const fd = new FormData();
    fd.append('kyc_image', file);
    await apiUpload(`/tokens/${tokenId}/kyc`, fd);
    showToast('🎉 KYC uploaded! Agent notified.', 'success');
    loadTokens();
  } catch(err) { showToast('Upload failed: ' + err.message, 'error'); loadTokens(); }
}

async function removeKyc(tokenId) {
  if (!confirm('Remove this KYC image?')) return;
  try { await api('DELETE', `/tokens/${tokenId}/kyc`); showToast('KYC removed'); loadTokens(); }
  catch(err) { showToast(err.message, 'error'); }
}

function openLightbox(url) {
  document.getElementById('kyc-lightbox-img').src = url;
  document.getElementById('kyc-lightbox').classList.add('open');
}

function showKycBanner(data) {
  if (!currentUser || currentUser.role === 'admin') return;
  const container = document.getElementById('kyc-banners');
  container.innerHTML = '';
  const banner = document.createElement('div');
  banner.className = 'kyc-banner';
  banner.innerHTML = `
    <div class="kyc-banner-icon">📄</div>
    <div style="flex:1">
      <div class="kyc-banner-title">KYC Document Ready — ${escHtml(data.token_ref)}</div>
      <div class="kyc-banner-sub">Admin has uploaded your KYC document. Tap to view.</div>
    </div>
    <div class="kyc-banner-cta">View →</div>
    <button onclick="event.stopPropagation();this.closest('.kyc-banner').remove()" style="background:none;border:none;color:var(--text-3);font-size:18px;cursor:pointer;padding:0 4px;margin-left:8px">✕</button>`;
  banner.onclick = () => { openLightbox(data.kyc_image_url); };
  container.appendChild(banner);
  showToast('📄 KYC document ready for ' + data.token_ref, 'success');
}

// ── REFRESH TIMER ────────────────────────────
function startRefreshTimer() {
  refreshSecs = 1800;
  clearInterval(refreshTimer);
  refreshTimer = setInterval(() => {
    refreshSecs--;
    if (refreshSecs <= 0) { refreshSecs = 1800; loadTokens(); }
    const m = Math.floor(refreshSecs/60), s = refreshSecs%60;
    const el = document.getElementById('refresh-timer');
    if (el) el.textContent = `${m}:${String(s).padStart(2,'0')}`;
  }, 1000);
}

// ── USERS ────────────────────────────────────
async function loadUsers() {
  try {
    allUsers = await api('GET', '/users');
    const sel = document.getElementById('filter-agent');
    if (sel) {
      sel.innerHTML = '<option value="">All Agents</option>';
      allUsers.forEach(u => {
        const o = document.createElement('option');
        o.value = u.id; o.textContent = u.name; sel.appendChild(o);
      });
    }
    renderTeamMembers();
  } catch(_) {}
}

function renderTeamMembers() {
  const el = document.getElementById('team-members');
  if (!el) return;
  el.innerHTML = allUsers.map(u => `
    <div class="member-row">
      <div class="member-dot" style="background:${u.id===currentUser.id?'var(--teal)':'var(--text-3)'}"></div>
      <span>${escHtml(u.name)}${u.id===currentUser.id?' <span style="color:var(--teal);font-size:10px">(you)</span>':''}</span>
    </div>`).join('');
}

// ── CHANNELS ─────────────────────────────────
async function loadChannels() {
  try { allChannels = await api('GET', '/channels'); renderChannelList(); } catch(_) {}
}

function renderChannelList() {
  const el = document.getElementById('channels-list');
  el.innerHTML = allChannels.map(ch => {
    const u = chUnreads[ch.id] || 0;
    const active = currentChannel && currentChannel.id === ch.id;
    return `<div class="sidebar-item ${active?'active':''}" onclick='selectChannel(${JSON.stringify(ch).replace(/'/g,"&#39;")})'>
      <span class="sidebar-item-icon">${ch.icon}</span>
      <span class="sidebar-item-name"># ${escHtml(ch.name)}</span>
      ${u>0?`<span class="sidebar-unread">${u}</span>`:''}
    </div>`;
  }).join('');
}

function selectChannel(ch) {
  closeMobileSidebar();
  if (typeof ch === 'string') ch = JSON.parse(ch);
  currentChannel = ch;
  chUnreads[ch.id] = 0;
  document.getElementById('chat-icon').textContent = ch.icon;
  document.getElementById('chat-name').textContent = '# ' + ch.name;
  document.getElementById('chat-desc').textContent = ch.description || '';
  document.getElementById('msg-input').placeholder = `Message #${ch.name}…`;
  if (socket) socket.emit('join_channel', ch.id);
  renderChannelList();
  updateNavBadges();
  loadChMessages(ch);
}

async function loadChMessages(ch) {
  const area = document.getElementById('messages-area');
  area.innerHTML = '<div class="empty-state"><span class="ei">⏳</span><p>Loading…</p></div>';
  try {
    const msgs = await api('GET', `/channels/${ch.id}/messages?limit=100`);
    renderMsgs('messages-area', msgs);
    setTimeout(() => scrollEl('messages-area'), 60);
  } catch(_) { area.innerHTML = '<div class="empty-state"><span class="ei">⚠️</span><p>Failed to load.</p></div>'; }
}

async function sendMessage() {
  const input = document.getElementById('msg-input');
  const text  = input.value.trim();
  if (!text || !currentChannel) return;
  input.value = ''; input.style.height = 'auto';
  try { await api('POST', `/channels/${currentChannel.id}/messages`, { text }); }
  catch(_) { showToast('Failed to send', 'error'); }
}

function handleMsgKey(e) { if (e.key==='Enter'&&!e.shiftKey){e.preventDefault();sendMessage();} }

// ── DIRECT MESSAGES ──────────────────────────
async function loadDmConversations() {
  try {
    const convs = await api('GET', '/dm/conversations');
    renderDmList(convs);
    convs.forEach(c => { if (parseInt(c.unread_count)>0) dmUnreads[c.id]=parseInt(c.unread_count); });
    updateNavBadges();
  } catch(_) {}
}

function renderDmList(convs) {
  const el = document.getElementById('dm-list');
  if (!convs.length) {
    el.innerHTML = '<div style="padding:16px;font-size:13px;color:var(--text-3)">No conversations yet.</div>';
    return;
  }
  el.innerHTML = convs.map(u => {
    const unread = parseInt(u.unread_count) || 0;
    const active = currentDmUser && currentDmUser.id === u.id;
    const color  = u.color || 'var(--teal)';
    return `<div class="sidebar-item ${active?'active':''}" onclick='openDm(${JSON.stringify(u).replace(/'/g,"&#39;")})'>
      <div class="dm-avatar" style="background:${color}">${u.name[0].toUpperCase()}</div>
      <div class="dm-item-info">
        <div class="dm-item-name">${escHtml(u.name)}</div>
        <div class="dm-item-preview">${u.last_message ? escHtml(u.last_message).replace(/<br>/g,' ') : 'No messages yet'}</div>
      </div>
      ${unread>0?`<span class="sidebar-unread">${unread}</span>`:''}
    </div>`;
  }).join('');
}

function openDm(user) {
  closeMobileSidebar();
  if (typeof user === 'string') user = JSON.parse(user);
  currentDmUser = user;
  dmUnreads[user.id] = 0;
  updateNavBadges();
  const main  = document.getElementById('dm-chat-main');
  const color = user.color || 'var(--teal)';
  main.innerHTML = `
    <div class="chat-topbar">
      <div class="chat-topbar-left">
        <div style="width:36px;height:36px;border-radius:50%;background:${color};display:flex;align-items:center;justify-content:center;color:var(--navy);font-weight:700;font-family:'Sora',sans-serif">${user.name[0].toUpperCase()}</div>
        <div>
          <div class="chat-topbar-name">${escHtml(user.name)}</div>
          <div class="chat-topbar-desc">${user.role === 'admin' ? '🛡 Admin' : '👤 Agent'} · Direct Message</div>
        </div>
      </div>
    </div>
    <div class="messages-area" id="dm-messages-area"><div class="empty-state"><span class="ei">⏳</span><p>Loading…</p></div></div>
    <div class="chat-input-area">
      <div class="chat-input-wrap">
        <textarea class="chat-textarea" id="dm-msg-input" placeholder="Message ${escHtml(user.name)}…" onkeydown="handleDmKey(event)" oninput="autoResizeTA(this)" rows="1"></textarea>
        <button class="send-btn" onclick="sendDm()">➤</button>
      </div>
      <div class="input-hint">Enter to send · Shift+Enter for new line</div>
    </div>`;
  if (socket) socket.emit('join_dm', buildDmKey(currentUser.id, user.id));
  loadDmMessages(user);
  loadDmConversations();
}

async function loadDmMessages(user) {
  try {
    const msgs = await api('GET', `/dm/${user.id}/messages`);
    renderMsgs('dm-messages-area', msgs, true);
    setTimeout(() => scrollEl('dm-messages-area'), 60);
  } catch(_) {}
}

async function sendDm() {
  if (!currentDmUser) return;
  const input = document.getElementById('dm-msg-input');
  if (!input) return;
  const text = input.value.trim();
  if (!text) return;
  input.value = ''; input.style.height = 'auto';
  try { await api('POST', `/dm/${currentDmUser.id}`, { text }); loadDmConversations(); }
  catch(err) { showToast('Failed: ' + err.message, 'error'); }
}

function handleDmKey(e) { if (e.key==='Enter'&&!e.shiftKey){e.preventDefault();sendDm();} }

// ── MESSAGE RENDERING ────────────────────────
function renderMsgs(areaId, msgs, isDm) {
  const area = document.getElementById(areaId);
  if (!area) return;
  if (!msgs.length) { area.innerHTML = '<div class="empty-state"><span class="ei">💬</span><p>No messages yet. Say hello!</p></div>'; return; }
  let html = '', lastDate = '', lastAuthor = null;
  msgs.forEach(msg => {
    const d  = new Date(msg.created_at);
    const ds = d.toLocaleDateString('en-IN',{day:'2-digit',month:'long',year:'numeric'});
    if (ds !== lastDate) { html += `<div class="date-divider">${ds}</div>`; lastDate=ds; lastAuthor=null; }
    html += buildMsgHTML(msg, msg.author_id===lastAuthor, isDm);
    lastAuthor = msg.author_id;
  });
  area.innerHTML = html;
}

function appendMsg(areaId, msg) {
  const area = document.getElementById(areaId);
  if (!area) return;
  const empty = area.querySelector('.empty-state');
  if (empty) empty.remove();
  const div = document.createElement('div');
  div.innerHTML = buildMsgHTML(msg, false);
  while (div.firstChild) area.appendChild(div.firstChild);
}

function buildMsgHTML(msg, hideAvatar, isDm) {
  const d       = new Date(msg.created_at);
  const time    = d.toLocaleTimeString('en-IN',{hour:'2-digit',minute:'2-digit'});
  const color   = msg.author_color || msg.sender_color || 'var(--teal)';
  const name    = msg.author_name  || msg.sender_name  || '?';
  const text    = msg.text || '';
  const initial = name[0].toUpperCase();
  const isAlert = msg.is_token_alert;
  const msgId   = msg.id;
  const canDel  = !isDm && currentUser && (currentUser.role === 'admin' || currentUser.id == msg.author_id);
  return `<div class="msg-row" data-msg-id="${msgId}">
    <div class="msg-avatar ${hideAvatar?'hidden':''}" style="background:${color}">${initial}</div>
    <div class="msg-body">
      ${!hideAvatar?`<div class="msg-meta"><span class="msg-author">${escHtml(name)}</span><span class="msg-time">${time}</span></div>`:''}
      <div class="msg-text ${isAlert?'token-alert':''}">${escHtml(text)}</div>
    </div>
    ${canDel ? `<button class="msg-del-btn" onclick="deleteChannelMessage(${msgId})" title="Delete message">🗑</button>` : ''}
  </div>`;
}

async function deleteChannelMessage(msgId) {
  if (!confirm('Delete this message?')) return;
  try {
    await api('DELETE', '/channels/messages/' + msgId);
    const el = document.querySelector(`.msg-row[data-msg-id="${msgId}"]`);
    if (el) el.remove();
  } catch(err) { showToast(err.message, 'error'); }
}

function updateNavBadges() {
  syncMobileBadges();
  const chT = Object.values(chUnreads).reduce((a,b)=>a+b,0);
  const dmT = Object.values(dmUnreads).reduce((a,b)=>a+b,0);
  const chB = document.getElementById('nav-ch-unread');
  const dmB = document.getElementById('nav-dm-unread');
  if (chT>0){chB.style.display='inline';chB.textContent=chT;}else chB.style.display='none';
  if (dmT>0){dmB.style.display='inline';dmB.textContent=dmT;}else dmB.style.display='none';
}

// ── CHANNEL MODAL ────────────────────────────
function openChannelModal(){document.getElementById('channel-modal').classList.add('open');}
async function createChannel(){
  const name        = document.getElementById('new-ch-name').value.trim();
  const description = document.getElementById('new-ch-desc').value.trim();
  const icon        = document.getElementById('new-ch-icon').value.trim()||'💬';
  if (!name){showToast('Channel name required','error');return;}
  try{
    const ch=await api('POST','/channels',{name,description,icon});
    allChannels.push(ch);
    closeModal('channel-modal');
    renderChannelList();
    selectChannel(ch);
    showToast('Channel #'+ch.name+' created!','success');
    document.getElementById('new-ch-name').value='';
    document.getElementById('new-ch-desc').value='';
  }catch(err){showToast(err.message,'error');}
}

// ── ADMIN ────────────────────────────────────
async function loadAdminSummary(){
  try{
    const s=await api('GET','/tokens/summary');
    document.getElementById('admin-summary').innerHTML=`
      <div class="admin-stat"><div class="admin-stat-val">${s.active_count}</div><div class="admin-stat-label">Active Tokens</div></div>
      <div class="admin-stat"><div class="admin-stat-val">${s.completed_count}</div><div class="admin-stat-label">Completed</div></div>
      <div class="admin-stat" style="grid-column:1/-1"><div class="admin-stat-val" style="color:var(--gold)">₹${parseFloat(s.total_due).toFixed(2)}</div><div class="admin-stat-label">Total Due (Completed Tokens)</div></div>`;
  }catch(_){}
}

async function loadAdminUsers(){
  try{
    const users=await api('GET','/users');
    document.getElementById('users-tbody').innerHTML=users.map(u=>`
      <tr>
        <td style="font-weight:600;color:var(--text-1)">${escHtml(u.name)}</td>
        <td class="cell-ref">${escHtml(u.username)}</td>
        <td><span style="background:${u.role==='admin'?'var(--teal-light)':'var(--s3)'};color:${u.role==='admin'?'var(--teal)':'var(--text-2)'};padding:3px 10px;border-radius:20px;font-size:11px;font-weight:700;border:1px solid ${u.role==='admin'?'var(--border-teal)':'var(--border)'}">${u.role.toUpperCase()}</span></td>
        <td>${u.id!==currentUser.id?`<button class="act-btn act-delete" onclick="deleteUser(${u.id})">Remove</button>`:'<span style="font-size:11px;color:var(--text-3)">Current user</span>'}</td>
      </tr>`).join('');
  }catch(_){}
}

function openUserModal(){document.getElementById('user-modal').classList.add('open');}
async function createUser(){
  const name=document.getElementById('new-u-name').value.trim();
  const username=document.getElementById('new-u-username').value.trim();
  const password=document.getElementById('new-u-pass').value;
  const role=document.getElementById('new-u-role').value;
  if(!name||!username||!password){showToast('All fields are required','error');return;}
  try{
    await api('POST','/users',{name,username,password,role});
    closeModal('user-modal');
    showToast('Agent added successfully!','success');
    loadUsers(); loadAdminUsers();
    ['new-u-name','new-u-username','new-u-pass'].forEach(id=>document.getElementById(id).value='');
  }catch(err){showToast(err.message,'error');}
}

async function deleteUser(id){
  if(!confirm('Remove this agent from the system?'))return;
  try{await api('DELETE',`/users/${id}`);showToast('Agent removed');loadUsers();loadAdminUsers();}
  catch(err){showToast(err.message,'error');}
}

// ── UTILS ────────────────────────────────────
function closeModal(id){document.getElementById(id).classList.remove('open');}
function closeModalOnBg(e,id){if(e.target.id===id)closeModal(id);}
function scrollEl(id){const el=document.getElementById(id);if(el)el.scrollTop=el.scrollHeight;}
function autoResizeTA(el){el.style.height='auto';el.style.height=Math.min(el.scrollHeight,120)+'px';}
function escHtml(s){return String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/\n/g,'<br>');}

function showToast(msg, type='success') {
  const icons = { success:'✅', error:'❌', warn:'⚠️' };
  const t = document.getElementById('toast');
  document.getElementById('toast-icon').textContent = icons[type] || '✅';
  document.getElementById('toast-msg').textContent  = msg;
  t.className = 'toast ' + type + ' show';
  clearTimeout(t._to);
  t._to = setTimeout(() => t.classList.remove('show'), 3500);
}

// ── INIT ─────────────────────────────────────
checkSession();

// ── SETTINGS ────────────────────────────────
function initSettings() {
  if (currentUser.role === 'admin') {
    document.getElementById('admin-pwd-card').style.display = 'block';
    document.getElementById('backup-card').style.display = 'block';
    loadResetUserList();
  }
  loadSettingsStats();
}

async function loadResetUserList() {
  try {
    const users = await api('GET', '/users');
    const sel = document.getElementById('reset-user-sel');
    sel.innerHTML = users
      .filter(u => u.id !== currentUser.id)
      .map(u => `<option value="${u.id}">${escHtml(u.name)} (${u.username})</option>`)
      .join('');
  } catch(_) {}
}

async function loadSettingsStats() {
  try {
    const s = await api('GET', '/settings/stats');
    document.getElementById('ss-tokens').textContent    = s.tokens.total;
    document.getElementById('ss-active').textContent    = s.tokens.active;
    document.getElementById('ss-completed').textContent = s.tokens.completed;
    document.getElementById('ss-due').textContent       = '₹' + parseFloat(s.tokens.total_due).toFixed(0);
    document.getElementById('ss-users').textContent     = s.users;
    document.getElementById('ss-msgs').textContent      = parseInt(s.messages) + parseInt(s.direct_messages);
  } catch(_) {}
}

async function changeOwnPassword() {
  const current = document.getElementById('cp-current').value;
  const nw      = document.getElementById('cp-new').value;
  const confirm = document.getElementById('cp-confirm').value;
  if (!current || !nw || !confirm) { showToast('All fields are required', 'error'); return; }
  if (nw !== confirm) { showToast('New passwords do not match', 'error'); return; }
  if (nw.length < 6) { showToast('Password must be at least 6 characters', 'error'); return; }
  try {
    await api('PATCH', '/settings/password', { current_password: current, new_password: nw });
    document.getElementById('cp-current').value = '';
    document.getElementById('cp-new').value     = '';
    document.getElementById('cp-confirm').value = '';
    showToast('✅ Password changed successfully!', 'success');
  } catch(err) { showToast(err.message, 'error'); }
}

async function resetUserPassword() {
  const userId  = document.getElementById('reset-user-sel').value;
  const newPass = document.getElementById('reset-user-pass').value;
  if (!userId || !newPass) { showToast('Select a user and enter a password', 'error'); return; }
  if (newPass.length < 6) { showToast('Password must be at least 6 characters', 'error'); return; }
  if (!confirm('Reset this agent\'s password?')) return;
  try {
    await api('PATCH', `/settings/user-password/${userId}`, { new_password: newPass });
    document.getElementById('reset-user-pass').value = '';
    showToast('✅ Agent password reset successfully!', 'success');
  } catch(err) { showToast(err.message, 'error'); }
}

// ── BACKUP ──────────────────────────────────
function downloadBackup() {
  showToast('⏳ Preparing backup…', 'success');
  window.location = '/api/settings/backup';
}

// ── RESTORE ─────────────────────────────────
let restoreData = null;

function handleRestoreFile(input) {
  const file = input.files[0];
  if (!file) return;
  readRestoreFile(file);
}

function handleRestoreDrop(e) {
  e.preventDefault();
  document.getElementById('restore-drop').classList.remove('drag-over');
  const file = e.dataTransfer.files[0];
  if (file) readRestoreFile(file);
}

function readRestoreFile(file) {
  const reader = new FileReader();
  reader.onload = (e) => {
    try { restoreData = JSON.parse(e.target.result); showRestorePreview(file.name, restoreData); }
    catch(_) { showToast('Invalid JSON file', 'error'); }
  };
  reader.readAsText(file);
}

function showRestorePreview(filename, data) {
  const d = data.data || {};
  document.getElementById('restore-file-info').innerHTML = `
    <strong>File:</strong> ${escHtml(filename)}<br>
    <strong>Exported:</strong> ${data.exported_at ? new Date(data.exported_at).toLocaleString('en-IN') : 'Unknown'}<br>
    <strong>Version:</strong> ${data.version || '?'}<br>
    <strong>Contains:</strong>
    ${d.tokens?.length || 0} tokens ·
    ${d.messages?.length || 0} messages ·
    ${d.direct_messages?.length || 0} DMs ·
    ${d.channels?.length || 0} channels ·
    ${d.users?.length || 0} users`;
  document.getElementById('restore-preview').style.display = 'block';
  document.getElementById('restore-drop').style.display = 'none';
}

function cancelRestore() {
  restoreData = null;
  document.getElementById('restore-preview').style.display = 'none';
  document.getElementById('restore-drop').style.display = 'block';
  document.getElementById('restore-file').value = '';
}

async function confirmRestore() {
  if (!restoreData) return;
  if (!confirm('⚠️ This will overwrite existing data. Are you sure?')) return;
  const restore_tokens   = document.getElementById('restore-tokens').checked;
  const restore_messages = document.getElementById('restore-messages').checked;
  const restore_users    = document.getElementById('restore-users').checked;
  try {
    showToast('⏳ Restoring data…', 'success');
    const result = await api('POST', '/settings/restore', {
      data: restoreData.data, restore_tokens, restore_messages, restore_users,
    });
    cancelRestore();
    loadSettingsStats();
    const s = result.summary;
    showToast(`✅ Restored: ${s.tokens} tokens, ${s.messages} messages, ${s.channels} channels`, 'success');
  } catch(err) { showToast('Restore failed: ' + err.message, 'error'); }
}

// ══════════════════════════════════════════
//  PAYMENTS
// ══════════════════════════════════════════

let payScreenshotFile = null;

function initPayments() {
  const formCard = document.getElementById('pay-form-card');
  if (formCard) formCard.style.display = 'block';

  const subEl = document.getElementById('pay-panel-sub');
  if (subEl) subEl.textContent = currentUser.role === 'admin'
    ? 'Record, upload and manage all payment submissions'
    : 'Record and track your payment submissions with screenshots';

  const dateEl = document.getElementById('pay-date');
  if (dateEl && !dateEl.value) dateEl.value = new Date().toISOString().slice(0, 10);

  loadPayments();
}

// ── File handling ────────────────────────
function handlePayFile(input) {
  const file = input.files[0];
  if (file) setPayScreenshot(file);
}

function handlePayDrop(e) {
  e.preventDefault();
  document.getElementById('pay-drop-zone').classList.remove('drag-over');
  const file = e.dataTransfer.files[0];
  if (file && file.type.startsWith('image/')) setPayScreenshot(file);
  else showToast('Please drop an image file', 'error');
}

function setPayScreenshot(file) {
  payScreenshotFile = file;
  const reader = new FileReader();
  reader.onload = (e) => {
    document.getElementById('pay-drop-content').style.display     = 'none';
    document.getElementById('pay-preview-wrap').style.display      = 'flex';
    document.getElementById('pay-preview-wrap').style.flexDirection = 'column';
    document.getElementById('pay-preview-wrap').style.alignItems   = 'center';
    document.getElementById('pay-preview-img').src = e.target.result;
    document.getElementById('pay-preview-name').textContent = file.name + ' (' + (file.size/1024).toFixed(0) + ' KB)';
  };
  reader.readAsDataURL(file);
}

function clearPayScreenshot() {
  payScreenshotFile = null;
  document.getElementById('pay-screenshot').value = '';
  document.getElementById('pay-drop-content').style.display = 'block';
  document.getElementById('pay-preview-wrap').style.display = 'none';
  document.getElementById('pay-preview-img').src = '';
}

function clearPayForm() {
  document.getElementById('pay-details').value = '';
  document.getElementById('pay-amount').value  = '';
  document.getElementById('pay-date').value    = new Date().toISOString().slice(0, 10);
  clearPayScreenshot();
}

// ── Submit ───────────────────────────────
async function submitPayment() {
  const details = document.getElementById('pay-details').value.trim();
  const amount  = document.getElementById('pay-amount').value.trim();
  const date    = document.getElementById('pay-date').value;
  const btn     = document.getElementById('pay-submit-btn');
  if (!details) { showToast('Please enter payment details', 'error'); return; }
  if (!amount || parseFloat(amount) <= 0) { showToast('Please enter a valid amount', 'error'); return; }
  btn.disabled = true; btn.textContent = '⏳ Submitting…';
  try {
    const fd = new FormData();
    fd.append('details', details);
    fd.append('amount',  amount);
    if (date) fd.append('payment_date', date);
    if (payScreenshotFile) fd.append('screenshot', payScreenshotFile);
    const res  = await fetch('/api/payments', { method:'POST', body:fd, credentials:'include' });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Failed');
    showToast('✅ Payment recorded successfully!', 'success');
    clearPayForm();
    loadPayments();
  } catch(err) { showToast(err.message, 'error'); }
  finally { btn.disabled = false; btn.textContent = '💳 Submit Payment'; }
}

// ── Load ─────────────────────────────────
async function loadPayments() {
  try {
    const payments = await api('GET', '/payments');
    // Store full list for search/pagination (set up in index.html inline script)
    window._allPayments = payments;
    if (typeof window._paySearchInit === 'function') {
      window._paySearchInit(payments);
    } else {
      // Fallback if inline script not loaded yet
      _renderPayPage(payments, payments, 1, payments.length);
    }
  } catch(err) { showToast('Failed to load payments', 'error'); }
}

// ── Render page (called by search/pagination engine) ──
window._renderPayPage = function (pageItems, _allFiltered, currentPage, total) {
  const list  = document.getElementById('pay-list');
  const badge = document.getElementById('pay-count-badge');
  if (badge) badge.textContent = total;

  if (!pageItems.length) {
    list.innerHTML = `<div class="empty-state"><span class="ei">💳</span>
      <p>${total === 0 ? 'No payments recorded yet.' : 'No payments match your search.'}</p></div>`;
    return;
  }

  list.innerHTML = pageItems.map(p => {
    const dateStr    = new Date(p.payment_date).toLocaleDateString('en-IN', { day:'2-digit', month:'short', year:'numeric' });
    const createdStr = new Date(p.created_at).toLocaleString('en-IN', { timeZone:'Asia/Kolkata', day:'2-digit', month:'short', hour:'2-digit', minute:'2-digit' });
    const canDelete  = currentUser.role === 'admin' || currentUser.id == p.submitted_by;
    const isAdmin    = currentUser.role === 'admin';

    // Screenshot section
    let screenshotHtml = '';
    if (p.screenshot_url) {
      screenshotHtml = `
        <div class="pay-ss-section">
          <img class="pay-screenshot-thumb" src="${p.screenshot_url}"
            alt="Screenshot" onclick="openPayLightbox('${p.screenshot_url}')"
            title="Click to view full screenshot">
          <button class="pay-view-btn" onclick="openPayLightbox('${p.screenshot_url}')">
            🔍 View Screenshot
          </button>
          ${canDelete ? `<button class="pay-remove-ss-btn" onclick="removePayScreenshot(${p.id})">✕ Remove</button>` : ''}
        </div>`;
    } else if (canDelete) {
      screenshotHtml = `
        <div class="pay-ss-section pay-ss-upload">
          <label class="pay-upload-label" title="Attach screenshot">
            📎 Attach Screenshot
            <input type="file" accept="image/*" style="display:none"
              onchange="uploadPayScreenshot(${p.id}, this)">
          </label>
        </div>`;
    }

    // Allocation info + Apply button (admin only)
    const allocated = parseFloat(p.total_allocated || 0);
    const amount    = parseFloat(p.amount || 0);
    let allocHtml   = '';

    if (allocated > 0) {
      allocHtml += `<div class="pay-alloc-info">
        <span class="pay-alloc-badge">✓ ₹${allocated.toFixed(2)} allocated</span>`;
      if (isAdmin) {
        allocHtml += `<button class="pay-undo-btn" onclick="removePayAllocations(${p.id})" title="Remove all allocations">↩ Undo</button>`;
      }
      allocHtml += `</div>`;
    }

    if (isAdmin && allocated < amount) {
      const agentName = (p.submitted_name || '').replace(/'/g, "\\'");
      allocHtml += `<button class="pay-apply-btn" style="margin-top:8px"
        onclick="openApplyPayModal(${p.id},'${escHtml(p.payment_ref)}',${p.amount},'${agentName}')">
        💳 Apply to Tokens
      </button>`;
    }

    return `
    <div class="pay-item" id="pay-item-${p.id}">
      <div class="pay-item-ref">${escHtml(p.payment_ref)}</div>
      <div class="pay-item-body">
        <div class="pay-item-details">${escHtml(p.details)}</div>
        <div class="pay-item-meta">
          <span>👤 ${escHtml(p.submitted_name)}</span>
          <span>📅 ${dateStr}</span>
          <span>🕐 Submitted ${createdStr} IST</span>
        </div>
        ${allocHtml}
      </div>
      <div class="pay-item-right">
        <div class="pay-item-amount">₹${amount.toLocaleString('en-IN', {minimumFractionDigits:2})}</div>
        ${screenshotHtml}
        ${canDelete ? `<button class="act-btn act-delete" onclick="deletePayment(${p.id})" style="font-size:11px;padding:4px 10px">🗑 Delete</button>` : ''}
      </div>
    </div>`;
  }).join('');
};

// ── Screenshot upload/remove ─────────────
async function uploadPayScreenshot(payId, input) {
  const file = input.files[0];
  if (!file) return;
  const fd = new FormData();
  fd.append('screenshot', file);
  showToast('⏳ Uploading screenshot…', 'success');
  try {
    const res  = await fetch(`/api/payments/${payId}/screenshot`, { method:'POST', body:fd, credentials:'include' });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Upload failed');
    showToast('✅ Screenshot attached!', 'success');
    loadPayments();
  } catch(err) { showToast(err.message, 'error'); }
}

async function removePayScreenshot(payId) {
  if (!confirm('Remove this screenshot?')) return;
  try { await api('DELETE', `/payments/${payId}/screenshot`); showToast('Screenshot removed', 'success'); loadPayments(); }
  catch(err) { showToast(err.message, 'error'); }
}

async function deletePayment(id) {
  if (!confirm('Delete this payment record?')) return;
  try { await api('DELETE', `/payments/${id}`); showToast('Payment deleted', 'success'); loadPayments(); }
  catch(err) { showToast(err.message, 'error'); }
}

// ── Undo allocations (called from payment item + Apply modal) ──
async function removePayAllocations(payId) {
  if (!confirm('Remove all payment allocations for this payment? Tokens will show as unpaid again.')) return;
  try {
    const d = await api('DELETE', `/payments/${payId}/allocations`);
    showToast(`↩️ Removed ${d.removed} allocation${d.removed !== 1 ? 's' : ''}`, 'success');
    await loadTokenPaidStatus();
    loadTokens();
    loadPayments();
  } catch(err) { showToast(err.message, 'error'); }
}

// ── Screenshot lightbox ──────────────────
function openPayLightbox(url) {
  const lb = document.createElement('div');
  lb.className = 'pay-lightbox';
  lb.innerHTML = `<span class="pay-lightbox-close" onclick="this.parentElement.remove()">✕</span><img src="${url}" alt="Payment Screenshot">`;
  lb.onclick = (e) => { if (e.target === lb) lb.remove(); };
  document.body.appendChild(lb);
}

// ══════════════════════════════════════════
//  APPLY PAYMENT MODAL  (admin only)
//  HTML lives in index.html; logic is here.
// ══════════════════════════════════════════

let _apmPayId   = null;
let _apmMethod  = 'date_range';
let _apmPreview = null;

function openApplyPayModal(payId, payRef, payAmount, agentName) {
  _apmPayId   = payId;
  _apmMethod  = 'date_range';
  _apmPreview = null;

  document.getElementById('apm-summary').innerHTML =
    `<div class="apm-summary-row">
       <span class="apm-summary-ref">${payRef}</span>
       <span class="apm-summary-agent">👤 ${escHtml(agentName || '—')}</span>
       <span class="apm-summary-amount">₹${parseFloat(payAmount).toFixed(2)}</span>
     </div>`;

  apmSwitchMethod('date_range');
  document.getElementById('apm-from').value   = '';
  document.getElementById('apm-to').value     = '';
  document.getElementById('apm-amount').value = '';
  document.getElementById('apm-preview-wrap').style.display = 'none';
  document.getElementById('apm-confirm-btn').disabled = true;

  document.getElementById('apply-pay-modal').classList.add('open');
}

function apmSwitchMethod(m) {
  _apmMethod  = m;
  _apmPreview = null;
  document.getElementById('apm-confirm-btn').disabled = true;
  document.getElementById('apm-preview-wrap').style.display = 'none';
  document.getElementById('apm-tab-range') .classList.toggle('active', m === 'date_range');
  document.getElementById('apm-tab-amount').classList.toggle('active', m === 'custom_amount');
  document.getElementById('apm-range-fields') .style.display = m === 'date_range'    ? 'block' : 'none';
  document.getElementById('apm-amount-fields').style.display = m === 'custom_amount' ? 'block' : 'none';
}

async function apmPreview() {
  const btn = document.getElementById('apm-preview-btn');
  btn.disabled = true; btn.textContent = '⏳ Loading…';

  const body = { method: _apmMethod };
  if (_apmMethod === 'date_range') {
    body.from_date = document.getElementById('apm-from').value;
    body.to_date   = document.getElementById('apm-to').value;
    if (!body.from_date || !body.to_date) {
      showToast('Please select both From and To dates', 'warn');
      btn.disabled = false; btn.textContent = '👁 Preview Tokens'; return;
    }
  } else {
    body.amount = document.getElementById('apm-amount').value;
    if (!body.amount || parseFloat(body.amount) <= 0) {
      showToast('Please enter a valid amount', 'warn');
      btn.disabled = false; btn.textContent = '👁 Preview Tokens'; return;
    }
  }

  try {
    const res  = await fetch(`/api/payments/${_apmPayId}/apply/preview`, {
      method:'POST', headers:{'Content-Type':'application/json'},
      body: JSON.stringify(body), credentials:'include',
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Preview failed');
    _apmPreview = { ...data, body };
    _apmRenderPreview(data);
    document.getElementById('apm-confirm-btn').disabled = (data.tokens.length === 0);
  } catch(e) { showToast(e.message, 'error'); }
  finally { btn.disabled = false; btn.textContent = '👁 Preview Tokens'; }
}

function _apmRenderPreview(data) {
  const wrap  = document.getElementById('apm-preview-wrap');
  const title = document.getElementById('apm-preview-title');
  const list  = document.getElementById('apm-token-list');
  const badge = document.getElementById('apm-remaining-badge');

  wrap.style.display = 'block';

  if (!data.tokens.length) {
    title.textContent   = 'No unpaid tokens found for this criteria.';
    badge.style.display = 'none';
    list.innerHTML      = '<div class="apm-empty">✅ All tokens in this range are already fully paid.</div>';
    return;
  }

  title.textContent = `${data.tokens.length} token${data.tokens.length !== 1 ? 's' : ''} · ₹${data.total_allocated.toFixed(2)} will be applied`;

  if (_apmMethod === 'custom_amount' && data.remaining_after > 0) {
    badge.style.display = 'inline-flex';
    badge.textContent   = `₹${data.remaining_after.toFixed(2)} unallocated`;
  } else {
    badge.style.display = 'none';
  }

  list.innerHTML = data.tokens.map(t => `
    <div class="apm-token-row">
      <div class="apm-token-details">${escHtml((t.details || '').substring(0, 70))}${(t.details||'').length > 70 ? '…' : ''}</div>
      <div class="apm-token-nums">
        <span class="apm-token-charge">₹${t.charge.toFixed(2)} charge</span>
        ${t.already_paid > 0 ? `<span class="apm-token-paid-so-far">₹${t.already_paid.toFixed(2)} paid</span>` : ''}
        <span class="apm-token-alloc ${t.will_be_fully_paid ? 'apm-full-pay' : 'apm-part-pay'}">
          ${t.will_be_fully_paid ? '✅' : '⚡'} ₹${t.will_allocate.toFixed(2)} now
        </span>
      </div>
    </div>`).join('');
}

async function apmConfirm() {
  if (!_apmPreview?.body) return;
  const btn = document.getElementById('apm-confirm-btn');
  btn.disabled = true; btn.textContent = '⏳ Applying…';
  try {
    const res  = await fetch(`/api/payments/${_apmPayId}/apply`, {
      method:'POST', headers:{'Content-Type':'application/json'},
      body: JSON.stringify(_apmPreview.body), credentials:'include',
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Apply failed');

    document.getElementById('apply-pay-modal').classList.remove('open');
    showToast(`✅ Payment applied to ${data.applied_count} token${data.applied_count !== 1 ? 's' : ''}`, 'success');

    // Refresh everything that shows paid data
    await loadTokenPaidStatus();
    loadTokens();
    loadPayments();
  } catch(e) {
    showToast(e.message, 'error');
    btn.disabled = false; btn.textContent = '✅ Apply Payment';
  }
}

// ══════════════════════════════════════════
//  MOBILE NAV
// ══════════════════════════════════════════

function syncMobileNav(panelName) {
  const tabs = ['tracker','discussion','messages','payments'];
  tabs.forEach(t => {
    const el = document.getElementById('mbn-' + t);
    if (el) el.classList.toggle('active', t === panelName);
  });
  const moreBtn = document.getElementById('mbn-more');
  if (moreBtn) moreBtn.classList.toggle('active', ['settings','about','admin'].includes(panelName));
}

function toggleMobileMenu() {
  document.getElementById('mobile-more-overlay').classList.toggle('open');
  document.getElementById('mobile-more-sheet').classList.toggle('open');
}
function closeMobileMenu() {
  document.getElementById('mobile-more-overlay').classList.remove('open');
  document.getElementById('mobile-more-sheet').classList.remove('open');
}

function openMobileSidebar(panel) {
  const id      = SIDEBAR_IDS[panel];
  const sidebar = document.getElementById(id);
  const overlay = document.getElementById('mobile-sidebar-overlay');
  if (sidebar) sidebar.classList.add('open');
  if (overlay) { overlay.classList.add('open'); overlay.dataset.panel = panel; }
}
function closeMobileSidebar() {
  const overlay = document.getElementById('mobile-sidebar-overlay');
  if (!overlay) return;
  const panel = overlay.dataset.panel;
  if (panel) {
    const sidebar = document.getElementById(SIDEBAR_IDS[panel]);
    if (sidebar) sidebar.classList.remove('open');
  }
  overlay.classList.remove('open');
}

function syncMobileUser() {
  if (!currentUser) return;
  const el = document.getElementById('mobile-more-avatar');
  if (el) el.textContent = currentUser.name[0].toUpperCase();
  const nm = document.getElementById('mobile-more-name');
  if (nm) nm.textContent = currentUser.name;
  const rl = document.getElementById('mobile-more-role');
  if (rl) rl.textContent = currentUser.role.toUpperCase();
  const adminItem = document.getElementById('mbn-admin');
  if (adminItem) adminItem.style.display = currentUser.role === 'admin' ? 'flex' : 'none';
}

function syncMobileBadges() {
  const chTotal = Object.values(chUnreads).reduce((a,b)=>a+b,0);
  const dmTotal = Object.values(dmUnreads).reduce((a,b)=>a+b,0);
  const chB = document.getElementById('mbn-ch-badge');
  const dmB = document.getElementById('mbn-dm-badge');
  if (chB) { chB.textContent = chTotal; chB.style.display = chTotal > 0 ? 'flex' : 'none'; }
  if (dmB) { dmB.textContent = dmTotal; dmB.style.display = dmTotal > 0 ? 'flex' : 'none'; }
}

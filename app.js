// ============================================================
// NexChat — Backend Firebase Realtime Database
// firebase SDK chargé dans index.html → window.FBDB
// ============================================================

const APP_KEY = 'nexchat_v1';

// ===== STATE =====
let currentUser = null;
let currentChat = null;
let typingTimer = null;
let pollTimer = null;

// ===== FIREBASE HELPERS =====
// Toutes les données vivent dans Firebase.
// On garde un cache mémoire local pour les lectures synchrones rapides.
const _cache = {};

const DB = {
  // Lecture depuis le cache mémoire (mis à jour par les listeners Firebase)
  get: (key, def = null) => {
    return _cache[key] !== undefined ? _cache[key] : def;
  },

  // Écriture : cache mémoire immédiat + Firebase en arrière-plan
  set: (key, val) => {
    _cache[key] = val;
    if (window.FBDB) {
      window.FBDB.ref(key).set(val)
        .catch(e => console.error('Firebase write error:', key, e));
    }
  },

  // Raccourcis
  users:    ()   => DB.get('users', {}),
  groups:   ()   => DB.get('groups', {}),
  messages: (id) => DB.get(`msgs_${id}`, []),

  addMessage: (chatId, msg) => {
    if (window.FBDB) {
      // Push Firebase natif (clé auto, temps réel)
      window.FBDB.ref(`msgs_${chatId}`).push(msg)
        .catch(e => console.error('Firebase push error:', e));
    } else {
      const msgs = DB.messages(chatId);
      msgs.push(msg);
      DB.set(`msgs_${chatId}`, msgs);
    }
  },

  typing: () => DB.get('typing', {}),
  setTyping: (chatId, username, ts) => {
    const t = { ...DB.typing() };
    if (!t[chatId]) t[chatId] = {};
    t[chatId][username] = ts;
    DB.set('typing', t);
  },
  clearTyping: (chatId, username) => {
    const t = { ...DB.typing() };
    if (t[chatId]) {
      delete t[chatId][username];
      DB.set('typing', t);
    }
  },

  bans: () => DB.get('bans', {}),
  banUser: (username, reason, bannedBy) => {
    const bans = { ...DB.get('bans', {}) };
    bans[username] = { reason: reason || 'Aucune raison', bannedBy, bannedAt: Date.now() };
    DB.set('bans', bans);
  },
  unbanUser: (username) => {
    const bans = { ...DB.get('bans', {}) };
    delete bans[username];
    DB.set('bans', bans);
  },
  isBanned: (username) => !!DB.get('bans', {})[username]
};

// ===== FIREBASE LISTENERS =====
// Écoute tous les chemins Firebase et met à jour le cache mémoire en temps réel
function startFirebaseListeners() {
  if (!window.FBDB) return;
  const db = window.FBDB;

  const paths = ['users', 'groups', 'bans', 'typing', 'reports'];

  paths.forEach(path => {
    db.ref(path).on('value', snap => {
      _cache[path] = snap.val() || (path === 'reports' ? [] : {});
      refreshUI();
    });
  });

  // Écoute les messages du chat courant
  listenCurrentChat();
}

let _chatListener = null;
let _chatListenerPath = null;

function listenCurrentChat() {
  if (!window.FBDB || !currentChat) return;
  const chatId = `msgs_${currentChat.type}_${currentChat.id}`;

  // Détache l'ancien listener
  if (_chatListenerPath && _chatListener) {
    window.FBDB.ref(_chatListenerPath).off('value', _chatListener);
  }

  _chatListenerPath = chatId;
  _chatListener = window.FBDB.ref(chatId).on('value', snap => {
    const raw = snap.val();
    // Firebase push() stocke les messages comme objet {key: msg} → on convertit en tableau
    _cache[chatId] = raw ? Object.values(raw).sort((a, b) => a.timestamp - b.timestamp) : [];
    renderMessages();
    markRead(chatId);
  });
}

function refreshUI() {
  if (currentUser) {
    renderGroups();
    renderPrivateChats();
    renderUsers();
    updateWelcomeStats();
    updateAdminAlertDot();
  }
}

// ===== INIT =====
function init() {
  // Abonne les listeners Firebase avant tout
  startFirebaseListeners();

  // Attendre que Firebase charge les données initiales
  if (window.FBDB) {
    showLoadingScreen();
    // On attend le premier snapshot 'users' pour savoir si la DB est vide
    window.FBDB.ref('users').once('value').then(snap => {
      _cache['users'] = snap.val() || {};
      window.FBDB.ref('groups').once('value').then(snapG => {
        _cache['groups'] = snapG.val() || {};
        initDefaultData();
        checkSession();
        hideLoadingScreen();
      });
    }).catch(() => {
      initDefaultData();
      checkSession();
      hideLoadingScreen();
    });
  } else {
    initDefaultData();
    checkSession();
  }
}

function showLoadingScreen() {
  let el = document.getElementById('loading-screen');
  if (!el) {
    el = document.createElement('div');
    el.id = 'loading-screen';
    el.style.cssText = 'position:fixed;inset:0;background:var(--bg,#0a0a0f);display:flex;flex-direction:column;align-items:center;justify-content:center;z-index:9999;gap:16px;color:#9999b0;font-family:sans-serif';
    el.innerHTML = '<div style="font-size:36px">💬</div><div style="font-size:14px">Connexion à Firebase...</div><div style="width:40px;height:40px;border:3px solid #2a2a38;border-top-color:#6c63ff;border-radius:50%;animation:spin 0.8s linear infinite"></div><style>@keyframes spin{to{transform:rotate(360deg)}}</style>';
    document.body.appendChild(el);
  }
}

function hideLoadingScreen() {
  const el = document.getElementById('loading-screen');
  if (el) el.remove();
}

function checkSession() {
  const saved = sessionStorage.getItem('nexchat_session');
  if (saved) {
    const s = JSON.parse(saved);
    const users = DB.users();
    if (users[s.username]) {
      currentUser = users[s.username];
      sessionStorage.setItem('nexchat_session', JSON.stringify(currentUser));
      enterApp();
      return;
    }
  }
  showAuth();
}


function initDefaultData() {
  const users = DB.users();
  // Create default admin if no users exist
  if (Object.keys(users).length === 0) {
    users['admin'] = {
      username: 'admin',
      displayName: 'Administrateur',
      password: btoa('admin123'),
      role: 'admin',
      createdAt: Date.now(),
      color: '#6c63ff'
    };
    DB.set('users', users);

    // Create default groups
    const groups = DB.groups();
    groups['general'] = {
      id: 'general',
      name: 'Général',
      description: 'Canal général de discussion',
      createdBy: 'admin',
      createdAt: Date.now(),
      members: ['admin'],
      admins: ['admin'],
      color: '#6c63ff',
      icon: '💬'
    };
    groups['random'] = {
      id: 'random',
      name: 'Aléatoire',
      description: 'Discussions libres',
      createdBy: 'admin',
      createdAt: Date.now(),
      members: ['admin'],
      admins: ['admin'],
      color: '#22c55e',
      icon: '🎲'
    };
    DB.set('groups', groups);

    // Welcome message
    DB.addMessage('group_general', {
      id: genId(),
      type: 'system',
      content: '👋 Bienvenue sur NexChat ! Créez un compte pour commencer à chatter.',
      timestamp: Date.now()
    });
  }
}

// ===== AUTH =====
function showAuth() {
  document.getElementById('auth-screen').classList.add('active');
  document.getElementById('app-screen').classList.remove('active');
}

function showLogin() {
  document.getElementById('auth-login').classList.remove('hidden');
  document.getElementById('auth-register').classList.add('hidden');
  clearAuthError();
}

function showRegister() {
  document.getElementById('auth-login').classList.add('hidden');
  document.getElementById('auth-register').classList.remove('hidden');
  clearAuthError();
}

function showAuthError(msg) {
  const el = document.getElementById('auth-error');
  el.textContent = msg;
  el.classList.remove('hidden');
}

function clearAuthError() {
  document.getElementById('auth-error').classList.add('hidden');
}

function login() {
  const username = document.getElementById('login-username').value.trim().toLowerCase();
  const password = document.getElementById('login-password').value;
  if (!username || !password) return showAuthError('Remplis tous les champs');

  const users = DB.users();
  const user = users[username];
  if (!user) return showAuthError('Utilisateur introuvable');
  if (user.password !== btoa(password)) return showAuthError('Mot de passe incorrect');

if (DB.isBanned(username)) {
  const ban = DB.bans()[username];

  // cacher login
  document.getElementById("auth-screen").classList.add("hidden");

  // afficher écran de ban
  document.getElementById("ban-screen").classList.remove("hidden");

  document.getElementById("ban-reason").innerText =
    ban.reason || "Aucune raison";

  return;
}

  currentUser = user;
  sessionStorage.setItem('nexchat_session', JSON.stringify(user));
  enterApp();
}

function register() {
  const username = document.getElementById('reg-username').value.trim().toLowerCase();
  const displayName = document.getElementById('reg-displayname').value.trim();
  const password = document.getElementById('reg-password').value;
  const confirm = document.getElementById('reg-confirm').value;

  if (!username || !displayName || !password) return showAuthError('Remplis tous les champs');
  if (!/^[a-z0-9_]{3,20}$/.test(username)) return showAuthError('Nom d\'utilisateur : 3-20 caractères, lettres/chiffres/underscore');
  if (password.length < 4) return showAuthError('Mot de passe trop court (min 4 caractères)');
  if (password !== confirm) return showAuthError('Les mots de passe ne correspondent pas');

  const users = DB.users();
  if (users[username]) return showAuthError('Ce nom d\'utilisateur est déjà pris');

  const colors = ['#6c63ff','#22c55e','#f59e0b','#ef4444','#06b6d4','#ec4899','#8b5cf6'];
  const newUser = {
    username,
    displayName,
    password: btoa(password),
    role: 'user',
    createdAt: Date.now(),
    color: colors[Math.floor(Math.random() * colors.length)]
  };

  users[username] = newUser;
  DB.set('users', users);

  // Add to all public groups
  const groups = DB.groups();
  for (const g of Object.values(groups)) {
    if (!g.private) {
      g.members = [...new Set([...(g.members || []), username])];
    }
  }
  DB.set('groups', groups);

  currentUser = newUser;
  sessionStorage.setItem('nexchat_session', JSON.stringify(newUser));

  broadcast({ type: 'user_joined', username });
  enterApp();
}

function logout() {
  if (currentUser) {
    DB.clearTyping(currentChat?.id ? `${currentChat.type}_${currentChat.id}` : '', currentUser.username);
    broadcast({ type: 'user_left', username: currentUser.username });
  }
  currentUser = null;
  currentChat = null;
  sessionStorage.clear();
  clearInterval(pollTimer);
  showAuth();
  document.getElementById('login-username').value = '';
  document.getElementById('login-password').value = '';
}

function enterApp() {
  document.getElementById('auth-screen').classList.remove('active');
  document.getElementById('app-screen').classList.add('active');

  // Admin class
  if (currentUser.role === 'admin') {
    document.body.classList.add('is-admin');
  } else {
    document.body.classList.remove('is-admin');
  }

  updateSidebarUser();
  renderGroups();
  renderPrivateChats();
  renderUsers();
  updateWelcomeStats();
  updateAdminAlertDot();
  startPolling();
  switchTab('groups');
}

// ===== SIDEBAR =====
function updateSidebarUser() {
  document.getElementById('sidebar-avatar').textContent = (currentUser.displayName || currentUser.username)[0].toUpperCase();
  document.getElementById('sidebar-avatar').style.background = currentUser.color || '#6c63ff';
  document.getElementById('sidebar-username').textContent = currentUser.displayName || currentUser.username;
  document.getElementById('admin-badge').style.display = currentUser.role === 'admin' ? 'block' : 'none';
  document.getElementById('create-group-btn').style.display = currentUser.role === 'admin' ? 'flex' : 'none';
  if (document.getElementById('manage-btn')) {
    document.getElementById('manage-btn').style.display = currentUser.role === 'admin' ? 'flex' : 'none';
  }
}

function renderGroups(filter = '') {
  const groups = DB.groups();
  const container = document.getElementById('groups-list');
  container.innerHTML = '';

  const myGroups = Object.values(groups).filter(g =>
    g.members?.includes(currentUser.username) &&
    (!filter || g.name.toLowerCase().includes(filter.toLowerCase()))
  );

  if (myGroups.length === 0) {
    container.innerHTML = '<div style="padding:16px;text-align:center;color:var(--text3);font-size:12px;">Aucun groupe</div>';
    return;
  }

  for (const g of myGroups) {
    const msgs = DB.messages(`group_${g.id}`);
    const lastMsg = msgs.filter(m => m.type !== 'system').slice(-1)[0];
    const unread = getUnreadCount(`group_${g.id}`);

    const item = document.createElement('div');
    item.className = `conv-item ${currentChat?.type === 'group' && currentChat?.id === g.id ? 'active' : ''}`;
    item.onclick = () => openChat('group', g.id);
    item.innerHTML = `
      <div class="avatar sm" style="background:${g.color || '#6c63ff'};border-radius:10px;">${g.icon || g.name[0]}</div>
      <div class="conv-body">
        <div class="conv-name">${escHtml(g.name)}</div>
        <div class="conv-preview">${lastMsg ? `${lastMsg.sender ? escHtml(getDisplayName(lastMsg.sender)) + ': ' : ''}${escHtml(lastMsg.content.substring(0,40))}` : escHtml(g.description || '')}</div>
      </div>
      <div class="conv-meta">
        <span class="conv-time">${lastMsg ? formatTime(lastMsg.timestamp) : ''}</span>
        ${unread > 0 ? `<span class="conv-unread">${unread}</span>` : ''}
      </div>
    `;
    container.appendChild(item);
  }
}

function renderPrivateChats(filter = '') {
  const users = DB.users();
  const container = document.getElementById('private-list');
  container.innerHTML = '';

  // Find all users we have PM history with
  const pmUsers = new Set();
  for (const key of Object.keys(localStorage)) {
    if (key.startsWith(`${APP_KEY}_msgs_private_`)) {
      const parts = key.replace(`${APP_KEY}_msgs_private_`, '').split('_');
      if (parts.includes(currentUser.username)) {
        parts.forEach(u => { if (u !== currentUser.username) pmUsers.add(u); });
      }
    }
  }

  const filteredUsers = [...pmUsers].filter(u =>
    !filter || (users[u]?.displayName || u).toLowerCase().includes(filter.toLowerCase())
  );

  if (filteredUsers.length === 0) {
    container.innerHTML = '<div style="padding:16px;text-align:center;color:var(--text3);font-size:12px;">Aucun message privé</div>';
    updatePMBadge();
    return;
  }

  let totalUnread = 0;
  for (const username of filteredUsers) {
    const user = users[username];
    if (!user) continue;
    const pmId = getPMId(currentUser.username, username);
    const msgs = DB.messages(`private_${pmId}`);
    const lastMsg = msgs.slice(-1)[0];
    const unread = getUnreadCount(`private_${pmId}`);
    totalUnread += unread;

    const item = document.createElement('div');
    item.className = `conv-item ${currentChat?.type === 'private' && currentChat?.id === pmId ? 'active' : ''}`;
    item.onclick = () => openChat('private', pmId, username);
    item.innerHTML = `
      <div class="avatar sm" style="background:${user.color || '#6c63ff'}">${(user.displayName || user.username)[0].toUpperCase()}</div>
      <div class="conv-body">
        <div class="conv-name">${escHtml(user.displayName || user.username)}</div>
        <div class="conv-preview">${lastMsg ? escHtml(lastMsg.content.substring(0, 40)) : 'Démarrer une conversation'}</div>
      </div>
      <div class="conv-meta">
        <span class="conv-time">${lastMsg ? formatTime(lastMsg.timestamp) : ''}</span>
        ${unread > 0 ? `<span class="conv-unread">${unread}</span>` : ''}
      </div>
    `;
    container.appendChild(item);
  }

  updatePMBadge(totalUnread);
}

function renderUsers(filter = '') {
  const users = DB.users();
  const bans = DB.bans();
  const container = document.getElementById('users-list');
  container.innerHTML = '';

  const all = Object.values(users).filter(u =>
    u.username !== currentUser.username &&
    (!filter || (u.displayName || u.username).toLowerCase().includes(filter.toLowerCase()))
  );

  for (const user of all) {
    const banned = bans[user.username];
    const item = document.createElement('div');
    item.className = 'conv-item';
    item.onclick = () => startPM(user.username);
    item.innerHTML = `
      <div class="avatar sm" style="background:${user.color || '#6c63ff'};${banned ? 'filter:grayscale(1);opacity:0.5' : ''}">${(user.displayName || user.username)[0].toUpperCase()}</div>
      <div class="conv-body">
        <div class="conv-name" style="${banned ? 'text-decoration:line-through;color:var(--text3)' : ''}">${escHtml(user.displayName || user.username)}${banned ? ' <span style="font-size:10px;color:var(--red)">🚫</span>' : ''}</div>
        <div class="conv-preview text-muted" style="font-size:11px;font-family:var(--font-mono)">${user.role === 'admin' ? '👑 Admin' : '@' + user.username}</div>
      </div>
      <div class="conv-meta" style="flex-direction:row;gap:2px;align-items:center">
        ${!banned ? `<button class="icon-btn small" onclick="event.stopPropagation();startPM('${user.username}')" title="Message privé" style="font-size:14px">✉</button>` : ''}
        ${user.role !== 'admin' ? `<button class="icon-btn small" onclick="event.stopPropagation();showReportModal('${user.username}')" title="Signaler" style="font-size:13px">🚩</button>` : ''}
      </div>
    `;
    container.appendChild(item);
  }

  if (all.length === 0) {
    container.innerHTML = '<div style="padding:16px;text-align:center;color:var(--text3);font-size:12px;">Aucun autre membre</div>';
  }
}

function updatePMBadge(count) {
  const badge = document.getElementById('pm-badge');
  if (count > 0) {
    badge.textContent = count;
    badge.classList.remove('hidden');
  } else {
    badge.classList.add('hidden');
  }
}

function switchTab(tab) {
  ['groups','private','users'].forEach(t => {
    document.getElementById(`tab-${t}`).classList.toggle('active', t === tab);
    document.getElementById(`panel-${t}`).classList.toggle('hidden', t !== tab);
  });
}

function filterConversations(val) {
  renderGroups(val);
  renderPrivateChats(val);
  renderUsers(val);
}

// ===== CHAT =====
function openChat(type, id, pmPartner = null) {
  currentChat = { type, id, pmPartner };
  markRead(`${type}_${id}`);

  const chatArea = document.getElementById('chat-area');
  const welcomeScreen = document.getElementById('welcome-screen');
  chatArea.classList.remove('hidden');
  welcomeScreen.classList.add('hidden');

  // Mobile: hide sidebar
  document.getElementById('sidebar').classList.add('hidden-mobile');

  // Update header
  if (type === 'group') {
    const groups = DB.groups();
    const g = groups[id];
    if (!g) return;
    document.getElementById('chat-name').textContent = g.name;
    document.getElementById('chat-meta').textContent = `${g.members?.length || 0} membres`;
    document.getElementById('chat-avatar').textContent = g.icon || g.name[0];
    document.getElementById('chat-avatar').style.background = g.color || '#6c63ff';
    document.getElementById('chat-avatar').style.borderRadius = '10px';
    document.getElementById('manage-btn').classList.toggle('hidden', currentUser.role !== 'admin');
  } else {
    const users = DB.users();
    const partner = users[pmPartner];
    document.getElementById('chat-name').textContent = partner?.displayName || pmPartner;
    document.getElementById('chat-meta').textContent = `@${pmPartner}`;
    document.getElementById('chat-avatar').textContent = (partner?.displayName || pmPartner)[0].toUpperCase();
    document.getElementById('chat-avatar').style.background = partner?.color || '#6c63ff';
    document.getElementById('chat-avatar').style.borderRadius = '50%';
    document.getElementById('manage-btn').classList.add('hidden');
  }

  renderMessages();
  listenCurrentChat(); // 🔥 Firebase listener sur ce chat
  updateActiveConv();
  document.getElementById('message-input').focus();
  closeInfoPanel();
}

function hideChatMobile() {
  document.getElementById('sidebar').classList.remove('hidden-mobile');
  document.getElementById('chat-area').classList.add('hidden');
  currentChat = null;
}

function updateActiveConv() {
  document.querySelectorAll('.conv-item').forEach(el => el.classList.remove('active'));
}

function renderMessages() {
  if (!currentChat) return;
  const chatId = `msgs_${currentChat.type}_${currentChat.id}`;
  const msgs = _cache[chatId] || [];
  const container = document.getElementById('messages-list');
  container.innerHTML = '';

  const grouped = groupMessages(msgs);
  for (const group of grouped) {
    container.appendChild(renderMessageGroup(group));
  }

  scrollToBottom();
}

function groupMessages(msgs) {
  const groups = [];
  let current = null;

  for (const msg of msgs) {
    if (msg.type === 'system') {
      if (current) groups.push(current);
      current = null;
      groups.push({ type: 'system', msg });
      continue;
    }

    if (current && current.sender === msg.sender &&
        msg.timestamp - current.msgs[current.msgs.length-1].timestamp < 3 * 60 * 1000) {
      current.msgs.push(msg);
    } else {
      if (current) groups.push(current);
      current = { type: 'msg', sender: msg.sender, msgs: [msg] };
    }
  }
  if (current) groups.push(current);
  return groups;
}

function renderMessageGroup(group) {
  if (group.type === 'system') {
    const el = document.createElement('div');
    el.className = 'system-msg';
    el.textContent = group.msg.content;
    return el;
  }

  const users = DB.users();
  const sender = users[group.sender];
  const isOwn = group.sender === currentUser.username;

  const el = document.createElement('div');
  el.className = `msg-group ${isOwn ? 'own' : ''}`;

  // Header
  if (!isOwn) {
    const header = document.createElement('div');
    header.className = 'msg-header';
    header.innerHTML = `
      <div class="avatar" style="width:28px;height:28px;font-size:12px;background:${sender?.color || '#6c63ff'}">${(sender?.displayName || group.sender)[0].toUpperCase()}</div>
      <span class="msg-sender">${escHtml(sender?.displayName || group.sender)}</span>
      <span class="msg-time">${formatTime(group.msgs[0].timestamp)}</span>
    `;
    el.appendChild(header);
  }

  for (const msg of group.msgs) {
    const bubble = document.createElement('div');
    bubble.className = 'msg-bubble';
    bubble.dataset.id = msg.id;

    const actions = document.createElement('div');
    actions.className = 'msg-actions';
    actions.innerHTML = `
      <button class="msg-action-btn" onclick="addReaction('${msg.id}')" title="Réagir">😊</button>
      ${isOwn || currentUser.role === 'admin' ? `<button class="msg-action-btn" onclick="deleteMessage('${msg.id}')" title="Supprimer">🗑</button>` : ''}
    `;

    bubble.innerHTML = `${escHtml(msg.content)}`;
    bubble.appendChild(actions);

    // Reactions
    if (msg.reactions && Object.keys(msg.reactions).length > 0) {
      const reactDiv = document.createElement('div');
      reactDiv.className = 'msg-reactions';
      const counts = {};
      for (const [user, emoji] of Object.entries(msg.reactions)) {
        counts[emoji] = (counts[emoji] || 0) + 1;
      }
      for (const [emoji, count] of Object.entries(counts)) {
        const r = document.createElement('span');
        r.className = 'reaction';
        r.innerHTML = `${emoji} <span class="count">${count}</span>`;
        r.onclick = () => addReactionEmoji(msg.id, emoji);
        reactDiv.appendChild(r);
      }
      bubble.appendChild(reactDiv);
    }

    el.appendChild(bubble);
  }

  if (isOwn) {
    const timeEl = document.createElement('div');
    timeEl.style.cssText = 'font-size:11px;color:var(--text3);padding:2px 4px;font-family:var(--font-mono)';
    timeEl.textContent = formatTime(group.msgs[0].timestamp);
    el.appendChild(timeEl);
  }

  return el;
}

function sendMessage() {
  if (!currentChat) return;
  const input = document.getElementById('message-input');
  const content = input.value.trim();
  if (!content) return;

  const chatId = `msgs_${currentChat.type}_${currentChat.id}`;
  const msg = {
    id: genId(),
    sender: currentUser.username,
    content,
    timestamp: Date.now(),
    reactions: {}
  };

  DB.addMessage(chatId, msg);

  // ✅ AJOUTE ÇA (FIX PRINCIPAL)
  displayMessage(msg);

  input.value = '';
  input.style.height = 'auto';
  DB.clearTyping(chatId, currentUser.username);
}

  DB.addMessage(chatId, msg); // push Firebase natif
  input.value = '';
  input.style.height = 'auto';
  DB.clearTyping(chatId, currentUser.username);
  // Le listener Firebase met à jour renderMessages automatiquement
}

function handleKey(e) {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    sendMessage();
  }
}

function autoResize(el) {
  el.style.height = 'auto';
  el.style.height = Math.min(el.scrollHeight, 120) + 'px';
}

function sendTyping() {
  if (!currentChat) return;
  const chatId = `${currentChat.type}_${currentChat.id}`;
  DB.setTyping(chatId, currentUser.username, Date.now());
  broadcast({ type: 'typing', chatId, username: currentUser.username });
  clearTimeout(typingTimer);
  typingTimer = setTimeout(() => {
    DB.clearTyping(chatId, currentUser.username);
  }, 2000);
}

function deleteMessage(msgId) {
  if (!currentChat) return;
  const fbChatId = `msgs_${currentChat.type}_${currentChat.id}`;
  const msgs = _cache[fbChatId] || [];
  const msg = msgs.find(m => m.id === msgId);
  if (!msg) return;
  if (msg.sender !== currentUser.username && currentUser.role !== 'admin') return;

  if (window.FBDB) {
    // Cherche la clé Firebase du message (format push)
    window.FBDB.ref(fbChatId).orderByChild('id').equalTo(msgId).once('value', snap => {
      snap.forEach(child => child.ref.remove());
    });
  }
}

function addReaction(msgId) {
  const emojis = ['👍','❤️','😂','😮','😢','🎉','🔥','👏'];
  const pick = document.createElement('div');
  pick.style.cssText = 'display:flex;gap:4px;flex-wrap:wrap;';
  emojis.forEach(e => {
    const b = document.createElement('button');
    b.textContent = e;
    b.style.cssText = 'background:none;border:none;cursor:pointer;font-size:20px;padding:4px;border-radius:6px;transition:background 0.15s';
    b.onmouseover = () => b.style.background = 'var(--surface2)';
    b.onmouseout = () => b.style.background = 'none';
    b.onclick = () => { addReactionEmoji(msgId, e); closeModal(); };
    pick.appendChild(b);
  });
  openModal('Réagir', pick, []);
}

function addReactionEmoji(msgId, emoji) {
  if (!currentChat || !window.FBDB) return;
  const fbChatId = `msgs_${currentChat.type}_${currentChat.id}`;
  window.FBDB.ref(fbChatId).orderByChild('id').equalTo(msgId).once('value', snap => {
    snap.forEach(child => {
      const msg = child.val();
      const reactions = msg.reactions || {};
      if (reactions[currentUser.username] === emoji) {
        delete reactions[currentUser.username];
      } else {
        reactions[currentUser.username] = emoji;
      }
      child.ref.update({ reactions });
    });
  });
}

// ===== EMOJI PICKER =====
const EMOJIS = ['😀','😂','😍','🤔','😢','😡','👍','👎','❤️','🔥','🎉','✨','🙏','💪','👏','🤝','😊','🥳','😎','🤗','😴','🤯','🥰','😇','👀','💯','🚀','⭐','🌟','💫','🎯','🎮','🎵','📚','💻','📱','🌈','🦋','🌺','🍕','☕','🍰','🌙','☀️','⚡','🎨','🏆','🌍','💎'];

function toggleEmoji() {
  const picker = document.getElementById('emoji-picker');
  if (picker.classList.contains('hidden')) {
    const grid = document.getElementById('emoji-grid');
    if (!grid.children.length) {
      EMOJIS.forEach(e => {
        const b = document.createElement('button');
        b.className = 'emoji-btn';
        b.textContent = e;
        b.onclick = () => {
          const input = document.getElementById('message-input');
          input.value += e;
          input.focus();
          picker.classList.add('hidden');
        };
        grid.appendChild(b);
      });
    }
    picker.classList.remove('hidden');
  } else {
    picker.classList.add('hidden');
  }
}

document.addEventListener('click', (e) => {
  if (!e.target.closest('.emoji-picker') && !e.target.closest('.icon-btn')) {
    document.getElementById('emoji-picker')?.classList.add('hidden');
  }
});

// ===== PRIVATE MESSAGES =====
function startPM(username) {
  const pmId = getPMId(currentUser.username, username);
  openChat('private', pmId, username);
  switchTab('private');
  renderPrivateChats();
}

function showNewPM() {
  const users = DB.users();
  const others = Object.values(users).filter(u => u.username !== currentUser.username);

  let html = '<div class="user-check-list">';
  for (const u of others) {
    html += `
      <div class="user-check-item" onclick="startPM('${u.username}');closeModal()">
        <div class="avatar sm" style="background:${u.color || '#6c63ff'}">${(u.displayName || u.username)[0].toUpperCase()}</div>
        <div>
          <div style="font-weight:600;font-size:13px">${escHtml(u.displayName || u.username)}</div>
          <div style="font-size:11px;color:var(--text3)">@${u.username}</div>
        </div>
      </div>
    `;
  }
  html += '</div>';

  const el = document.createElement('div');
  el.innerHTML = html;
  openModal('Nouveau message privé', el, []);
}

// ===== GROUPS =====
function showCreateGroup() {
  if (currentUser.role !== 'admin') return toast('Seul un admin peut créer des groupes', 'error');
  const users = DB.users();
  const others = Object.values(users).filter(u => u.username !== currentUser.username);

  let membersHtml = others.map(u => `
    <div class="user-check-item">
      <input type="checkbox" id="member_${u.username}" value="${u.username}">
      <div class="avatar sm" style="background:${u.color || '#6c63ff'}">${(u.displayName || u.username)[0].toUpperCase()}</div>
      <label for="member_${u.username}" style="cursor:pointer">
        <div style="font-weight:600;font-size:13px">${escHtml(u.displayName || u.username)}</div>
        <div style="font-size:11px;color:var(--text3)">@${u.username}</div>
      </label>
    </div>
  `).join('');

  const el = document.createElement('div');
  el.innerHTML = `
    <div class="form-group">
      <label>Nom du groupe</label>
      <input type="text" id="new-group-name" placeholder="Ex: Équipe projet">
    </div>
    <div class="form-group">
      <label>Description</label>
      <input type="text" id="new-group-desc" placeholder="Description du groupe">
    </div>
    <div class="form-group">
      <label>Icône (emoji)</label>
      <input type="text" id="new-group-icon" placeholder="💬" maxlength="2" style="width:60px">
    </div>
    <div class="form-group">
      <label>Membres</label>
      <div class="user-check-list">${membersHtml}</div>
    </div>
  `;

  openModal('Créer un groupe', el, [
    { label: 'Annuler', cls: 'btn-cancel', action: closeModal },
    { label: 'Créer', cls: 'btn-confirm', action: createGroup }
  ]);
}

function createGroup() {
  const name = document.getElementById('new-group-name').value.trim();
  const desc = document.getElementById('new-group-desc').value.trim();
  const icon = document.getElementById('new-group-icon').value.trim() || '💬';

  if (!name) return toast('Donne un nom au groupe', 'error');

  const members = [currentUser.username];
  document.querySelectorAll('[id^="member_"]:checked').forEach(cb => members.push(cb.value));

  const colors = ['#6c63ff','#22c55e','#f59e0b','#ef4444','#06b6d4','#ec4899','#8b5cf6'];
  const id = name.toLowerCase().replace(/[^a-z0-9]/g,'_') + '_' + Date.now();
  const group = {
    id,
    name,
    description: desc,
    icon,
    createdBy: currentUser.username,
    createdAt: Date.now(),
    members,
    admins: [currentUser.username],
    color: colors[Math.floor(Math.random() * colors.length)]
  };

  const groups = DB.groups();
  groups[id] = group;
  DB.set('groups', groups);

  DB.addMessage(`group_${id}`, {
    id: genId(), type: 'system',
    content: `Groupe "${name}" créé par ${currentUser.displayName}`,
    timestamp: Date.now()
  });

  closeModal();
  renderGroups();
  openChat('group', id);
  broadcast({ type: 'group_created', group });
  toast(`Groupe "${name}" créé !`, 'success');
}

function showGroupManage() {
  if (!currentChat || currentChat.type !== 'group') return;
  if (currentUser.role !== 'admin') return;

  const groups = DB.groups();
  const g = groups[currentChat.id];
  if (!g) return;

  const users = DB.users();
  const membersHtml = (g.members || []).map(username => {
    const u = users[username];
    const isAdmin = (g.admins || []).includes(username);
    const isSelf = username === currentUser.username;
    return `
      <div class="member-manage-item">
        <div class="avatar sm" style="background:${u?.color || '#6c63ff'}">${(u?.displayName || username)[0].toUpperCase()}</div>
        <div>
          <div style="font-weight:600;font-size:13px">${escHtml(u?.displayName || username)}</div>
          <span class="role-tag ${isAdmin ? 'role-admin' : 'role-user'}">${isAdmin ? 'Admin' : 'Membre'}</span>
        </div>
        <div class="actions">
          ${!isSelf ? `
            ${!isAdmin ? `<button class="btn-sm-accent" onclick="toggleGroupAdmin('${currentChat.id}','${username}',true)">Promouvoir</button>` : `<button class="btn-sm-warn" onclick="toggleGroupAdmin('${currentChat.id}','${username}',false)">Rétrograder</button>`}
            <button class="btn-sm-danger" onclick="kickFromGroup('${currentChat.id}','${username}')">Exclure</button>
            <button class="btn-sm-danger" onclick="promptBan('${username}')" title="Bannir définitivement">🚫</button>
          ` : '<span style="font-size:11px;color:var(--text3)">Vous</span>'}
        </div>
      </div>
    `;
  }).join('');

  const nonMembers = Object.values(users).filter(u => !g.members?.includes(u.username));
  const addMembersHtml = nonMembers.length > 0 ? `
    <div class="form-group" style="margin-top:12px">
      <label>Ajouter des membres</label>
      <div class="user-check-list">
        ${nonMembers.map(u => `
          <div class="user-check-item">
            <input type="checkbox" id="add_member_${u.username}" value="${u.username}">
            <div class="avatar sm" style="background:${u.color || '#6c63ff'}">${(u.displayName || u.username)[0].toUpperCase()}</div>
            <label for="add_member_${u.username}" style="cursor:pointer">${escHtml(u.displayName || u.username)}</label>
          </div>
        `).join('')}
      </div>
    </div>
  ` : '';

  const el = document.createElement('div');
  el.innerHTML = `
    <div class="form-group">
      <label>Nom</label>
      <input type="text" id="edit-group-name" value="${escHtml(g.name)}">
    </div>
    <div class="form-group">
      <label>Description</label>
      <input type="text" id="edit-group-desc" value="${escHtml(g.description || '')}">
    </div>
    <div class="divider"></div>
    <label>Membres (${g.members?.length || 0})</label>
    <div style="margin-top:8px">${membersHtml}</div>
    ${addMembersHtml}
  `;

  openModal(`Gérer : ${g.name}`, el, [
    { label: 'Supprimer le groupe', cls: 'btn-danger', action: () => deleteGroup(currentChat.id) },
    { label: 'Annuler', cls: 'btn-cancel', action: closeModal },
    { label: 'Sauvegarder', cls: 'btn-confirm', action: () => saveGroupEdit(currentChat.id) }
  ]);
}

function saveGroupEdit(groupId) {
  const groups = DB.groups();
  const g = groups[groupId];
  const name = document.getElementById('edit-group-name').value.trim();
  const desc = document.getElementById('edit-group-desc').value.trim();
  if (!name) return toast('Le nom est requis', 'error');

  // Add selected new members
  document.querySelectorAll('[id^="add_member_"]:checked').forEach(cb => {
    if (!g.members.includes(cb.value)) g.members.push(cb.value);
  });

  g.name = name;
  g.description = desc;
  DB.set('groups', groups);
  closeModal();
  renderGroups();
  openChat('group', groupId);
  broadcast({ type: 'group_updated', groupId });
  toast('Groupe mis à jour', 'success');
}

function toggleGroupAdmin(groupId, username, promote) {
  const groups = DB.groups();
  const g = groups[groupId];
  if (!g.admins) g.admins = [];
  if (promote) {
    if (!g.admins.includes(username)) g.admins.push(username);
  } else {
    g.admins = g.admins.filter(u => u !== username);
  }
  DB.set('groups', groups);
  showGroupManage();
  toast(promote ? `${username} promu admin` : `${username} rétrogradé`, 'info');
}

function kickFromGroup(groupId, username) {
  const groups = DB.groups();
  const g = groups[groupId];
  g.members = (g.members || []).filter(u => u !== username);
  g.admins = (g.admins || []).filter(u => u !== username);
  DB.set('groups', groups);

  DB.addMessage(`group_${groupId}`, {
    id: genId(), type: 'system',
    content: `${username} a été exclu du groupe`,
    timestamp: Date.now()
  });

  showGroupManage();
  broadcast({ type: 'group_updated', groupId });
  toast(`${username} exclu du groupe`, 'info');
}

function deleteGroup(groupId) {
  if (!confirm('Supprimer ce groupe définitivement ?')) return;
  const groups = DB.groups();
  delete groups[groupId];
  DB.set('groups', groups);
  closeModal();
  currentChat = null;
  document.getElementById('chat-area').classList.add('hidden');
  document.getElementById('welcome-screen').classList.remove('hidden');
  renderGroups();
  broadcast({ type: 'group_deleted', groupId });
  toast('Groupe supprimé', 'info');
}

// ===== REPORT SYSTEM =====
function reportsDB() { return DB.get('reports', []); }

function submitReport(reportedUsername, reason, details) {
  const reports = reportsDB();
  const report = {
    id: genId(),
    reportedBy: currentUser.username,
    reportedUser: reportedUsername,
    reason,
    details: details || '',
    timestamp: Date.now(),
    status: 'pending' // pending | reviewed | dismissed
  };
  reports.push(report);
  DB.set('reports', reports);
  broadcast({ type: 'new_report' });
  updateAdminAlertDot();
  toast('Signalement envoyé aux admins', 'success');
}

function showReportModal(preselectedUser = '') {
  const users = DB.users();
  const others = Object.values(users).filter(u => u.username !== currentUser.username && u.role !== 'admin');

  const optionsHtml = others.map(u =>
    `<option value="${u.username}" ${u.username === preselectedUser ? 'selected' : ''}>${escHtml(u.displayName || u.username)} (@${u.username})</option>`
  ).join('');

  const el = document.createElement('div');
  el.innerHTML = `
    <div class="form-group">
      <label>Utilisateur à signaler</label>
      <select id="report-user">
        <option value="">-- Choisir un membre --</option>
        ${optionsHtml}
      </select>
    </div>
    <div class="form-group">
      <label>Raison</label>
      <select id="report-reason">
        <option value="spam">📢 Spam / Messages abusifs</option>
        <option value="harassment">😡 Harcèlement / Insultes</option>
        <option value="inappropriate">🔞 Contenu inapproprié</option>
        <option value="impersonation">🎭 Usurpation d'identité</option>
        <option value="other">❓ Autre</option>
      </select>
    </div>
    <div class="form-group">
      <label>Détails (optionnel)</label>
      <textarea id="report-details" placeholder="Décris le problème en quelques mots..."></textarea>
    </div>
  `;

  openModal('🚩 Signaler un utilisateur', el, [
    { label: 'Annuler', cls: 'btn-cancel', action: closeModal },
    {
      label: 'Envoyer le signalement', cls: 'btn-confirm',
      action: () => {
        const user = document.getElementById('report-user').value;
        const reason = document.getElementById('report-reason').value;
        const details = document.getElementById('report-details').value.trim();
        if (!user) return toast('Choisis un utilisateur à signaler', 'error');
        submitReport(user, reason, details);
        closeModal();
      }
    }
  ]);
}

function updateAdminAlertDot() {
  if (currentUser?.role !== 'admin') return;
  const reports = reportsDB().filter(r => r.status === 'pending');
  const dot = document.getElementById('admin-alert-dot');
  if (dot) dot.classList.toggle('hidden', reports.length === 0);
}

// ===== ADMIN PANEL =====
function showAdminPanel() {
  if (currentUser.role !== 'admin') return;

  const users = DB.users();
  const bans = DB.bans();
  const reports = reportsDB();
  const pendingReports = reports.filter(r => r.status === 'pending');

  const el = document.createElement('div');
  el.innerHTML = `
    <div class="admin-tabs">
      <button class="admin-tab active" onclick="switchAdminTab('users', this)">👤 Membres <span class="badge" style="background:var(--text3)">${Object.keys(users).length}</span></button>
      <button class="admin-tab" onclick="switchAdminTab('reports', this)">🚩 Signalements ${pendingReports.length > 0 ? `<span class="badge">${pendingReports.length}</span>` : ''}</button>
      <button class="admin-tab" onclick="switchAdminTab('bans', this)">🚫 Bans <span class="badge" style="background:var(--text3)">${Object.keys(bans).length}</span></button>
    </div>

    <!-- USERS TAB -->
    <div id="admin-tab-users" class="admin-tab-content">
      ${Object.values(users).map(u => {&
        const isBanned = !!bans[u.username];
        const isSelf = u.username === currentUser.username;
        return `
          <div class="member-manage-item" style="${isBanned ? 'opacity:0.5;border-color:rgba(239,68,68,0.3)' : ''}">
            <div class="avatar sm" style="background:${u.color || '#6c63ff'}">${(u.displayName || u.username)[0].toUpperCase()}</div>
            <div style="flex:1;min-width:0">
              <div style="font-weight:600;font-size:13px">${escHtml(u.displayName || u.username)}</div>
              <div style="font-size:11px;color:var(--text3)">@${u.username} · ${new Date(u.createdAt||Date.now()).toLocaleDateString('fr-FR')}</div>
              ${isBanned ? `<div style="font-size:11px;color:var(--red)">🚫 Banni : ${escHtml(bans[u.username].reason)}</div>` : ''}
            </div>
            <span class="role-tag ${u.role === 'admin' ? 'role-admin' : 'role-user'}">${u.role === 'admin' ? 'Admin' : 'Membre'}</span>
            ${!isSelf ? `
              <div class="actions" style="flex-direction:column;gap:4px">
                ${isBanned
                  ? `<button class="btn-sm-accent" onclick="unbanUser('${u.username}');closeModal();showAdminPanel()">Débannir</button>`
                  : `<button class="btn-sm-danger" onclick="closeModal();promptBan('${u.username}')">🚫 Bannir</button>`
                }
                <button class="btn-sm-danger" onclick="confirmDeleteUser('${u.username}')">🗑 Supprimer</button>
              </div>
            ` : '<span style="font-size:10px;color:var(--text3)">Vous</span>'}
          </div>
        `;
      }).join('')}
    </div>

    <!-- REPORTS TAB -->
    <div id="admin-tab-reports" class="admin-tab-content hidden">
      ${reports.length === 0
        ? '<p style="text-align:center;color:var(--text3);padding:20px 0;font-size:13px">Aucun signalement</p>'
        : [...reports].reverse().map(r => {
          const reporter = users[r.reportedBy];
          const reported = users[r.reportedUser];
          const reasonLabels = { spam:'📢 Spam', harassment:'😡 Harcèlement', inappropriate:'🔞 Contenu inapproprié', impersonation:'🎭 Usurpation', other:'❓ Autre' };
          return `
            <div class="report-card ${r.status}" data-id="${r.id}">
              <div class="report-header">
                <span class="report-status-tag ${r.status}">${r.status === 'pending' ? '⏳ En attente' : r.status === 'reviewed' ? '✅ Traité' : '❌ Rejeté'}</span>
                <span style="font-size:11px;color:var(--text3)">${formatTime(r.timestamp)}</span>
              </div>
              <div style="margin:8px 0">
                <span style="font-size:13px">
                  <strong style="color:var(--accent2)">${escHtml(reporter?.displayName || r.reportedBy)}</strong>
                  <span style="color:var(--text3)"> a signalé </span>
                  <strong style="color:var(--red)">${escHtml(reported?.displayName || r.reportedUser)}</strong>
                </span>
              </div>
              <div style="font-size:12px;color:var(--text2);margin-bottom:4px">${reasonLabels[r.reason] || r.reason}</div>
              ${r.details ? `<div style="font-size:12px;color:var(--text3);font-style:italic">"${escHtml(r.details)}"</div>` : ''}
              ${r.status === 'pending' ? `
                <div style="display:flex;gap:6px;margin-top:10px">
                  <button class="btn-sm-danger" onclick="handleReport('${r.id}','ban')">🚫 Bannir</button>
                  <button class="btn-sm-accent" onclick="handleReport('${r.id}','reviewed')">✅ Traité</button>
                  <button style="background:var(--bg3);color:var(--text3);border:none;padding:4px 10px;border-radius:6px;cursor:pointer;font-size:12px" onclick="handleReport('${r.id}','dismissed')">Rejeter</button>
                </div>
              ` : ''}
            </div>
          `;
        }).join('')
      }
    </div>

    <!-- BANS TAB -->
    <div id="admin-tab-bans" class="admin-tab-content hidden">
      ${Object.keys(bans).length === 0
        ? '<p style="text-align:center;color:var(--text3);padding:20px 0;font-size:13px">Aucun utilisateur banni</p>'
        : Object.entries(bans).map(([username, ban]) => {
          const u = users[username];
          return `
            <div class="member-manage-item" style="border-color:rgba(239,68,68,0.3)">
              <div class="avatar sm" style="background:${u?.color || '#ef4444'};filter:grayscale(1)">${(u?.displayName || username)[0].toUpperCase()}</div>
              <div style="flex:1">
                <div style="font-weight:600;font-size:13px">${escHtml(u?.displayName || username)}</div>
                <div style="font-size:11px;color:var(--red)">🚫 ${escHtml(ban.reason)}</div>
                <div style="font-size:10px;color:var(--text3)">Par ${ban.bannedBy} · ${new Date(ban.bannedAt).toLocaleDateString('fr-FR')}</div>
              </div>
              <div class="actions">
                <button class="btn-sm-accent" onclick="unbanUser('${username}');closeModal();showAdminPanel()">Débannir</button>
                <button class="btn-sm-danger" onclick="confirmDeleteUser('${username}')">🗑 Suppr.</button>
              </div>
            </div>
          `;
        }).join('')
      }
    </div>
  `;

  openModal('⚙ Panneau Administrateur', el, [
    { label: 'Fermer', cls: 'btn-cancel', action: closeModal }
  ]);
}

function switchAdminTab(tab, btn) {
  document.querySelectorAll('.admin-tab-content').forEach(t => t.classList.add('hidden'));
  document.querySelectorAll('.admin-tab').forEach(b => b.classList.remove('active'));
  document.getElementById(`admin-tab-${tab}`)?.classList.remove('hidden');
  btn.classList.add('active');
}

function handleReport(reportId, action) {
  const reports = reportsDB();
  const report = reports.find(r => r.id === reportId);
  if (!report) return;

  if (action === 'ban') {
    report.status = 'reviewed';
    DB.set('reports', reports);
    closeModal();
    promptBan(report.reportedUser);
  } else {
    report.status = action;
    DB.set('reports', reports);
    updateAdminAlertDot();
    closeModal();
    showAdminPanel();
    toast(action === 'reviewed' ? 'Signalement marqué traité' : 'Signalement rejeté', 'info');
  }
}

function confirmDeleteUser(username) {
  if (username === 'admin') return toast('Impossible de supprimer le compte admin', 'error');
  const users = DB.users();
  const u = users[username];

  const el = document.createElement('div');
  el.innerHTML = `
    <div style="text-align:center;padding:8px 0 16px">
      <div class="avatar lg" style="background:${u?.color || '#6c63ff'};margin:0 auto 12px">${(u?.displayName || username)[0].toUpperCase()}</div>
      <p style="color:var(--text2);font-size:14px">Supprimer définitivement le compte de<br><strong style="color:var(--text)">${escHtml(u?.displayName || username)}</strong> (@${username}) ?</p>
      <p style="color:var(--red);font-size:12px;margin-top:8px">⚠️ Cette action est irréversible. Tous ses messages resteront visibles.</p>
    </div>
  `;

  openModal('Supprimer un compte', el, [
    { label: 'Annuler', cls: 'btn-cancel', action: () => { closeModal(); showAdminPanel(); } },
    {
      label: '🗑 Supprimer définitivement', cls: 'btn-danger',
      action: () => {
        deleteUserAccount(username);
        closeModal();
        showAdminPanel();
      }
    }
  ]);
}

function deleteUserAccount(username) {
  if (username === 'admin') return toast('Impossible de supprimer le compte admin', 'error');

  // Remove from users
  const users = DB.users();
  delete users[username];
  DB.set('users', users);

  // Remove from all groups
  const groups = DB.groups();
  for (const g of Object.values(groups)) {
    g.members = (g.members || []).filter(u => u !== username);
    g.admins = (g.admins || []).filter(u => u !== username);
  }
  DB.set('groups', groups);

  // Remove from bans
  DB.unbanUser(username);

  // Clean reports about/by this user
  const reports = reportsDB().filter(r => r.reportedBy !== username && r.reportedUser !== username);
  DB.set('reports', reports);

  broadcast({ type: 'user_deleted', username });
  renderGroups();
  renderPrivateChats();
  renderUsers();
  updateAdminAlertDot();
  toast(`Compte @${username} supprimé`, 'info');
}

// ===== BAN SYSTEM =====
function banUser(username, reason) {
  if (currentUser.role !== 'admin') return toast('Accès refusé', 'error');
  if (username === 'admin') return toast('Impossible de bannir l\'admin', 'error');
  DB.banUser(username, reason, currentUser.username);

  // Kick from all groups
  const groups = DB.groups();
  for (const g of Object.values(groups)) {
    g.members = (g.members || []).filter(u => u !== username);
    g.admins = (g.admins || []).filter(u => u !== username);
  }
  DB.set('groups', groups);

  broadcast({ type: 'user_banned', username });
  toast(`🚫 ${username} banni`, 'info');
  renderGroups();
  renderUsers();
}

function unbanUser(username) {
  if (currentUser.role !== 'admin') return toast('Accès refusé', 'error');
  DB.unbanUser(username);
  toast(`✅ ${username} débanni`, 'success');
  showBanPanel();
  renderUsers();
}

function showBanPanel() {
  if (currentUser.role !== 'admin') return toast('Accès refusé', 'error');
  const bans = DB.bans();
  const users = DB.users();
  const allUsers = Object.values(users).filter(u => u.username !== currentUser.username && u.username !== 'admin');

  const el = document.createElement('div');

  // Banned users section
  const bannedList = Object.entries(bans);
  let bannedHtml = '';
  if (bannedList.length === 0) {
    bannedHtml = '<p style="color:var(--text3);font-size:13px;text-align:center;padding:12px 0">Aucun utilisateur banni</p>';
  } else {
    bannedHtml = bannedList.map(([username, ban]) => {
      const u = users[username];
      return `
        <div class="member-manage-item" style="border-color:rgba(239,68,68,0.3)">
          <div class="avatar sm" style="background:${u?.color || '#ef4444'}">${(u?.displayName || username)[0].toUpperCase()}</div>
          <div style="flex:1">
            <div style="font-weight:600;font-size:13px">${escHtml(u?.displayName || username)}</div>
            <div style="font-size:11px;color:var(--red)">🚫 ${escHtml(ban.reason)}</div>
            <div style="font-size:10px;color:var(--text3)">Banni le ${new Date(ban.bannedAt).toLocaleDateString('fr-FR')}</div>
          </div>
          <div class="actions">
            <button class="btn-sm-accent" onclick="unbanUser('${username}')">Débannir</button>
          </div>
        </div>
      `;
    }).join('');
  }

  // Active users — ban button
  const activeHtml = allUsers.filter(u => !bans[u.username]).map(u => `
    <div class="member-manage-item">
      <div class="avatar sm" style="background:${u.color || '#6c63ff'}">${(u.displayName || u.username)[0].toUpperCase()}</div>
      <div style="flex:1">
        <div style="font-weight:600;font-size:13px">${escHtml(u.displayName || u.username)}</div>
        <div style="font-size:11px;color:var(--text3)">@${u.username}</div>
      </div>
      <div class="actions">
        <button class="btn-sm-danger" onclick="promptBan('${u.username}')">Bannir</button>
      </div>
    </div>
  `).join('');

  el.innerHTML = `
    <div style="margin-bottom:16px">
      <div class="info-section-title" style="margin-bottom:8px">Utilisateurs bannis (${bannedList.length})</div>
      ${bannedHtml}
    </div>
    <div class="divider"></div>
    <div style="margin-top:16px">
      <div class="info-section-title" style="margin-bottom:8px">Membres actifs</div>
      ${activeHtml || '<p style="color:var(--text3);font-size:13px;text-align:center;padding:12px 0">Aucun membre</p>'}
    </div>
  `;

  openModal('🚫 Gestion des bans', el, [
    { label: 'Fermer', cls: 'btn-cancel', action: closeModal }
  ]);
}

function promptBan(username) {
  const el = document.createElement('div');
  el.innerHTML = `
    <p style="margin-bottom:12px;color:var(--text2)">Bannir <strong style="color:var(--text)">${escHtml(username)}</strong> ?<br>
    L'utilisateur ne pourra plus se connecter.</p>
    <div class="form-group">
      <label>Raison du ban</label>
      <input type="text" id="ban-reason" placeholder="Ex: Non-respect des règles...">
    </div>
  `;
  openModal(`Bannir ${username}`, el, [
    { label: 'Annuler', cls: 'btn-cancel', action: () => { closeModal(); showBanPanel(); } },
    {
      label: '🚫 Confirmer le ban', cls: 'btn-danger',
      action: () => {
        const reason = document.getElementById('ban-reason').value.trim() || 'Aucune raison précisée';
        banUser(username, reason);
        closeModal();
        showBanPanel();
      }
    }
  ]);
}

// ===== INFO PANEL =====
function toggleChatInfo() {
  const panel = document.getElementById('info-panel');
  if (panel.classList.contains('hidden')) {
    openInfoPanel();
  } else {
    closeInfoPanel();
  }
}

function openInfoPanel() {
  if (!currentChat) return;
  const panel = document.getElementById('info-panel');
  panel.classList.remove('hidden');

  const content = document.getElementById('info-content');

  if (currentChat.type === 'group') {
    const groups = DB.groups();
    const g = groups[currentChat.id];
    const users = DB.users();

    content.innerHTML = `
      <div style="text-align:center;padding:20px 0">
        <div class="avatar lg" style="background:${g.color};border-radius:16px;margin:0 auto 12px">${g.icon || g.name[0]}</div>
        <h3 style="font-family:var(--font-display);font-size:18px">${escHtml(g.name)}</h3>
        <p style="color:var(--text2);font-size:13px;margin-top:4px">${escHtml(g.description || '')}</p>
      </div>
      <div class="divider"></div>
      <div class="info-section">
        <div class="info-section-title">Membres (${g.members?.length || 0})</div>
        ${(g.members || []).map(u => {
          const user = users[u];
          const isAdmin = (g.admins || []).includes(u);
          return `
            <div class="info-member" onclick="startPM('${u}')">
              <div class="avatar sm" style="background:${user?.color || '#6c63ff'}">${(user?.displayName || u)[0].toUpperCase()}</div>
              <div style="flex:1">
                <div style="font-size:13px;font-weight:600">${escHtml(user?.displayName || u)}</div>
                <div style="font-size:11px;color:var(--text3)">@${u}</div>
              </div>
              ${isAdmin ? '<span class="role-tag role-admin">Admin</span>' : ''}
            </div>
          `;
        }).join('')}
      </div>
    `;
  } else {
    const users = DB.users();
    const partner = users[currentChat.pmPartner];
    content.innerHTML = `
      <div style="text-align:center;padding:20px 0">
        <div class="avatar lg" style="background:${partner?.color || '#6c63ff'};margin:0 auto 12px">${(partner?.displayName || currentChat.pmPartner)[0].toUpperCase()}</div>
        <h3 style="font-family:var(--font-display);font-size:18px">${escHtml(partner?.displayName || currentChat.pmPartner)}</h3>
        <p style="color:var(--text3);font-size:12px;font-family:var(--font-mono)">@${currentChat.pmPartner}</p>
        <span class="role-tag ${partner?.role === 'admin' ? 'role-admin' : 'role-user'}" style="margin-top:8px;display:inline-block">${partner?.role === 'admin' ? 'Administrateur' : 'Membre'}</span>
      </div>
      <div class="divider"></div>
      <div style="text-align:center;color:var(--text3);font-size:12px">
        Membre depuis ${new Date(partner?.createdAt || Date.now()).toLocaleDateString('fr-FR')}
      </div>
    `;
  }
}

function closeInfoPanel() {
  document.getElementById('info-panel').classList.add('hidden');
}

// ===== PROFILE =====
function showProfile() {
  const el = document.createElement('div');
  el.innerHTML = `
    <div style="text-align:center;margin-bottom:20px">
      <div class="avatar lg" style="background:${currentUser.color || '#6c63ff'};margin:0 auto 12px">${(currentUser.displayName || currentUser.username)[0].toUpperCase()}</div>
      <span class="role-tag ${currentUser.role === 'admin' ? 'role-admin' : 'role-user'}">${currentUser.role === 'admin' ? 'Administrateur' : 'Membre'}</span>
    </div>
    <div class="form-group">
      <label>Nom affiché</label>
      <input type="text" id="profile-displayname" value="${escHtml(currentUser.displayName || '')}">
    </div>
    <div class="form-group">
      <label>Nom d'utilisateur</label>
      <input type="text" value="${escHtml(currentUser.username)}" disabled style="opacity:0.5">
    </div>
    <div class="form-group">
      <label>Nouveau mot de passe (laisser vide pour ne pas changer)</label>
      <input type="password" id="profile-password" placeholder="Nouveau mot de passe">
    </div>
    <div class="form-group">
      <label>Couleur</label>
      <div style="display:flex;gap:8px;flex-wrap:wrap;margin-top:4px">
        ${['#6c63ff','#22c55e','#f59e0b','#ef4444','#06b6d4','#ec4899','#8b5cf6','#ff7849'].map(c => `
          <div onclick="document.getElementById('profile-color').value='${c}';document.querySelectorAll('.color-swatch').forEach(s=>s.style.outline='none');this.style.outline='2px solid white'"
            class="color-swatch" style="width:28px;height:28px;border-radius:50%;background:${c};cursor:pointer;outline:${c === currentUser.color ? '2px solid white' : 'none'};outline-offset:2px"></div>
        `).join('')}
        <input type="hidden" id="profile-color" value="${currentUser.color || '#6c63ff'}">
      </div>
    </div>
  `;

  openModal('Mon profil', el, [
    { label: 'Annuler', cls: 'btn-cancel', action: closeModal },
    { label: 'Sauvegarder', cls: 'btn-confirm', action: saveProfile }
  ]);
}

function saveProfile() {
  const displayName = document.getElementById('profile-displayname').value.trim();
  const password = document.getElementById('profile-password').value;
  const color = document.getElementById('profile-color').value;

  if (!displayName) return toast('Le nom affiché est requis', 'error');

  const users = DB.users();
  users[currentUser.username].displayName = displayName;
  users[currentUser.username].color = color;
  if (password) users[currentUser.username].password = btoa(password);

  DB.set('users', users);
  currentUser = users[currentUser.username];
  sessionStorage.setItem('nexchat_session', JSON.stringify(currentUser));

  closeModal();
  updateSidebarUser();
  toast('Profil mis à jour', 'success');
  broadcast({ type: 'profile_updated', username: currentUser.username });
}

// ===== REAL-TIME TYPING INDICATOR =====
// Firebase gère le temps réel — on garde juste un timer pour afficher l'indicateur
function startPolling() {
  clearInterval(pollTimer);
  // Vérifie l'indicateur de frappe toutes les 500ms (léger)
  pollTimer = setInterval(() => {
    if (!currentChat) return;
    const chatId = `${currentChat.type}_${currentChat.id}`;
    const typing = DB.typing();
    const chatTyping = typing[chatId] || {};
    const now = Date.now();
    const others = Object.entries(chatTyping)
      .filter(([u, ts]) => u !== currentUser.username && now - ts < 2000)
      .map(([u]) => getDisplayName(u));
    const indicator = document.getElementById('typing-indicator');
    if (others.length > 0) {
      indicator.classList.remove('hidden');
      scrollToBottom();
    } else {
      indicator.classList.add('hidden');
    }
  }, 500);
}

function broadcast() {} // No-op : Firebase gère la sync en temps réel

// ===== READ STATUS =====
const READ_KEY = 'reads';
function getReads() { return DB.get(READ_KEY, {}); }

function markRead(chatId) {
  const msgs = _cache[chatId] || [];
  if (msgs.length > 0) {
    const reads = { ...getReads() };
    if (!reads[currentUser.username]) reads[currentUser.username] = {};
    reads[currentUser.username][chatId] = msgs[msgs.length - 1].timestamp;
    DB.set(READ_KEY, reads);
  }
}

function getUnreadCount(chatId) {
  const reads = getReads();
  const lastRead = reads[currentUser?.username]?.[chatId] || 0;
  const msgs = DB.messages(chatId);
  return msgs.filter(m => m.timestamp > lastRead && m.sender !== currentUser?.username && m.type !== 'system').length;
}

// ===== WELCOME STATS =====
function updateWelcomeStats() {
  const users = DB.users();
  const groups = DB.groups();
  const el = document.getElementById('welcome-stats');
  if (el) {
    el.innerHTML = `
      <div class="stat-card"><div class="stat-num">${Object.keys(users).length}</div><div class="stat-label">Membres</div></div>
      <div class="stat-card"><div class="stat-num">${Object.keys(groups).length}</div><div class="stat-label">Groupes</div></div>
    `;
  }
}

// ===== MODAL =====
function openModal(title, bodyEl, buttons) {
  document.getElementById('modal-title').textContent = title;
  const body = document.getElementById('modal-body');
  body.innerHTML = '';
  if (typeof bodyEl === 'string') body.innerHTML = bodyEl;
  else body.appendChild(bodyEl);

  const footer = document.getElementById('modal-footer');
  footer.innerHTML = '';
  (buttons || []).forEach(btn => {
    const b = document.createElement('button');
    b.textContent = btn.label;
    b.className = btn.cls;
    b.onclick = btn.action;
    footer.appendChild(b);
  });

  document.getElementById('modal-overlay').classList.remove('hidden');
}

function closeModal() {
  document.getElementById('modal-overlay').classList.add('hidden');
}

// ===== TOAST =====
function toast(msg, type = 'info') {
  const icons = { success: '✅', error: '❌', info: 'ℹ️' };
  const el = document.createElement('div');
  el.className = `toast ${type}`;
  el.innerHTML = `<span class="toast-icon">${icons[type]}</span><span>${escHtml(msg)}</span>`;
  document.getElementById('toast-container').appendChild(el);
  setTimeout(() => { el.style.opacity = '0'; el.style.transform = 'translateX(20px)'; el.style.transition = '0.3s'; setTimeout(() => el.remove(), 300); }, 3000);
}

// ===== NOTIFICATIONS =====
function toggleNotifications() {
  if (Notification.permission === 'default') {
    Notification.requestPermission().then(p => {
      if (p === 'granted') toast('Notifications activées', 'success');
      else toast('Notifications refusées', 'error');
    });
  } else if (Notification.permission === 'granted') {
    toast('Notifications déjà actives', 'info');
  } else {
    toast('Notifications bloquées par le navigateur', 'error');
  }
}

// ===== UTILS =====
function genId() {
  return Date.now().toString(36) + Math.random().toString(36).substr(2, 6);
}

function getPMId(a, b) {
  return [a, b].sort().join('_');
}

function formatTime(ts) {
  if (!ts) return '';
  const d = new Date(ts);
  const now = new Date();
  if (d.toDateString() === now.toDateString()) {
    return d.toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' });
  }
  return d.toLocaleDateString('fr-FR', { day: '2-digit', month: '2-digit' });
}

function escHtml(str) {
  if (!str) return '';
  return str.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

function getDisplayName(username) {
  const users = DB.users();
  return users[username]?.displayName || username;
}

function scrollToBottom() {
  const c = document.getElementById('messages-container');
  if (c) c.scrollTop = c.scrollHeight;
}

// ===== START =====
window.addEventListener('load', init);

// Cross-tab sync via storage event
window.addEventListener('storage', (e) => {
  if (e.key === `${APP_KEY}_ping`) {
    if (currentChat) renderMessages();
    renderGroups();
    renderPrivateChats();
    renderUsers();
  }
});

/* ── Slacker Frontend — vanilla JS SPA ───────────────── */

// ── State ──────────────────────────────────────────────
const state = {
  team: null,
  channels: [],        // from /channels/rich
  users: {},           // userId → user object
  currentChannel: null, // channel object
  messages: [],        // current channel messages
  threadTs: null,      // open thread parent ts
  threadMessages: [],
};

// ── API layer ──────────────────────────────────────────
const api = {
  async getTeam()           { return (await fetch('/team').then(r => r.json())).team; },
  async getChannels()       { return (await fetch('/channels/rich').then(r => r.json())).channels; },
  async getUsers()          { return (await fetch('/users/rich').then(r => r.json())).users; },
  async getRecent(ch, lim)  { return (await fetch(`/recent/${ch}/rich?limit=${lim || 200}`).then(r => r.json())).messages; },
  async getThread(ch, ts)   { return (await fetch(`/thread/${ch}/${ts}/rich`).then(r => r.json())).messages; },
  async search(query)       { return (await fetch('/search', { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify({ query, limit: 50 }) }).then(r => r.json())).results; },
  async getPins(ch)         { return (await fetch(`/pins/${ch}`).then(r => r.json())).pins; },
  async getBookmarks(ch)    { return (await fetch(`/bookmarks/${ch}`).then(r => r.json())).bookmarks; },
};

// ── DOM refs ───────────────────────────────────────────
const $ = (sel) => document.querySelector(sel);
const $channels = $('#channels');
const $dms = $('#dms');
const $messages = $('#messages');
const $threadMessages = $('#thread-messages');
const $searchResults = $('#search-results');

// ── Init ───────────────────────────────────────────────
async function init() {
  try {
    const [team, channels, users] = await Promise.all([
      api.getTeam(),
      api.getChannels(),
      api.getUsers(),
    ]);

    state.team = team;
    state.channels = channels;
    for (const u of users) state.users[u.id] = u;

    renderTeam();
    renderSidebar();

    // Auto-select first channel with messages
    const first = channels.find(c => c.message_count > 0 && c.name);
    if (first) selectChannel(first.id);
  } catch (err) {
    $messages.innerHTML = `<div class="empty-state"><h3>Could not load data</h3><p>${esc(err.message)}</p></div>`;
  }
}

// ── Render team header ─────────────────────────────────
function renderTeam() {
  if (!state.team) return;
  $('#team-name').textContent = state.team.name || 'Slacker';
  const icon = state.team.icon;
  if (icon) {
    // icon can be a JSON string or an object
    let iconObj = icon;
    if (typeof icon === 'string') { try { iconObj = JSON.parse(icon); } catch { iconObj = null; } }
    const url = iconObj?.image_88 || iconObj?.image_68 || iconObj?.image_44 || iconObj?.image_34 || '';
    if (url) {
      $('#team-icon').src = url;
    }
  }
  document.title = `Slacker - ${state.team.name || 'Workspace'}`;
}

// ── Render sidebar ─────────────────────────────────────
function renderSidebar() {
  const regularChannels = state.channels.filter(c => c.name && !c.name.startsWith('mpdm-'));
  const dmChannels = state.channels.filter(c => !c.name || c.name.startsWith('mpdm-'));

  $channels.innerHTML = regularChannels.map(ch => {
    const icon = ch.is_private ? '&#128274;' : '#';
    const count = ch.message_count || 0;
    return `
      <li data-id="${esc(ch.id)}" title="${esc(ch.topic || ch.purpose || '')}">
        <span class="ch-icon">${icon}</span>
        <span class="ch-name">${esc(ch.name)}</span>
        ${count ? `<span class="unread-badge">${fmtCount(count)}</span>` : ''}
      </li>`;
  }).join('');

  if (dmChannels.length) {
    $dms.innerHTML = dmChannels.map(ch => {
      const label = ch.name ? ch.name.replace(/^mpdm-/, '').replace(/-+/g, ', ').replace(/,\s*$/, '') : ch.id;
      return `
        <li data-id="${esc(ch.id)}">
          <span class="ch-icon">&#128172;</span>
          <span class="ch-name">${esc(label)}</span>
        </li>`;
    }).join('');
  } else {
    $('#dm-list').style.display = 'none';
  }

  // Click handlers
  $channels.addEventListener('click', onChannelClick);
  $dms.addEventListener('click', onChannelClick);
}

function onChannelClick(e) {
  const li = e.target.closest('li');
  if (!li) return;
  selectChannel(li.dataset.id);
}

// ── Select channel ─────────────────────────────────────
async function selectChannel(channelId) {
  // Update active state
  document.querySelectorAll('#channels li, #dms li').forEach(li => li.classList.remove('active'));
  const li = document.querySelector(`li[data-id="${channelId}"]`);
  if (li) li.classList.add('active');

  const ch = state.channels.find(c => c.id === channelId);
  state.currentChannel = ch;

  // Update header
  const name = ch?.name || ch?.id || '?';
  const prefix = ch?.is_private ? '&#128274; ' : '# ';
  $('#channel-title').innerHTML = `${prefix}${esc(name)}`;
  $('#channel-topic').textContent = ch?.topic || '';
  $('#channel-stats').textContent = ch?.message_count ? `${fmtCount(ch.message_count)} messages` : '';

  // Close thread + overlays
  closeThread();
  closeOverlays();

  // Load messages (skeleton loader)
  $messages.innerHTML = renderSkeletonMessages(8);
  try {
    const msgs = await api.getRecent(channelId, 300);
    state.messages = msgs.reverse(); // API returns newest first, we want oldest first
    renderMessages($messages, state.messages, true);
    // Scroll to bottom
    $messages.scrollTop = $messages.scrollHeight;
  } catch (err) {
    $messages.innerHTML = `<div class="empty-state"><h3>Error loading messages</h3><p>${esc(err.message)}</p></div>`;
  }
}

// ── Render messages ────────────────────────────────────
function renderMessages(container, messages, showDayDividers = false) {
  if (!messages.length) {
    container.innerHTML = '<div class="empty-state"><h3>No messages</h3></div>';
    return;
  }

  let html = '';
  let lastDate = '';
  let lastUser = '';

  for (const msg of messages) {
    const date = tsToDate(msg.ts);
    const dateStr = date.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' });

    if (showDayDividers && dateStr !== lastDate) {
      html += `<div class="day-divider"><span>${dateStr}</span></div>`;
      lastDate = dateStr;
      lastUser = ''; // reset grouping on date change
    }

    const sameAuthor = msg.user_id === lastUser;
    const isSystem = isSystemMessage(msg);
    const classes = ['message'];
    if (sameAuthor && !isSystem) classes.push('same-author');
    if (isSystem) classes.push('system-message');

    const user = state.users[msg.user_id];
    const displayName = msg.bot_profile_name || user?.display_name || user?.real_name || user?.name || msg.user_id || 'Unknown';
    const avatarUrl = msg.user_avatar_url || user?.avatar_url || '';
    const isBot = !!msg.bot_id || !!msg.bot_profile_name || user?.is_bot || !!msg.user_is_bot;
    const time = date.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
    const isEdited = !!msg.edited_at;

    html += `<div class="${classes.join(' ')}" data-ts="${esc(msg.ts)}" data-channel="${esc(msg.channel_id)}">`;

    const fullTs = date.toLocaleString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric', hour: 'numeric', minute: '2-digit', second: '2-digit' });

    // Avatar (clickable for profile popover)
    const avatarClick = msg.user_id ? `data-user-id="${esc(msg.user_id)}"` : '';
    if (avatarUrl) {
      html += `<img class="msg-avatar clickable-user" ${avatarClick} src="${esc(avatarUrl)}" alt="" loading="lazy">`;
    } else {
      html += `<div class="msg-avatar clickable-user" ${avatarClick} style="display:flex;align-items:center;justify-content:center;font-size:16px;color:#666;background:#e0e0e0">${esc(displayName.charAt(0).toUpperCase())}</div>`;
    }

    html += `<div class="msg-body">`;
    html += `<div class="msg-header">`;
    html += `<span class="msg-author clickable-user${isBot ? ' bot-label' : ''}" ${avatarClick}>${esc(displayName)}</span>`;
    if (isBot) html += `<span class="app-badge">APP</span>`;
    html += `<span class="msg-time" title="${esc(fullTs)}">${time}</span>`;
    if (isEdited) html += `<span class="msg-edited" title="Edited">(edited)</span>`;
    html += `</div>`;

    // Text (collapsible if long)
    const formatted = formatMessage(msg.text || '');
    const lineCount = (msg.text || '').split('\n').length;
    const isLong = lineCount > 15 || (msg.text || '').length > 1500;
    if (isLong) {
      html += `<div class="msg-text msg-collapsible collapsed">${formatted}</div>`;
      html += `<button class="show-more-btn" data-expanded="false">Show more</button>`;
    } else {
      html += `<div class="msg-text">${formatted}</div>`;
    }

    // Reactions
    html += renderReactions(msg.reactions);

    // Attachments
    html += renderAttachments(msg.attachments);

    // Block Kit elements (buttons, context, etc.)
    html += renderBlocks(msg.blocks);

    // Thread preview bar (Slack-style)
    if (msg.reply_count > 0 && (!msg.thread_ts || msg.thread_ts === msg.ts)) {
      const replyUsers = (msg.reply_users || '').split(',').filter(Boolean);
      // Show up to 3 unique reply participant avatars
      const avatarsHtml = replyUsers.slice(0, 3).map(uid => {
        const ru = state.users[uid];
        const av = ru?.avatar_url;
        const rn = ru?.display_name || ru?.real_name || ru?.name || uid;
        return av
          ? `<img class="thread-avatar" src="${esc(av)}" alt="${esc(rn)}" title="${esc(rn)}" loading="lazy">`
          : `<span class="thread-avatar thread-avatar-placeholder" title="${esc(rn)}">${esc(rn.charAt(0).toUpperCase())}</span>`;
      }).join('');

      // Last reply time
      let lastReplyStr = '';
      if (msg.last_reply_ts) {
        const lastReplyDate = tsToDate(msg.last_reply_ts);
        const now = new Date();
        const diffMs = now - lastReplyDate;
        const diffDays = Math.floor(diffMs / 86400000);
        if (diffDays === 0) {
          lastReplyStr = lastReplyDate.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
        } else if (diffDays === 1) {
          lastReplyStr = 'Yesterday';
        } else if (diffDays < 7) {
          lastReplyStr = lastReplyDate.toLocaleDateString('en-US', { weekday: 'short' });
        } else {
          lastReplyStr = lastReplyDate.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
        }
      }

      html += `<button class="thread-preview" data-thread-ts="${esc(msg.ts)}" data-channel="${esc(msg.channel_id)}">`;
      html += `<span class="thread-avatars">${avatarsHtml}</span>`;
      html += `<span class="thread-reply-text"><span class="thread-reply-count">${msg.reply_count} ${msg.reply_count === 1 ? 'reply' : 'replies'}</span>`;
      if (lastReplyStr) html += `<span class="thread-last-reply">Last reply ${lastReplyStr}</span>`;
      html += `</span>`;
      html += `<span class="thread-view-label">View thread ›</span>`;
      html += `</button>`;
    }

    html += `</div></div>`;
    lastUser = isSystem ? '' : msg.user_id;
  }

  container.innerHTML = html;

  // Wire up thread preview bars
  container.querySelectorAll('.thread-preview').forEach(btn => {
    btn.addEventListener('click', () => {
      openThread(btn.dataset.channel, btn.dataset.threadTs);
    });
  });

  // Wire up channel links
  container.querySelectorAll('.channel-link').forEach(link => {
    link.addEventListener('click', (e) => {
      e.preventDefault();
      const chId = link.dataset.channelId;
      if (chId) selectChannel(chId);
    });
  });

  // Wire up show-more/less buttons
  container.querySelectorAll('.show-more-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const textEl = btn.previousElementSibling;
      const expanded = btn.dataset.expanded === 'true';
      if (expanded) {
        textEl.classList.add('collapsed');
        btn.textContent = 'Show more';
        btn.dataset.expanded = 'false';
      } else {
        textEl.classList.remove('collapsed');
        btn.textContent = 'Show less';
        btn.dataset.expanded = 'true';
      }
    });
  });

  // Wire up user profile popover clicks
  container.querySelectorAll('.clickable-user[data-user-id]').forEach(el => {
    el.addEventListener('click', (e) => {
      e.stopPropagation();
      showUserPopover(el.dataset.userId, el);
    });
  });
}

// ── Format Slack message markup ────────────────────────
function formatMessage(text) {
  if (!text) return '';

  let html = esc(text);

  // Code blocks: ```...```
  html = html.replace(/```([\s\S]*?)```/g, (_, code) => `<pre><code>${code}</code></pre>`);

  // Inline code: `...`
  html = html.replace(/`([^`\n]+)`/g, '<code>$1</code>');

  // User mentions: <@U123> or <@U123|display>
  html = html.replace(/&lt;@(U[A-Z0-9]+)(?:\|([^&]*))?&gt;/g, (_, userId, label) => {
    const user = state.users[userId];
    const name = label || user?.display_name || user?.real_name || user?.name || userId;
    return `<span class="mention">@${name}</span>`;
  });

  // Channel links: <#C123|name>
  html = html.replace(/&lt;#(C[A-Z0-9]+)(?:\|([^&]*))?&gt;/g, (_, chId, label) => {
    const ch = state.channels.find(c => c.id === chId);
    const name = label || ch?.name || chId;
    return `<a class="channel-link" href="#" data-channel-id="${chId}">#${name}</a>`;
  });

  // URLs: <url|label> or <url>
  html = html.replace(/&lt;(https?:\/\/[^|&]+?)(?:\|([^&]*?))?&gt;/g, (_, url, label) => {
    return `<a href="${url}" target="_blank" rel="noopener">${label || url}</a>`;
  });

  // Bold: *text*
  html = html.replace(/(?<![a-zA-Z0-9])\*([^\*\n]+)\*(?![a-zA-Z0-9])/g, '<strong>$1</strong>');

  // Italic: _text_
  html = html.replace(/(?<![a-zA-Z0-9])_([^_\n]+)_(?![a-zA-Z0-9])/g, '<em>$1</em>');

  // Strikethrough: ~text~
  html = html.replace(/(?<![a-zA-Z0-9])~([^~\n]+)~(?![a-zA-Z0-9])/g, '<del>$1</del>');

  // Blockquotes: &gt; at start of line
  html = html.replace(/^(&gt;) (.+)$/gm, '<blockquote>$2</blockquote>');

  // Emoji shortcodes: :name: (but not inside code/pre)
  html = html.replace(/:([a-zA-Z0-9_+\-]+):/g, (match, name) => {
    const emoji = emojiToUnicode(name);
    return emoji !== `:${name}:` ? emoji : match;
  });

  // Newlines
  html = html.replace(/\n/g, '<br>');

  return html;
}

// ── Render reactions ───────────────────────────────────
function renderReactions(reactionsRaw) {
  if (!reactionsRaw) return '';
  let reactions;
  try {
    reactions = typeof reactionsRaw === 'string' ? JSON.parse(reactionsRaw) : reactionsRaw;
  } catch { return ''; }
  if (!Array.isArray(reactions) || !reactions.length) return '';

  return `<div class="msg-reactions">${reactions.map(r => {
    const emoji = emojiToUnicode(r.name);
    const isNative = emoji !== `:${r.name}:`;
    const emojiHtml = isNative
      ? `<span class="reaction-emoji">${emoji}</span>`
      : `<span class="reaction-emoji custom-emoji">:${esc(r.name)}:</span>`;
    return `<span class="reaction">${emojiHtml}<span class="reaction-count">${r.count}</span></span>`;
  }).join('')}</div>`;
}

// ── Render attachments ─────────────────────────────────
function renderAttachments(attachmentsRaw) {
  if (!attachmentsRaw) return '';
  let attachments;
  try {
    attachments = typeof attachmentsRaw === 'string' ? JSON.parse(attachmentsRaw) : attachmentsRaw;
  } catch { return ''; }
  if (!Array.isArray(attachments) || !attachments.length) return '';

  return `<div class="msg-attachments">${attachments.map(a => {
    const colorStyle = a.color ? `border-left-color: #${esc(a.color)}` : '';
    let inner = '';
    if (a.title) {
      inner += a.title_link
        ? `<a class="attachment-title" href="${esc(a.title_link)}" target="_blank">${esc(a.title)}</a>`
        : `<div class="attachment-title">${esc(a.title)}</div>`;
    }
    if (a.text) inner += `<div class="attachment-text">${formatMessage(a.text)}</div>`;
    if (a.fallback && !a.title && !a.text) inner += `<div class="attachment-text">${esc(a.fallback)}</div>`;
    if (a.image_url) inner += `<img class="attachment-image" src="${esc(a.image_url)}" loading="lazy" alt="">`;
    if (a.thumb_url && !a.image_url) inner += `<img class="attachment-image" src="${esc(a.thumb_url)}" loading="lazy" alt="">`;
    return `<div class="attachment${a.color ? ' attachment-color' : ''}" style="${colorStyle}">${inner}</div>`;
  }).join('')}</div>`;
}

// ── Render Block Kit elements ────────────────────────────
function renderBlocks(blocksRaw) {
  if (!blocksRaw) return '';
  let blocks;
  try {
    blocks = typeof blocksRaw === 'string' ? JSON.parse(blocksRaw) : blocksRaw;
  } catch { return ''; }
  if (!Array.isArray(blocks) || !blocks.length) return '';

  let html = '<div class="msg-blocks">';
  for (const block of blocks) {
    switch (block.type) {
      case 'actions':
        // Render buttons/selects as non-interactive labels
        html += '<div class="block-actions">';
        for (const el of (block.elements || [])) {
          if (el.type === 'button') {
            const label = el.text?.text || el.text?.emoji ? emojiToUnicode(el.text.text?.replace(/:/g, '') || '') : 'Button';
            html += `<span class="block-button">${esc(typeof label === 'string' ? label : 'Button')}</span>`;
          }
        }
        html += '</div>';
        break;
      case 'context':
        // Context blocks: small text/images
        html += '<div class="block-context">';
        for (const el of (block.elements || [])) {
          if (el.type === 'mrkdwn' || el.type === 'plain_text') {
            html += `<span class="block-context-text">${formatMessage(el.text || '')}</span>`;
          } else if (el.type === 'image') {
            html += `<img class="block-context-image" src="${esc(el.image_url || '')}" alt="${esc(el.alt_text || '')}" loading="lazy">`;
          }
        }
        html += '</div>';
        break;
      case 'divider':
        html += '<hr class="block-divider">';
        break;
      case 'header':
        html += `<div class="block-header">${esc(block.text?.text || '')}</div>`;
        break;
      case 'image':
        html += `<div class="block-image">`;
        if (block.title) html += `<div class="block-image-title">${esc(block.title.text || '')}</div>`;
        html += `<img src="${esc(block.image_url || '')}" alt="${esc(block.alt_text || '')}" loading="lazy">`;
        html += `</div>`;
        break;
      // section and rich_text blocks: text is already in msg.text, skip to avoid duplication
      default:
        break;
    }
  }
  html += '</div>';
  return html;
}

// ── Thread ─────────────────────────────────────────────
async function openThread(channelId, threadTs) {
  state.threadTs = threadTs;
  $('#thread-panel').classList.remove('hidden');
  $threadMessages.innerHTML = renderSkeletonMessages(4);

  try {
    const msgs = await api.getThread(channelId, threadTs);
    state.threadMessages = msgs;
    renderMessages($threadMessages, msgs, false);
  } catch (err) {
    $threadMessages.innerHTML = `<div class="empty-state"><p>${esc(err.message)}</p></div>`;
  }
}

function closeThread() {
  state.threadTs = null;
  state.threadMessages = [];
  $('#thread-panel').classList.add('hidden');
}

// ── Search ─────────────────────────────────────────────
let searchTimeout = null;

function onSearchInput(e) {
  const query = e.target.value.trim();
  clearTimeout(searchTimeout);

  if (!query) {
    closeOverlays();
    return;
  }

  searchTimeout = setTimeout(async () => {
    $('#search-overlay').classList.remove('hidden');
    $searchResults.innerHTML = '<div class="loading">Searching...</div>';

    try {
      const results = await api.search(query);
      if (!results?.length) {
        $searchResults.innerHTML = '<div class="empty-state"><h3>No results</h3></div>';
        return;
      }

      $searchResults.innerHTML = results.map(hit => {
        const user = state.users[hit.user_id];
        const displayName = user?.display_name || user?.real_name || user?.name || hit.user_id || 'Unknown';
        const ch = state.channels.find(c => c.id === hit.channel_id);
        const chName = ch?.name || hit.channel_id;
        const date = tsToDate(hit.ts);
        const time = date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) + ' ' +
                     date.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });

        return `
          <div class="search-hit" data-channel="${esc(hit.channel_id)}" data-ts="${esc(hit.ts)}" data-thread-ts="${esc(hit.thread_ts || '')}">
            <div class="search-hit-channel">#${esc(chName)} &middot; ${esc(displayName)} &middot; ${time}</div>
            <div class="msg-text">${formatMessage(hit.text || '')}</div>
          </div>`;
      }).join('');

      // Click search result → go to that channel
      $searchResults.querySelectorAll('.search-hit').forEach(el => {
        el.addEventListener('click', () => {
          closeOverlays();
          $('#search-input').value = '';
          selectChannel(el.dataset.channel);
          // If it's a thread reply, open the thread
          if (el.dataset.threadTs) {
            setTimeout(() => openThread(el.dataset.channel, el.dataset.threadTs), 300);
          }
        });
      });
    } catch (err) {
      $searchResults.innerHTML = `<div class="empty-state"><p>${esc(err.message)}</p></div>`;
    }
  }, 300); // 300ms debounce
}

// ── Pins ───────────────────────────────────────────────
async function showPins() {
  if (!state.currentChannel) return;
  closeOverlays();
  $('#pins-overlay').classList.remove('hidden');
  const content = $('#pins-content');
  content.innerHTML = '<div class="loading">Loading pins...</div>';

  try {
    const pins = await api.getPins(state.currentChannel.id);
    if (!pins?.length) {
      content.innerHTML = '<div class="empty-state"><h3>No pinned messages</h3></div>';
      return;
    }

    content.innerHTML = pins.map(pin => {
      const name = pin.user_display_name || pin.user_name || pin.user_id || '';
      const date = pin.pinned_at ? new Date(pin.pinned_at * 1000).toLocaleDateString() : '';
      return `
        <div class="pin-item">
          <div class="msg-header"><span class="msg-author">${esc(name)}</span> <span class="msg-time">${date}</span></div>
          <div class="msg-text">${formatMessage(pin.text || '(no text)')}</div>
        </div>`;
    }).join('');
  } catch (err) {
    content.innerHTML = `<div class="empty-state"><p>${esc(err.message)}</p></div>`;
  }
}

// ── Bookmarks ──────────────────────────────────────────
async function showBookmarks() {
  if (!state.currentChannel) return;
  closeOverlays();
  $('#bookmarks-overlay').classList.remove('hidden');
  const content = $('#bookmarks-content');
  content.innerHTML = '<div class="loading">Loading bookmarks...</div>';

  try {
    const bookmarks = await api.getBookmarks(state.currentChannel.id);
    if (!bookmarks?.length) {
      content.innerHTML = '<div class="empty-state"><h3>No bookmarks</h3></div>';
      return;
    }

    content.innerHTML = bookmarks.map(bm => {
      const creator = bm.creator_display_name || bm.creator_name || '';
      const emoji = bm.emoji || '';
      return `
        <div class="bookmark-item">
          ${emoji} <a href="${esc(bm.link || '#')}" target="_blank" rel="noopener">${esc(bm.title || bm.link || 'Untitled')}</a>
          ${creator ? `<div class="bm-creator">Added by ${esc(creator)}</div>` : ''}
        </div>`;
    }).join('');
  } catch (err) {
    content.innerHTML = `<div class="empty-state"><p>${esc(err.message)}</p></div>`;
  }
}

// ── Overlays ───────────────────────────────────────────
function closeOverlays() {
  $('#search-overlay').classList.add('hidden');
  $('#pins-overlay').classList.add('hidden');
  $('#bookmarks-overlay').classList.add('hidden');
}

// ── Event wiring ───────────────────────────────────────
$('#search-input').addEventListener('input', onSearchInput);
$('#search-close').addEventListener('click', () => { closeOverlays(); $('#search-input').value = ''; });
$('#thread-close').addEventListener('click', closeThread);
$('#pins-btn').addEventListener('click', showPins);
$('#pins-close').addEventListener('click', closeOverlays);
$('#bookmarks-btn').addEventListener('click', showBookmarks);
$('#bookmarks-close').addEventListener('click', closeOverlays);

// Escape key closes overlays, thread, and popover
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    closeOverlays();
    closeThread();
    closeUserPopover();
    $('#search-input').value = '';
    $('#search-input').blur();
  }
});

// ── User profile popover ────────────────────────────────
function showUserPopover(userId, anchorEl) {
  // Remove any existing popover
  closeUserPopover();

  const user = state.users[userId];
  if (!user) return;

  const popover = document.createElement('div');
  popover.id = 'user-popover';
  popover.className = 'user-popover';

  const name = user.display_name || user.real_name || user.name || userId;
  const fullName = user.real_name && user.real_name !== name ? user.real_name : '';
  const avatar = user.avatar_url || '';
  const statusEmoji = user.status_emoji ? emojiToUnicode(user.status_emoji.replace(/:/g, '')) : '';
  const statusText = user.status_text || '';
  const title = user.title || '';
  const email = user.email || '';
  const tz = user.timezone || '';
  const isBot = user.is_bot;

  let html = '<div class="popover-header">';
  if (avatar) {
    html += `<img class="popover-avatar" src="${esc(avatar)}" alt="">`;
  } else {
    html += `<div class="popover-avatar popover-avatar-placeholder">${esc(name.charAt(0).toUpperCase())}</div>`;
  }
  html += `<div class="popover-names">`;
  html += `<div class="popover-display-name">${esc(name)}${isBot ? '<span class="popover-bot-badge">APP</span>' : ''}</div>`;
  if (fullName) html += `<div class="popover-real-name">${esc(fullName)}</div>`;
  html += `</div></div>`;

  if (statusText || statusEmoji) {
    html += `<div class="popover-status">${statusEmoji ? `<span>${statusEmoji}</span> ` : ''}${esc(statusText)}</div>`;
  }

  if (title || email || tz) {
    html += '<div class="popover-details">';
    if (title) html += `<div class="popover-detail"><span class="popover-detail-label">Title</span><span>${esc(title)}</span></div>`;
    if (email) html += `<div class="popover-detail"><span class="popover-detail-label">Email</span><span>${esc(email)}</span></div>`;
    if (tz) {
      const tzPretty = tz.replace(/_/g, ' ').replace(/\//g, ' / ');
      html += `<div class="popover-detail"><span class="popover-detail-label">Timezone</span><span>${esc(tzPretty)}</span></div>`;
    }
    html += '</div>';
  }

  popover.innerHTML = html;
  document.body.appendChild(popover);

  // Position relative to anchor
  const rect = anchorEl.getBoundingClientRect();
  const popH = popover.offsetHeight;
  const popW = popover.offsetWidth;

  let top = rect.bottom + 6;
  let left = rect.left;

  // Flip up if too close to bottom
  if (top + popH > window.innerHeight - 10) {
    top = rect.top - popH - 6;
  }
  // Keep within right edge
  if (left + popW > window.innerWidth - 10) {
    left = window.innerWidth - popW - 10;
  }

  popover.style.top = `${top}px`;
  popover.style.left = `${left}px`;

  // Close on click outside (after this event loop)
  requestAnimationFrame(() => {
    document.addEventListener('click', closeUserPopover, { once: true });
  });
}

function closeUserPopover() {
  const existing = document.getElementById('user-popover');
  if (existing) existing.remove();
}

// ── Keyboard navigation ─────────────────────────────────
document.addEventListener('keydown', (e) => {
  // '/' focuses search (unless already in an input)
  if (e.key === '/' && !e.ctrlKey && !e.metaKey && !e.altKey) {
    const active = document.activeElement;
    if (active && (active.tagName === 'INPUT' || active.tagName === 'TEXTAREA')) return;
    e.preventDefault();
    $('#search-input').focus();
    return;
  }

  // Arrow up/down navigates channels when not focused on input
  if ((e.key === 'ArrowUp' || e.key === 'ArrowDown') && !e.ctrlKey && !e.metaKey) {
    const active = document.activeElement;
    if (active && (active.tagName === 'INPUT' || active.tagName === 'TEXTAREA')) return;

    const allItems = [...document.querySelectorAll('#channels li, #dms li')];
    if (!allItems.length) return;

    const currentIdx = allItems.findIndex(li => li.classList.contains('active'));
    let nextIdx;

    if (e.key === 'ArrowDown') {
      nextIdx = currentIdx < allItems.length - 1 ? currentIdx + 1 : 0;
    } else {
      nextIdx = currentIdx > 0 ? currentIdx - 1 : allItems.length - 1;
    }

    e.preventDefault();
    const nextId = allItems[nextIdx].dataset.id;
    if (nextId) selectChannel(nextId);
  }
});

// ── Emoji shortcode → Unicode map ──────────────────────
const EMOJI = {
  '+1':'👍','-1':'👎','100':'💯','1234':'🔢',
  'admit_one_ticket':'🎟️','airplane':'✈️','alien':'👽','ambulance':'🚑',
  'anchor':'⚓','angel':'👼','anger':'💢','angry':'😠','anguished':'😧',
  'ant':'🐜','apple':'🍎','arrow_down':'⬇️','arrow_left':'⬅️',
  'arrow_right':'➡️','arrow_up':'⬆️','art':'🎨','astonished':'😲',
  'athletic_shoe':'👟','atm':'🏧','avocado':'🥑',
  'baby':'👶','back':'🔙','balloon':'🎈','ballot_box_with_check':'☑️',
  'banana':'🍌','bangbang':'‼️','bar_chart':'📊','baseball':'⚾',
  'basketball':'🏀','bath':'🛁','battery':'🔋','bear':'🐻',
  'beer':'🍺','beers':'🍻','bell':'🔔','bike':'🚲','bird':'🐦',
  'birthday':'🎂','black_heart':'🖤','black_large_square':'⬛',
  'black_small_square':'▪️','blossom':'🌼','blue_book':'📘',
  'blue_heart':'💙','blush':'😊','bomb':'💣','bone':'🦴',
  'book':'📖','bookmark':'🔖','boom':'💥','boot':'👢',
  'bow':'🙇','bowling':'🎳','boy':'👦','brain':'🧠',
  'bread':'🍞','broken_heart':'💔','bug':'🐛','bulb':'💡',
  'bullettrain_front':'🚅','burrito':'🌯','bus':'🚌','bust_in_silhouette':'👤',
  'busts_in_silhouette':'👥','butterfly':'🦋',
  'cactus':'🌵','cake':'🍰','calendar':'📅','camel':'🐫',
  'camera':'📷','candle':'🕯️','candy':'🍬','car':'🚗','cat':'🐱',
  'cat2':'🐈','cd':'💿','chains':'⛓️','champagne':'🍾',
  'chart_with_upwards_trend':'📈','check':'✔️','checkered_flag':'🏁',
  'cherry_blossom':'🌸','chestnut':'🌰','chicken':'🐔','chocolate_bar':'🍫',
  'christmas_tree':'🎄','clap':'👏','clipboard':'📋','clock':'🕐',
  'cloud':'☁️','clown_face':'🤡','clubs':'♣️','cocktail':'🍸',
  'coffee':'☕','cold_sweat':'😰','collision':'💥','computer':'💻',
  'confetti_ball':'🎊','confounded':'😖','confused':'😕',
  'construction':'🚧','construction_worker':'👷','cookie':'🍪',
  'cool':'😎','cop':'👮','copyright':'©️','corn':'🌽',
  'couch_and_lamp':'🛋️','couple':'👫','cow':'🐄','cow2':'🐂',
  'crab':'🦀','credit_card':'💳','crescent_moon':'🌙',
  'cricket':'🏏','crossed_fingers':'🤞','crossed_swords':'⚔️',
  'crown':'👑','cry':'😢','crying_cat_face':'😿','crystal_ball':'🔮',
  'cup_with_straw':'🥤','cupid':'💘','cyclone':'🌀',
  'dancer':'💃','dark_sunglasses':'🕶️','dart':'🎯','dash':'💨',
  'date':'📅','deciduous_tree':'🌳','deer':'🦌','desktop_computer':'🖥️',
  'detective':'🕵️','diamond_shape_with_a_dot_inside':'💠',
  'diamonds':'♦️','disappointed':'😞','dizzy':'💫','dizzy_face':'😵',
  'dna':'🧬','dog':'🐶','dog2':'🐕','dollar':'💵','dolphin':'🐬',
  'door':'🚪','doughnut':'🍩','dove_of_peace':'🕊️','dragon':'🐉',
  'dress':'👗','droplet':'💧','drum_with_drumsticks':'🥁','duck':'🦆',
  'dvd':'📀',
  'eagle':'🦅','ear':'👂','earth_americas':'🌎','earth_asia':'🌏',
  'egg':'🥚','eggplant':'🍆','eight_pointed_black_star':'✴️',
  'electric_plug':'🔌','elephant':'🐘','email':'📧',
  'envelope':'✉️','envelope_with_arrow':'📩','euro':'💶',
  'evergreen_tree':'🌲','exclamation':'❗','expressionless':'😑',
  'eye':'👁️','eyeglasses':'👓','eyes':'👀',
  'face_with_head_bandage':'🤕','face_with_rolling_eyes':'🙄',
  'face_with_thermometer':'🤒','facepunch':'👊','factory':'🏭',
  'fallen_leaf':'🍂','family':'👪','fast_forward':'⏩',
  'fax':'📠','fearful':'😨','feet':'🐾','female_sign':'♀️',
  'ferris_wheel':'🎡','film_frames':'🎞️','fire':'🔥',
  'fire_engine':'🚒','fireworks':'🎆','first_place_medal':'🥇',
  'fish':'🐟','fishing_pole_and_fish':'🎣','fist':'✊',
  'flag_white':'🏳️','flashlight':'🔦','floppy_disk':'💾',
  'flower_playing_cards':'🎴','flushed':'😳','fog':'🌫️',
  'football':'🏈','footprints':'👣','fork_and_knife':'🍴',
  'fountain':'⛲','four_leaf_clover':'🍀','fox_face':'🦊',
  'free':'🆓','fried_egg':'🍳','frog':'🐸','frowning':'😦',
  'fuelpump':'⛽','full_moon':'🌕','full_moon_with_face':'🌝',
  'game_die':'🎲','gem':'💎','ghost':'👻','gift':'🎁',
  'gift_heart':'💝','girl':'👧','globe_with_meridians':'🌐',
  'gloves':'🧤','goat':'🐐','golf':'⛳','gorilla':'🦍',
  'grapes':'🍇','green_apple':'🍏','green_book':'📗',
  'green_heart':'💚','grey_exclamation':'❕','grey_question':'❔',
  'grimacing':'😬','grin':'😁','grinning':'😀','guardsman':'💂',
  'guitar':'🎸','gun':'🔫',
  'hamburger':'🍔','hammer':'🔨','hammer_and_wrench':'🛠️',
  'hamster':'🐹','hand':'✋','handbag':'👜','handshake':'🤝',
  'hankey':'💩','hash':'#️⃣','hatched_chick':'🐥','hatching_chick':'🐣',
  'headphones':'🎧','headstone':'🪦','hear_no_evil':'🙉',
  'heart':'❤️','heart_decoration':'💟','heart_eyes':'😍',
  'heart_eyes_cat':'😻','heartbeat':'💓','heartpulse':'💗',
  'hearts':'♥️','heavy_check_mark':'✅','heavy_division_sign':'➗',
  'heavy_dollar_sign':'💲','heavy_minus_sign':'➖',
  'heavy_multiplication_x':'✖️','heavy_plus_sign':'➕',
  'helicopter':'🚁','herb':'🌿','hibiscus':'🌺',
  'high_brightness':'🔆','high_heel':'👠','hockey':'🏒',
  'hole':'🕳️','honey_pot':'🍯','horse':'🐴','horse_racing':'🏇',
  'hospital':'🏥','hot_pepper':'🌶️','hotdog':'🌭','hotel':'🏨',
  'hourglass':'⌛','house':'🏠','hugging_face':'🤗','hushed':'😯',
  'ice_cream':'🍨','icecream':'🍦','id':'🆔','imp':'👿',
  'inbox_tray':'📥','incoming_envelope':'📨','information_source':'ℹ️',
  'innocent':'😇','interrobang':'⁉️','iphone':'📱',
  'jack_o_lantern':'🎃','japan':'🗾','japanese_goblin':'👺',
  'jeans':'👖','joy':'😂','joy_cat':'😹','joystick':'🕹️',
  'key':'🔑','keyboard':'⌨️','kimono':'👘','kiss':'💋',
  'kissing':'😗','kissing_cat':'😽','kissing_closed_eyes':'😚',
  'kissing_heart':'😘','kissing_smiling_eyes':'😙',
  'kiwi_fruit':'🥝','knife':'🔪','koala':'🐨',
  'label':'🏷️','large_blue_circle':'🔵','large_blue_diamond':'🔷',
  'large_orange_diamond':'🔶','last_quarter_moon_with_face':'🌜',
  'laughing':'😆','leaves':'🍃','ledger':'📒','left_right_arrow':'↔️',
  'lemon':'🍋','leopard':'🐆','level_slider':'🎚️',
  'light_rail':'🚈','lightning':'🌩️','link':'🔗','lion_face':'🦁',
  'lips':'👄','lipstick':'💄','lizard':'🦎','lock':'🔒',
  'lollipop':'🍭','loud_sound':'🔊','loudspeaker':'📢',
  'love_hotel':'🏩','love_letter':'💌','low_brightness':'🔅',
  'lying_face':'🤥',
  'mag':'🔍','mag_right':'🔎','mage':'🧙','magic_wand':'🪄',
  'magnet':'🧲','mahjong':'🀄','mailbox':'📫',
  'male_sign':'♂️','man':'👨','man_dancing':'🕺',
  'maple_leaf':'🍁','mask':'😷','medal':'🏅','mega':'📣',
  'melon':'🍈','melting_face':'🫠','memo':'📝','menorah':'🕎',
  'mermaid':'🧜','mermaid':'🧜‍♀️','merman':'🧜‍♂️',
  'microphone':'🎤','microscope':'🔬','middle_finger':'🖕',
  'milky_way':'🌌','minibus':'🚐','mirror':'🪞','money_mouth_face':'🤑',
  'money_with_wings':'💸','monkey':'🐒','monkey_face':'🐵',
  'moon':'🌙','mortar_board':'🎓','motor_boat':'🛥️',
  'motorcycle':'🏍️','mountain':'⛰️','mouse':'🐭','mouse2':'🐁',
  'movie_camera':'🎥','moyai':'🗿','muscle':'💪','mushroom':'🍄',
  'musical_keyboard':'🎹','musical_note':'🎵','musical_score':'🎼',
  'mute':'🔇',
  'nail_care':'💅','nerd_face':'🤓','neutral_face':'😐',
  'new':'🆕','new_moon_with_face':'🌚','newspaper':'📰',
  'no_bell':'🔕','no_entry':'⛔','no_entry_sign':'🚫',
  'no_good':'🙅','no_mouth':'😶','nose':'👃',
  'notebook':'📓','notes':'🎶','nut_and_bolt':'🔩',
  'o':'⭕','ocean':'🌊','octopus':'🐙','ok':'🆗',
  'ok_hand':'👌','old_key':'🗝️','older_man':'👴','older_woman':'👵',
  'open_hands':'👐','open_mouth':'😮','orange_book':'📙',
  'orange_heart':'🧡','outbox_tray':'📤','owl':'🦉','ox':'🐂',
  'package':'📦','page_facing_up':'📄','page_with_curl':'📃',
  'pager':'📟','palm_tree':'🌴','palms_up_together':'🤲',
  'pancakes':'🥞','panda_face':'🐼','paperclip':'📎',
  'parking':'🅿️','parrot':'🦜','party_popper':'🎉',
  'partying_face':'🥳','passport_control':'🛂','peach':'🍑',
  'peanuts':'🥜','pear':'🍐','pen':'🖊️','pencil':'📝',
  'pencil2':'✏️','penguin':'🐧','pensive':'😔','people_holding_hands':'🧑‍🤝‍🧑',
  'performing_arts':'🎭','persevere':'😣','person_bowing':'🙇',
  'person_frowning':'🙍','person_raising_hand':'🙋',
  'person_shrugging':'🤷','person_tipping_hand':'💁',
  'phone':'☎️','pick':'⛏️','pie':'🥧','pig':'🐷','pig2':'🐖',
  'pill':'💊','pineapple':'🍍','pizza':'🍕','place_of_worship':'🛐',
  'pleading_face':'🥺','point_down':'👇','point_left':'👈',
  'point_right':'👉','point_up':'☝️','point_up_2':'👆',
  'police_car':'🚓','poo':'💩','poodle':'🐩','popcorn':'🍿',
  'post_office':'🏣','postbox':'📮','potable_water':'🚰',
  'potato':'🥔','poultry_leg':'🍗','pound':'💷','pouting_cat':'😾',
  'pray':'🙏','prayer_beads':'📿','pretzel':'🥨','prince':'🤴',
  'princess':'👸','printer':'🖨️','punch':'👊','purple_heart':'💜',
  'pushpin':'📌','put_litter_in_its_place':'🚮','puzzle_piece':'🧩',
  'question':'❓','rabbit':'🐰','rabbit2':'🐇','raccoon':'🦝',
  'racing_car':'🏎️','radio':'📻','rage':'😡','railway_car':'🚃',
  'rainbow':'🌈','raised_back_of_hand':'🤚','raised_eyebrow':'🤨',
  'raised_hand':'✋','raised_hands':'🙌','raising_hand':'🙋',
  'ram':'🐏','ramen':'🍜','rat':'🐀','recycle':'♻️',
  'red_circle':'🔴','registered':'®️','relaxed':'☺️',
  'relieved':'😌','reminder_ribbon':'🎗️','repeat':'🔁',
  'revolving_hearts':'💞','ribbon':'🎀','rice':'🍚',
  'rice_ball':'🍙','ring':'💍','robot_face':'🤖','rocket':'🚀',
  'rofl':'🤣','roller_coaster':'🎢','rolling_eyes':'🙄',
  'rose':'🌹','rotating_light':'🚨','round_pushpin':'📍',
  'rugby_football':'🏉','runner':'🏃','running_shirt_with_sash':'🎽',
  'sad':'😢','safety_pin':'🧷','sagittarius':'♐',
  'sailboat':'⛵','sake':'🍶','salt':'🧂','saluting_face':'🫡',
  'sandwich':'🥪','santa':'🎅','satellite':'📡','sauropod':'🦕',
  'saxophone':'🎷','scarf':'🧣','school':'🏫','school_satchel':'🎒',
  'scissors':'✂️','scooter':'🛴','scorpion':'🦂','scream':'😱',
  'scream_cat':'🙀','scroll':'📜','seat':'💺',
  'second_place_medal':'🥈','see_no_evil':'🙈','seedling':'🌱',
  'selfie':'🤳','shark':'🦈','shaved_ice':'🍧','sheep':'🐑',
  'shell':'🐚','shield':'🛡️','ship':'🚢','shirt':'👕',
  'shocked':'😱','shopping_bags':'🛍️','shower':'🚿',
  'shrimp':'🦐','shrug':'🤷','shushing_face':'🤫',
  'skull':'💀','skull_and_crossbones':'☠️','sleeping':'😴',
  'sleepy':'😪','slight_frown':'🙁','slight_smile':'🙂',
  'slot_machine':'🎰','sloth':'🦥','small_blue_diamond':'🔹',
  'small_orange_diamond':'🔸','small_red_triangle':'🔺',
  'small_red_triangle_down':'🔻','smile':'😄','smile_cat':'😸',
  'smiley':'😃','smiley_cat':'😺','smiling_face_with_tear':'🥲',
  'smiling_imp':'😈','smirk':'😏','smirk_cat':'😼',
  'smoking':'🚬','snail':'🐌','snake':'🐍','sneezing_face':'🤧',
  'snowflake':'❄️','snowman':'⛄','snowman_without_snow':'⛄',
  'sob':'😭','soccer':'⚽','soon':'🔜','sos':'🆘',
  'sound':'🔉','space_invader':'👾','spades':'♠️',
  'spaghetti':'🍝','sparkle':'❇️','sparkler':'🎇','sparkles':'✨',
  'sparkling_heart':'💖','speak_no_evil':'🙊','speaker':'🔈',
  'speaking_head':'🗣️','speech_balloon':'💬','speedboat':'🚤',
  'spider':'🕷️','spider_web':'🕸️','spiral_calendar':'🗓️',
  'sponge':'🧽','spoon':'🥄','squid':'🦑','stadium':'🏟️',
  'star':'⭐','star2':'🌟','star_struck':'🤩','stars':'🌃',
  'steam_locomotive':'🚂','stethoscope':'🩺','stew':'🍲',
  'stop_sign':'🛑','stopwatch':'⏱️','strawberry':'🍓',
  'stuck_out_tongue':'😛','stuck_out_tongue_closed_eyes':'😝',
  'stuck_out_tongue_winking_eye':'😜','sun_with_face':'🌞',
  'sunflower':'🌻','sunglasses':'😎','sunny':'☀️',
  'sunrise':'🌅','superhero':'🦸','supervillain':'🦹',
  'sushi':'🍣','sweat':'😓','sweat_drops':'💦',
  'sweat_smile':'😅','sweet_potato':'🍠','swimming_man':'🏊',
  'symbols':'🔣','syringe':'💉',
  'taco':'🌮','tada':'🎉','tangerine':'🍊','target':'🎯',
  'taxi':'🚕','tea':'🍵','telephone_receiver':'📞','telescope':'🔭',
  'tennis':'🎾','tent':'⛺','test_tube':'🧪','thermometer':'🌡️',
  'thinking_face':'🤔','thinking':'🤔','third_place_medal':'🥉',
  'thought_balloon':'💭','thumbsdown':'👎','thumbsup':'👍',
  'thunder_cloud_and_rain':'⛈️','ticket':'🎫','tiger':'🐯',
  'tiger2':'🐅','timer_clock':'⏲️','tired_face':'😫',
  'tm':'™️','toilet':'🚽','tomato':'🍅','tongue':'👅',
  'toolbox':'🧰','tooth':'🦷','top':'🔝','tophat':'🎩',
  'tornado':'🌪️','tr':'🇹🇷','trophy':'🏆','tropical_drink':'🍹',
  'tropical_fish':'🐠','truck':'🚚','trumpet':'🎺',
  'tulip':'🌷','tumbler_glass':'🥃','turkey':'🦃','turtle':'🐢',
  'tv':'📺','twisted_rightwards_arrows':'🔀','two_hearts':'💕',
  'umbrella':'☂️','unamused':'😒','underage':'🔞','unicorn_face':'🦄',
  'unlock':'🔓','up':'🆙','upside_down_face':'🙃',
  'v':'✌️','video_camera':'📹','video_game':'🎮',
  'violin':'🎻','volcano':'🌋','volleyball':'🏐','vs':'🆚',
  'vulcan_salute':'🖖',
  'walking':'🚶','waning_crescent_moon':'🌘','warning':'⚠️',
  'wastebasket':'🗑️','watch':'⌚','water_buffalo':'🐃',
  'watermelon':'🍉','wave':'👋','wavy_dash':'〰️',
  'waxing_crescent_moon':'🌒','weary':'😩','wedding':'💒',
  'whale':'🐳','whale2':'🐋','wheel_of_dharma':'☸️',
  'wheelchair':'♿','white_check_mark':'✅','white_flower':'💮',
  'white_heart':'🤍','white_large_square':'⬜',
  'white_small_square':'▫️','wilted_flower':'🥀',
  'wind_blowing_face':'🌬️','wine_glass':'🍷','wink':'😉',
  'wolf':'🐺','woman':'👩','womans_hat':'👒',
  'woozy_face':'🥴','world_map':'🗺️','worried':'😟',
  'wrench':'🔧','writing_hand':'✍️',
  'x':'❌',
  'yarn':'🧶','yawning_face':'🥱','yellow_heart':'💛','yen':'💴',
  'yum':'😋',
  'zany_face':'🤪','zap':'⚡','zero':'0️⃣','zipper_mouth_face':'🤐',
  'zombie':'🧟','zzz':'💤',
  // Common skin tone variants / aliases
  'thumbsup_all':'👍','ok_hand_all':'👌','clap_all':'👏','wave_all':'👋',
  'raised_hands_all':'🙌','pray_all':'🙏','muscle_all':'💪',
  // Slack-specific aliases
  'simple_smile':'🙂','slightly_smiling_face':'🙂',
  'white_frowning_face':'☹️','upside_down':'🙃',
  'stuck_out_tongue_winking_eye':'😜','stuck_out_tongue_closed_eyes':'😝',
  'the_horns':'🤘','sign_of_the_horns':'🤘','metal':'🤘',
  'call_me_hand':'🤙','love_you_gesture':'🤟',
  'face_palm':'🤦','facepalm':'🤦','man_facepalming':'🤦‍♂️',
  'woman_facepalming':'🤦‍♀️',
  'mindblown':'🤯','exploding_head':'🤯',
  'hot_face':'🥵','cold_face':'🥶','pleading':'🥺',
  'salute':'🫡','melting':'🫠',
};

/**
 * Convert an emoji shortcode name to its Unicode character.
 * Falls back to :name: text wrapped in a span for unknown/custom emoji.
 */
function emojiToUnicode(name) {
  return EMOJI[name] || `:${name}:`;
}

// ── Skeleton loader ──────────────────────────────────────
function renderSkeletonMessages(count = 6) {
  let html = '';
  for (let i = 0; i < count; i++) {
    // Vary widths for realism
    const nameW = 60 + Math.floor(Math.random() * 80);
    const line1W = 40 + Math.floor(Math.random() * 50);
    const line2W = 20 + Math.floor(Math.random() * 40);
    const showSecondLine = Math.random() > 0.3;
    html += `<div class="skeleton-message">
      <div class="skeleton-avatar skeleton-pulse"></div>
      <div class="skeleton-body">
        <div class="skeleton-header">
          <div class="skeleton-name skeleton-pulse" style="width:${nameW}px"></div>
          <div class="skeleton-time skeleton-pulse"></div>
        </div>
        <div class="skeleton-line skeleton-pulse" style="width:${line1W}%"></div>
        ${showSecondLine ? `<div class="skeleton-line skeleton-pulse" style="width:${line2W}%"></div>` : ''}
      </div>
    </div>`;
  }
  return html;
}

// ── Helpers ────────────────────────────────────────────
function esc(str) {
  if (str == null) return '';
  const div = document.createElement('div');
  div.textContent = String(str);
  return div.innerHTML;
}

function tsToDate(ts) {
  if (!ts) return new Date(0);
  const secs = parseFloat(ts);
  return new Date(secs * 1000);
}

function fmtCount(n) {
  if (n >= 1000) return (n / 1000).toFixed(1).replace(/\.0$/, '') + 'k';
  return String(n);
}

function isSystemMessage(msg) {
  // Use subtype if available (populated from Slack API)
  if (msg.subtype) {
    const systemSubtypes = [
      'channel_join', 'channel_leave', 'channel_topic', 'channel_purpose',
      'channel_name', 'channel_archive', 'channel_unarchive',
      'group_join', 'group_leave', 'group_topic', 'group_purpose',
      'bot_add', 'bot_remove', 'pinned_item', 'unpinned_item',
    ];
    return systemSubtypes.includes(msg.subtype);
  }
  // Fallback: text-based detection for messages imported before subtype tracking
  if (!msg.text) return false;
  const t = msg.text;
  return t.includes(' has joined the channel') ||
         t.includes(' has left the channel') ||
         t.includes(' set the channel topic') ||
         t.includes(' set the channel purpose') ||
         t.includes(' was added to the channel') ||
         t.includes(' was removed from the channel');
}

// ── Boot ───────────────────────────────────────────────
init();

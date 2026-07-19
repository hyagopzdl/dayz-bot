const byId = (id) => document.getElementById(id);
const number = new Intl.NumberFormat('en-US');
const relative = new Intl.RelativeTimeFormat('en', { numeric: 'auto' });

function relativeTime(value) {
  const timestamp = new Date(value).getTime();
  if (!Number.isFinite(timestamp)) return '';
  const seconds = Math.round((timestamp - Date.now()) / 1000);
  if (Math.abs(seconds) < 60) return relative.format(seconds, 'second');
  const minutes = Math.round(seconds / 60);
  if (Math.abs(minutes) < 60) return relative.format(minutes, 'minute');
  const hours = Math.round(minutes / 60);
  if (Math.abs(hours) < 24) return relative.format(hours, 'hour');
  return relative.format(Math.round(hours / 24), 'day');
}

function escapeHtml(value) {
  const span = document.createElement('span');
  span.textContent = String(value ?? '');
  return span.innerHTML;
}

function renderProfile(data) {
  const chip = byId('profileChip');
  const avatar = data.profile.avatarUrl
    ? `<img class="avatar" src="${escapeHtml(data.profile.avatarUrl)}" alt="">`
    : `<div class="avatar"></div>`;
  chip.innerHTML = `${avatar}<div><strong>${escapeHtml(data.profile.displayName)}</strong><small>${escapeHtml(data.profile.role)}</small></div>`;
  byId('linkNotice').classList.toggle('hidden', data.profile.linked);
}

function renderMetrics(stats) {
  const cards = [
    ['Coins', number.format(stats.coins), '◈', ''],
    ['Global rank', stats.rank ? `#${stats.rank}` : '—', '↗', ''],
    ['Kills', number.format(stats.kills), '✦', ''],
    ['Deaths', number.format(stats.deaths), '†', ''],
    ['K/D ratio', Number(stats.kd).toFixed(2), '×', ''],
    ['Longshot', stats.longshot ? Math.round(stats.longshot) : '—', '⌁', stats.longshot ? 'm' : ''],
  ];
  byId('metricsGrid').innerHTML = cards.map(([label, value, icon, unit]) => `<article class="metric-card"><div class="metric-icon">${icon}</div><div><span class="metric-label">${label}</span><strong class="metric-value">${value}${unit ? `<span class="metric-unit">${unit}</span>` : ''}</strong></div></article>`).join('');
}

function renderActivity(items) {
  const target = byId('activityList');
  if (!items.length) {
    target.innerHTML = '<div class="empty-state compact"><p>No combat activity found yet.<br>Your latest kills and deaths will appear here.</p></div>';
    return;
  }
  target.innerHTML = items.map((item) => `<div class="activity-row"><div class="activity-symbol ${item.type}">${item.type === 'kill' ? '✦' : '†'}</div><div class="activity-main"><strong>${item.type === 'kill' ? 'Eliminated' : 'Eliminated by'} ${escapeHtml(item.opponent)}</strong><span>${item.weapon ? escapeHtml(item.weapon) : 'Combat event'}</span></div><time class="activity-time">${relativeTime(item.at)}</time></div>`).join('');
}

function renderLeaderboard(items) {
  const target = byId('leaderboardList');
  if (!items.length) {
    target.innerHTML = '<div class="empty-state compact"><p>The global ranking is still empty.</p></div>';
    return;
  }
  target.innerHTML = items.map((item) => `<div class="leader-row ${item.isCurrentPlayer ? 'current' : ''}"><div class="rank-number">${item.rank}</div><div class="leader-player"><strong>${escapeHtml(item.gamertag)}${item.isCurrentPlayer ? ' · You' : ''}</strong><span>${number.format(item.deaths)} deaths · ${Number(item.kd).toFixed(2)} K/D</span></div><div class="leader-score"><strong>${number.format(item.kills)}</strong><span>KILLS</span></div></div>`).join('');
}

function renderShop(items) {
  const target = byId('shopGrid');
  if (!items.length) {
    target.innerHTML = '<div class="empty-state"><p>No featured items available right now.<br>The store remains accessible through Discord.</p></div>';
    return;
  }
  target.innerHTML = items.map((item) => `<article class="shop-card">${item.imageUrl ? `<img class="shop-image" src="${escapeHtml(item.imageUrl)}" alt="" loading="lazy">` : ''}<div class="shop-info"><div><strong>${escapeHtml(item.name)}</strong><span>${escapeHtml(item.category || 'Item')}</span></div><span class="price">${number.format(item.price)} coins</span></div></article>`).join('');
}

async function loadDashboard() {
  try {
    const response = await fetch('/api/player/dashboard', { headers: { Accept: 'application/json' } });
    if (response.status === 401) {
      location.href = '/login?returnTo=/app';
      return;
    }
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const data = await response.json();
    renderProfile(data);
    renderMetrics(data.stats);
    renderActivity(data.recentActivity);
    renderLeaderboard(data.leaderboard);
    renderShop(data.shopPreview);
  } catch (error) {
    console.error('Failed to load player dashboard', error);
    byId('activityList').innerHTML = '<div class="empty-state compact"><p>Dashboard data is temporarily unavailable.<br>Refresh the page to try again.</p></div>';
  }
}

byId('logoutButton')?.addEventListener('click', async () => {
  await fetch('/api/auth/logout', { method: 'POST' });
  location.href = '/login';
});

const sidebar = byId('sidebar');
const backdrop = byId('backdrop');
byId('menuButton')?.addEventListener('click', () => {
  sidebar.classList.add('open');
  backdrop.classList.add('visible');
});
backdrop?.addEventListener('click', () => {
  sidebar.classList.remove('open');
  backdrop.classList.remove('visible');
});

document.querySelectorAll('.nav-item.disabled').forEach((item) => item.addEventListener('click', (event) => event.preventDefault()));
loadDashboard();

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
  if (!target) return;
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


const contentRoot = byId('contentRoot');
function coins(value){return `${number.format(Number(value||0))} M`;}
function showToast(message, error=false){const old=byId('portalToast');if(old)old.remove();const el=document.createElement('div');el.id='portalToast';el.className=`toast${error?' error':''}`;el.textContent=message;document.body.appendChild(el);setTimeout(()=>el.remove(),4500);}
async function api(url, options={}){const response=await fetch(url,{headers:{Accept:'application/json','Content-Type':'application/json',...(options.headers||{})},...options});if(response.status===401){location.href=`/login?returnTo=${encodeURIComponent(location.pathname)}`;throw new Error('Unauthorized');}const data=await response.json().catch(()=>({}));if(!response.ok)throw new Error(data.error||`HTTP ${response.status}`);return data;}
function imageMarkup(url,name){return url?`<img src="${escapeHtml(url)}" alt="${escapeHtml(name)}" loading="lazy">`:'<span class="placeholder">◇</span>';}
function shopHeader(title,subtitle,balance){return `<header class="shop-page-header"><div><p class="eyebrow">Player shop</p><h1>${escapeHtml(title)}</h1><p class="page-subtitle">${escapeHtml(subtitle)}</p></div><div class="shop-balance"><span>Available balance</span><strong>${coins(balance)}</strong></div></header>`;}
function runtimeBanner(runtime){return `<div class="runtime-banner ${runtime.canAcceptPurchase?'ready':''}"><div><strong>${runtime.canAcceptPurchase?'Shop open':'Checkout temporarily paused'}</strong><div class="muted">${escapeHtml(runtime.reason)}</div></div>${runtime.nextRestartLabel?`<strong>${escapeHtml(runtime.nextRestartLabel)}</strong>`:''}</div>`;}
async function renderShopHome(){contentRoot.innerHTML='<div class="empty-state"><div class="loader"></div><p>Loading shop...</p></div>';try{const data=await api('/api/player/shop');contentRoot.innerHTML=shopHeader('Shop','Choose a category and find your next delivery.',data.balance)+runtimeBanner(data.runtime)+(!data.profile.linked?'<div class="link-notice"><div><strong>Connect your DayZ account</strong><span>Use <code>/link</code> on Discord before purchasing.</span></div></div>':'')+`<section class="category-grid">${data.categories.map(c=>`<a class="category-card" href="/app/shop/category/${encodeURIComponent(c.id)}"><div class="category-icon">${escapeHtml(c.emoji||'◇')}</div><h3>${escapeHtml(c.label)}</h3><p>${escapeHtml(c.description||'Browse available items and prices.')}</p><div class="category-meta"><span>${c.itemCount} items</span><span>From ${coins(c.minimumPrice)}</span></div></a>`).join('')}</section>`;}catch(e){contentRoot.innerHTML=`<div class="empty-state"><p>${escapeHtml(e.message)}</p></div>`;}}
async function renderCategory(id){contentRoot.innerHTML='<div class="empty-state"><div class="loader"></div></div>';try{const data=await api(`/api/player/shop/categories/${encodeURIComponent(id)}`);contentRoot.innerHTML=`<a class="back-link" href="/app/shop">← All categories</a>${shopHeader(data.category.label,data.category.description||'Available items',data.balance)}${runtimeBanner(data.runtime)}<section class="product-grid">${data.items.map(item=>`<a class="product-card" href="/app/shop/item/${encodeURIComponent(item.id)}"><div class="product-image">${imageMarkup(item.imageUrl,item.name)}</div><div class="product-body"><h3>${escapeHtml(item.name)}</h3><p>${escapeHtml(item.description)}</p><div class="product-price"><strong>${coins(item.price)}</strong><span>View →</span></div></div></a>`).join('')}</section>`;}catch(e){showToast(e.message,true);renderShopHome();}}
let selectedItemData=null, selectedCoords=null;
async function renderItem(id){contentRoot.innerHTML='<div class="empty-state"><div class="loader"></div></div>';try{const data=await api(`/api/player/shop/items/${encodeURIComponent(id)}`);selectedItemData=data;contentRoot.innerHTML=`<a class="back-link" href="/app/shop/category/${encodeURIComponent(data.item.category)}">← Back to category</a><section class="item-layout"><article class="item-hero"><div class="item-visual">${imageMarkup(data.item.imageUrl,data.item.name)}</div><div class="item-details"><p class="eyebrow">${escapeHtml(data.item.deliveryKind)}</p><h1>${escapeHtml(data.item.name)}</h1><p>${escapeHtml(data.item.description)}</p></div></article><aside class="checkout-card purchase-summary"><h2>Delivery</h2><div class="summary-row"><span>Price</span><strong>${coins(data.item.price)}</strong></div><div class="summary-row"><span>Your balance</span><strong>${coins(data.balance)}</strong></div><div class="summary-row"><span>Delivery</span><strong>Next reset</strong></div><p class="page-subtitle">Choose exactly where your item should be delivered on the Chernarus map.</p><button id="chooseLocation" class="primary-button full-button" ${!data.runtime.canAcceptPurchase||!data.profile.linked||data.balance<data.item.price?'disabled':''}>${data.balance<data.item.price?'Insufficient balance':'Choose delivery location'}</button></aside></section>`;byId('chooseLocation')?.addEventListener('click',openMapDialog);}catch(e){contentRoot.innerHTML=`<div class="empty-state"><p>${escapeHtml(e.message)}</p></div>`;}}
function openMapDialog(){const data=selectedItemData;const locations=data.locations||[];document.body.insertAdjacentHTML('beforeend',`<div class="map-dialog" id="mapDialog"><div class="map-shell"><div class="delivery-map" id="deliveryMap"><img src="/api/player/shop/map" alt="Chernarus map"><i class="delivery-pin" id="deliveryPin"></i></div><aside class="map-sidebar"><p class="eyebrow">Delivery location</p><h2>Choose on map</h2><p class="page-subtitle">Click the map or reuse a saved coordinate from Discord.</p>${locations.length?`<div class="field"><label>Saved locations</label><select id="savedLocation"><option value="">Custom location</option>${locations.map(l=>`<option value="${escapeHtml(l.id)}" data-x="${l.x}" data-z="${l.z}">${escapeHtml(l.name)} · ${l.x}, ${l.z}</option>`).join('')}</select></div>`:''}<div class="coord-grid"><div class="field"><label>X coordinate</label><input id="coordX" inputmode="decimal" placeholder="4587.29"></div><div class="field"><label>Z coordinate</label><input id="coordZ" inputmode="decimal" placeholder="8373.59"></div></div><div class="field"><label>Save location as (optional)</label><input id="locationName" maxlength="40" placeholder="Main base"></div><div class="checkout-review"><div class="summary-row"><span>Item</span><strong>${escapeHtml(data.item.name)}</strong></div><div class="summary-row"><span>Price</span><strong>${coins(data.item.price)}</strong></div></div><div class="modal-actions"><button class="sign-out" id="closeMap">Cancel</button><button class="primary-button" id="reviewPurchase" disabled>Review purchase</button></div></aside></div></div>`);const map=byId('deliveryMap'),pin=byId('deliveryPin'),xInput=byId('coordX'),zInput=byId('coordZ'),review=byId('reviewPurchase');function update(x,z){x=Number(x);z=Number(z);if(!Number.isFinite(x)||!Number.isFinite(z))return;selectedCoords={x,z};xInput.value=x.toFixed(2);zInput.value=z.toFixed(2);pin.style.left=`${x/15360*100}%`;pin.style.top=`${(15360-z)/15360*100}%`;pin.style.display='block';review.disabled=false;}map.addEventListener('click',e=>{const r=map.getBoundingClientRect();update((e.clientX-r.left)/r.width*15360,15360-(e.clientY-r.top)/r.height*15360)});[xInput,zInput].forEach(el=>el.addEventListener('input',()=>update(xInput.value,zInput.value)));byId('savedLocation')?.addEventListener('change',e=>{const option=e.target.selectedOptions[0];if(option?.dataset.x)update(option.dataset.x,option.dataset.z);byId('locationName').value=option?.textContent?.split(' · ')[0]||''});byId('closeMap').onclick=()=>byId('mapDialog').remove();review.onclick=createCheckout;}
async function createCheckout(){try{const button=byId('reviewPurchase');button.disabled=true;button.textContent='Preparing...';const checkout=await api('/api/player/shop/checkouts',{method:'POST',body:JSON.stringify({itemId:selectedItemData.item.id,x:selectedCoords.x,z:selectedCoords.z,locationId:byId('savedLocation')?.value||undefined,saveLocationName:byId('locationName').value||undefined})});renderCheckoutReview(checkout);}catch(e){showToast(e.message,true);byId('reviewPurchase').disabled=false;}}
function renderCheckoutReview(checkout){const sidebar=document.querySelector('.map-sidebar');sidebar.innerHTML=`<p class="eyebrow">Final review</p><h2>Confirm purchase</h2><div class="mini-map"><img src="/api/player/shop/map"><i style="left:${checkout.location.x/15360*100}%;top:${(15360-checkout.location.z)/15360*100}%"></i></div><div class="summary-row"><span>Item</span><strong>${escapeHtml(checkout.item.name)}</strong></div><div class="summary-row"><span>Location</span><strong>${escapeHtml(checkout.location.name||`${checkout.location.x}, ${checkout.location.z}`)}</strong></div><div class="summary-row"><span>Price</span><strong>${coins(checkout.item.price)}</strong></div><div class="summary-row"><span>Balance after</span><strong>${coins(checkout.balanceAfter)}</strong></div><p class="page-subtitle">The delivery will be included in the next server reset.</p><div class="modal-actions"><button class="sign-out" id="backToMap">Back</button><button class="primary-button" id="confirmPurchase">Confirm for ${coins(checkout.item.price)}</button></div>`;byId('backToMap').onclick=()=>{byId('mapDialog').remove();openMapDialog()};byId('confirmPurchase').onclick=async()=>{const b=byId('confirmPurchase');b.disabled=true;b.textContent='Confirming...';try{const order=await api(`/api/player/shop/checkouts/${encodeURIComponent(checkout.id)}/confirm`,{method:'POST',body:'{}'});byId('mapDialog').remove();showPurchaseSuccess(order);}catch(e){showToast(e.message,true);b.disabled=false;b.textContent='Confirm purchase';}};}
function showPurchaseSuccess(order){contentRoot.innerHTML=`<section class="panel" style="max-width:720px;margin:40px auto;text-align:center"><div class="metric-icon" style="margin:auto">✓</div><p class="eyebrow">Purchase confirmed</p><h1>${escapeHtml(order.itemName)}</h1><p class="page-subtitle">Your order is waiting for the next server reset and will be delivered at ${escapeHtml(order.location.name||`${order.location.x}, ${order.location.z}`)}.</p><a class="primary-button" href="/app/purchases">Track delivery →</a></section>`;}
async function renderPurchases(){contentRoot.innerHTML='<div class="empty-state"><div class="loader"></div></div>';try{const data=await api('/api/player/purchases');contentRoot.innerHTML=`<header class="shop-page-header"><div><p class="eyebrow">Orders</p><h1>Purchases</h1><p class="page-subtitle">Track upcoming deliveries and review your complete purchase history.</p></div><a class="primary-button" href="/app/shop">Open shop →</a></header><section class="purchase-list">${data.purchases.length?data.purchases.map(renderPurchaseCard).join(''):'<div class="empty-state"><p>You have not purchased anything yet.</p><a class="primary-button" href="/app/shop">Browse shop</a></div>'}</section>`;}catch(e){contentRoot.innerHTML=`<div class="empty-state"><p>${escapeHtml(e.message)}</p></div>`;}}
function renderPurchaseCard(p){const steps=['Confirmed','Waiting for reset','Preparing delivery','Delivered'];return `<article class="purchase-card"><div class="purchase-head"><div><p class="eyebrow">${new Date(p.createdAt).toLocaleString()}</p><h3>${escapeHtml(p.itemName)}</h3><span class="muted">${escapeHtml(p.location.name||`${p.location.x}, ${p.location.z}`)}${p.price?` · ${coins(p.price)}`:''}</span></div><span class="status-badge ${p.status.tone}">${escapeHtml(p.status.label)}</span></div><div class="timeline">${steps.map((s,i)=>`<div class="timeline-step ${i+1<=p.status.step?'done':''}">${s}</div>`).join('')}</div>${p.failReason?`<div class="runtime-banner"><strong>Delivery issue</strong><span>${escapeHtml(p.failReason)}</span></div>`:''}<div class="purchase-meta"><span>Order ${escapeHtml(p.id)}</span>${p.balanceAfter!==null?`<span>Balance after: ${coins(p.balanceAfter)}</span>`:''}</div></article>`;}

const rankingLabels={kills:'Kills',kd:'K/D ratio',streak:'Killstreak',longshot:'Longshot'};
const rankingPeriodLabels={overall:'Overall',weekly:'Weekly',daily:'Daily'};
function rankingValue(entry,category){if(category==='kd')return Number(entry.kd||0).toFixed(2);if(category==='streak')return number.format(Number(entry.streak||entry.value||0));if(category==='longshot')return `${Math.round(Number(entry.distance||entry.value||0))} m`;return number.format(Number(entry.kills||0));}
function rankingMeta(entry,category){if(category==='kills')return `${number.format(Number(entry.deaths||0))} deaths · ${Number(entry.kd||0).toFixed(2)} K/D`;if(category==='kd')return `${number.format(Number(entry.kills||0))} kills · ${number.format(Number(entry.deaths||0))} deaths`;if(category==='streak')return 'Best recorded streak';if(category==='longshot')return `${entry.weapon?escapeHtml(entry.weapon):'Unknown weapon'}${entry.victim?` · vs ${escapeHtml(entry.victim)}`:''}`;return '';}
function rankBadge(rank){if(rank===1)return '🥇';if(rank===2)return '🥈';if(rank===3)return '🥉';return `#${number.format(rank)}`;}
function rankingRow(entry,category){return `<div class="ranking-row ${entry.isCurrentPlayer?'current':''}"><div class="ranking-position">${rankBadge(entry.rank)}</div><div class="ranking-player"><strong>${escapeHtml(entry.gamertag)}${entry.isCurrentPlayer?' <span class="you-pill">You</span>':''}</strong><span>${rankingMeta(entry,category)}</span></div><div class="ranking-value"><strong>${rankingValue(entry,category)}</strong><span>${escapeHtml(rankingLabels[category]||category)}</span></div></div>`;}
async function renderRankings(){
  const params=new URLSearchParams(location.search);let category=params.get('category')||'kills';let period=params.get('period')||'overall';let page=Math.max(1,Number(params.get('page')||1));
  contentRoot.innerHTML='<div class="empty-state"><div class="loader"></div><p>Loading rankings...</p></div>';
  try{
    const data=await api(`/api/player/rankings?category=${encodeURIComponent(category)}&period=${encodeURIComponent(period)}&page=${page}&pageSize=50`);
    category=data.category;period=data.period;
    const periods=['overall','weekly','daily'];const categories=['kills','kd','streak','longshot'];
    const periodButtons=periods.map(p=>`<button type="button" class="ranking-filter ${period===p?'active':''}" data-period="${p}" ${!data.config.supportedPeriods.includes(p)?'disabled':''}>${rankingPeriodLabels[p]}</button>`).join('');
    const categoryButtons=categories.map(c=>`<button type="button" class="ranking-filter ${category===c?'active':''}" data-category="${c}">${rankingLabels[c]}</button>`).join('');
    const own=data.currentPlayer&&data.currentPlayer.rank?`<div class="your-rank-card"><div><span>Your position</span><strong>#${number.format(data.currentPlayer.rank)}</strong></div><div><span>${escapeHtml(rankingLabels[category])}</span><strong>${rankingValue(data.currentPlayer,category)}</strong></div></div>`:'';
    const note=category==='kd'?`<p class="ranking-note">K/D ranking requires at least ${number.format(data.config.kdMinimumKills)} kills.</p>`:(category==='streak'||category==='longshot')?'<p class="ranking-note">This category uses the server\'s recorded streak/longshot history and is currently available as an overall ranking.</p>':'';
    contentRoot.innerHTML=`<header class="rankings-header"><div><p class="eyebrow">Competitive standings</p><h1>Rankings</h1><p class="page-subtitle">Compare performance across the server. Clan standings are already reserved for the next phase.</p></div><div class="ranking-scope"><button class="scope-tab active" type="button">Players</button><button class="scope-tab" type="button" disabled>Clans <span class="soon">Soon</span></button></div></header><section class="ranking-controls"><div><span class="control-label">Period</span><div class="ranking-filter-group">${periodButtons}</div></div><div><span class="control-label">Category</span><div class="ranking-filter-group">${categoryButtons}</div></div></section>${own}${note}<section class="panel rankings-panel"><div class="ranking-table-head"><span>Rank</span><span>Player</span><span>${escapeHtml(rankingLabels[category])}</span></div><div class="ranking-list">${data.entries.length?data.entries.map(e=>rankingRow(e,category)).join(''):'<div class="empty-state"><p>No ranking data is available for this selection yet.</p></div>'}</div></section><div class="ranking-pagination"><button id="rankingPrev" class="ranking-page-button" ${data.pagination.page<=1?'disabled':''}>← Previous</button><span>Page ${data.pagination.page} of ${data.pagination.totalPages} · ${number.format(data.pagination.total)} players</span><button id="rankingNext" class="ranking-page-button" ${data.pagination.page>=data.pagination.totalPages?'disabled':''}>Next →</button></div>`;
    const navigate=(nextCategory,nextPeriod,nextPage=1)=>{const q=new URLSearchParams();q.set('category',nextCategory);q.set('period',nextPeriod);if(nextPage>1)q.set('page',String(nextPage));location.href=`/app/rankings?${q.toString()}`;};
    document.querySelectorAll('[data-period]').forEach(el=>el.addEventListener('click',()=>navigate(category,el.dataset.period,1)));
    document.querySelectorAll('[data-category]').forEach(el=>el.addEventListener('click',()=>navigate(el.dataset.category,period,1)));
    byId('rankingPrev')?.addEventListener('click',()=>navigate(category,period,Math.max(1,data.pagination.page-1)));
    byId('rankingNext')?.addEventListener('click',()=>navigate(category,period,data.pagination.page+1));
  }catch(e){contentRoot.innerHTML=`<div class="empty-state"><p>${escapeHtml(e.message)}</p></div>`;}
}

function bootView(){const view=document.body.dataset.view;if(view==='shop'){const parts=location.pathname.split('/').filter(Boolean);if(parts[2]==='category'&&parts[3])renderCategory(decodeURIComponent(parts[3]));else if(parts[2]==='item'&&parts[3])renderItem(decodeURIComponent(parts[3]));else renderShopHome();return;}if(view==='purchases'){renderPurchases();return;}if(view==='rankings'){renderRankings();return;}loadDashboard();}

bootView();

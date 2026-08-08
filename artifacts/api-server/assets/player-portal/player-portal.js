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
function rankingValue(entry,category){if(category==='kd')return Number(entry.kd||0).toFixed(2);if(category==='streak')return number.format(Number(entry.streak||entry.value||0));if(category==='longshot')return `${Math.round(Number(entry.longshot||entry.distance||entry.value||0))} m`;return number.format(Number(entry.kills||0));}
function rankingMeta(entry,category,scope){if(scope==='clans')return `${number.format(Number(entry.members||0))} members · ${number.format(Number(entry.deaths||0))} deaths${category==='longshot'&&entry.longshotPlayer?` · ${escapeHtml(entry.longshotPlayer)}`:''}`;if(category==='kills')return `${number.format(Number(entry.deaths||0))} deaths · ${Number(entry.kd||0).toFixed(2)} K/D`;if(category==='kd')return `${number.format(Number(entry.kills||0))} kills · ${number.format(Number(entry.deaths||0))} deaths`;if(category==='streak')return 'Best recorded streak';if(category==='longshot')return `${entry.weapon?escapeHtml(entry.weapon):'Unknown weapon'}${entry.victim?` · vs ${escapeHtml(entry.victim)}`:''}`;return '';}
function rankBadge(rank){if(rank===1)return '🥇';if(rank===2)return '🥈';if(rank===3)return '🥉';return `#${number.format(rank)}`;}
function rankingRow(entry,category,scope){const current=scope==='clans'?entry.isCurrentClan:entry.isCurrentPlayer;const title=scope==='clans'?`[${escapeHtml(entry.tag)}] ${escapeHtml(entry.name)}`:escapeHtml(entry.gamertag);return `<div class="ranking-row ${current?'current':''}"><div class="ranking-position">${rankBadge(entry.rank)}</div><div class="ranking-player"><strong>${title}${current?' <span class="you-pill">Yours</span>':''}</strong><span>${rankingMeta(entry,category,scope)}</span></div><div class="ranking-value"><strong>${rankingValue(entry,category)}</strong><span>${escapeHtml(rankingLabels[category]||category)}</span></div></div>`;}
async function renderRankings(){
  const params=new URLSearchParams(location.search);let scope=params.get('scope')==='clans'?'clans':'players';let category=params.get('category')||'kills';let period=params.get('period')||'overall';let page=Math.max(1,Number(params.get('page')||1));
  contentRoot.innerHTML='<div class="empty-state"><div class="loader"></div><p>Loading rankings...</p></div>';
  try{
    const data=await api(`/api/player/rankings?scope=${encodeURIComponent(scope)}&category=${encodeURIComponent(category)}&period=${encodeURIComponent(period)}&page=${page}&pageSize=50`);
    scope=data.scope;category=data.category;period=data.period;
    const periods=['overall','weekly','daily'];const categories=['kills','kd','streak','longshot'];
    const periodButtons=periods.map(p=>`<button type="button" class="ranking-filter ${period===p?'active':''}" data-period="${p}" ${!data.config.supportedPeriods.includes(p)?'disabled':''}>${rankingPeriodLabels[p]}</button>`).join('');
    const categoryButtons=categories.map(c=>`<button type="button" class="ranking-filter ${category===c?'active':''}" data-category="${c}">${rankingLabels[c]}</button>`).join('');
    const ownEntry=scope==='clans'?data.currentClan:data.currentPlayer;
    const own=ownEntry&&ownEntry.rank?`<div class="your-rank-card"><div><span>${scope==='clans'?'Your clan':'Your position'}</span><strong>#${number.format(ownEntry.rank)}</strong></div><div><span>${escapeHtml(rankingLabels[category])}</span><strong>${rankingValue(ownEntry,category)}</strong></div></div>`:'';
    const note=category==='kd'?`<p class="ranking-note">K/D ranking requires at least ${number.format(data.config.kdMinimumKills)} kills${scope==='clans'?' across current clan members':''}.</p>`:(category==='streak'||category==='longshot')?'<p class="ranking-note">This category uses the server\'s recorded streak/longshot history and is currently available as an overall ranking.</p>':'';
    const label=scope==='clans'?'Clan':'Player';
    contentRoot.innerHTML=`<header class="rankings-header"><div><p class="eyebrow">Competitive standings</p><h1>Rankings</h1><p class="page-subtitle">Compare players and clans across overall, weekly and daily performance.</p></div><div class="ranking-scope"><button class="scope-tab ${scope==='players'?'active':''}" data-scope="players" type="button">Players</button><button class="scope-tab ${scope==='clans'?'active':''}" data-scope="clans" type="button">Clans</button></div></header><section class="ranking-controls"><div><span class="control-label">Period</span><div class="ranking-filter-group">${periodButtons}</div></div><div><span class="control-label">Category</span><div class="ranking-filter-group">${categoryButtons}</div></div></section>${own}${note}<section class="panel rankings-panel"><div class="ranking-table-head"><span>Rank</span><span>${label}</span><span>${escapeHtml(rankingLabels[category])}</span></div><div class="ranking-list">${data.entries.length?data.entries.map(e=>rankingRow(e,category,scope)).join(''):`<div class="empty-state"><p>No ${scope==='clans'?'clan':'player'} ranking data is available for this selection yet.</p></div>`}</div></section><div class="ranking-pagination"><button id="rankingPrev" class="ranking-page-button" ${data.pagination.page<=1?'disabled':''}>← Previous</button><span>Page ${data.pagination.page} of ${data.pagination.totalPages} · ${number.format(data.pagination.total)} ${scope}</span><button id="rankingNext" class="ranking-page-button" ${data.pagination.page>=data.pagination.totalPages?'disabled':''}>Next →</button></div>`;
    const navigate=(nextScope,nextCategory,nextPeriod,nextPage=1)=>{const q=new URLSearchParams();q.set('scope',nextScope);q.set('category',nextCategory);q.set('period',nextPeriod);if(nextPage>1)q.set('page',String(nextPage));location.href=`/app/rankings?${q.toString()}`;};
    document.querySelectorAll('[data-scope]').forEach(el=>el.addEventListener('click',()=>navigate(el.dataset.scope,category,period,1)));
    document.querySelectorAll('[data-period]').forEach(el=>el.addEventListener('click',()=>navigate(scope,category,el.dataset.period,1)));
    document.querySelectorAll('[data-category]').forEach(el=>el.addEventListener('click',()=>navigate(scope,el.dataset.category,period,1)));
    byId('rankingPrev')?.addEventListener('click',()=>navigate(scope,category,period,Math.max(1,data.pagination.page-1)));
    byId('rankingNext')?.addEventListener('click',()=>navigate(scope,category,period,data.pagination.page+1));
  }catch(e){contentRoot.innerHTML=`<div class="empty-state"><p>${escapeHtml(e.message)}</p></div>`;}
}


function accountStatsCard(label, stats){return `<article class="account-summary-card"><span>${escapeHtml(label)}</span><strong>${number.format(Number(stats?.kills||0))}</strong><small>${number.format(Number(stats?.deaths||0))} deaths · ${Number(stats?.kd||0).toFixed(2)} K/D</small></article>`;}
function accountRow(account){const isMain=account.type==='main';return `<article class="account-row ${isMain?'main':''}"><div class="account-row-main"><div class="account-avatar">${escapeHtml(account.gamertag.slice(0,2).toUpperCase())}</div><div><div class="account-title"><strong>${escapeHtml(account.gamertag)}</strong>${isMain?'<span class="main-account-pill">Main</span>':'<span class="alt-account-pill">Alt</span>'}${account.online?'<span class="online-account-pill">Online</span>':''}</div><span>${number.format(account.kills)} kills · ${number.format(account.deaths)} deaths · ${Number(account.kd).toFixed(2)} K/D</span></div></div><div class="account-actions">${!isMain?`<button class="clan-action" type="button" data-account-main="${escapeHtml(account.gamertag)}">Make main</button><button class="clan-action danger" type="button" data-account-remove="${escapeHtml(account.gamertag)}">Remove</button>`:''}</div></article>`;}
async function submitAccountRequest(url,options,success){try{await api(url,options);showToast(success);await renderAccounts();}catch(e){showToast(e.message,true);}}
async function renderAccounts(){
  contentRoot.innerHTML='<div class="empty-state"><div class="loader"></div><p>Loading linked accounts...</p></div>';
  try{
    const data=await api('/api/player/accounts');
    if(!data.linked){contentRoot.innerHTML='<section class="panel account-onboarding"><p class="eyebrow">Player identity</p><h1>Link your main account first</h1><p class="page-subtitle">Use <code>/link</code> on Discord to connect your primary DayZ gamertag. After that, you can manage alt accounts here.</p></section>';return;}
    const combined=data.combined||{};const longest=combined.longestShot;
    contentRoot.innerHTML=`<header class="accounts-header"><div><p class="eyebrow">Player identity</p><h1>My Accounts</h1><p class="page-subtitle">Keep your main and alt DayZ characters under one Discord identity without changing the individual leaderboard.</p></div><div class="account-count"><span>Linked characters</span><strong>${number.format(data.accounts.length)}</strong><small>${number.format(Math.max(0,data.config.maxAlts-(data.accounts.length-1)))} alt slots available</small></div></header><section class="account-combined-grid">${accountStatsCard('Combined overall',combined.overall)}${accountStatsCard('This week',combined.weekly)}${accountStatsCard('Today',combined.daily)}<article class="account-summary-card"><span>Best streak</span><strong>${number.format(Number(combined.bestStreak||0))}</strong><small>${longest?`Longest shot ${Math.round(longest.distance)} m · ${escapeHtml(longest.gamertag)}`:'No longshot recorded'}</small></article></section><section class="accounts-layout"><div class="panel"><div class="panel-header"><div><p class="eyebrow">Characters</p><h2>Linked accounts</h2></div></div><div class="account-list">${data.accounts.map(accountRow).join('')}</div></div><aside class="panel add-alt-panel"><p class="eyebrow">Add character</p><h2>Link an alt</h2><p class="page-subtitle">The gamertag must already exist in the server statistics and cannot belong to another Discord account.</p><form id="addAltForm" class="clan-form compact"><label><span>Gamertag</span><input name="gamertag" required maxlength="32" placeholder="Your alt gamertag"></label><button class="primary-button" type="submit" ${data.accounts.length-1>=data.config.maxAlts?'disabled':''}>Add alt</button></form><div class="account-info-box"><strong>How rankings work</strong><span>Player rankings remain character-based. Combined stats are shown only on your account profile for now.</span></div></aside></section>`;
    byId('addAltForm')?.addEventListener('submit',async(e)=>{e.preventDefault();const form=new FormData(e.currentTarget);await submitAccountRequest('/api/player/accounts/alts',{method:'POST',body:JSON.stringify({gamertag:form.get('gamertag')})},'Alt linked.');});
    document.querySelectorAll('[data-account-main]').forEach(button=>button.addEventListener('click',async()=>{const gamertag=button.dataset.accountMain;if(!confirm(`Make ${gamertag} your main account? Your current main will become an alt.`))return;await submitAccountRequest('/api/player/accounts/main',{method:'POST',body:JSON.stringify({gamertag})},'Main account updated.');}));
    document.querySelectorAll('[data-account-remove]').forEach(button=>button.addEventListener('click',async()=>{const gamertag=button.dataset.accountRemove;if(!confirm(`Remove ${gamertag} from your linked alts?`))return;await submitAccountRequest(`/api/player/accounts/alts/${encodeURIComponent(gamertag)}`,{method:'DELETE'},'Alt removed.');}));
  }catch(e){contentRoot.innerHTML=`<div class="empty-state"><p>${escapeHtml(e.message)}</p></div>`;}
}

const clanRoleLabels={owner:'Owner',officer:'Officer',member:'Member'};
const clanActivityLabels={created:'created the clan',updated:'updated clan details',invited:'invited',joined:'joined the clan',left:'left the clan',removed:'removed',promoted:'promoted',demoted:'demoted',ownership_transferred:'transferred ownership to'};
function clanActionButton(label,action,discordId='',tone=''){return `<button type="button" class="clan-action ${tone}" data-clan-action="${action}" ${discordId?`data-discord-id="${escapeHtml(discordId)}"`:''}>${escapeHtml(label)}</button>`;}
function clanMemberRow(member,permissions,currentDiscordId){
  const isSelf=member.discordId===currentDiscordId;let actions='';
  if(!isSelf&&member.role!=='owner'&&permissions.canManageMembers){
    if(permissions.role==='owner')actions+=member.role==='officer'?clanActionButton('Demote','demote',member.discordId):clanActionButton('Promote','promote',member.discordId);
    if(permissions.role==='owner'||member.role==='member')actions+=clanActionButton('Remove','remove',member.discordId,'danger');
    if(permissions.canTransferOwnership)actions+=clanActionButton('Make owner','transfer',member.discordId);
  }
  return `<div class="clan-member-row"><div class="clan-member-main"><div class="clan-avatar">${escapeHtml(member.gamertag.slice(0,2).toUpperCase())}</div><div><strong>${escapeHtml(member.gamertag)}${isSelf?' <span class="you-pill">You</span>':''}</strong><span>${escapeHtml(clanRoleLabels[member.role]||member.role)} · ${number.format(member.kills)} kills · ${Number(member.kd).toFixed(2)} K/D · ${number.format(member.linkedCharacters||1)} linked character${Number(member.linkedCharacters||1)===1?'':'s'}</span></div></div><div class="clan-member-actions">${actions}</div></div>`;
}
function renderClanActivity(events){if(!events.length)return '<div class="empty-state compact"><p>No clan activity yet.</p></div>';return events.map(event=>`<div class="clan-activity-row"><div class="activity-symbol clan">◉</div><div class="activity-main"><strong>${escapeHtml(event.actorGamertag)} ${escapeHtml(clanActivityLabels[event.type]||event.type)}${event.subject?` ${escapeHtml(event.subject)}`:''}</strong><span>${relativeTime(event.createdAt)}</span></div></div>`).join('');}
function clanInviteCard(invite){return `<article class="clan-invite-card"><div><p class="eyebrow">Clan invitation</p><h3>[${escapeHtml(invite.clanTag)}] ${escapeHtml(invite.clanName)}</h3><p>Invited by ${escapeHtml(invite.invitedByGamertag)} · expires ${relativeTime(invite.expiresAt)}</p></div><div class="clan-inline-actions"><button class="clan-action" data-invite-action="decline" data-invite-id="${escapeHtml(invite.id)}">Decline</button><button class="primary-button" data-invite-action="accept" data-invite-id="${escapeHtml(invite.id)}">Accept</button></div></article>`;}
async function submitClanRequest(url,options,success){try{await api(url,options);showToast(success);await renderClan();}catch(e){showToast(e.message,true);}}
async function renderClan(){
  contentRoot.innerHTML='<div class="empty-state"><div class="loader"></div><p>Loading clan...</p></div>';
  try{
    const data=await api('/api/player/clan');
    if(!data.profile.linked){contentRoot.innerHTML='<section class="panel clan-onboarding"><p class="eyebrow">Clan system</p><h1>Link your DayZ account first</h1><p class="page-subtitle">Use <code>/link</code> on Discord. Clan membership is tied to your Discord identity and linked DayZ account.</p></section>';return;}
    const invites=data.invites||[];
    if(!data.clan){
      contentRoot.innerHTML=`<header class="clan-page-header"><div><p class="eyebrow">Clan system</p><h1>Find your squad</h1><p class="page-subtitle">Create a clan or accept an invitation. Your clan will automatically compete in clan rankings.</p></div><a class="text-button" href="/app/rankings?scope=clans">View clan rankings →</a></header>${invites.length?`<section class="clan-invites">${invites.map(clanInviteCard).join('')}</section>`:''}<section class="panel clan-create-card"><div><p class="eyebrow">Create clan</p><h2>Build your identity</h2><p class="page-subtitle">Names and tags are unique. Tags use 2–6 letters or numbers.</p></div><form id="createClanForm" class="clan-form"><div class="clan-form-grid"><label><span>Clan name</span><input name="name" minlength="3" maxlength="32" required placeholder="The Survivors"></label><label><span>Tag</span><input name="tag" minlength="2" maxlength="6" required placeholder="SURV" style="text-transform:uppercase"></label></div><label><span>Description</span><textarea name="description" maxlength="180" placeholder="Tell the server what your clan is about."></textarea></label><button class="primary-button" type="submit">Create clan</button></form></section>`;
      byId('createClanForm')?.addEventListener('submit',async(e)=>{e.preventDefault();const form=new FormData(e.currentTarget);await submitClanRequest('/api/player/clan',{method:'POST',body:JSON.stringify({name:form.get('name'),tag:form.get('tag'),description:form.get('description')})},'Clan created.');});
      bindInviteActions();return;
    }
    const clan=data.clan;const me=clan.members.find(member=>member.role==='owner'&&clan.permissions.role==='owner')||clan.members.find(member=>member.gamertag===data.profile.gamertag);const currentDiscordId=me?.discordId||'';
    const management=clan.permissions.canInvite||clan.permissions.canEditClan?`<aside class="panel clan-management"><p class="eyebrow">Management</p><h2>Clan controls</h2>${clan.permissions.canInvite?`<form id="inviteClanForm" class="clan-form compact"><label><span>Invite linked gamertag</span><div class="clan-input-action"><input name="gamertag" required maxlength="40" placeholder="Player gamertag"><button class="primary-button" type="submit">Invite</button></div></label></form>`:''}${clan.permissions.canEditClan?`<form id="editClanForm" class="clan-form compact"><label><span>Clan name</span><input name="name" value="${escapeHtml(clan.name)}" minlength="3" maxlength="32" required></label><label><span>Tag</span><input name="tag" value="${escapeHtml(clan.tag)}" minlength="2" maxlength="6" required></label><label><span>Description</span><textarea name="description" maxlength="180">${escapeHtml(clan.description||'')}</textarea></label><button class="clan-action" type="submit">Save details</button></form>`:''}</aside>`:'';
    contentRoot.innerHTML=`<header class="clan-hero"><div class="clan-mark">${escapeHtml(clan.tag)}</div><div class="clan-hero-main"><p class="eyebrow">Your clan</p><h1>[${escapeHtml(clan.tag)}] ${escapeHtml(clan.name)}</h1><p class="page-subtitle">${escapeHtml(clan.description||'No clan description yet.')}</p><div class="clan-meta"><span>${number.format(clan.members.length)} / ${number.format(data.config.maxMembers)} members</span><span>Created ${new Date(clan.createdAt).toLocaleDateString()}</span><span>Your role: ${escapeHtml(clanRoleLabels[clan.permissions.role]||clan.permissions.role)}</span></div></div><a class="primary-button" href="/app/rankings?scope=clans">Clan rankings →</a></header><section class="clan-stats"><article><span>Kills</span><strong>${number.format(clan.stats.kills)}</strong></article><article><span>Deaths</span><strong>${number.format(clan.stats.deaths)}</strong></article><article><span>K/D</span><strong>${Number(clan.stats.kd).toFixed(2)}</strong></article><article><span>Best streak</span><strong>${number.format(clan.stats.streak)}</strong></article><article><span>Longshot</span><strong>${clan.stats.longshot?`${Math.round(clan.stats.longshot)} m`:'—'}</strong></article></section><section class="clan-layout"><div><article class="panel"><div class="panel-header"><div><p class="eyebrow">Roster</p><h2>Members</h2></div></div><div class="clan-members">${clan.members.map(member=>clanMemberRow(member,clan.permissions,currentDiscordId)).join('')}</div></article><article class="panel clan-activity"><div class="panel-header"><div><p class="eyebrow">Clan feed</p><h2>Recent activity</h2></div></div>${renderClanActivity(clan.activity)}</article></div><div>${management}<aside class="panel clan-danger"><p class="eyebrow">Membership</p><h2>${clan.permissions.role==='owner'?'Owner actions':'Your membership'}</h2>${clan.permissions.role==='owner'?'<p class="page-subtitle">Transfer ownership before leaving, or disband the clan permanently.</p><button id="disbandClan" class="clan-action danger full">Disband clan</button>':'<p class="page-subtitle">Leaving removes you from the roster immediately. You can join another clan afterward.</p><button id="leaveClan" class="clan-action danger full">Leave clan</button>'}</aside></div></section>`;
    byId('inviteClanForm')?.addEventListener('submit',async(e)=>{e.preventDefault();const form=new FormData(e.currentTarget);await submitClanRequest('/api/player/clan/invites',{method:'POST',body:JSON.stringify({gamertag:form.get('gamertag')})},'Invitation sent.');});
    byId('editClanForm')?.addEventListener('submit',async(e)=>{e.preventDefault();const form=new FormData(e.currentTarget);await submitClanRequest('/api/player/clan',{method:'PATCH',body:JSON.stringify({name:form.get('name'),tag:form.get('tag'),description:form.get('description')})},'Clan updated.');});
    document.querySelectorAll('[data-clan-action]').forEach(button=>button.addEventListener('click',async()=>{const action=button.dataset.clanAction;const discordId=button.dataset.discordId;if(action==='remove'){if(!confirm('Remove this member from the clan?'))return;await submitClanRequest(`/api/player/clan/members/${encodeURIComponent(discordId)}`,{method:'DELETE'},'Member removed.');}else if(action==='promote'||action==='demote'){await submitClanRequest(`/api/player/clan/members/${encodeURIComponent(discordId)}`,{method:'PATCH',body:JSON.stringify({role:action==='promote'?'officer':'member'})},action==='promote'?'Member promoted.':'Member demoted.');}else if(action==='transfer'){if(!confirm('Transfer clan ownership to this member? You will become an officer.'))return;await submitClanRequest('/api/player/clan/transfer',{method:'POST',body:JSON.stringify({discordId})},'Ownership transferred.');}}));
    byId('leaveClan')?.addEventListener('click',async()=>{if(!confirm('Leave this clan?'))return;await submitClanRequest('/api/player/clan/leave',{method:'POST',body:'{}'},'You left the clan.');});
    byId('disbandClan')?.addEventListener('click',async()=>{const name=prompt(`Type ${clan.tag} to permanently disband the clan.`);if(name!==clan.tag)return;await submitClanRequest('/api/player/clan',{method:'DELETE'},'Clan disbanded.');});
    bindInviteActions();
  }catch(e){contentRoot.innerHTML=`<div class="empty-state"><p>${escapeHtml(e.message)}</p></div>`;}
}
function bindInviteActions(){document.querySelectorAll('[data-invite-action]').forEach(button=>button.addEventListener('click',async()=>{const accept=button.dataset.inviteAction==='accept';await submitClanRequest(`/api/player/clan/invites/${encodeURIComponent(button.dataset.inviteId)}/respond`,{method:'POST',body:JSON.stringify({accept})},accept?'Welcome to the clan.':'Invitation declined.');}));}


function profileStatCard(label,value,unit=''){return `<article class="profile-stat-card"><span>${escapeHtml(label)}</span><strong>${escapeHtml(value)}${unit?` <small>${escapeHtml(unit)}</small>`:''}</strong></article>`;}
function profilePeriodCard(label,stats){return `<article class="profile-period-card"><p class="eyebrow">${escapeHtml(label)}</p><h3>Combat performance</h3><div class="profile-period-values"><div><span>Rank</span><strong>${stats.rank?`#${number.format(stats.rank)}`:'—'}</strong></div><div><span>Kills</span><strong>${number.format(stats.kills)}</strong></div><div><span>K/D</span><strong>${Number(stats.kd||0).toFixed(2)}</strong></div></div></article>`;}
async function renderPlayerProfile(){
  contentRoot.innerHTML='<div class="empty-state"><div class="loader"></div><p>Loading profile...</p></div>';
  try{
    const data=await api('/api/player/profile');
    const identity=data.identity;
    if(!identity.linked){
      contentRoot.innerHTML=`<section class="panel account-onboarding"><p class="eyebrow">Player profile</p><h1>Connect your DayZ identity</h1><p class="page-subtitle">Use <code>/link</code> on Discord to connect your main gamertag. Your profile will then bring together stats, records, clan and linked characters.</p><a class="primary-button profile-link-cta" href="/app/accounts">Open accounts →</a></section>`;
      return;
    }
    const overall=data.stats.overall||{};const records=data.records||{};const shot=records.longestShot;const clan=data.clan;
    const avatar=identity.avatarUrl?`<img class="profile-hero-avatar" src="${escapeHtml(identity.avatarUrl)}" alt="">`:`<div class="profile-hero-avatar fallback">${escapeHtml(String(identity.displayName||identity.gamertag||'?').slice(0,2).toUpperCase())}</div>`;
    const clanBadge=clan?`<span class="profile-badge clan">[${escapeHtml(clan.tag)}] ${escapeHtml(clan.name)}</span>`:'';
    const joined=identity.linkedAt?new Date(identity.linkedAt).toLocaleDateString(): '—';
    contentRoot.innerHTML=`<div class="player-profile-shell"><section class="profile-hero">${avatar}<div class="profile-hero-copy"><p class="eyebrow">Player identity</p><h1>${escapeHtml(identity.displayName)}</h1><div class="profile-gamertag">${escapeHtml(identity.gamertag)}</div><div class="profile-badges"><span class="profile-badge ${identity.online?'online':''}">${identity.online?'● Online':'○ Offline'}</span>${clanBadge}<span class="profile-badge">${number.format(identity.linkedCharacters)} linked character${identity.linkedCharacters===1?'':'s'}</span></div></div><div class="profile-rank-spotlight"><span>Overall rank</span><strong>${overall.rank?`#${number.format(overall.rank)}`:'—'}</strong></div></section><section class="profile-stat-grid">${profileStatCard('Kills',number.format(overall.kills||0))}${profileStatCard('Deaths',number.format(overall.deaths||0))}${profileStatCard('K/D',Number(overall.kd||0).toFixed(2))}${profileStatCard('Current streak',number.format(records.currentStreak||0))}${profileStatCard('Best streak',number.format(records.bestStreak||0))}${profileStatCard('Longest shot',shot?number.format(Math.round(shot.distance)):'—',shot?'m':'')}</section><section class="profile-period-grid">${profilePeriodCard('Overall',data.stats.overall)}${profilePeriodCard('This week',data.stats.weekly)}${profilePeriodCard('Today',data.stats.daily)}</section><section class="profile-content-grid"><article class="panel profile-records"><div class="panel-header" style="padding:0 0 12px"><div><p class="eyebrow">Personal bests</p><h2>Records</h2></div></div><div class="profile-record-list"><div class="profile-record-row"><span>Highest recorded killstreak</span><strong>${number.format(records.bestStreak||0)}</strong></div><div class="profile-record-row"><span>Current killstreak</span><strong>${number.format(records.currentStreak||0)}</strong></div><div class="profile-record-row"><span>Longest shot</span><strong>${shot?`${number.format(Math.round(shot.distance))} m${shot.weapon?` · ${escapeHtml(shot.weapon)}`:''}`:'No record yet'}</strong></div><div class="profile-record-row"><span>Overall position</span><strong>${overall.rank?`#${number.format(overall.rank)}`:'Unranked'}</strong></div></div></article><aside class="panel profile-identity-panel"><p class="eyebrow">Identity</p><h2>Player details</h2><div class="profile-identity-list"><div class="profile-identity-item"><span>Main character</span><strong>${escapeHtml(identity.gamertag)}</strong></div><div class="profile-identity-item"><span>Linked characters</span><strong>${number.format(identity.linkedCharacters)}</strong></div><div class="profile-identity-item"><span>Clan</span><strong>${clan?`[${escapeHtml(clan.tag)}] ${escapeHtml(clan.name)}`:'No clan'}</strong></div><div class="profile-identity-item"><span>Clan role</span><strong>${clan?escapeHtml(clan.role):'—'}</strong></div><div class="profile-identity-item"><span>Linked since</span><strong>${escapeHtml(joined)}</strong></div></div></aside></section><section class="profile-coming-grid"><article class="profile-coming-card"><p class="eyebrow">Coming next</p><h3>Timeline</h3><p>Your important combat, clan and server moments will live here without adding a new background polling service.</p></article><article class="profile-coming-card"><p class="eyebrow">Coming next</p><h3>Achievements</h3><p>Milestones and badges will plug into this profile as a separate system in a future iteration.</p></article></section></div>`;
  }catch(e){contentRoot.innerHTML=`<div class="empty-state"><p>${escapeHtml(e.message)}</p></div>`;}
}

function bootView(){const view=document.body.dataset.view;if(view==='shop'){const parts=location.pathname.split('/').filter(Boolean);if(parts[2]==='category'&&parts[3])renderCategory(decodeURIComponent(parts[3]));else if(parts[2]==='item'&&parts[3])renderItem(decodeURIComponent(parts[3]));else renderShopHome();return;}if(view==='purchases'){renderPurchases();return;}if(view==='profile'){renderPlayerProfile();return;}if(view==='rankings'){renderRankings();return;}if(view==='accounts'){renderAccounts();return;}if(view==='clan'){renderClan();return;}loadDashboard();}

bootView();

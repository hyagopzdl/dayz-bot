import type { PortalSession } from "../auth/session";
import { getOrCreateWalletForLink, hasEnoughCoins, purchaseWithWallet } from "./economy";
import { getPlayerLinkByDiscordId } from "./playerLinks";
import {
  assertShopCanAcceptPurchase,
  createShopOrder,
  ensureShopState,
  findSavedShopLocation,
  getSavedShopLocations,
  getShopRuntimeStatus,
  markShopLocationUsed,
  saveShopLocation,
} from "./shop";
import {
  ensureShopCatalogLoaded,
  findShopItem,
  getShopCategories,
  getShopItemDeliveryKind,
  getShopItems,
  getShopItemsByCategory,
} from "./shopCatalog";
import type { AppState, ShopOrder, ShopPendingCheckout } from "./state";

const CHECKOUT_TTL_MS = 10 * 60 * 1000;
const activeConfirmations = new Set<string>();

function roundCoord(value: unknown) {
  const number = Number(value);
  if (!Number.isFinite(number)) throw new Error("Invalid delivery coordinates.");
  if (number < 0 || number > 15360) throw new Error("Coordinates must be inside the Chernarus map.");
  return Number(number.toFixed(2));
}

export function prunePlayerShopCheckouts(state: AppState) {
  ensureShopState(state);
  const now = Date.now();
  state.shopPendingCheckouts = (state.shopPendingCheckouts || []).filter((checkout) => {
    const expiresAt = new Date(checkout.expiresAt || 0).getTime();
    return Number.isFinite(expiresAt) && expiresAt > now;
  });
  return state.shopPendingCheckouts;
}

export async function buildPlayerShopCatalog(state: AppState, session: PortalSession) {
  await ensureShopCatalogLoaded();
  const link = getPlayerLinkByDiscordId(state, session.discordId);
  const wallet = link ? getOrCreateWalletForLink(state, link).wallet : null;
  const runtime = getShopRuntimeStatus(state);
  const items = getShopItems();
  const categories = getShopCategories().map((category) => {
    const categoryItems = items.filter((item) => (item.category || "misc") === category.id);
    return {
      ...category,
      itemCount: categoryItems.length,
      previewImages: categoryItems.map((item) => item.imageUrl).filter(Boolean).slice(0, 3),
      minimumPrice: categoryItems.length ? Math.min(...categoryItems.map((item) => Number(item.price || 0))) : 0,
    };
  });

  return {
    profile: { linked: Boolean(link), gamertag: link?.gamertag || null },
    balance: Number(wallet?.balance || 0),
    runtime,
    categories,
  };
}

export async function buildPlayerShopCategory(state: AppState, session: PortalSession, categoryId: string) {
  await ensureShopCatalogLoaded();
  const catalog = await buildPlayerShopCatalog(state, session);
  const category = catalog.categories.find((candidate) => candidate.id === categoryId);
  if (!category) throw new Error("Category not found.");
  return {
    ...catalog,
    category,
    items: getShopItemsByCategory(categoryId).map(presentItem),
  };
}

export async function buildPlayerShopItem(state: AppState, session: PortalSession, itemId: string) {
  await ensureShopCatalogLoaded();
  const catalog = await buildPlayerShopCatalog(state, session);
  const item = findShopItem(itemId);
  if (!item) throw new Error("Item not found.");
  return { ...catalog, item: presentItem(item), locations: getSavedShopLocations(state, session.discordId) };
}

function presentItem(item: ReturnType<typeof getShopItems>[number]) {
  return {
    id: item.id,
    name: item.popularName || item.name,
    technicalName: item.name,
    description: item.description || "Delivered automatically at the selected location on the next server reset.",
    imageUrl: item.imageUrl || null,
    category: item.category || "misc",
    price: Number(item.price || 0),
    deliveryKind: getShopItemDeliveryKind(item),
  };
}

export function createPlayerShopCheckout(options: {
  state: AppState;
  session: PortalSession;
  itemId: string;
  x: unknown;
  z: unknown;
  locationId?: string;
  saveLocationName?: string;
}) {
  const state = ensureShopState(options.state);
  const link = getPlayerLinkByDiscordId(state, options.session.discordId);
  if (!link) throw new Error("Link your DayZ gamertag through Discord before purchasing.");
  assertShopCanAcceptPurchase(state);
  const item = findShopItem(options.itemId);
  if (!item) throw new Error("Item not found.");
  const x = roundCoord(options.x);
  const z = roundCoord(options.z);
  const y = 0;
  const saved = options.locationId
    ? findSavedShopLocation(state, options.session.discordId, options.locationId)
    : null;
  const locationName = String(options.saveLocationName || saved?.name || "").trim().slice(0, 40) || undefined;
  const now = new Date();
  prunePlayerShopCheckouts(state);
  const checkout: ShopPendingCheckout = {
    id: `checkout_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    discordUserId: options.session.discordId,
    itemId: item.id,
    itemClass: item.className,
    itemName: item.popularName || item.name,
    price: Number(item.price || 0),
    ...(item.spawnEventName ? { spawnEventName: item.spawnEventName } : {}),
    deliveryKind: getShopItemDeliveryKind(item),
    x, y, z,
    saveLocationName: locationName,
    createdAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + CHECKOUT_TTL_MS).toISOString(),
  };
  state.shopPendingCheckouts = (state.shopPendingCheckouts || []).filter((candidate) => candidate.discordUserId !== options.session.discordId);
  state.shopPendingCheckouts.push(checkout);
  if (saved) markShopLocationUsed(saved);
  const wallet = getOrCreateWalletForLink(state, link).wallet;
  return presentCheckout(checkout, wallet.balance, getShopRuntimeStatus(state));
}

export function getPlayerShopCheckout(state: AppState, session: PortalSession, checkoutId: string) {
  const checkout = prunePlayerShopCheckouts(state).find((candidate) => candidate.id === checkoutId && candidate.discordUserId === session.discordId);
  if (!checkout) throw new Error("This checkout expired. Select the item again.");
  const link = getPlayerLinkByDiscordId(state, session.discordId);
  if (!link) throw new Error("Player account is not linked.");
  const wallet = getOrCreateWalletForLink(state, link).wallet;
  return presentCheckout(checkout, wallet.balance, getShopRuntimeStatus(state));
}

function presentCheckout(checkout: ShopPendingCheckout, balance: number, runtime: ReturnType<typeof getShopRuntimeStatus>) {
  return {
    id: checkout.id,
    item: { id: checkout.itemId, name: checkout.itemName || checkout.itemClass, price: Number(checkout.price || 0), deliveryKind: checkout.deliveryKind },
    location: { name: checkout.saveLocationName || null, x: checkout.x, z: checkout.z },
    balance,
    balanceAfter: Math.max(0, balance - Number(checkout.price || 0)),
    expiresAt: checkout.expiresAt,
    runtime,
  };
}

export function confirmPlayerShopCheckout(state: AppState, session: PortalSession, checkoutId: string) {
  if (activeConfirmations.has(checkoutId)) throw new Error("This purchase is already being processed.");
  activeConfirmations.add(checkoutId);
  try {
    const checkout = prunePlayerShopCheckouts(state).find((candidate) => candidate.id === checkoutId && candidate.discordUserId === session.discordId);
    if (!checkout) throw new Error("This checkout expired. Select the item again.");
    const link = getPlayerLinkByDiscordId(state, session.discordId);
    if (!link) throw new Error("Player account is not linked.");
    assertShopCanAcceptPurchase(state);
    const price = Number(checkout.price || 0);
    if (!hasEnoughCoins(state, link, price)) throw new Error("Insufficient balance.");
    const walletBefore = getOrCreateWalletForLink(state, link).wallet.balance;
    if (checkout.saveLocationName) {
      saveShopLocation({ state, discordUserId: session.discordId, name: checkout.saveLocationName, x: checkout.x, y: checkout.y, z: checkout.z });
    }
    const order = createShopOrder({ state, discordUserId: session.discordId, itemInput: checkout.itemId, x: checkout.x, y: checkout.y, z: checkout.z, price, locationName: checkout.saveLocationName });
    if (price > 0) purchaseWithWallet({ state, link, amount: price, itemName: checkout.itemName || order.itemName || checkout.itemClass, orderId: order.id });
    const walletAfter = getOrCreateWalletForLink(state, link).wallet.balance;
    order.price = price;
    order.locationName = checkout.saveLocationName;
    order.balanceBefore = walletBefore;
    order.balanceAfter = walletAfter;
    state.shopPendingCheckouts = (state.shopPendingCheckouts || []).filter((candidate) => candidate.id !== checkoutId);
    return presentOrder(order);
  } finally {
    activeConfirmations.delete(checkoutId);
  }
}

export function buildPlayerPurchases(state: AppState, session: PortalSession) {
  ensureShopState(state);
  return (state.shopOrders || [])
    .filter((order) => order.discordUserId === session.discordId)
    .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)))
    .map(presentOrder);
}

function statusCopy(status: ShopOrder["status"]) {
  if (status === "pending_spawn") return { key: status, label: "Waiting for next reset", step: 2, tone: "waiting" };
  if (status === "included_in_restart") return { key: status, label: "Delivery prepared", step: 3, tone: "progress" };
  if (status === "spawned") return { key: status, label: "Delivered", step: 4, tone: "success" };
  return { key: status, label: "Delivery failed", step: 4, tone: "danger" };
}

export function presentOrder(order: ShopOrder) {
  return {
    id: order.id,
    itemName: order.itemName || order.itemClass,
    price: Number(order.price || 0),
    location: { name: order.locationName || null, x: order.x, z: order.z },
    status: statusCopy(order.status),
    createdAt: order.createdAt,
    includedAt: order.includedAt || null,
    deliveredAt: order.spawnedAt || null,
    failedAt: order.failedAt || null,
    failReason: order.failReason || null,
    balanceBefore: order.balanceBefore ?? null,
    balanceAfter: order.balanceAfter ?? null,
  };
}

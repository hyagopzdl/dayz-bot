import crypto from "crypto";
import type { AppState, EconomyTransaction, EconomyTransactionType, PlayerLink, Wallet } from "./state";

const TRANSACTION_HISTORY_LIMIT = Number(process.env.ECONOMY_TRANSACTION_HISTORY_LIMIT || 1000);

function nowIso() {
  return new Date().toISOString();
}

function normalizeAmount(amount: number): number {
  return Math.max(0, Math.floor(Number(amount || 0)));
}

export function ensureEconomyState(state: AppState) {
  state.wallets = state.wallets || {};
  state.economyTransactions = Array.isArray(state.economyTransactions) ? state.economyTransactions : [];
}

export function getWalletByDiscordId(state: AppState, discordId: string): Wallet | null {
  ensureEconomyState(state);
  return state.wallets[discordId] || null;
}

export function getOrCreateWalletForLink(state: AppState, link: PlayerLink): { wallet: Wallet; created: boolean } {
  ensureEconomyState(state);

  const existing = state.wallets[link.discordId];
  if (existing) {
    if (existing.gamertag !== link.gamertag) {
      existing.gamertag = link.gamertag;
      existing.updatedAt = nowIso();
    }
    return { wallet: existing, created: false };
  }

  const createdAt = nowIso();
  const wallet: Wallet = {
    discordId: link.discordId,
    gamertag: link.gamertag,
    balance: 0,
    totalEarned: 0,
    totalSpent: 0,
    onlineRewardMinutes: 0,
    createdAt,
    updatedAt: createdAt,
  };

  state.wallets[link.discordId] = wallet;
  return { wallet, created: true };
}

export function recordEconomyTransaction(params: {
  state: AppState;
  discordId: string;
  gamertag: string;
  type: EconomyTransactionType;
  amount: number;
  balanceBefore: number;
  balanceAfter: number;
  reason?: string;
  createdBy?: string;
}): EconomyTransaction {
  ensureEconomyState(params.state);

  const transaction: EconomyTransaction = {
    id: crypto.randomUUID(),
    discordId: params.discordId,
    gamertag: params.gamertag,
    type: params.type,
    amount: normalizeAmount(params.amount),
    balanceBefore: normalizeAmount(params.balanceBefore),
    balanceAfter: normalizeAmount(params.balanceAfter),
    reason: params.reason,
    createdAt: nowIso(),
    createdBy: params.createdBy,
  };

  params.state.economyTransactions.push(transaction);
  params.state.economyTransactions = params.state.economyTransactions.slice(-TRANSACTION_HISTORY_LIMIT);

  return transaction;
}

export function addCoins(params: {
  state: AppState;
  link: PlayerLink;
  amount: number;
  reason?: string;
  createdBy?: string;
}) {
  const amount = normalizeAmount(params.amount);
  const { wallet } = getOrCreateWalletForLink(params.state, params.link);
  const balanceBefore = wallet.balance;
  wallet.balance = balanceBefore + amount;
  wallet.totalEarned = Math.max(0, Math.floor(Number(wallet.totalEarned || 0))) + amount;
  wallet.updatedAt = nowIso();

  const transaction = recordEconomyTransaction({
    state: params.state,
    discordId: params.link.discordId,
    gamertag: params.link.gamertag,
    type: "ADMIN_ADD",
    amount,
    balanceBefore,
    balanceAfter: wallet.balance,
    reason: params.reason,
    createdBy: params.createdBy,
  });

  return { wallet, transaction };
}

export function removeCoins(params: {
  state: AppState;
  link: PlayerLink;
  amount: number;
  reason?: string;
  createdBy?: string;
}) {
  const amount = normalizeAmount(params.amount);
  const { wallet } = getOrCreateWalletForLink(params.state, params.link);
  const balanceBefore = wallet.balance;
  const appliedAmount = Math.min(balanceBefore, amount);
  wallet.balance = Math.max(0, balanceBefore - amount);
  wallet.totalSpent = Math.max(0, Math.floor(Number(wallet.totalSpent || 0))) + appliedAmount;
  wallet.updatedAt = nowIso();

  const transaction = recordEconomyTransaction({
    state: params.state,
    discordId: params.link.discordId,
    gamertag: params.link.gamertag,
    type: "ADMIN_REMOVE",
    amount: appliedAmount,
    balanceBefore,
    balanceAfter: wallet.balance,
    reason: params.reason,
    createdBy: params.createdBy,
  });

  return { wallet, transaction, requestedAmount: amount, appliedAmount };
}

export function setCoins(params: {
  state: AppState;
  link: PlayerLink;
  amount: number;
  reason?: string;
  createdBy?: string;
}) {
  const amount = normalizeAmount(params.amount);
  const { wallet } = getOrCreateWalletForLink(params.state, params.link);
  const balanceBefore = wallet.balance;
  wallet.balance = amount;

  if (amount > balanceBefore) {
    wallet.totalEarned = Math.max(0, Math.floor(Number(wallet.totalEarned || 0))) + (amount - balanceBefore);
  } else if (amount < balanceBefore) {
    wallet.totalSpent = Math.max(0, Math.floor(Number(wallet.totalSpent || 0))) + (balanceBefore - amount);
  }

  wallet.updatedAt = nowIso();

  const transaction = recordEconomyTransaction({
    state: params.state,
    discordId: params.link.discordId,
    gamertag: params.link.gamertag,
    type: "ADMIN_SET",
    amount,
    balanceBefore,
    balanceAfter: wallet.balance,
    reason: params.reason,
    createdBy: params.createdBy,
  });

  return { wallet, transaction };
}

export function debitCoins(params: {
  state: AppState;
  link: PlayerLink;
  amount: number;
  type: Extract<EconomyTransactionType, "ADMIN_REMOVE" | "SHOP_PURCHASE">;
  reason?: string;
  createdBy?: string;
}) {
  const amount = normalizeAmount(params.amount);
  const { wallet } = getOrCreateWalletForLink(params.state, params.link);
  const balanceBefore = wallet.balance;

  if (amount <= 0) {
    throw new Error("Amount must be greater than zero.");
  }

  if (balanceBefore < amount) {
    throw new Error("Insufficient balance.");
  }

  wallet.balance = balanceBefore - amount;
  wallet.totalSpent = Math.max(0, Math.floor(Number(wallet.totalSpent || 0))) + amount;
  wallet.updatedAt = nowIso();

  const transaction = recordEconomyTransaction({
    state: params.state,
    discordId: params.link.discordId,
    gamertag: params.link.gamertag,
    type: params.type,
    amount,
    balanceBefore,
    balanceAfter: wallet.balance,
    reason: params.reason,
    createdBy: params.createdBy,
  });

  return { wallet, transaction };
}

export function purchaseWithWallet(params: {
  state: AppState;
  link: PlayerLink;
  amount: number;
  itemName: string;
  orderId?: string;
}) {
  return debitCoins({
    state: params.state,
    link: params.link,
    amount: params.amount,
    type: "SHOP_PURCHASE",
    reason: params.orderId
      ? `Shop purchase: ${params.itemName} (${params.orderId})`
      : `Shop purchase: ${params.itemName}`,
    createdBy: params.link.discordId,
  });
}

export function hasEnoughCoins(state: AppState, link: PlayerLink, amount: number) {
  const { wallet } = getOrCreateWalletForLink(state, link);
  return wallet.balance >= normalizeAmount(amount);
}


export function addPlaytimeRewardMinutes(params: {
  state: AppState;
  link: PlayerLink;
  minutes: number;
  rewardMinutes: number;
  rewardCoins: number;
  reason?: string;
}) {
  ensureEconomyState(params.state);

  const minutes = Math.max(0, Math.floor(Number(params.minutes || 0)));
  const rewardMinutes = Math.max(1, Math.floor(Number(params.rewardMinutes || 60)));
  const rewardCoins = Math.max(0, Math.floor(Number(params.rewardCoins || 0)));
  const { wallet } = getOrCreateWalletForLink(params.state, params.link);

  wallet.onlineRewardMinutes = Math.max(0, Math.floor(Number(wallet.onlineRewardMinutes || 0))) + minutes;
  wallet.updatedAt = nowIso();

  const rewardsToPay = rewardCoins > 0 ? Math.floor(wallet.onlineRewardMinutes / rewardMinutes) : 0;
  if (rewardsToPay <= 0) {
    return { wallet, transaction: null, paid: false, paidAmount: 0, remainingMinutes: wallet.onlineRewardMinutes };
  }

  const paidAmount = rewardsToPay * rewardCoins;
  const consumedMinutes = rewardsToPay * rewardMinutes;
  const balanceBefore = wallet.balance;

  wallet.balance = balanceBefore + paidAmount;
  wallet.totalEarned = Math.max(0, Math.floor(Number(wallet.totalEarned || 0))) + paidAmount;
  wallet.onlineRewardMinutes = Math.max(0, wallet.onlineRewardMinutes - consumedMinutes);
  wallet.lastPlaytimeRewardAt = nowIso();
  wallet.updatedAt = wallet.lastPlaytimeRewardAt;

  const transaction = recordEconomyTransaction({
    state: params.state,
    discordId: params.link.discordId,
    gamertag: params.link.gamertag,
    type: "PLAYTIME_REWARD",
    amount: paidAmount,
    balanceBefore,
    balanceAfter: wallet.balance,
    reason: params.reason || `Online time reward (${consumedMinutes} minutes)`,
    createdBy: "system:playtime",
  });

  return { wallet, transaction, paid: true, paidAmount, remainingMinutes: wallet.onlineRewardMinutes };
}

export function formatCoins(amount: number): string {
  return new Intl.NumberFormat("en-US").format(Math.floor(Number(amount || 0)));
}

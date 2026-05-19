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

export function formatCoins(amount: number): string {
  return new Intl.NumberFormat("en-US").format(Math.floor(Number(amount || 0)));
}

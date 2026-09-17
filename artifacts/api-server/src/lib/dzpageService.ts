import { getDayzItemImageOverrides } from "./dayzItemOverridesService";

const DZPAGE_API_BASE_URL = "https://dzpage.com/api/v1";
const DEFAULT_SEARCH_LIMIT = 48;
const MAX_SEARCH_LIMIT = 100;
const SEARCH_CACHE_TTL_MS = 30_000;
const ITEM_CACHE_TTL_MS = 10 * 60_000;
const META_CACHE_TTL_MS = 60 * 60_000;

type CacheEntry<T> = {
  value: T;
  expiresAt: number;
};

export type DzPageItemSummary = {
  className: string;
  slug: string;
  name: string;
  category: string;
  hasIcon: boolean;
  iconUrl?: string;
  iconThumbUrl?: string;
  url?: string;
};

export type DzPageSearchResult = {
  items: DzPageItemSummary[];
  total: number;
  page: number;
  pages: number;
  limit: number;
};

export type DzPageMeta = {
  [key: string]: unknown;
};

const searchCache = new Map<string, CacheEntry<DzPageSearchResult>>();
const itemCache = new Map<string, CacheEntry<DzPageItemSummary>>();
let metaCache: CacheEntry<DzPageMeta> | null = null;

function getApiKey() {
  const key = String(process.env.DZPAGE_API_KEY || "").trim();
  if (!key) {
    throw new Error("DZPage API is not configured: DZPAGE_API_KEY is missing.");
  }
  return key;
}

function buildUrl(path: string, params?: URLSearchParams) {
  const url = new URL(`${DZPAGE_API_BASE_URL}${path}`);
  if (params) url.search = params.toString();
  return url;
}

async function requestJson<T>(path: string, params?: URLSearchParams): Promise<T> {
  const response = await fetch(buildUrl(path, params), {
    headers: {
      Authorization: `Bearer ${getApiKey()}`,
      Accept: "application/json",
      "User-Agent": "PZs-DayZ-Bot/1.0",
    },
  });

  let payload: any = null;
  try {
    payload = await response.json();
  } catch {
    payload = null;
  }

  if (!response.ok) {
    const errorCode = String(payload?.error || `http_${response.status}`);
    const message = String(payload?.message || `DZPage API request failed with HTTP ${response.status}.`);
    const error = new Error(`${errorCode}: ${message}`);
    (error as Error & { status?: number; retryAfter?: string }).status = response.status;
    (error as Error & { status?: number; retryAfter?: string }).retryAfter = response.headers.get("Retry-After") || undefined;
    throw error;
  }

  return payload as T;
}

function normalizeItem(item: any): DzPageItemSummary {
  return {
    className: String(item?.class_name || "").trim(),
    slug: String(item?.slug || "").trim(),
    name: String(item?.name || item?.class_name || "").trim(),
    category: String(item?.category || "Misc").trim(),
    hasIcon: item?.has_icon === true,
    iconUrl: item?.icon ? String(item.icon).trim() : undefined,
    iconThumbUrl: item?.icon_thumb ? String(item.icon_thumb).trim() : undefined,
    url: item?.url ? String(item.url).trim() : undefined,
  };
}

async function applyImageOverrides(items: DzPageItemSummary[]) {
  if (!items.length) return items;
  const overrides = await getDayzItemImageOverrides();
  return items.map((item) => {
    const override = overrides.get(item.className.trim().toLowerCase());
    if (!override) return item;
    return { ...item, iconUrl: override, iconThumbUrl: override, hasIcon: true };
  });
}

function getFresh<T>(entry: CacheEntry<T> | undefined | null) {
  return entry && entry.expiresAt > Date.now() ? entry.value : undefined;
}

export async function searchDzPageItems(options: {
  query?: string;
  category?: string;
  page?: number;
  limit?: number;
  iconsOnly?: boolean;
  language?: string;
  forceRefresh?: boolean;
} = {}): Promise<DzPageSearchResult> {
  const page = Math.max(1, Math.floor(Number(options.page || 1)));
  const limit = Math.min(MAX_SEARCH_LIMIT, Math.max(1, Math.floor(Number(options.limit || DEFAULT_SEARCH_LIMIT))));
  const language = String(options.language || "pt").trim().toLowerCase();
  const query = String(options.query || "").trim();
  const category = String(options.category || "").trim();
  const iconsOnly = options.iconsOnly === true;
  const cacheKey = JSON.stringify({ query, category, page, limit, language, iconsOnly });

  if (!options.forceRefresh) {
    const cached = getFresh(searchCache.get(cacheKey));
    if (cached) return cached;
  }

  const params = new URLSearchParams({ page: String(page), limit: String(limit), lang: language });
  if (query) params.set("q", query);
  if (category) params.set("cat", category);
  if (iconsOnly) params.set("icons", "1");

  const payload = await requestJson<{ meta?: any; items?: any[] }>("/items", params);
  const normalizedItems = Array.isArray(payload?.items)
    ? payload.items.map(normalizeItem).filter((item) => item.className)
    : [];
  const result: DzPageSearchResult = {
    items: await applyImageOverrides(normalizedItems),
    total: Number(payload?.meta?.total || 0),
    page: Number(payload?.meta?.page || page),
    pages: Number(payload?.meta?.pages || 0),
    limit: Number(payload?.meta?.limit || limit),
  };

  searchCache.set(cacheKey, { value: result, expiresAt: Date.now() + SEARCH_CACHE_TTL_MS });
  return result;
}

export async function getDzPageItem(className: string, options: { language?: string; forceRefresh?: boolean } = {}) {
  const normalizedClassName = String(className || "").trim();
  if (!normalizedClassName) throw new Error("className is required.");

  const language = String(options.language || "pt").trim().toLowerCase();
  const cacheKey = `${normalizedClassName.toLowerCase()}:${language}`;
  if (!options.forceRefresh) {
    const cached = getFresh(itemCache.get(cacheKey));
    if (cached) {
      const [resolved] = await applyImageOverrides([cached]);
      return resolved;
    }
  }

  const params = new URLSearchParams({ lang: language });
  const payload = await requestJson<{ item?: any }>(`/items/${encodeURIComponent(normalizedClassName)}`, params);
  if (!payload?.item) throw new Error(`DZPage item not found: ${normalizedClassName}`);

  const item = normalizeItem(payload.item);
  itemCache.set(cacheKey, { value: item, expiresAt: Date.now() + ITEM_CACHE_TTL_MS });
  const [resolved] = await applyImageOverrides([item]);
  return resolved;
}

export async function getDzPageMeta(options: { forceRefresh?: boolean } = {}) {
  if (!options.forceRefresh) {
    const cached = getFresh(metaCache);
    if (cached) return cached;
  }

  const payload = await requestJson<DzPageMeta>("/meta");
  metaCache = { value: payload, expiresAt: Date.now() + META_CACHE_TTL_MS };
  return payload;
}

export function clearDzPageCache() {
  searchCache.clear();
  itemCache.clear();
  metaCache = null;
}

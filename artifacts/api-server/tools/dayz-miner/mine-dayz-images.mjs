import fs from 'node:fs/promises';
import path from 'node:path';

const API_URL = 'https://dayz.fandom.com/api.php';
const BASE_WIKI = 'https://dayz.fandom.com/wiki/';
const CACHE_FILE = '.dayz-fandom-cache.json';
const DEFAULT_PLACEHOLDER = '/artifacts/api-server/assets/ui/img-placeholder.png';

const COLOR_WORDS = new Set([
  'black', 'blue', 'brown', 'green', 'grey', 'gray', 'orange', 'pink', 'red',
  'white', 'yellow', 'beige', 'camo', 'olive', 'khaki', 'tan', 'purple',
  'lime', 'natural', 'mossy', 'woodland', 'autumn', 'summer', 'winter', 'spring'
]);

const STOPWORDS = new Set([
  'the', 'a', 'an', 'and', 'of', 'with', 'by', 'for', 'to', 'in', 'on', 'or',
  'food', 'internal', 'testing', 'placeholder', 'restrained', 'boxed', 'rounds', 'rnd'
]);

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function argValue(name, fallback = '') {
  const idx = process.argv.indexOf(name);
  return idx >= 0 && process.argv[idx + 1] ? process.argv[idx + 1] : fallback;
}

const inputFile = argValue('--input', 'dayz-items.json');
const outputFile = argValue('--output', 'dayz-items-with-url-img.json');
const auditFile = argValue('--audit', 'dayz-items-image-audit.csv');
const placeholderUrl = argValue('--placeholder', DEFAULT_PLACEHOLDER);
const limit = Number(argValue('--limit', '0'));
const delayMs = Number(argValue('--delay-ms', '350'));

function norm(text = '') {
  return String(text).toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

function tokens(text = '') {
  return new Set(norm(text).split(/\s+/).filter((t) => t.length > 1 && !STOPWORDS.has(t)));
}

function classTokens(className = '') {
  const spaced = String(className).replace(/([a-z])([A-Z])/g, '$1 $2').replace(/_/g, ' ');
  return tokens(spaced);
}

function intersectionSize(a, b) {
  let count = 0;
  for (const x of a) if (b.has(x)) count += 1;
  return count;
}

function wikiUrl(title) {
  return BASE_WIKI + encodeURIComponent(String(title).replaceAll(' ', '_')).replaceAll('%2F', '/');
}

async function loadCache() {
  try {
    return JSON.parse(await fs.readFile(CACHE_FILE, 'utf8'));
  } catch {
    return { search: {}, page: {}, images: {} };
  }
}

async function saveCache(cache) {
  await fs.writeFile(CACHE_FILE, JSON.stringify(cache, null, 2));
}

class Miner {
  constructor(cache) {
    this.cache = cache;
  }

  async api(params) {
    const url = new URL(API_URL);
    Object.entries({ ...params, format: 'json', formatversion: '2' }).forEach(([k, v]) => url.searchParams.set(k, v));
    let lastError;
    for (let attempt = 0; attempt < 4; attempt += 1) {
      try {
        const res = await fetch(url, { headers: { 'User-Agent': 'DayZ image URL miner for Replit' } });
        if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
        await sleep(delayMs);
        return await res.json();
      } catch (err) {
        lastError = err;
        await sleep(1500 * (attempt + 1));
      }
    }
    throw lastError;
  }

  async searchTitles(query, limit = 8) {
    const key = query.toLowerCase();
    if (this.cache.search[key]) return this.cache.search[key];
    const data = await this.api({ action: 'query', list: 'search', srsearch: query, srlimit: String(limit) });
    const titles = data?.query?.search?.map((x) => x.title) || [];
    this.cache.search[key] = titles;
    return titles;
  }

  async pagePayload(title) {
    if (Object.hasOwn(this.cache.page, title)) return this.cache.page[title];
    const data = await this.api({
      action: 'query',
      prop: 'revisions|images',
      titles: title,
      rvprop: 'content',
      rvslots: 'main',
      imlimit: 'max'
    });
    const page = data?.query?.pages?.[0];
    if (!page || page.missing) {
      this.cache.page[title] = null;
      return null;
    }
    const content = page.revisions?.[0]?.slots?.main?.content || '';
    const payload = {
      title: page.title || title,
      content,
      images: (page.images || []).map((img) => img.title).filter(Boolean)
    };
    this.cache.page[title] = payload;
    return payload;
  }

  async imageInfo(fileTitles) {
    const missing = fileTitles.filter((t) => !this.cache.images[t]);
    for (let i = 0; i < missing.length; i += 50) {
      const batch = missing.slice(i, i + 50);
      if (!batch.length) continue;
      const data = await this.api({ action: 'query', prop: 'imageinfo', titles: batch.join('|'), iiprop: 'url' });
      for (const page of data?.query?.pages || []) {
        const title = page.title;
        const info = page.imageinfo?.[0] || {};
        this.cache.images[title] = { url: info.url || '', imagePageUrl: info.descriptionurl || wikiUrl(title) };
      }
    }
    return Object.fromEntries(fileTitles.map((title) => [title, this.cache.images[title] || { url: '', imagePageUrl: wikiUrl(title) }]));
  }

  titleCandidates(item) {
    const cn = item.className || '';
    const pn = item.popularName || '';
    const guesses = [];
    if (pn && !pn.startsWith('$') && !pn.includes('Internal:')) guesses.push(pn);
    const pnParts = pn.split(/\s+/);
    if (pnParts.length && COLOR_WORDS.has(pnParts.at(-1).toLowerCase())) guesses.push(pnParts.slice(0, -1).join(' '));
    const base = cn.replace(/_(Black|Blue|Brown|Green|Grey|Gray|Orange|Pink|Red|White|Yellow|Beige|Camo|Olive|Khaki|Tan)$/i, '');
    if (base !== cn) guesses.push(base.replaceAll('_', ' '));
    guesses.push(cn.replaceAll('_', ' '));
    return [...new Map(guesses.map((g) => [g.trim().toLowerCase(), g.trim()])).values()].filter(Boolean);
  }

  scorePage(item, payload) {
    const cn = item.className || '';
    const pn = item.popularName || '';
    const hay = norm(`${payload.title} ${payload.content}`);
    let score = 0;
    if (hay.includes(norm(cn))) score += 100;
    if (hay.includes(norm(pn))) score += 30;
    score += 4 * intersectionSize(tokens(pn), tokens(payload.title));
    score += 3 * intersectionSize(classTokens(cn), tokens(payload.title));
    return score;
  }

  async choosePage(item) {
    const titles = [];
    for (const query of this.titleCandidates(item)) {
      titles.push(query);
      titles.push(...await this.searchTitles(query));
    }
    let best = null;
    const seen = new Set();
    for (const title of titles) {
      const key = title.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      const payload = await this.pagePayload(title);
      if (!payload) continue;
      const score = this.scorePage(item, payload);
      if (!best || score > best.score) best = { score, payload };
    }
    return best && best.score > 0 ? best.payload : null;
  }

  scoreImage(item, fileTitle) {
    const cn = item.className || '';
    const pn = item.popularName || '';
    const fileTokens = tokens(fileTitle.replace(/^File:/, ''));
    const cnParts = new Set(cn.split(/[_\W]+/).map((x) => x.toLowerCase()).filter(Boolean));
    let score = 0;
    score += 10 * intersectionSize(tokens(pn), fileTokens);
    score += 8 * intersectionSize(classTokens(cn), fileTokens);
    for (const color of COLOR_WORDS) {
      if (cnParts.has(color) || tokens(pn).has(color)) score += fileTokens.has(color) ? 40 : -20;
    }
    const bad = new Set(['jpg', 'screenshot', 'cooking', 'deployed', 'types', 'with', 'used']);
    score -= 8 * intersectionSize(bad, fileTokens);
    return score;
  }

  async mineItem(item) {
    const page = await this.choosePage(item);
    if (!page) return { urlImg: placeholderUrl, matchStatus: 'not_found', imagePageUrl: '' };
    const files = page.images.filter((f) => /\.(png|jpg|jpeg|webp)$/i.test(f));
    if (!files.length) return { urlImg: placeholderUrl, matchStatus: 'page_found_no_image', imagePageUrl: '' };
    const bestFile = files.sort((a, b) => this.scoreImage(item, b) - this.scoreImage(item, a))[0];
    const info = (await this.imageInfo([bestFile]))[bestFile];
    return { urlImg: info.url || placeholderUrl, matchStatus: info.url ? 'matched' : 'image_without_url', imagePageUrl: info.imagePageUrl || '' };
  }
}

function csvEscape(value) {
  const s = String(value ?? '');
  return /[",\n]/.test(s) ? `"${s.replaceAll('"', '""')}"` : s;
}

async function main() {
  const raw = JSON.parse(await fs.readFile(inputFile, 'utf8'));
  const items = limit > 0 ? raw.slice(0, limit) : raw;
  const cache = await loadCache();
  const miner = new Miner(cache);
  const output = [];
  const audit = [['className', 'popularName', 'urlImg', 'matchStatus', 'imagePageUrl']];

  for (let i = 0; i < items.length; i += 1) {
    const item = items[i];
    let mined;
    try {
      mined = await miner.mineItem(item);
    } catch (err) {
      mined = { urlImg: placeholderUrl, matchStatus: `error: ${err.message}`, imagePageUrl: '' };
    }

    output.push({ ...item, urlImg: mined.urlImg });
    audit.push([item.className || '', item.popularName || '', mined.urlImg, mined.matchStatus, mined.imagePageUrl]);
    console.log(`[${i + 1}/${items.length}] ${item.className} -> ${mined.matchStatus}`);

    if ((i + 1) % 25 === 0) {
      await saveCache(cache);
      await fs.writeFile(outputFile, JSON.stringify(output, null, 2));
    }
  }

  await saveCache(cache);
  await fs.writeFile(outputFile, JSON.stringify(output, null, 2));
  await fs.writeFile(auditFile, audit.map((row) => row.map(csvEscape).join(',')).join('\n'));
  console.log(`\nOK: ${outputFile}`);
  console.log(`Auditoria: ${auditFile}`);
  console.log(`Placeholder usado quando não encontra imagem: ${placeholderUrl}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

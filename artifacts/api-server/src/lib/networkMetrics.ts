export type NetworkDirection = "outbound" | "inbound" | "http-response";

export type NetworkTransferSample = {
  at: string;
  service: string;
  operation: string;
  direction: NetworkDirection;
  bytes: number;
  ok: boolean;
};

type NetworkBucket = {
  requests: number;
  failures: number;
  outboundBytes: number;
  inboundBytes: number;
  httpResponseBytes: number;
  lastAt?: string;
};

const startedAt = new Date().toISOString();
const buckets: Record<string, NetworkBucket> = {};
const recentTransfers: NetworkTransferSample[] = [];

function bucketFor(service: string) {
  const key = service || "unknown";
  if (!buckets[key]) {
    buckets[key] = {
      requests: 0,
      failures: 0,
      outboundBytes: 0,
      inboundBytes: 0,
      httpResponseBytes: 0,
    };
  }
  return buckets[key];
}

function sanitizeBytes(bytes: number) {
  return Number.isFinite(bytes) && bytes > 0 ? Math.floor(bytes) : 0;
}

export function recordNetworkTransfer(input: {
  service: string;
  operation: string;
  direction: NetworkDirection;
  bytes: number;
  ok?: boolean;
}) {
  const bytes = sanitizeBytes(input.bytes);
  const ok = input.ok !== false;
  const at = new Date().toISOString();
  const bucket = bucketFor(input.service);

  bucket.requests += 1;
  if (!ok) bucket.failures += 1;
  bucket.lastAt = at;
  if (input.direction === "outbound") bucket.outboundBytes += bytes;
  else if (input.direction === "inbound") bucket.inboundBytes += bytes;
  else bucket.httpResponseBytes += bytes;

  recentTransfers.push({
    at,
    service: input.service,
    operation: input.operation,
    direction: input.direction,
    bytes,
    ok,
  });
  if (recentTransfers.length > 120) {
    recentTransfers.splice(0, recentTransfers.length - 120);
  }
}

export function byteLengthOfBody(body: unknown): number {
  if (body == null) return 0;
  if (typeof body === "string") return Buffer.byteLength(body, "utf8");
  if (Buffer.isBuffer(body)) return body.length;
  if (body instanceof Uint8Array) return body.byteLength;
  if (body instanceof URLSearchParams) return Buffer.byteLength(body.toString(), "utf8");
  return 0;
}

export function classifyExternalHost(value: string): string {
  try {
    const host = new URL(value).hostname.toLowerCase();
    if (host.includes("nitrado")) return "nitrado";
    if (host.includes("discord")) return "discord";
    if (host.includes("neon") || host.includes("postgres")) return "neon";
    return host || "external";
  } catch {
    return "external";
  }
}

export function getNetworkMetrics() {
  const started = new Date(startedAt).getTime();
  const elapsedMs = Math.max(1, Date.now() - started);
  const monthMs = 30 * 24 * 60 * 60 * 1000;
  const services = Object.entries(buckets)
    .map(([service, value]) => ({ service, ...value }))
    .sort((a, b) => (b.outboundBytes + b.httpResponseBytes) - (a.outboundBytes + a.httpResponseBytes));

  const totals = services.reduce(
    (acc, item) => {
      acc.requests += item.requests;
      acc.failures += item.failures;
      acc.outboundBytes += item.outboundBytes;
      acc.inboundBytes += item.inboundBytes;
      acc.httpResponseBytes += item.httpResponseBytes;
      return acc;
    },
    { requests: 0, failures: 0, outboundBytes: 0, inboundBytes: 0, httpResponseBytes: 0 },
  );

  return {
    startedAt,
    elapsedMs,
    ...totals,
    projected30DayOutboundBytes: Math.round((totals.outboundBytes / elapsedMs) * monthMs),
    projected30DayHttpResponseBytes: Math.round((totals.httpResponseBytes / elapsedMs) * monthMs),
    services,
    recentTransfers: [...recentTransfers],
    coverageNote:
      "Application payload counters. Neon state writes, Nitrado HTTP payloads, OAuth fetches and HTTP responses are measured. TLS/protocol overhead and Discord.js internal REST/Gateway payloads are not fully captured.",
  };
}

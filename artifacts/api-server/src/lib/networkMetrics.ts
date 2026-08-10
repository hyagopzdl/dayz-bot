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

type HttpRouteBucket = {
  requests: number;
  failures: number;
  totalBytes: number;
  maxBytes: number;
  lastBytes: number;
  lastAt?: string;
};

export type LargeHttpResponseSample = {
  at: string;
  operation: string;
  bytes: number;
  ok: boolean;
};

const startedAt = new Date().toISOString();
const buckets: Record<string, NetworkBucket> = {};
const httpRouteBuckets: Record<string, HttpRouteBucket> = {};
const recentTransfers: NetworkTransferSample[] = [];
const recentLargeHttpResponses: LargeHttpResponseSample[] = [];
const LARGE_HTTP_RESPONSE_BYTES = 256 * 1024;

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

function httpRouteBucketFor(operation: string) {
  const key = operation || "unknown";
  if (!httpRouteBuckets[key]) {
    httpRouteBuckets[key] = {
      requests: 0,
      failures: 0,
      totalBytes: 0,
      maxBytes: 0,
      lastBytes: 0,
    };
  }
  return httpRouteBuckets[key];
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

  if (input.service === "http-responses" && input.direction === "http-response") {
    const routeBucket = httpRouteBucketFor(input.operation);
    routeBucket.requests += 1;
    if (!ok) routeBucket.failures += 1;
    routeBucket.totalBytes += bytes;
    routeBucket.lastBytes = bytes;
    routeBucket.maxBytes = Math.max(routeBucket.maxBytes, bytes);
    routeBucket.lastAt = at;

    if (bytes >= LARGE_HTTP_RESPONSE_BYTES) {
      recentLargeHttpResponses.push({ at, operation: input.operation, bytes, ok });
      if (recentLargeHttpResponses.length > 60) {
        recentLargeHttpResponses.splice(0, recentLargeHttpResponses.length - 60);
      }
    }
  }

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

  const httpRoutes = Object.entries(httpRouteBuckets)
    .map(([operation, value]) => ({
      operation,
      ...value,
      averageBytes: value.requests > 0 ? Math.round(value.totalBytes / value.requests) : 0,
      projected30DayBytes: Math.round((value.totalBytes / elapsedMs) * monthMs),
    }))
    .sort((a, b) => b.totalBytes - a.totalBytes || b.maxBytes - a.maxBytes);

  return {
    startedAt,
    elapsedMs,
    ...totals,
    projected30DayOutboundBytes: Math.round((totals.outboundBytes / elapsedMs) * monthMs),
    projected30DayHttpResponseBytes: Math.round((totals.httpResponseBytes / elapsedMs) * monthMs),
    largestHttpResponseBytes: httpRoutes.reduce((max, item) => Math.max(max, item.maxBytes), 0),
    services,
    httpRoutes,
    recentLargeHttpResponses: [...recentLargeHttpResponses],
    recentTransfers: [...recentTransfers],
    coverageNote:
      "Application payload counters. Render Service-Initiated and HTTP Response bandwidth are different categories: outbound service calls (for example Neon writes) appear under service outbound, while bytes returned to browsers appear under HTTP responses. TLS/protocol overhead and Discord.js internal REST/Gateway payloads are not fully captured.",
  };
}

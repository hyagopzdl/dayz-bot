import fs from "fs";
import path from "path";
import postgres from "postgres";
import type { MapEventInjectRequest, MapEventPresetId } from "./mapEventTypes";
import { findMapEventPreset } from "./mapEventPresets";
import { injectMapEventNow } from "./mapEventService";
import { getPrimaryServerId, listExecutableManagedServers } from "../serverRegistry";
import { getActiveServerId, runInServerRuntimeContext } from "../serverRuntime";

export type ScheduledMapEventRecurrence = "none" | "daily" | "weekly" | "monthly";
export type ScheduledMapEventStatus = "scheduled" | "active" | "paused" | "completed" | "cancelled" | "failed";

export type ScheduledMapEvent = {
  id: string;
  eventType: "locked_container" | "airdrop";
  presetId: MapEventPresetId;
  name: string;
  x: number;
  z: number;
  angle: number;
  executeAt: string;
  nextRunAt: string | null;
  recurrence: ScheduledMapEventRecurrence;
  status: ScheduledMapEventStatus;
  lastRunAt?: string | null;
  lastResult?: string | null;
  lastError?: string | null;
  createdAt: string;
  updatedAt: string;
};

type Store = { events: ScheduledMapEvent[] };

const LEGACY_SCHEDULE_FILE = path.resolve(process.cwd(), process.env.MAP_EVENTS_SCHEDULE_FILE || "map-events-schedule.json");
const sql = process.env.DATABASE_URL ? postgres(process.env.DATABASE_URL, { ssl: "require", max: 1 }) : null;
let schemaReady: Promise<void> | null = null;
let schedulerTimer: NodeJS.Timeout | null = null;
const schedulerRunningServers = new Set<string>();
const legacyImportChecked = new Set<string>();

function getLegacyScheduleFile(serverId: string) {
  if (serverId === getPrimaryServerId()) return LEGACY_SCHEDULE_FILE;
  return path.resolve(process.cwd(), "map-events-schedules", `${serverId}.json`);
}

function safeId() {
  return `map_evt_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

function normalizeRecurrence(value: unknown): ScheduledMapEventRecurrence {
  return value === "daily" || value === "weekly" || value === "monthly" ? value : "none";
}

function addRecurrence(date: Date, recurrence: ScheduledMapEventRecurrence) {
  const next = new Date(date.getTime());
  if (recurrence === "daily") next.setDate(next.getDate() + 1);
  if (recurrence === "weekly") next.setDate(next.getDate() + 7);
  if (recurrence === "monthly") next.setMonth(next.getMonth() + 1);
  return next;
}

function computeNextRunAfter(baseIso: string, recurrence: ScheduledMapEventRecurrence, now = new Date()) {
  if (recurrence === "none") return null;
  let next = new Date(baseIso);
  if (Number.isNaN(next.getTime())) next = new Date(now.getTime());
  let guard = 0;
  while (next.getTime() <= now.getTime() && guard < 370) {
    next = addRecurrence(next, recurrence);
    guard += 1;
  }
  return next.toISOString();
}

function eventPayload(event: ScheduledMapEvent): MapEventInjectRequest {
  return {
    presetId: event.presetId,
    name: event.name,
    x: event.x,
    z: event.z,
    angle: event.angle,
    quantity: 1,
    lifetime: 2400,
    safeRadius: 500,
    distanceRadius: 500,
    cleanupRadius: 250,
    lootMode: "rng",
  };
}

function readLegacyStore(serverId: string): Store {
  const scheduleFile = getLegacyScheduleFile(serverId);
  try {
    if (!fs.existsSync(scheduleFile)) return { events: [] };
    const parsed = JSON.parse(fs.readFileSync(scheduleFile, "utf8"));
    return { events: Array.isArray(parsed?.events) ? parsed.events : [] };
  } catch (err) {
    console.warn(`Failed to read legacy map event schedule [${serverId}]:`, err);
    return { events: [] };
  }
}

function writeLegacyStore(serverId: string, store: Store) {
  const scheduleFile = getLegacyScheduleFile(serverId);
  const dir = path.dirname(scheduleFile);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(scheduleFile, `${JSON.stringify({ events: store.events }, null, 2)}\n`, "utf8");
}

async function ensureSchema() {
  if (!sql) return;
  if (!schemaReady) schemaReady = (async () => {
    await sql`CREATE TABLE IF NOT EXISTS server_scheduled_map_events (
      server_id TEXT NOT NULL,
      id TEXT NOT NULL,
      payload JSONB NOT NULL,
      status TEXT NOT NULL,
      next_run_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY (server_id, id)
    )`;
    await sql`CREATE INDEX IF NOT EXISTS idx_server_scheduled_map_events_due
      ON server_scheduled_map_events(server_id, status, next_run_at)`;
  })().catch((error) => {
    schemaReady = null;
    throw error;
  });
  await schemaReady;
}

async function importLegacyIfNeeded(serverId: string) {
  if (!sql || legacyImportChecked.has(serverId)) return;
  await ensureSchema();
  legacyImportChecked.add(serverId);
  const [{ count }] = await sql`SELECT COUNT(*)::int AS count FROM server_scheduled_map_events WHERE server_id = ${serverId}` as any[];
  if (Number(count || 0) > 0) return;
  const legacy = readLegacyStore(serverId);
  for (const event of legacy.events) {
    await persistEvent(serverId, event);
  }
  if (legacy.events.length) console.log(`✅ imported ${legacy.events.length} legacy map schedules [${serverId}]`);
}

async function persistEvent(serverId: string, event: ScheduledMapEvent) {
  if (!sql) return;
  await ensureSchema();
  await sql`INSERT INTO server_scheduled_map_events (server_id, id, payload, status, next_run_at, created_at, updated_at)
    VALUES (${serverId}, ${event.id}, ${sql.json(event)}, ${event.status}, ${event.nextRunAt ? new Date(event.nextRunAt) : null}, ${new Date(event.createdAt)}, ${new Date(event.updatedAt)})
    ON CONFLICT (server_id, id) DO UPDATE SET
      payload = EXCLUDED.payload,
      status = EXCLUDED.status,
      next_run_at = EXCLUDED.next_run_at,
      updated_at = EXCLUDED.updated_at`;
}

async function readStore(serverId = getActiveServerId()): Promise<Store> {
  if (!sql) return readLegacyStore(serverId);
  await importLegacyIfNeeded(serverId);
  const rows = await sql`SELECT payload FROM server_scheduled_map_events WHERE server_id = ${serverId}` as any[];
  return { events: rows.map((row) => row.payload as ScheduledMapEvent) };
}

async function writeStore(serverId: string, store: Store) {
  if (!sql) {
    writeLegacyStore(serverId, store);
    return;
  }
  await ensureSchema();
  const ids = store.events.map((event) => event.id);
  if (ids.length) {
    await sql`DELETE FROM server_scheduled_map_events WHERE server_id = ${serverId} AND NOT (id = ANY(${ids}))`;
  } else {
    await sql`DELETE FROM server_scheduled_map_events WHERE server_id = ${serverId}`;
  }
  for (const event of store.events) await persistEvent(serverId, event);
}

export async function listScheduledMapEvents() {
  const store = await readStore();
  const order: Record<ScheduledMapEventStatus, number> = { active: 0, scheduled: 1, failed: 2, paused: 3, completed: 4, cancelled: 5 };
  const events = [...store.events].sort((a, b) => {
    const statusDelta = (order[a.status] ?? 99) - (order[b.status] ?? 99);
    if (statusDelta) return statusDelta;
    return String(a.nextRunAt || a.executeAt).localeCompare(String(b.nextRunAt || b.executeAt));
  });
  return { events };
}

export async function createScheduledMapEvent(input: Partial<ScheduledMapEvent> & { presetId: MapEventPresetId; executeAt: string }) {
  const executeAt = new Date(input.executeAt);
  if (Number.isNaN(executeAt.getTime())) throw new Error("Data/hora do evento inválida.");
  const x = Number(input.x);
  const z = Number(input.z);
  if (!Number.isFinite(x) || !Number.isFinite(z) || x <= 0 || z <= 0) throw new Error("Coordenadas inválidas.");
  const now = new Date();
  const recurrence = normalizeRecurrence(input.recurrence);
  const event: ScheduledMapEvent = {
    id: safeId(),
    eventType: findMapEventPreset(input.presetId)?.eventTypeLabel === "Airdrop" ? "airdrop" : "locked_container",
    presetId: input.presetId,
    name: String(input.name || "Locked Container").trim() || "Locked Container",
    x,
    z,
    angle: Number(input.angle || 0),
    executeAt: executeAt.toISOString(),
    nextRunAt: executeAt.toISOString(),
    recurrence,
    status: recurrence === "none" ? "scheduled" : "active",
    lastRunAt: null,
    lastResult: null,
    lastError: null,
    createdAt: now.toISOString(),
    updatedAt: now.toISOString(),
  };
  const serverId = getActiveServerId();
  const store = await readStore(serverId);
  store.events.unshift(event);
  await writeStore(serverId, store);
  return event;
}

export async function runScheduledMapEventNow(id: string) {
  const serverId = getActiveServerId();
  const store = await readStore(serverId);
  const index = store.events.findIndex((event) => event.id === id);
  if (index < 0) throw new Error("Evento agendado não encontrado.");
  const event = store.events[index];
  const now = new Date();
  try {
    const result = await injectMapEventNow(eventPayload(event));
    store.events[index] = {
      ...event,
      status: event.recurrence === "none" ? "completed" : "active",
      lastRunAt: now.toISOString(),
      nextRunAt: computeNextRunAfter(now.toISOString(), event.recurrence, now),
      lastResult: result.eventName,
      lastError: null,
      updatedAt: now.toISOString(),
    };
    await writeStore(serverId, store);
    return { event: store.events[index], result };
  } catch (err) {
    store.events[index] = { ...event, status: "failed", lastRunAt: now.toISOString(), lastError: String(err), updatedAt: now.toISOString() };
    await writeStore(serverId, store);
    throw err;
  }
}

export async function updateScheduledMapEventStatus(id: string, status: "paused" | "active" | "cancelled") {
  const serverId = getActiveServerId();
  const store = await readStore(serverId);
  const index = store.events.findIndex((event) => event.id === id);
  if (index < 0) throw new Error("Evento agendado não encontrado.");
  const event = store.events[index];
  const now = new Date();
  store.events[index] = {
    ...event,
    status,
    nextRunAt: status === "active" && !event.nextRunAt ? computeNextRunAfter(event.executeAt, event.recurrence, now) : event.nextRunAt,
    updatedAt: now.toISOString(),
  };
  await writeStore(serverId, store);
  return store.events[index];
}

export async function deleteScheduledMapEvent(id: string) {
  const serverId = getActiveServerId();
  const store = await readStore(serverId);
  const before = store.events.length;
  store.events = store.events.filter((event) => event.id !== id);
  if (store.events.length === before) throw new Error("Evento agendado não encontrado.");
  await writeStore(serverId, store);
  return { ok: true as const };
}

export async function runDueScheduledMapEvents() {
  const serverId = getActiveServerId();
  if (schedulerRunningServers.has(serverId)) return { ran: 0 };
  schedulerRunningServers.add(serverId);
  let ran = 0;
  try {
    const store = await readStore(serverId);
    const now = new Date();
    const due = store.events.filter((event) =>
      (event.status === "scheduled" || event.status === "active") &&
      event.nextRunAt && new Date(event.nextRunAt).getTime() <= now.getTime(),
    );
    for (const event of due) {
      try {
        await runScheduledMapEventNow(event.id);
        ran += 1;
      } catch (err) {
        console.error(`Failed to run scheduled map event [${serverId}] ${event.id}`, err);
      }
    }
    return { ran };
  } finally {
    schedulerRunningServers.delete(serverId);
  }
}

export function startMapEventScheduler() {
  if (schedulerTimer) return;
  schedulerTimer = setInterval(() => {
    void (async () => {
      for (const server of listExecutableManagedServers()) {
        try {
          await runInServerRuntimeContext(server.id, () => runDueScheduledMapEvents());
        } catch (err) {
          console.error(`Map event scheduler failed [${server.id}]:`, err);
        }
      }
    })();
  }, 60_000);
  schedulerTimer.unref?.();
}

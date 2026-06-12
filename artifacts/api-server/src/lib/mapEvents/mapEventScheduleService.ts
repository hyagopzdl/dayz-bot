import fs from "fs";
import path from "path";
import type { MapEventInjectRequest, MapEventPresetId } from "./mapEventTypes";
import { injectMapEventNow } from "./mapEventService";

export type ScheduledMapEventRecurrence = "none" | "daily" | "weekly" | "monthly";
export type ScheduledMapEventStatus = "scheduled" | "active" | "paused" | "completed" | "cancelled" | "failed";

export type ScheduledMapEvent = {
  id: string;
  eventType: "locked_container";
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

const SCHEDULE_FILE = path.resolve(process.cwd(), process.env.MAP_EVENTS_SCHEDULE_FILE || "map-events-schedule.json");
let schedulerTimer: NodeJS.Timeout | null = null;
let schedulerRunning = false;

function safeId() {
  return `map_evt_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

function readStore(): Store {
  try {
    if (!fs.existsSync(SCHEDULE_FILE)) return { events: [] };
    const parsed = JSON.parse(fs.readFileSync(SCHEDULE_FILE, "utf8"));
    return { events: Array.isArray(parsed?.events) ? parsed.events : [] };
  } catch (err) {
    console.warn("Failed to read map event schedule store:", err);
    return { events: [] };
  }
}

function writeStore(store: Store) {
  const dir = path.dirname(SCHEDULE_FILE);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(SCHEDULE_FILE, `${JSON.stringify({ events: store.events }, null, 2)}\n`, "utf8");
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

export function listScheduledMapEvents() {
  const store = readStore();
  const order: Record<ScheduledMapEventStatus, number> = { active: 0, scheduled: 1, failed: 2, paused: 3, completed: 4, cancelled: 5 };
  const events = [...store.events].sort((a, b) => {
    const statusDelta = (order[a.status] ?? 99) - (order[b.status] ?? 99);
    if (statusDelta) return statusDelta;
    return String(a.nextRunAt || a.executeAt).localeCompare(String(b.nextRunAt || b.executeAt));
  });
  return { events };
}

export function createScheduledMapEvent(input: Partial<ScheduledMapEvent> & { presetId: MapEventPresetId; executeAt: string }) {
  const executeAt = new Date(input.executeAt);
  if (Number.isNaN(executeAt.getTime())) throw new Error("Data/hora do evento inválida.");
  const x = Number(input.x);
  const z = Number(input.z);
  if (!Number.isFinite(x) || !Number.isFinite(z) || x <= 0 || z <= 0) throw new Error("Coordenadas inválidas.");

  const now = new Date();
  const recurrence = normalizeRecurrence(input.recurrence);
  const status: ScheduledMapEventStatus = recurrence === "none" ? "scheduled" : "active";
  const event: ScheduledMapEvent = {
    id: safeId(),
    eventType: "locked_container",
    presetId: input.presetId,
    name: String(input.name || "Locked Container").trim() || "Locked Container",
    x,
    z,
    angle: Number(input.angle || 0),
    executeAt: executeAt.toISOString(),
    nextRunAt: executeAt.toISOString(),
    recurrence,
    status,
    lastRunAt: null,
    lastResult: null,
    lastError: null,
    createdAt: now.toISOString(),
    updatedAt: now.toISOString(),
  };

  const store = readStore();
  store.events.unshift(event);
  writeStore(store);
  return event;
}

export async function runScheduledMapEventNow(id: string) {
  const store = readStore();
  const index = store.events.findIndex((event) => event.id === id);
  if (index < 0) throw new Error("Evento agendado não encontrado.");
  const event = store.events[index];
  const now = new Date();
  try {
    const result = await injectMapEventNow(eventPayload(event));
    const nextRunAt = computeNextRunAfter(now.toISOString(), event.recurrence, now);
    store.events[index] = {
      ...event,
      status: event.recurrence === "none" ? "completed" : "active",
      lastRunAt: now.toISOString(),
      nextRunAt,
      lastResult: result.eventName,
      lastError: null,
      updatedAt: now.toISOString(),
    };
    writeStore(store);
    return { event: store.events[index], result };
  } catch (err) {
    store.events[index] = {
      ...event,
      status: "failed",
      lastRunAt: now.toISOString(),
      lastError: String(err),
      updatedAt: now.toISOString(),
    };
    writeStore(store);
    throw err;
  }
}

export function updateScheduledMapEventStatus(id: string, status: "paused" | "active" | "cancelled") {
  const store = readStore();
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
  writeStore(store);
  return store.events[index];
}

export function deleteScheduledMapEvent(id: string) {
  const store = readStore();
  const before = store.events.length;
  store.events = store.events.filter((event) => event.id !== id);
  if (store.events.length === before) throw new Error("Evento agendado não encontrado.");
  writeStore(store);
  return { ok: true as const };
}

export async function runDueScheduledMapEvents() {
  if (schedulerRunning) return { ran: 0 };
  schedulerRunning = true;
  let ran = 0;
  try {
    const store = readStore();
    const now = new Date();
    const due = store.events.filter((event) =>
      (event.status === "scheduled" || event.status === "active") &&
      event.nextRunAt &&
      new Date(event.nextRunAt).getTime() <= now.getTime(),
    );
    for (const event of due) {
      try {
        await runScheduledMapEventNow(event.id);
        ran += 1;
      } catch (err) {
        console.error("Failed to run scheduled map event", event.id, err);
      }
    }
    return { ran };
  } finally {
    schedulerRunning = false;
  }
}

export function startMapEventScheduler() {
  if (schedulerTimer) return;
  schedulerTimer = setInterval(() => {
    runDueScheduledMapEvents().catch((err) => console.error("Map event scheduler failed:", err));
  }, 60_000);
  schedulerTimer.unref?.();
}

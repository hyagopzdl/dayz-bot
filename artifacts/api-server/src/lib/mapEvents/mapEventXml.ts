import { createHash } from "node:crypto";
import { findMapEventPreset } from "./mapEventPresets";
import type { MapEventInjectRequest, MapEventPresetId, ResolvedMapEvent } from "./mapEventTypes";

export const MAP_EVENT_START_PREFIX = "<!-- MAP_EVENT_START";
export const MAP_EVENT_END = "<!-- MAP_EVENT_END -->";

function sanitizeEventPart(value: string) {
  return (
    String(value || "")
      .replace(/[^a-zA-Z0-9_]/g, "_")
      .replace(/_+/g, "_")
      .replace(/^_+|_+$/g, "")
      .slice(0, 48) || "Event"
  );
}

function numberOrDefault(value: unknown, fallback: number) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function intOrDefault(value: unknown, fallback: number) {
  return Math.max(0, Math.floor(numberOrDefault(value, fallback)));
}

function formatNumber(value: number) {
  if (!Number.isFinite(value)) return "0";
  return Number(value.toFixed(2)).toString();
}

function boolAttr(value: boolean) {
  return value ? "1" : "0";
}

function makeRunId(presetId: string, name: string) {
  const hash = createHash("sha1")
    .update(`${presetId}:${name}:${Date.now()}:${Math.random()}`)
    .digest("hex")
    .slice(0, 8);

  return `${sanitizeEventPart(presetId)}_${hash}`;
}

function makeEventName(prefix: string, id: string) {
  return `${sanitizeEventPart(prefix)}_${sanitizeEventPart(id).slice(-16)}`.slice(0, 96);
}

export function resolveMapEventRequest(input: MapEventInjectRequest): ResolvedMapEvent {
  const preset = findMapEventPreset(input.presetId);
  if (!preset) {
    throw new Error(`Preset de evento do mapa inválido: ${input.presetId}`);
  }

  const x = numberOrDefault(input.x, Number.NaN);
  const z = numberOrDefault(input.z, Number.NaN);
  const a = numberOrDefault(input.angle, 0);

  if (!Number.isFinite(x) || !Number.isFinite(z)) {
    throw new Error("Coordenadas inválidas. Informe X e Z numéricos.");
  }

  const requestedQuantity = Math.max(1, Math.min(25, intOrDefault(input.quantity, preset.nominal)));
  const id = makeRunId(input.presetId, input.name || preset.name);
  const eventName = makeEventName(preset.eventPrefix || preset.defaultEventName, id);

  return {
    id,
    name: String(input.name || preset.name).trim() || preset.name,
    eventName,
    preset,
    position: { x, z, a },
    nominal: requestedQuantity,
    min: Math.min(requestedQuantity, Math.max(1, preset.min)),
    max: requestedQuantity,
    lifetime: Math.max(60, intOrDefault(input.lifetime, preset.lifetime)),
    saferadius: intOrDefault(input.safeRadius, preset.saferadius),
    distanceradius: intOrDefault(input.distanceRadius, preset.distanceradius),
    cleanupradius: intOrDefault(input.cleanupRadius, preset.cleanupradius),
    children: preset.children.map((child) => ({ ...child })),
  };
}

export function buildMapEventEventsBlock(event: ResolvedMapEvent) {
  const preset = event.preset;
  const childXml = event.children.map((child) => {
    const lootmax = child.lootmax ?? 0;
    const lootmin = child.lootmin ?? 0;
    return `            <child lootmax="${lootmax}" lootmin="${lootmin}" max="${child.max}" min="${child.min}" type="${child.type}"/>`;
  });

  return [
    `<!-- MAP_EVENT_START id="${event.id}" name="${event.name}" -->`,
    `    <event name="${event.eventName}">`,
    `        <nominal>${event.nominal}</nominal>`,
    `        <min>${event.min}</min>`,
    `        <max>${event.max}</max>`,
    `        <lifetime>${event.lifetime}</lifetime>`,
    `        <restock>${preset.restock}</restock>`,
    `        <saferadius>${event.saferadius}</saferadius>`,
    `        <distanceradius>${event.distanceradius}</distanceradius>`,
    `        <cleanupradius>${event.cleanupradius}</cleanupradius>`,
    `        <flags deletable="${boolAttr(preset.deletable)}" init_random="${boolAttr(preset.initRandom)}" remove_damaged="${boolAttr(preset.removeDamaged)}"/>`,
    `        <position>${preset.position}</position>`,
    `        <limit>${preset.limit}</limit>`,
    "        <active>1</active>",
    "        <children>",
    ...childXml,
    "        </children>",
    "    </event>",
    MAP_EVENT_END,
  ].join("\n");
}

export function buildMapEventSpawnsBlock(event: ResolvedMapEvent) {
  return [
    `<!-- MAP_EVENT_START id="${event.id}" name="${event.name}" -->`,
    `    <event name="${event.eventName}">`,
    `        <pos x="${formatNumber(event.position.x)}" z="${formatNumber(event.position.z)}" a="${formatNumber(event.position.a ?? 0)}"/>`,
    "    </event>",
    MAP_EVENT_END,
  ].join("\n");
}

export function removeMapEventBlocks(xml: string) {
  const pattern = /\s*<!--\s*MAP_EVENT_START\b[\s\S]*?<!--\s*MAP_EVENT_END\s*-->\s*/g;
  return String(xml || "")
    .replace(pattern, "\n")
    .replace(/\n{3,}/g, "\n\n");
}

function injectBeforeClosingTag(xml: string, closingTag: string, block: string) {
  const cleanXml = removeMapEventBlocks(xml);
  const closingIndex = cleanXml.lastIndexOf(closingTag);

  if (closingIndex === -1) {
    throw new Error(`Could not find closing tag ${closingTag}`);
  }

  const before = cleanXml.slice(0, closingIndex).trimEnd();
  const after = cleanXml.slice(closingIndex);

  return `${before}\n\n${block}\n${after}`;
}

export function injectMapEventIntoEventsXml(xml: string, event: ResolvedMapEvent) {
  return injectBeforeClosingTag(xml, "</events>", buildMapEventEventsBlock(event));
}

export function injectMapEventIntoEventSpawnsXml(xml: string, event: ResolvedMapEvent) {
  return injectBeforeClosingTag(xml, "</eventposdef>", buildMapEventSpawnsBlock(event));
}

export function hasMapEventBlock(xml: string) {
  return String(xml || "").includes(MAP_EVENT_START_PREFIX) && String(xml || "").includes(MAP_EVENT_END);
}

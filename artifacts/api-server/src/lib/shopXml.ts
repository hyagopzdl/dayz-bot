import type { ShopOrder } from "./state";
import { findDayzItem } from "./dayzItemDatabase";

export const SHOP_BOT_START = "<!-- SHOP_BOT_START -->";
export const SHOP_BOT_END = "<!-- SHOP_BOT_END -->";

export type ShopXmlBlock = {
  eventsBlock: string;
  eventSpawnsBlock: string;
  eventNames: string[];
};

function sanitizeEventPart(value: string) {
  return (
    String(value || "")
      .replace(/[^a-zA-Z0-9_]/g, "_")
      .replace(/_+/g, "_")
      .replace(/^_+|_+$/g, "")
      .slice(0, 48) || "Item"
  );
}

function formatNumber(value: number) {
  if (!Number.isFinite(value)) return "0.0";
  return Number(value.toFixed(2)).toString();
}

function getOrderEventName(order: ShopOrder, index: number) {
  const dayzItem = findDayzItem(order.itemClass || "");
  const configuredEventName = String(dayzItem?.spawnEventName || "").trim();
  const item = sanitizeEventPart(order.itemClass || order.itemName || "Item");
  const id = sanitizeEventPart(order.id || String(index)).slice(-16);

  // Vehicles must use the real DayZ Central Economy event name, exactly as
  // configured in dayz-items.json, e.g. VehicleCivilianSedan or VehicleTruck01.
  // Do not add Shop/Static prefixes or custom suffixes to vehicle events.
  if (configuredEventName.startsWith("Vehicle")) {
    return sanitizeEventPart(configuredEventName);
  }

  // Regular shop items keep the original static-style custom event name.
  return `Static_${item}_${id || index}`;
}

function isVehicleEventName(eventName: string) {
  return String(eventName || "").startsWith("Vehicle");
}

function buildEventXml(order: ShopOrder, eventName: string) {
  const isVehicle = isVehicleEventName(eventName);
  const flags = isVehicle
    ? '        <flags deletable="0" init_random="0" remove_damaged="1"/>'
    : '        <flags deletable="1" init_random="0" remove_damaged="0"/>';
  const limit = isVehicle ? "mixed" : "child";

  return [
    `    <event name="${eventName}">`,
    "        <nominal>1</nominal>",
    "        <min>0</min>",
    "        <max>1</max>",
    "        <lifetime>3888000</lifetime>",
    "        <restock>0</restock>",
    "        <saferadius>0</saferadius>",
    "        <distanceradius>0</distanceradius>",
    "        <cleanupradius>0</cleanupradius>",
    flags,
    "        <position>fixed</position>",
    `        <limit>${limit}</limit>`,
    "        <active>1</active>",
    "        <children>",
    `            <child lootmax="0" lootmin="0" max="1" min="1" type="${order.itemClass}"/>`,
    "        </children>",
    "    </event>",
  ].join("\n");
}

function buildEventSpawnXml(order: ShopOrder, eventName: string) {
  return [
    `    <event name="${eventName}">`,
    `        <pos x="${formatNumber(order.x)}" y="${formatNumber(order.y ?? 0)}" z="${formatNumber(order.z)}" a="0.0"/>`,
    "    </event>",
  ].join("\n");
}

export function buildShopXmlBlock(orders: ShopOrder[]): ShopXmlBlock {
  const eventNames: string[] = [];
  const events = orders.map((order, index) => {
    const eventName = getOrderEventName(order, index);
    eventNames.push(eventName);
    return buildEventXml(order, eventName);
  });

  const spawns = orders.map((order, index) =>
    buildEventSpawnXml(order, eventNames[index]),
  );

  return {
    eventNames,
    eventsBlock: [SHOP_BOT_START, ...events, SHOP_BOT_END].join("\n"),
    eventSpawnsBlock: [SHOP_BOT_START, ...spawns, SHOP_BOT_END].join("\n"),
  };
}

export function removeShopBotBlock(xml: string) {
  const pattern = /<!-- SHOP_BOT_START -->[\s\S]*?<!-- SHOP_BOT_END -->/g;

  return String(xml || "")
    .replace(pattern, "")
    .replace(/\n{3,}/g, "\n\n");
}

export function injectBeforeClosingTag(
  xml: string,
  closingTag: string,
  block: string,
) {
  const cleanXml = removeShopBotBlock(xml);
  const closingIndex = cleanXml.lastIndexOf(closingTag);

  if (closingIndex === -1) {
    throw new Error(`Could not find closing tag ${closingTag}`);
  }

  const before = cleanXml.slice(0, closingIndex).trimEnd();
  const after = cleanXml.slice(closingIndex);

  return `${before}\n\n${block}\n${after}`;
}

export function injectShopEventsXml(xml: string, orders: ShopOrder[]) {
  const block = buildShopXmlBlock(orders);
  return {
    xml: injectBeforeClosingTag(xml, "</events>", block.eventsBlock),
    eventNames: block.eventNames,
  };
}

export function injectShopEventSpawnsXml(xml: string, orders: ShopOrder[]) {
  const block = buildShopXmlBlock(orders);
  return injectBeforeClosingTag(xml, "</eventposdef>", block.eventSpawnsBlock);
}

import type { ShopOrder } from "./state";
import { findDayzItem } from "./dayzItemDatabase";

export const SHOP_BOT_START = "<!-- SHOP_BOT_START -->";
export const SHOP_BOT_END = "<!-- SHOP_BOT_END -->";

export type ShopXmlBlock = {
  eventsBlock: string;
  eventSpawnsBlock: string;
  eventNames: string[];
};

type ResolvedShopOrder = {
  order: ShopOrder;
  eventName: string;
  isVehicle: boolean;
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

function getConfiguredVehicleEventName(order: ShopOrder) {
  const dayzItem = findDayzItem(order.itemClass || "");
  const configuredEventName = String(dayzItem?.spawnEventName || "").trim();

  return configuredEventName.startsWith("Vehicle")
    ? sanitizeEventPart(configuredEventName)
    : "";
}

function getOrderEventName(order: ShopOrder, index: number) {
  const configuredVehicleEventName = getConfiguredVehicleEventName(order);

  if (configuredVehicleEventName) {
    return configuredVehicleEventName;
  }

  const item = sanitizeEventPart(order.itemClass || order.itemName || "Item");
  const id = sanitizeEventPart(order.id || String(index)).slice(-16);

  // Regular shop items use a custom Static_* event. Vehicles are the only
  // exception: they must use the vanilla Vehicle* event that already exists in
  // DayZ's Central Economy files.
  return `Static_${item}_${id || index}`;
}

function resolveShopOrders(orders: ShopOrder[]): ResolvedShopOrder[] {
  return orders.map((order, index) => {
    const eventName = getOrderEventName(order, index);

    return {
      order,
      eventName,
      isVehicle: eventName.startsWith("Vehicle"),
    };
  });
}

function buildStaticEventXml(order: ShopOrder, eventName: string) {
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
    '        <flags deletable="1" init_random="0" remove_damaged="0"/>',
    "        <position>fixed</position>",
    "        <limit>child</limit>",
    "        <active>1</active>",
    "        <children>",
    `            <child lootmax="0" lootmin="0" max="1" min="1" type="${order.itemClass}"/>`,
    "        </children>",
    "    </event>",
  ].join("\n");
}

function buildStaticEventSpawnXml(order: ShopOrder, eventName: string) {
  return [
    `    <event name="${eventName}">`,
    `        <pos x="${formatNumber(order.x)}" y="${formatNumber(order.y ?? 0)}" z="${formatNumber(order.z)}" a="0.0"/>`,
    "    </event>",
  ].join("\n");
}

function buildVehiclePosXml(order: ShopOrder) {
  // Vanilla vehicle spawn positions do not use a y attribute in cfgeventspawns.
  return `        <pos x="${formatNumber(order.x)}" z="${formatNumber(order.z)}" a="0.0"/>`;
}

export function buildShopXmlBlock(orders: ShopOrder[]): ShopXmlBlock {
  const resolvedOrders = resolveShopOrders(orders);
  const staticOrders = resolvedOrders.filter((entry) => !entry.isVehicle);
  const eventNames = resolvedOrders.map((entry) => entry.eventName);

  const events = staticOrders.map((entry) =>
    buildStaticEventXml(entry.order, entry.eventName),
  );

  const spawns = staticOrders.map((entry) =>
    buildStaticEventSpawnXml(entry.order, entry.eventName),
  );

  return {
    eventNames,
    // Keep SHOP_BOT markers even when the batch has only vehicles. deployPendingShopOrders
    // validates that both uploaded XML files still contain the marker; an empty block is
    // harmless inside <events> and lets the verified deploy flow stay generic.
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

function injectVehiclePositionsIntoExistingEvents(xml: string, orders: ShopOrder[]) {
  const resolvedOrders = resolveShopOrders(orders).filter((entry) => entry.isVehicle);
  if (!resolvedOrders.length) return removeShopBotBlock(xml);

  let nextXml = removeShopBotBlock(xml);
  const grouped = new Map<string, ShopOrder[]>();

  for (const entry of resolvedOrders) {
    const existing = grouped.get(entry.eventName) || [];
    existing.push(entry.order);
    grouped.set(entry.eventName, existing);
  }

  for (const [eventName, eventOrders] of grouped.entries()) {
    const eventPattern = new RegExp(
      `(<event\\s+name=["']${eventName}["'][^>]*>[\\s\\S]*?)(\\s*</event>)`,
      "m",
    );
    const match = nextXml.match(eventPattern);

    if (!match) {
      throw new Error(
        `Vehicle event ${eventName} not found in cfgeventspawns.xml. Add the vanilla vehicle event block before selling this vehicle.`,
      );
    }

    const vehiclePosBlock = [
      `        ${SHOP_BOT_START}`,
      ...eventOrders.map((order) => buildVehiclePosXml(order)),
      `        ${SHOP_BOT_END}`,
    ].join("\n");

    nextXml = nextXml.replace(
      eventPattern,
      `$1\n${vehiclePosBlock}$2`,
    );
  }

  return nextXml;
}

export function injectShopEventsXml(xml: string, orders: ShopOrder[]) {
  const block = buildShopXmlBlock(orders);
  return {
    xml: injectBeforeClosingTag(xml, "</events>", block.eventsBlock),
    eventNames: block.eventNames,
  };
}

export function injectShopEventSpawnsXml(xml: string, orders: ShopOrder[]) {
  const resolvedOrders = resolveShopOrders(orders);
  const staticOrders = resolvedOrders
    .filter((entry) => !entry.isVehicle)
    .map((entry) => entry.order);

  let nextXml = injectVehiclePositionsIntoExistingEvents(xml, orders);

  if (!staticOrders.length) {
    return nextXml;
  }

  const block = buildShopXmlBlock(staticOrders);
  return injectBeforeClosingTag(nextXml, "</eventposdef>", block.eventSpawnsBlock);
}

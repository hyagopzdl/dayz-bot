import fs from "node:fs";
import path from "node:path";
import { seedDayzItemsInDatabase } from "../lib/dayzItemsService";

function readJsonFile(filePath: string) {
  if (!fs.existsSync(filePath)) return null;
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function dayzItemFileCandidates() {
  const configured = process.env.DAYZ_ITEMS_SEED_FILE || process.env.DAYZ_ITEMS_FILE || "";
  return Array.from(
    new Set(
      [
        configured,
        path.resolve(process.cwd(), "data/dayz-items.json"),
        path.resolve(process.cwd(), "dayz-items.json"),
        path.resolve(process.cwd(), "artifacts/api-server/data/dayz-items.json"),
        path.resolve(process.cwd(), "artifacts/api-server/dayz-items.json"),
      ].filter(Boolean),
    ),
  );
}

async function loadSeedItems() {
  for (const filePath of dayzItemFileCandidates()) {
    const parsed = readJsonFile(filePath);
    if (parsed) {
      console.log(`📦 using DayZ items seed file: ${filePath}`);
      return parsed;
    }
  }

  throw new Error("No DayZ item seed found. Set DAYZ_ITEMS_SEED_FILE or add data/dayz-items.json.");
}

async function main() {
  const items = await loadSeedItems();
  const replace = process.env.DAYZ_ITEMS_SEED_REPLACE === "true";
  const result = await seedDayzItemsInDatabase(items, { replace });

  console.log("✅ DayZ item database seeded to Neon", result);
}

main().catch((err) => {
  console.error("❌ failed to seed DayZ item database:", err);
  process.exit(1);
});

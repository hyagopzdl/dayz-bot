import fs from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const checks = [
  ['src/lib/mapEvents/mapEventScheduleService.ts', /runInServerRuntimeContext\(primaryServerId/],
  ['src/lib/discordBot.ts', /setInterval\([^\n]*updateLeaderboard|startShopStatusMonitor|startEconomyRewardsLoop/],
  ['src/lib/discord/secondaryInteractions.ts', /client\.guilds\.cache\.first\(\)/],
];
let failed = false;
for (const [file, pattern] of checks) {
  const text = fs.readFileSync(path.join(root, file), 'utf8');
  if (pattern.test(text)) {
    console.error(`tenant-isolation audit failed: ${file} matches ${pattern}`);
    failed = true;
  }
}
if (failed) process.exit(1);
console.log('tenant-isolation audit passed');

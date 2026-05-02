import { getLeaderboard } from './parser.js';
import { startBot } from './discordBot.js';

startBot(getLeaderboard);

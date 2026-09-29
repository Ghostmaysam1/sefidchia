import { config } from "dotenv";
import { session, Telegraf } from "telegraf";
import { BOT_ADMIN_IDS, BOT_TOKEN } from "./bot/config/env.config";
import { registerRotationHandlers } from "./bot/handlers/rotation.js";
import { prisma } from "./bot/config/database.config";


config();

const token = BOT_TOKEN();
if (token.isErr()) {
    throw new Error("bot token not found in ENV")
}

export const bot = new Telegraf(token.value);
await prisma.$connect();

bot.use(session());

const adminIds = BOT_ADMIN_IDS();
if (adminIds.isErr()) {
    console.error("Set BOT_ADMIN_IDS to your Telegram numeric user IDs (comma separated) to enable bot controls.");
} else {
    await registerRotationHandlers(bot, adminIds.value);
}

let isPolling = false;
if (process.env.NODE_ENV !== 'production' && isPolling === false) {
    console.log("Starting local polling...");
    bot.launch();
    isPolling = true;
}

async function shutdown(signal: "SIGINT" | "SIGTERM"): Promise<void> {
    bot.stop(signal);
    await prisma.$disconnect();
}

process.once("SIGINT", () => void shutdown("SIGINT"));
process.once("SIGTERM", () => void shutdown("SIGTERM"));

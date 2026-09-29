import { config } from "dotenv";
import { session, Telegraf } from "telegraf";
import { BOT_OWNER_ID, BOT_TOKEN } from "./bot/config/env.config";
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

const ownerId = BOT_OWNER_ID();
if (ownerId.isErr()) {
    console.error("Set BOT_OWNER_ID to your Telegram numeric user ID to enable bot controls.");
} else {
    await registerRotationHandlers(bot, ownerId.value);
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

import { config } from "dotenv";
import { session, Telegraf } from "telegraf";
import { BOT_OWNER_ID, BOT_TOKEN } from "./bot/config/env.config";
import { registerRotationHandlers } from "./bot/handlers/rotation.js";


config();

const token = BOT_TOKEN();
if (token.isErr()) {
    throw new Error("bot token not found in ENV")
}

export const bot = new Telegraf(token.value);

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

process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));

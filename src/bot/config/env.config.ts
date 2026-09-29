import { config } from "dotenv";
import { err, ok, Result } from "neverthrow";
config();

export function BOT_TOKEN(): Result<string, "NOT_FOUND"> {
    if (process.env.BOT_TOKEN) {
        return ok(process.env.BOT_TOKEN);
    } else {
        return err("NOT_FOUND");
    }
}

export function NODE_ENV(): Result<string, "NOT_FOUND"> {
    if (process.env.NODE_ENV) {
        return ok(process.env.NODE_ENV);
    } else {
        return err("NOT_FOUND");
    }
}

export function DATABASE_URL(): Result<string, "NOT_FOUND"> {
    if (process.env.DATABASE_URL) {
        return ok(process.env.DATABASE_URL);
    } else {
        return err("NOT_FOUND");
    }
}

export function BOT_OWNER_ID(): Result<number, "NOT_FOUND"> {
    if (process.env.BOT_OWNER_ID) {
        const ownerId = Number(process.env.BOT_OWNER_ID);
        if (Number.isSafeInteger(ownerId) && ownerId > 0) {
            return ok(ownerId);
        } else {
            return err("NOT_FOUND");
        }
    } else {
        return err("NOT_FOUND");
    }
}
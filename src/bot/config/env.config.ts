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

export function BOT_ADMIN_IDS(): Result<number[], "NOT_FOUND"> {
    if (process.env.BOT_ADMIN_IDS) {
        const ids = process.env.BOT_ADMIN_IDS.split(/[\s,]+/)
            .map(id => Number(id.trim()))
            .filter(id => Number.isSafeInteger(id) && id > 0);
        return ids.length > 0 ? ok(ids) : err("NOT_FOUND");
    }
    return err("NOT_FOUND");
}
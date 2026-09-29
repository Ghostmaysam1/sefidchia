import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@prisma/client";
import { DATABASE_URL, NODE_ENV } from "./env.config";

const database_url = DATABASE_URL();

if (database_url.isErr()) {
    throw new Error("database url not found in ENV")
}

const adapter = new PrismaPg({
    connectionString: database_url.value,
});

let log: any[] = [];

const node_env = NODE_ENV();

if (node_env.isErr()) {
    throw new Error("node env not found in ENV")
}

if (node_env.value !== 'production') {
    log = ["info", "warn", "error"]
} else {
    log = ["warn", "error"]
}

export const prisma = new PrismaClient({
    adapter,
    log: log,
});
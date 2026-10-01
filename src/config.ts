import { resolve } from "node:path";
import { openDb } from "./db.js";
import type { DatabaseSync } from "node:sqlite";

export const PROJECT_ROOT = resolve(new URL("..", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"));
export const DATA_DIR = process.env.BATT_DATA_DIR ?? resolve(PROJECT_ROOT, "data");
export const DB_PATH = process.env.BATT_DB ?? resolve(DATA_DIR, "battery.db");
export const PORT_FILE = resolve(DATA_DIR, "server.port");
export const PID_FILE = resolve(DATA_DIR, "server.pid");

export function dbFromEnv(): DatabaseSync {
  return openDb(DB_PATH);
}

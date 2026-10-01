import { createServer } from 'node:http';
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { openDb } from './db.ts';
import { Store } from './store.ts';
import { Services } from './services.ts';
import { handleRequest } from './api.ts';

const ROOT = resolve(new URL('..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
const DB_PATH = process.env.BATTERY_DB ?? resolve(ROOT, 'data', 'battery.db');
const PORT_FILE = resolve(ROOT, 'tmp', 'server.port');
const PID_FILE = resolve(ROOT, 'tmp', 'server.pid');

const db = openDb(DB_PATH);
const store = new Store(db);
const services = new Services(store);

const server = createServer((req, res) => {
  void handleRequest(req, res, { services, store });
});

// 端口 0 = 由操作系统自动分配空闲端口；仅绑定本机回环，不对外暴露。
server.listen(0, '127.0.0.1', () => {
  const addr = server.address();
  const port = typeof addr === 'object' && addr ? addr.port : 0;
  mkdirSync(resolve(ROOT, 'tmp'), { recursive: true });
  writeFileSync(PORT_FILE, String(port), 'utf8');
  writeFileSync(PID_FILE, String(process.pid), 'utf8');
  console.log(`[server] 仅监听本机 http://127.0.0.1:${port} (pid ${process.pid})`);
  console.log(`[server] 数据库 ${DB_PATH}`);
});

function shutdown(signal: string) {
  console.log(`[server] 收到 ${signal}，关闭中...`);
  server.close(() => {
    db.close();
    process.exit(0);
  });
  setTimeout(() => process.exit(0), 2000).unref();
}
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

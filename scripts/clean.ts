// Remove only project-local data/tmp artifacts and stop only a server this project started.
import { existsSync, readFileSync, rmSync, unlinkSync } from "node:fs";
import { resolve } from "node:path";

const root = resolve(new URL("..", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"));
const pidFile = resolve(root, "data", "server.pid");
if (existsSync(pidFile)) {
  const pid = Number(readFileSync(pidFile, "utf8").trim());
  if (Number.isInteger(pid) && pid > 0) {
    try {
      process.kill(pid, "SIGTERM");
      console.log(`stopped project server pid=${pid}`);
    } catch {
      console.log(`pid=${pid} not running`);
    }
  }
  unlinkSync(pidFile);
}
for (const dir of ["data", "tmp"]) {
  const p = resolve(root, dir);
  if (existsSync(p)) {
    rmSync(p, { recursive: true, force: true });
    console.log(`removed ${p}`);
  }
}

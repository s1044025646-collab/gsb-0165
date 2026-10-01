/** 仅停止本项目记录在 tmp/server.pid 的服务进程（不触碰其他进程）。 */
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { execSync } from 'node:child_process';

const ROOT = resolve(new URL('..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
const PID_FILE = resolve(ROOT, 'tmp', 'server.pid');
const PORT_FILE = resolve(ROOT, 'tmp', 'server.port');

if (!existsSync(PID_FILE)) {
  console.log('未找到本项目服务 pid 文件，服务可能未运行。');
  process.exit(0);
}
const pid = Number(readFileSync(PID_FILE, 'utf8').trim());
function isAlive(target: number): boolean {
  try {
    process.kill(target, 0);
    return true;
  } catch {
    return false;
  }
}
try {
  if (!isAlive(pid)) {
    console.log(`进程 ${pid} 已不在运行。`);
  } else if (process.platform === 'win32') {
    try {
      execSync(`taskkill /PID ${pid} /T /F`, { stdio: 'pipe' });
    } catch (e) {
      // 某些环境下 taskkill 不在 PATH，回退到完整路径。
      execSync(`${process.env.SystemRoot ?? 'C:\\Windows'}\\System32\\taskkill.exe /PID ${pid} /T /F`, {
        stdio: 'pipe',
      });
      void e;
    }
    console.log(`已停止本项目服务 pid=${pid}`);
  } else {
    process.kill(pid, 'SIGTERM');
    console.log(`已停止本项目服务 pid=${pid}`);
  }
} catch {
  console.log(`进程 ${pid} 已不在运行。`);
} finally {
  rmSync(PID_FILE, { force: true });
  rmSync(PORT_FILE, { force: true });
}

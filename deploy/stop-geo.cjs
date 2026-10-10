const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const scriptDir = __dirname;
const root = path.resolve(scriptDir, '..');
const envFile = path.join(scriptDir, 'geo-browser-env');
let port = '8787';

if (fs.existsSync(envFile)) {
  for (const line of fs.readFileSync(envFile, 'utf8').split('\n')) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    const i = t.indexOf('=');
    if (i <= 0) continue;
    const k = t.slice(0, i).trim();
    const v = t.slice(i + 1).trim();
    if (k === 'PORT' && v) port = v;
  }
}

const dataRoot = process.env.GEO_DATA_ROOT
  ? path.resolve(root, process.env.GEO_DATA_ROOT)
  : path.resolve(root, '../geo-browser-data');
const pidFile = path.join(dataRoot, 'geo-browser.pid');

const pids = [];
if (fs.existsSync(pidFile)) {
  const pid = parseInt(fs.readFileSync(pidFile, 'utf8').trim(), 10);
  if (!isNaN(pid)) pids.push(pid);
}

// spawnSync 偶发 EBUSY（杀软/沙箱瞬时锁文件），重试 3 次
function spawnSyncRetry(cmd, args) {
  for (let i = 0; i < 3; i++) {
    const r = spawnSync(cmd, args, { encoding: 'utf8' });
    if (!r.error) return r;
  }
  return { stdout: '' };
}

// also discover listeners on the port
try {
  const out = spawnSyncRetry('netstat', ['-ano']).stdout || '';
  for (const l of out.split('\n')) {
    if (l.includes(':' + port) && l.includes('LISTENING')) {
      const parts = l.trim().split(/\s+/);
      const p = parseInt(parts[parts.length - 1], 10);
      if (!isNaN(p)) pids.push(p);
    }
  }
} catch (e) { /* ignore */ }

if (pids.length === 0) {
  console.log('service not running');
  process.exit(0);
}

for (const p of [...new Set(pids)]) {
  console.log('stopping PID ' + p + ' ...');
  try { spawnSyncRetry('taskkill', ['/F', '/T', '/PID', String(p)]); } catch (e) {}
}

console.log('service stopped (or stopping)');
process.exit(0);

const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const http = require('http');

const scriptDir = __dirname;
const root = path.resolve(scriptDir, '..');
const envFile = path.join(scriptDir, 'geo-browser-env');

function fail(msg) {
  console.log('[ERROR] ' + msg);
  process.exit(1);
}

if (!fs.existsSync(envFile)) {
  fail('missing ' + envFile + ' (copy geo-browser-env.example to geo-browser-env and edit it)');
}

// load env (skip # comments and blank lines). Node parsing is safe.
let port = '8787';
const txt = fs.readFileSync(envFile, 'utf8');
for (const line of txt.split('\n')) {
  const t = line.trim();
  if (!t || t.startsWith('#')) continue;
  const i = t.indexOf('=');
  if (i <= 0) continue;
  const k = t.slice(0, i).trim();
  let v = t.slice(i + 1).trim();
  if (v.startsWith('"') && v.endsWith('"')) v = v.slice(1, -1);
  process.env[k] = v;
  if (k === 'PORT' && v) port = v;
}

// readiness check via node http (does NOT honor system HTTP_PROXY)
function checkReady() {
  return new Promise((resolve) => {
    const req = http.get(
      { host: '127.0.0.1', port: Number(port), path: '/admin', timeout: 3000 },
      (res) => { res.resume(); resolve(res.statusCode === 200); }
    );
    req.on('error', () => resolve(false));
    req.on('timeout', () => { req.destroy(); resolve(false); });
  });
}

(async () => {
  if (await checkReady()) {
    console.log('[INFO] already running: http://127.0.0.1:' + port + '/admin');
    process.exit(0);
  }

  if (!process.env.DB_HOST) fail('missing DB_HOST in env file');
  if (!process.env.DB_USER) fail('missing DB_USER in env file');
  if (!process.env.DB_NAME) fail('missing DB_NAME in env file');

  const nodeBin = process.execPath;
  const tsx = path.join(root, 'node_modules/tsx/dist/cli.mjs');
  if (!fs.existsSync(tsx)) fail('tsx not found: ' + tsx + ' (run: cd ' + root + ' && npm install)');

  const dataRoot = process.env.GEO_DATA_ROOT
    ? path.resolve(root, process.env.GEO_DATA_ROOT)
    : path.resolve(root, '../geo-browser-data');
  const logDir = path.join(dataRoot, 'logs');
  const logFile = path.join(logDir, 'geo-browser.log');
  fs.mkdirSync(logDir, { recursive: true });

  console.log('[deploy] starting service (log: ' + logFile + ')');

  const logFd = fs.openSync(logFile, 'a');
  // proxy vars are only for downloading code, never passed to the service
  const childEnv = Object.assign({}, process.env);
  for (const k of ['HTTP_PROXY', 'HTTPS_PROXY', 'http_proxy', 'https_proxy',
    'ALL_PROXY', 'all_proxy', 'FTP_PROXY', 'ftp_proxy']) delete childEnv[k];
  childEnv.NO_PROXY = 'localhost,127.0.0.1';
  childEnv.no_proxy = 'localhost,127.0.0.1';

  const child = spawn(nodeBin, [tsx, 'src/cli.ts', '--server'], {
    cwd: root,
    env: childEnv,
    stdio: ['ignore', logFd, logFd],
    detached: true,
  });
  child.unref();
  fs.writeFileSync(path.join(dataRoot, 'geo-browser.pid'), String(child.pid));

  let ok = false;
  for (let i = 0; i < 60; i++) {
    await new Promise((r) => setTimeout(r, 2000));
    if (await checkReady()) { ok = true; break; }
  }

  if (!ok) {
    console.log('[ERROR] service not ready within 120s. Last 30 log lines:');
    console.log('--------------------------------------------------');
    try {
      const lines = fs.readFileSync(logFile, 'utf8').split('\n');
      console.log(lines.slice(-30).join('\n'));
    } catch (e) { console.log('(no log file)'); }
    console.log('--------------------------------------------------');
    console.log('Fix the error above, then run stop.bat and run.bat again.');
    process.exit(1);
  }

  console.log('');
  console.log('== done ==');
  console.log('  local URL: http://127.0.0.1:' + port + '/admin');
  console.log('  stop: stop.bat');
  process.exit(0);
})();

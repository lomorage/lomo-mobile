// Starts a throwaway lomod (fresh base dir, free ports, no mDNS) for one test
// file, so every file gets a brand-new server with no users.
const fs = require('fs');
const http = require('http');
const net = require('net');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const ARTIFACTS_DIR = path.join(__dirname, '..', '.artifacts');

async function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.unref();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

function tail(file, lines = 40) {
  try {
    return fs.readFileSync(file, 'utf8').split('\n').slice(-lines).join('\n');
  } catch {
    return '(no log)';
  }
}

// One-shot GET (no keep-alive) returning the status code, or 0 if the server
// isn't listening yet.
function statusOf(url) {
  return new Promise((resolve) => {
    http
      .get(url, { agent: false }, (res) => {
        res.resume();
        resolve(res.statusCode);
      })
      .on('error', () => resolve(0));
  });
}

async function waitForSystem(url, child, logFile, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(`lomod exited with code ${child.exitCode} during startup:\n${tail(logFile)}`);
    }
    if ((await statusOf(`${url}/system`)) === 200) return;
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`lomod did not answer ${url}/system within ${timeoutMs}ms:\n${tail(logFile)}`);
}

async function startLomod(name) {
  const bin = process.env.LOMOD_BIN;
  const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), `lomod-it-${name}-`));
  const mediaDir = path.join(baseDir, 'media');
  fs.mkdirSync(mediaDir);
  fs.mkdirSync(ARTIFACTS_DIR, { recursive: true });
  const logFile = path.join(ARTIFACTS_DIR, `lomod-${name}.log`);
  const log = fs.openSync(logFile, 'w');

  const [http, https, webdav] = [await freePort(), await freePort(), await freePort()];
  const args = [
    '-b', baseDir,
    '--mount-dir', mediaDir,
    '-p', String(http),
    '--port-https', String(https),
    '--port-webdev', String(webdav),
    '--no-mdns',
  ];
  // cwd = the binary's dir so a Windows build finds its bundled ffmpeg/exiftool/DLLs.
  const child = spawn(bin, args, { cwd: path.dirname(bin), stdio: ['ignore', log, log], windowsHide: true });
  fs.closeSync(log);
  const killOnExit = () => child.kill();
  process.on('exit', killOnExit);

  const url = `http://127.0.0.1:${http}`;
  try {
    await waitForSystem(url, child, logFile, 30000);
  } catch (e) {
    child.kill();
    throw e;
  }

  async function stop() {
    process.off('exit', killOnExit);
    if (child.exitCode === null) {
      let timer;
      const exited = new Promise((r) => child.once('exit', r));
      child.kill();
      await Promise.race([exited, new Promise((r) => (timer = setTimeout(r, 5000)))]);
      clearTimeout(timer);
      if (child.exitCode === null) child.kill('SIGKILL');
    }
    if (!process.env.LOMO_IT_KEEP) {
      fs.rmSync(baseDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    }
  }

  return {
    url,
    // What a user types into the login screen; AuthService turns it into a URL.
    address: `127.0.0.1:${http}`,
    baseDir,
    logFile,
    stop,
  };
}

module.exports = { startLomod, ARTIFACTS_DIR };

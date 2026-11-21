// Per-test-file wiring: a fresh lomod plus fresh app state (SecureStore,
// SQLite, file sandbox) for the file, and helpers that drive the real services.
const crypto = require('crypto');
const fs = require('fs');
const { startLomod } = require('./lomod');
const sandbox = require('../shims/sandbox');

function startTestServer(name) {
  const server = {};

  beforeAll(async () => {
    Object.assign(server, await startLomod(name));
  }, 60000);

  afterAll(async () => {
    // fetchRemoteOverview fires GPS syncs in the background; let them finish
    // before the server goes away so they don't fail against a dead socket.
    const SyncService = require('../../src/services/SyncService').default;
    await waitFor(() => !SyncService._isSyncingGPS && !SyncService._isSyncingLocalGPS, { timeoutMs: 30000 });
    const AssetDBService = require('../../src/services/AssetDBService').default;
    if (AssetDBService.db) await AssetDBService.db.closeAsync();
    if (server.stop) await server.stop();
    sandbox.cleanup();
  }, 60000);

  return server;
}

// Registers a user through the same path RegisterScreen uses: list the
// server's disks, create the account on the first one, then auto-login.
async function registerUser(server, { username = 'alice', password = 'alice-pw-1' } = {}) {
  const AuthService = require('../../src/services/AuthService').default;
  const disks = await listDisks(AuthService, server);
  if (disks.length === 0) throw new Error('lomod reported no usable disk to register on');
  await AuthService.register(server.address, username, password, disks[0].name, `${username}-nick`);
  return { username, password };
}

// The disk list right after lomod starts. Answering /system doesn't mean /mount answers within
// the app's 8 s lookup timeout on a busy CI runner (seen once: every test of a file failed here),
// so it gets a few tries; if they all fail, the error carries the cause and lomod's log.
async function listDisks(AuthService, server, attempts = 3) {
  let lastError;
  for (let i = 0; i < attempts; i++) {
    try {
      return await AuthService.getAvailableDisks(server.address);
    } catch (e) {
      lastError = e;
      await new Promise((r) => setTimeout(r, 2000));
    }
  }
  let log = '(no log)';
  try {
    log = fs.readFileSync(server.logFile, 'utf8').split('\n').slice(-40).join('\n');
  } catch (_e) { /* no log */ }
  throw new Error(`lomod's disk list failed ${attempts} times: ${lastError?.cause?.message || lastError?.message}\n${log}`);
}

async function waitFor(check, { timeoutMs = 20000, intervalMs = 250, what = 'condition' } = {}) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await check();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`Timed out after ${timeoutMs}ms waiting for ${what}`);
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}

function sha1(file) {
  return crypto.createHash('sha1').update(fs.readFileSync(file)).digest('hex');
}

module.exports = { registerUser, sha1, startTestServer, waitFor };

// expo-sqlite's async API on top of Node's built-in node:sqlite, so
// AssetDBService runs its real schema/migrations/queries.
// process.getBuiltinModule sidesteps Jest's resolver, which doesn't know the
// scheme-only `node:sqlite` builtin.
const path = require('path');
const sandbox = require('./sandbox');

const { DatabaseSync } = process.getBuiltinModule('node:sqlite');

function toSqlValue(v) {
  if (v === undefined) return null;
  if (typeof v === 'boolean') return v ? 1 : 0;
  return v;
}

// expo-sqlite accepts `(sql, a, b)`, `(sql, [a, b])` and `(sql, { $a: 1 })`.
function bindArgs(params) {
  const single = params.length === 1 ? params[0] : undefined;
  if (Array.isArray(single)) return single.map(toSqlValue);
  if (single && typeof single === 'object' && !Buffer.isBuffer(single) && !ArrayBuffer.isView(single)) {
    return [Object.fromEntries(Object.entries(single).map(([k, v]) => [k, toSqlValue(v)]))];
  }
  return params.map(toSqlValue);
}

function returnsRows(sql) {
  return /^\s*(select|pragma|with|explain)\b/i.test(sql) || /\breturning\b/i.test(sql);
}

function execute(stmt, sql, params) {
  const args = bindArgs(params);
  if (returnsRows(sql)) {
    const rows = stmt.all(...args);
    return { rows, changes: 0, lastInsertRowId: 0 };
  }
  const { changes, lastInsertRowid } = stmt.run(...args);
  return { rows: [], changes: Number(changes), lastInsertRowId: Number(lastInsertRowid) };
}

function resultOf({ rows, changes, lastInsertRowId }) {
  return {
    changes,
    lastInsertRowId,
    getAllAsync: async () => rows,
    getFirstAsync: async () => rows[0] ?? null,
    getAllSync: () => rows,
    getFirstSync: () => rows[0] ?? null,
    resetAsync: async () => {},
    resetSync: () => {},
  };
}

function wrap(db) {
  const api = {
    databasePath: db.location?.() ?? null,
    execAsync: async (sql) => db.exec(sql),
    execSync: (sql) => db.exec(sql),
    runAsync: async (sql, ...params) => api.runSync(sql, ...params),
    runSync: (sql, ...params) => {
      const { changes, lastInsertRowId } = execute(db.prepare(sql), sql, params);
      return { changes, lastInsertRowId };
    },
    getAllAsync: async (sql, ...params) => api.getAllSync(sql, ...params),
    getAllSync: (sql, ...params) => db.prepare(sql).all(...bindArgs(params)),
    getFirstAsync: async (sql, ...params) => api.getFirstSync(sql, ...params),
    getFirstSync: (sql, ...params) => db.prepare(sql).get(...bindArgs(params)) ?? null,
    prepareAsync: async (sql) => api.prepareSync(sql),
    prepareSync: (sql) => {
      const stmt = db.prepare(sql);
      return {
        executeAsync: async (...params) => resultOf(execute(stmt, sql, params)),
        executeSync: (...params) => resultOf(execute(stmt, sql, params)),
        finalizeAsync: async () => {},
        finalizeSync: () => {},
      };
    },
    withTransactionAsync: (task) => transaction(db, 'BEGIN', () => task()),
    withExclusiveTransactionAsync: (task) => transaction(db, 'BEGIN EXCLUSIVE', () => task(api)),
    closeAsync: async () => db.close(),
    closeSync: () => db.close(),
  };
  return api;
}

async function transaction(db, begin, task) {
  db.exec(begin);
  try {
    const result = await task();
    db.exec('COMMIT');
    return result;
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}

async function openDatabaseAsync(name) {
  return wrap(new DatabaseSync(path.join(sandbox.dir('SQLite'), name)));
}

module.exports = { openDatabaseAsync };

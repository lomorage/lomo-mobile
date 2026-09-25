# Integration tests: mobile services ↔ lomod

These tests run the app's real service layer (`src/services`: AuthService,
UploadService, SyncService, RemoteAlbumService, …) under Node against a real
`lomod`, over real HTTP. They catch API-contract breaks between the app and
lomo-backend that the mocked unit tests can't.

Each test file starts its own `lomod` with an empty base dir, free ports and
mDNS off, registers a user through the app's own flow, and kills the server
afterwards. Test files are isolated from each other and from any lomod you
already run.

## Running locally

Requires Node 22.13+ (tests use the built-in `node:sqlite`).

```sh
LOMOD_BIN=/path/to/lomod npm run test:integration
```

On Windows, unzip a `lomorage-windows-amd64-*.zip` build and point
`LOMOD_BIN` at its `lomod.exe`. The DLLs and ffmpeg/exiftool next to it are
picked up automatically.

```powershell
$env:LOMOD_BIN = "C:\path\to\unzipped\lomod.exe"; npm run test:integration
```

Useful knobs:

- `LOMO_IT_VERBOSE=1` shows the services' console output (silenced by default).
- `LOMO_IT_KEEP=1` keeps each lomod's base dir (DB, uploaded files) after the run.
- `LOMO_IT_PLATFORM=ios` runs the services with `Platform.OS === 'ios'` (default `android`).
- Each file's lomod log goes to `integration/.artifacts/lomod-<name>.log`.

## CI

The `integration` job in `.github/workflows/ci.yml` runs inside
`ghcr.io/lomorage/lomod-test`, which lomo-backend's CI publishes. It's an
Ubuntu image with `lomod` at `/opt/lomorage/bin/lomod` plus its runtime
dependencies. Tags are `latest` (backend `master`), the branch name, and
`sha-<commit>`. To pin a backend build, set the repo variable `LOMOD_IMAGE`,
for example `ghcr.io/lomorage/lomod-test:sha-1234abc`.

## How it works

`jest.config.js` maps the native modules to Node implementations in `shims/`:

| Module | Replacement |
| --- | --- |
| `expo-file-system/legacy` | `node:fs`; `createUploadTask` sends the file with `fetch` |
| `expo-sqlite` | `node:sqlite`, so AssetDBService runs its real schema and queries |
| `expo-media-library` | a fake camera roll filled by `support/cameraRoll.js` |
| `react-native-argon2` | `hash-wasm`, producing the same encoded hash the app sends |
| `modules/expo-lomo-hasher` | `node:crypto` SHA-1 and file slicing |
| `expo-secure-store`, `expo-crypto`, `react-native` | small in-memory/Node versions |

`AIService` (on-device ML) and a few other device-only modules are stubbed in
`shims/stubs/`. `Alert.alert` automatically presses Cancel, so a dead server
fails the test instead of hanging it.

To add a test, create `tests/<area>.test.js`. Call
`startTestServer('<area>')` at the top level, then `registerUser(server)` in
a `beforeAll`, and drive the services directly.

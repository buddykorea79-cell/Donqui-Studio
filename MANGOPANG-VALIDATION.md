# Mangopang Studio development validation — 2026-09-23

> Renamed from WatermelonAI to Mangopang Studio on 2026-09-23. The results below were recorded under the old name; the post-rename re-check is in [Post-rename check](#post-rename-check).

Base: OpenScreen v1.12.2 (`e60428a71d68f26bb0a7a830bfcbae40ed8d17d8`). Branch: `codex/watermelonai-foundation`. Windows x64; Electron 41.2.1. No native source modifications.

## Verified behavior

- Photo conversion: selected PNG to 3.5-second H.264 clip; repeat import returns the same cached file without changing its mtime; source SHA-256 unchanged; FFmpeg full decode exit 0.
- Electron automated UI: new project, photo duration input, photo import through actual main-process conversion, full video import (2 seconds), two clips retained, typed Korean subtitle with start/duration, two clip anchors stored, font size 57, app restart restores project.
- Only the native file picker was stubbed to return generated test files; conversion, IPC, project persistence, renderer actions and app restart were real.
- Actual Electron native export of the UI-created document: `success:true`, 1280×720 MP4. Full file decoded without error. Rendered frame inspected: Korean subtitle centered inside the frame with no right-edge clipping.
- Upstream native payload copied in full from the official Windows installer. All 24 file hashes matched after copying. Installer SHA-256: `098fce823aa7f4473327105bc5a1802754381fb86b71c28b82b477dabc3aa9a8`, matching the GitHub release asset digest.

## Actual command output

`npm run test -- --maxWorkers=2`:

```text
Test Files  252 passed (252)
Tests       3065 passed | 5 skipped (3070)
Duration    96.30s
```

The opt-in photo integration test is among the skipped tests in the general run and was executed separately:

```text
Test Files  2 passed (2)
Tests       14 passed (14)
```

`node scripts/mangopang-smoke.cjs`:

```text
PASS photo import: 3.5s, persisted clip
PASS full video import: 2s, previous photo retained
PASS manual subtitle: text, size 57, two clip anchors saved
PASS restart: saved project restored
```

Both `npx tsc --noEmit` and `npx tsc -p tsconfig.test.json --noEmit`: exit 0.
`npm run build-vite`: exit 0; renderer, Electron main and preload built.
`npm run lint`: exit 0, 25 existing warnings (no errors). Windows checkout CRLF differences were normalized to LF for checked text files; no unrelated functional refactoring.
`npm run i18n:check`: `i18n check PASSED — all 14 locales match en across 7 namespaces.`
`npm run docs:check`: `check-docs: OK (34 files)`.

FFprobe on the 5.5-second validation export:

```text
codec_name: h264 / aac
width: 1280
height: 720
r_frame_rate: 60/1
nb_frames: 330
duration: 5.500000
Decode exit: 0
```

## Limitations / not claimed

- Manual OS mouse/keyboard pass was attempted through the computer-use skill. `get_window_state` returned `Computer Use app approval timed out`; no actual OS picker/HUD/tray pass is claimed. Automated renderer tests do not replace this pass.
- Webcam, recording, tray, GIF export, other operating systems, installer packaging and AI-provider features were outside this first implementation and not validated.
- No installer or production release was produced. Use the prepared local build through `start-mangopang.cmd`.
- Upstream `npm ci` reported 42 dependency advisories (2 low, 29 moderate, 10 high, 1 critical). No unreviewed bulk dependency upgrade was applied; assess/update before any public distribution.
- AutoVeo AI recommendation/group/voice features are future work. Existing AutoVeo files were not changed by this project.

Artifacts/logs: `.local/validation/ui-validation.mp4`, `frame-final.png`, `editor-project.png`, `ui-project.openscreen`; `.local/full-test.log`, `.local/smoke.log`, `.local/ui-export.log`, `.local/lint.log`, `.local/build.log`.

## Post-rename check

Re-run on 2026-09-23 after renaming the app to Mangopang Studio (display name `Mangopang Studio`; file-system name `MangopangStudio` for `productName` and the user-data folder; `appId` `com.mangopang.studio`; theme key `mangopang-theme`; env vars `MANGOPANG_USER_DATA`, `MANGOPANG_INTEGRATION`).

- `npx tsc --noEmit` and `npx tsc -p tsconfig.test.json --noEmit`: exit 0.
- `npm run lint`: exit 0, 25 existing warnings.
- `npm run build-vite`: exit 0.
- `npm run test -- --maxWorkers=2`: `Test Files 252 passed (252)`, `Tests 3065 passed | 5 skipped (3070)`.
- `MANGOPANG_INTEGRATION=1` photo/subtitle integration run: `Test Files 2 passed (2)`, `Tests 14 passed (14)`.
- `npm run i18n:check`: PASSED. `npm run docs:check`: OK (34 files).
- `node scripts/mangopang-smoke.cjs`: all four PASS lines (photo import, full video import, manual subtitle, restart).
- Launched app: window title `Mangopang Studio`, `app.getName()` `Mangopang Studio`, mango mark in the top bar and empty state.

Not changed: tray icon (`openscreen.png`) and installer icons (`icons/icons/*`) are still OpenScreen artwork; they need PNG/ICO/ICNS sets when packaging is set up.

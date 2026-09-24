# Donqui Studio validation — 2026-09-23

Windows x64 development build based on OpenScreen `94e6cff` plus the existing Mangopang Studio foundation. Changes live in this worktree; the main checkout and AutoVeo source were not modified. No installer or release was published.

## Automated checks

- Final full unit suite: 262 files passed; 3,201 tests passed, 7 skipped (`npm run test -- --maxWorkers=4`). Log: `.local/donqui-full-test-final.log`. The optional media integration tests were run separately with their opt-in environment flag.
- Application and test TypeScript configurations passed.
- Biome passed with no errors and 25 existing warnings.
- Locale validation passed for all 15 locales; documentation validation passed.
- Remotion integration rendered both audible video and a silent photo-style source, verified stream types, trim duration, full decoding, original preservation and cache reuse. Silent sources produce no audio stream. The runtime uses installed Edge, without downloading a browser.
- Audio, duration fitting, captions under cuts/speed changes, persistence, preview controls and source switching have focused regression coverage.
- Concurrent clip placement, video/audio import, transcript completion and background metadata now share a document write queue. Regression tests verify persisted clips and imported assets survive concurrent saves, and superseded work is discarded after project switches or undo.
- Real Electron flow passed: music trimmed from 8 to 5 seconds before video import; random-effect photo 1.5 seconds; zoom-in video fitted to the remaining 3.5 seconds; both clips and the entire music bed retained. Native export produced a decodable 1920×1080 H.264 MP4 with audio, approximately 5 seconds, and project restoration passed after restarting. Evidence: `.local/donqui-validation/{audio.png,clip-preview.png,editor.png,export-frame.png,ffprobe.json,donqui-final.mp4,profile.txt}`.
- Responsive top-bar checks passed 210 combinations (15 locales, 14 widths from 800 to 1920px), reserving 138px for Windows controls. All tab labels and Export remain visible.

Validation used the host's Node 24.21.0 / npm 11.19.0. The repository remains pinned to Node 22.22.1 / npm 10.9.4 for reproducible CI builds.

## Reproduce the desktop flow

Build with `npm run build-vite`, then run `node scripts/donqui-smoke.cjs`. It creates synthetic image/video/audio sources and a fresh isolated profile under `.local/donqui-validation`, imports and trims music to 5 seconds, renders a 1.5-second photo effect, fits a 3.5-second video effect to the remainder, exports MP4 and reopens the project. Native file pickers are replaced only within this automated test. The script verifies project files and decodes the exported MP4, and saves screenshots plus stream metadata.

The entire 24-file Windows native payload was copied from the existing main checkout and verified by SHA-256. Native capture/compositor source was not changed or rebuilt. These checks do not validate an installer, real screen capture, webcam, tray/HUD, GIF, macOS or Linux.

## Manual desktop scope

Computer-use opened and inspected the real Windows Audio surface and donkey branding. The mouse input attempt was interrupted with `user input was detected in this window; call get_window_state before continuing`; a fresh capture showed another foreground application. OS click/playback/picker checks were therefore skipped during concurrent desktop use, not marked passed. See the dated result in `technical-documentation/testing/manual-e2e-checklist.md`. Automated renderer clicks are not treated as real OS input.

# V.Clip and startup fix — 2026-09-24

V.Clip is the tab between Audio and Media. It splits long footage into scored segments, AutoVeo's "영상 클립" step, and renders the chosen ones as Remotion-effect clips onto the timeline. The range cutter that sat in Media's detail pane moved there as the "직접 자르기" tab; Media keeps import, whole-source placement and transcripts, and hands a source over with "V.Clip에서 구간 나누기". The Donqui baseline above was committed first (`feat: add Donqui Studio baseline`), so worktrees now start from it.

## Startup

`start-donqui.cmd` passed `"%~dp0"` to Electron. That path ends in a backslash, which escapes the closing quote, so Electron was handed a folder name ending in `"` and showed a window titled "Error". It now passes `.` (the script already `cd`s to its folder), clears `ELECTRON_RUN_AS_NODE`, and rebuilds with `npm run build-vite` when any source is newer than `dist-electron/main.js` (`scripts/donqui-ensure-build.cjs`), so a double-click after an edit or branch switch never runs the previous build. `.cmd`/`.bat` files are checked out with CRLF. Checked by launching both scripts through `cmd.exe` with an isolated profile: the committed-before script opens "Error", the new one opens "Donqui Studio"; a second run with nothing changed skips the build (0.1 s).

`scripts/build-clip-effects.mjs` now compares against the real path of `node_modules`, so it builds in a worktree whose `node_modules` is a junction to the main checkout's, as AGENTS.md recommends.

## Automated checks

- V.Clip unit and component tests: 68 passing (segments, Ollama client, analysis, store, stage), plus 2 FFmpeg integration tests run with `DONQUI_VCLIP_INTEGRATION=1` against the bundled `ffmpeg-shared.exe`. Application and test TypeScript configurations pass; Biome reports no errors.
- Real Electron, real footage — `node scripts/vclip-smoke.cjs <DJI_20260724084147_0017_D.MP4>`: DJI Mini 4 Pro, 4K HEVC 29.97 fps, 2:46.8, 1.8 GB, no audio stream, with `qwen3-vl:4b`. FFmpeg probed it in under a second; 12 windows analysed in 61 s; "남은 Audio만큼 선택" picked 3 segments (15.0 s) for a 12 s music bed; the preview played the HEVC source; three random-effect clips (위로 이동, 슬라이드, 페이드) rendered in 223 s (≈75 s each, 1080p) and landed on the timeline in filmed order with the music track unchanged. Evidence: `.local/vclip-validation/{vclip-segments,vclip-preview,vclip-timeline}.png`, `project.openscreen`.
- `qwen3-vl:4b` gave 11 or 12 of the 12 windows the same score (85) across runs, which left the first windows in time order to win every tie. Ties now go to the frame-quality score (84–94 on this clip); the analysis cache version was bumped for the new field.
- `node scripts/donqui-smoke.cjs`, updated to cut the photo and video effect clips in V.Clip's manual tab: all five steps pass (audio-first trim, random photo effect, zoom-in video fitted to the remaining 3.5 s, native MP4 export, restart).
- Top bar with five tabs, real window resizes (`BrowserWindow.setSize`), 15 locales × 14 widths from 800 to 1920 px, the export button checked against `env(titlebar-area-width)`: 210/210 pass. The same check found 22 overlaps with five tabs before the fix — and 5 already with the four-tab bar (fr/ru at 900 px, fr at 1024 px, cs/pt-BR at 900 px), which the earlier emulated check did not catch. Export is icon-only below 1200 px and Presets below 960 px; both keep their names as tooltips and accessible names.
- The Audio and V.Clip stages now fill the editor stage absolutely, like Media. With `height: 100%` they could not scroll, which cut off V.Clip's create button (and would have cut off a long Audio track list).

## Not covered

No computer-use was available in this session, so nothing here was driven by real OS mouse or keyboard input; Playwright's clicks are not treated as such. Not built or checked: an installer, macOS, Linux, other Ollama models, sources with rotation metadata in a real run (covered by a unit test only).

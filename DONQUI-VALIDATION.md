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

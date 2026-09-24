import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { describe, expect, it, vi } from "vitest";
import { addManualSubtitle } from "../../src/lib/ai-edition/document/manualSubtitle";
import { createEmptyDocument, documentSchema } from "../../src/lib/ai-edition/schema";
import { createImageClip, imageClipArgs } from "./imageClip";

vi.mock("electron", () => ({ app: undefined }));
const run = promisify(execFile);
describe("photo clips", () => {
	it.each([0, -1, 601, Number.NaN, Infinity])("rejects invalid duration %s", (duration) => {
		expect(() => imageClipArgs("photo.png", duration, "out.mp4")).toThrow();
	});
	it("keeps shell characters as a single input argument and limits CPU", () => {
		const args = imageClipArgs("photo & 한글.png", 3.5, "output.mp4");
		expect(args[args.indexOf("-i") + 1]).toBe("photo & 한글.png");
		expect(args[args.indexOf("-t") + 1]).toBe("3.5");
		expect(args).toContain("libopenh264");
		expect(args[args.indexOf("-threads") + 1]).toBe("2");
	});
	it.runIf(process.env.MANGOPANG_INTEGRATION === "1")(
		"creates a decodable cached photo clip and export fixture",
		async () => {
			const ffmpeg = path.resolve("electron/native/bin/win32-x64/ffmpeg-shared.exe");
			const root = path.resolve(".local/validation");
			await mkdir(root, { recursive: true });
			const input = path.join(root, "photo 한글.png");
			await run(
				ffmpeg,
				["-y", "-f", "lavfi", "-i", "testsrc2=size=1280x720:rate=1", "-frames:v", "1", input],
				{ windowsHide: true },
			);
			const digest = async () =>
				createHash("sha256")
					.update(await readFile(input))
					.digest("hex");
			const before = await digest();
			const output = await createImageClip(input, 3.5, path.join(root, "cache"));
			const mtime = (await stat(output)).mtimeMs;
			expect(await createImageClip(input, 3.5, path.join(root, "cache"))).toBe(output);
			expect((await stat(output)).mtimeMs).toBe(mtime);
			expect(await digest()).toBe(before);
			await run(ffmpeg, ["-v", "error", "-i", output, "-f", "null", "-"], { windowsHide: true });
			const video = path.join(root, "full-video.mp4");
			await run(
				ffmpeg,
				[
					"-y",
					"-f",
					"lavfi",
					"-i",
					"color=c=teal:s=1280x720:r=30:d=2",
					"-f",
					"lavfi",
					"-i",
					"sine=frequency=440:duration=2",
					"-c:v",
					"libopenh264",
					"-threads",
					"2",
					"-c:a",
					"aac",
					"-shortest",
					video,
				],
				{ windowsHide: true },
			);
			const doc = createEmptyDocument({
				projectId: "mangopang-validation",
				title: "Mangopang Studio 사진·영상·자막 검증",
			});
			doc.assets = [
				{
					id: "photo",
					kind: "video",
					label: "사진 3.5초",
					originalPath: output,
					durationSec: 3.5,
					cameraTrack: null,
				},
				{
					id: "video",
					kind: "video",
					label: "전체 영상 2초",
					originalPath: video,
					durationSec: 2,
					cameraTrack: null,
				},
			];
			doc.project.primaryAssetId = "photo";
			doc.timeline.clips = [
				{
					id: "photo-clip",
					assetId: "photo",
					sourceStartSec: 0,
					sourceEndSec: 3.5,
					timelineStartSec: 0,
					timelineEndSec: 3.5,
					wordRefs: [],
					origin: "user",
					reason: "Test fixture",
				},
				{
					id: "video-clip",
					assetId: "video",
					sourceStartSec: 0,
					sourceEndSec: 2,
					timelineStartSec: 3.5,
					timelineEndSec: 5.5,
					wordRefs: [],
					origin: "user",
					reason: "Test fixture",
				},
			];
			const final = documentSchema.parse(
				addManualSubtitle(doc, {
					text: "사진과 전체 영상 · 자막 테스트",
					startSec: 0.5,
					endSec: 5,
				}),
			);
			await writeFile(path.join(root, "validation.openscreen"), JSON.stringify(final, null, 2));
		},
		60000,
	);
});

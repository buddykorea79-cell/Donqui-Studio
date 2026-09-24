const fs = require("node:fs/promises");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const assert = require("node:assert/strict");
const { launchDirect } = require("./electron-direct-launch.cjs");
const root = process.cwd();
const validation = path.join(root, ".local", "donqui-validation");
const profile = path.join(validation, `profile-${Date.now()}`);
const native = path.join(root, "electron", "native", "bin", "win32-x64");
const ffmpeg = path.join(native, "ffmpeg-shared.exe");
const photo = path.join(validation, "photo 한글.png");
const video = path.join(validation, "video.mp4");
const audio = path.join(validation, "music.wav");
const output = path.join(validation, "donqui-final.mp4");

function fixture(args) {
	const result = spawnSync(ffmpeg, ["-hide_banner", "-loglevel", "error", "-y", ...args], {
		windowsHide: true,
		encoding: "utf8",
	});
	assert.equal(result.status, 0, result.stderr);
}
async function savedDocument(check, timeoutMs = 120000) {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		const dir = path.join(profile, "projects");
		for (const file of (await fs.readdir(dir).catch(() => [])).filter((f) =>
			f.endsWith(".openscreen"),
		)) {
			const doc = await fs
				.readFile(path.join(dir, file), "utf8")
				.then(JSON.parse)
				.catch(() => null);
			if (doc && check(doc)) return doc;
		}
		await new Promise((resolve) => setTimeout(resolve, 200));
	}
	throw new Error("Expected project state was not persisted");
}
async function launch() {
	const env = {
		...process.env,
		DONQUI_USER_DATA: profile,
		OPENSCREEN_DISABLE_CONTENT_PROTECTION: "1",
		PATH: `${native}${path.delimiter}${process.env.PATH}`,
	};
	delete env.ELECTRON_RUN_AS_NODE;
	// Not Playwright's `_electron.launch`: see electron-direct-launch.cjs.
	return launchDirect({
		executablePath: path.join(root, "node_modules/electron/dist/electron.exe"),
		args: [".", "--disable-backgrounding-occluded-windows", "--disable-renderer-backgrounding"],
		cwd: root,
		env,
	});
}
(async () => {
	await fs.mkdir(validation, { recursive: true });
	fixture(["-f", "lavfi", "-i", "testsrc2=size=640x360:rate=30", "-frames:v", "1", photo]);
	fixture([
		"-f",
		"lavfi",
		"-i",
		"testsrc2=size=640x360:rate=30",
		"-f",
		"lavfi",
		"-i",
		"sine=frequency=880:sample_rate=48000",
		"-t",
		"4",
		"-c:v",
		"libopenh264",
		"-b:v",
		"2M",
		"-c:a",
		"aac",
		video,
	]);
	fixture(["-f", "lavfi", "-i", "sine=frequency=440:sample_rate=48000", "-t", "8", audio]);
	let app = await launch();
	let page;
	try {
		page = await app.firstWindow();
		page.on("pageerror", (error) => console.error("RENDERER", error.message));
		await page.getByRole("button", { name: "Donqui Studio", exact: true }).waitFor();
		assert.equal((await page.getByRole("tab").allTextContents())[0], "Audio");
		await page
			.getByRole("button", { name: /^(새 프로젝트|New project)$/ })
			.first()
			.click();
		await page.locator("#np-name").fill("Donqui audio-led validation");
		await page.getByRole("button", { name: /^(프로젝트 만들기|Create project)$/ }).click();
		assert.equal(
			await page.getByRole("tab", { name: "Audio", exact: true }).getAttribute("aria-selected"),
			"true",
		);
		await app.evaluate(
			({ dialog }, files) => {
				dialog.showOpenDialog = async (options) => ({
					canceled: false,
					filePaths: [
						options.filters?.[0]?.extensions?.includes("png")
							? files.photo
							: options.filters?.[0]?.extensions?.includes("mp3")
								? files.audio
								: files.video,
					],
				});
				dialog.showSaveDialog = async () => ({ canceled: false, filePath: files.output });
			},
			{ photo, video, audio, output },
		);
		await page.getByRole("button", { name: "음악 가져오기", exact: true }).click();
		await savedDocument((doc) => doc.audioTracks.length === 1);
		await page.getByLabel("원본 종료 (초)", { exact: true }).fill("5");
		await page.getByRole("button", { name: "설정 적용", exact: true }).click();
		await savedDocument(
			(doc) => doc.audioTracks[0]?.endMs === 5000 && doc.audioTracks[0]?.timelineLocked,
		);
		console.log("PASS Audio first: 8s music imported and trimmed to 5s before any visual clip");
		await page.getByRole("button", { name: "오디오 전체 미리보기", exact: true }).click();
		await page.waitForTimeout(350);
		await page.getByRole("button", { name: "일시 정지", exact: true }).click();
		await page.screenshot({ path: path.join(validation, "audio.png") });
		// V.Clip: split a range of the video. Only the range is recorded; nothing renders here.
		await page.getByRole("tab", { name: "V.Clip", exact: true }).click();
		await page.getByRole("button", { name: "영상 가져오기", exact: true }).first().click();
		const panel = page.getByRole("region", { name: "video.mp4 구간" });
		await panel.getByText(/640×360/).waitFor({ timeout: 60000 });
		await panel.getByRole("button", { name: /구간 직접 추가/ }).click();
		const card = panel.getByRole("article").first();
		await card.getByText(/^0:00\.0–0:04\.0/).waitFor();
		await card.getByLabel("길이 (초)", { exact: true }).fill("3.5");
		await card.getByLabel("길이 (초)", { exact: true }).press("Enter");
		await card.getByText("0:00.0–0:03.5 · 3.5초").waitFor();
		await card.getByRole("button", { name: /구간 미리보기$/ }).click();
		await card.locator("video").waitFor();
		await page.waitForTimeout(800);
		await page.screenshot({ path: path.join(validation, "vclip.png") });
		await page
			.getByRole("button", { name: /선택한 구간 1개 클립으로 나누기/ })
			.first()
			.click();
		let doc = await savedDocument((value) => value.mediaBoard?.clips?.length === 1);
		assert.deepEqual([doc.mediaBoard.clips[0].startSec, doc.mediaBoard.clips[0].endSec], [0, 3.5]);
		assert.equal(doc.timeline.clips.length, 0);
		console.log("PASS V.Clip: a 3.5 s range split into Media's bin, nothing rendered or placed");

		// Media: a photo with a random effect, then the clip zoomed, fitted to the 5 s of music.
		await page.getByRole("tab", { name: /^(미디어|Media)$/ }).click();
		await page.getByRole("tab", { name: /^사진/ }).click();
		await page.getByRole("button", { name: "사진 추가", exact: true }).click();
		doc = await savedDocument((value) => value.mediaBoard?.images?.length === 1);
		assert.deepEqual([doc.mediaBoard.images[0].width, doc.mediaBoard.images[0].height], [640, 360]);
		await page.getByLabel("사진 길이 (초)", { exact: true }).fill("2");
		await page.getByLabel("새 항목 효과", { exact: true }).selectOption("random");
		await page.getByRole("button", { name: "조합에 넣기", exact: true }).click();
		await page.getByRole("tab", { name: /^V\.Clip 클립/ }).click();
		await page.getByLabel("새 항목 효과", { exact: true }).selectOption("zoom-in");
		await page.getByRole("button", { name: "조합에 넣기", exact: true }).click();
		await savedDocument((value) => value.mediaBoard?.items?.length === 2);
		await page.getByText("0:00.5 넘침").waitFor();
		await page.getByRole("button", { name: "Audio 길이에 맞추기", exact: true }).click();
		const total = (value) =>
			value.mediaBoard.items.reduce((sum, item) => sum + item.endSec - item.startSec, 0);
		doc = await savedDocument((value) => Math.abs(total(value) - 5) < 0.02);
		console.log(
			`PASS Media fit: 2 s photo + 3.5 s clip fitted to the 5 s bed → ${doc.mediaBoard.items
				.map((item) => (item.endSec - item.startSec).toFixed(3))
				.join(" + ")}`,
		);
		const previewButton = page.getByRole("button", { name: "1번 미리보기", exact: true });
		const previewOpens = async (timeoutMs) => {
			const deadline = Date.now() + timeoutMs;
			while (Date.now() < deadline) {
				if ((await previewButton.getAttribute("aria-pressed")) === "true") return true;
				await page.waitForTimeout(250);
			}
			return false;
		};
		// The button toggles, so clicking again too soon would close what a slow first click opened.
		// Ask again only after long enough for that click to have landed (it took 15–315 ms in
		// traced runs), and say how long it took.
		const clickedAt = Date.now();
		await previewButton.click();
		if (!(await previewOpens(15000))) {
			console.log("preview did not open 15 s after the click; clicking again");
			await previewButton.click();
			assert(await previewOpens(15000), "the preview did not open");
		}
		console.log(`preview opened ${Date.now() - clickedAt} ms after the click`);
		// The Remotion player shows the photo through <Img>, under the item.
		await page.locator("[class*=itemPreview] img").first().waitFor({ timeout: 60000 });
		await page.waitForTimeout(800);
		await page.screenshot({ path: path.join(validation, "media-compose.png") });
		await page.getByRole("button", { name: "1번 미리보기", exact: true }).click();
		await page.getByRole("button", { name: /타임라인에 적용/ }).click();
		doc = await savedDocument(
			(value) =>
				value.timeline.clips.length === 2 &&
				Math.abs(value.timeline.clips[1].timelineEndSec - 5) < 0.04,
			600000,
		);
		assert.equal(doc.audioTracks[0].endMs, 5000);
		const placed = doc.timeline.clips.map(
			(clip) => doc.assets.find((asset) => asset.id === clip.assetId)?.originalPath ?? "",
		);
		assert(/[\\/]clip-effects[\\/]/.test(placed[0]), `photo not rendered: ${placed[0]}`);
		assert(/[\\/]clip-effects[\\/]/.test(placed[1]), `clip not rendered: ${placed[1]}`);
		await page.screenshot({ path: path.join(validation, "media-applied.png") });
		console.log(
			"PASS Media apply: photo (random effect) and clip (zoom-in) rendered by Remotion, 5 s picture, music bed intact",
		);
		await fs.writeFile(path.join(validation, "project.openscreen"), JSON.stringify(doc, null, 2));
		await page.getByRole("tab", { name: /^(편집|Edit)$/ }).click();
		await page.screenshot({ path: path.join(validation, "editor.png") });
		await page.getByRole("button", { name: /^(내보내기|Export)$/, exact: true }).click();
		await page.getByRole("button", { name: /^(MP4 내보내기|Export MP4)$/, exact: true }).click();
		await page.getByTestId("export-show-in-folder").waitFor({ timeout: 120000 });
		const probe = spawnSync(
			path.join(root, "node_modules/@remotion/compositor-win32-x64-msvc/ffprobe.exe"),
			["-v", "error", "-show_streams", "-show_format", "-of", "json", output],
			{ windowsHide: true, encoding: "utf8" },
		);
		assert.equal(probe.status, 0, probe.stderr);
		const outputInfo = JSON.parse(probe.stdout);
		assert(Math.abs(Number(outputInfo.format.duration) - 5) < 0.1);
		assert(outputInfo.streams.some((stream) => stream.codec_type === "audio"));
		fixture(["-i", output, "-f", "null", "-"]);
		fixture([
			"-ss",
			"0.75",
			"-i",
			output,
			"-frames:v",
			"1",
			path.join(validation, "export-frame.png"),
		]);
		await fs.writeFile(path.join(validation, "ffprobe.json"), probe.stdout);
		console.log("PASS native MP4 export: 5s picture + audio, full decode and frame extraction");
		await page
			.getByRole("button", { name: /^(닫기|Close)$/, exact: true })
			.last()
			.click();
		await app.close();
		app = await launch();
		page = await app.firstWindow();
		await page.getByText("Donqui audio-led validation", { exact: true }).first().waitFor();
		console.log("PASS restart: audio-led project restored");
		// The photo is rendered from its original file, which only the project names after a
		// restart: applying again proves the main process approved it from the document.
		await page.getByRole("tab", { name: /^(미디어|Media)$/ }).click();
		const before = doc.timeline.clips.map((clip) => clip.id).join();
		await page.getByRole("button", { name: /타임라인에 적용/ }).click();
		await page.getByRole("button", { name: "바꾸기", exact: true }).click();
		doc = await savedDocument(
			(value) =>
				value.timeline.clips.length === 2 &&
				value.timeline.clips.map((clip) => clip.id).join() !== before,
			120000,
		);
		assert.equal(doc.mediaBoard.items.length, 2);
		console.log("PASS restart: composition persisted and re-applied from the render cache");
		await fs.writeFile(path.join(validation, "profile.txt"), profile);
	} catch (error) {
		console.error("SMOKE FAILURE", error);
		if (page && !page.isClosed())
			await fs.writeFile(
				path.join(validation, "failure-accessibility.txt"),
				await page.locator("body").ariaSnapshot(),
			);
		if (page && !page.isClosed())
			await page
				.screenshot({ path: path.join(validation, "failure.png"), timeout: 5000 })
				.catch(() => undefined);
		throw error;
	} finally {
		await app.close();
	}
})().catch((error) => {
	console.error(error);
	process.exitCode = 1;
});

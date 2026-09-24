const { _electron: electron } = require("playwright");
const fs = require("node:fs/promises");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const assert = require("node:assert/strict");
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
async function savedDocument(check) {
	const deadline = Date.now() + 120000;
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
	return electron.launch({
		executablePath: path.join(root, "node_modules/electron/dist/electron.exe"),
		args: [".", "--disable-backgrounding-occluded-windows", "--disable-renderer-backgrounding"],
		cwd: root,
		env,
		timeout: 30000,
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
		await page.getByRole("tab", { name: /^(미디어|Media)$/ }).click();
		await page.getByLabel("사진 클립 길이 (초)", { exact: true }).fill("1.5");
		await page.getByRole("button", { name: "사진 추가", exact: true }).click();
		await page.getByRole("button", { name: "클립 미리보기", exact: true }).waitFor();
		await page.getByLabel("Remotion 효과", { exact: true }).selectOption("random");
		await page.getByRole("button", { name: "클립 미리보기", exact: true }).click();
		await page.locator("section[aria-label='클립 만들기'] video").waitFor();
		await page.screenshot({ path: path.join(validation, "clip-preview.png") });
		await page.getByRole("button", { name: "클립 만들고 타임라인에 추가", exact: true }).click();
		let doc = await savedDocument(
			(value) =>
				value.timeline.clips.length === 1 &&
				Math.abs(value.timeline.clips[0].timelineEndSec - 1.5) < 0.04,
		);
		assert.equal(doc.audioTracks[0].endMs, 5000);
		assert(Math.abs(doc.timeline.clips[0].timelineEndSec - 1.5) < 0.04);
		console.log(
			"PASS photo random Remotion effect: preview, render, timeline insert, full audio bed retained",
		);
		await page.bringToFront();
		await page.getByRole("button", { name: "미리보기 닫기", exact: true }).dispatchEvent("click");
		await page.locator("button").filter({ hasText: "전체 영상 추가" }).click();
		await page.getByLabel("클립 끝 (초)", { exact: true }).fill("4");
		await page.getByRole("button", { name: "남은 Audio 길이에 맞추기", exact: true }).click();
		assert.equal(await page.getByLabel("클립 끝 (초)", { exact: true }).inputValue(), "3.5");
		await page.getByLabel("Remotion 효과", { exact: true }).selectOption("zoom-in");
		await page.getByRole("button", { name: "클립 만들고 타임라인에 추가", exact: true }).click();
		doc = await savedDocument(
			(value) =>
				value.timeline.clips.length === 2 &&
				Math.abs(value.timeline.clips[1].timelineEndSec - 5) < 0.04,
		);
		assert(Math.abs(doc.timeline.clips[1].timelineEndSec - 5) < 0.04);
		assert.equal(doc.audioTracks[0].endMs, 5000);
		console.log(
			"PASS video trim + zoom effect: fits remaining Audio duration (3.5s), combined picture 5s",
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

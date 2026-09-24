// V.Clip on real footage, in the real Electron app:
//   npm run build-vite && node scripts/vclip-smoke.cjs <video> [--no-ai]
// Imports 12 s of music, splits <video> in V.Clip (with the lightest Ollama vision model unless
// --no-ai), selects segments to fill the music, renders them as random-effect clips and checks
// the saved project. Uses a fresh profile under .local/vclip-validation; native file pickers
// are replaced only inside this run. Screenshots land next to the profile.
const { _electron: electron } = require("playwright");
const fs = require("node:fs/promises");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const assert = require("node:assert/strict");

const root = process.cwd();
const source = process.argv[2] ? path.resolve(process.argv[2]) : null;
const withoutAi = process.argv.includes("--no-ai");
const validation = path.join(root, ".local", "vclip-validation");
const profile = path.join(validation, `profile-${Date.now()}`);
const native = path.join(root, "electron", "native", "bin", "win32-x64");
const audio = path.join(validation, "music 12s.wav");

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
		await new Promise((resolve) => setTimeout(resolve, 250));
	}
	throw new Error("Expected project state was not persisted");
}

(async () => {
	if (!source) throw new Error("Usage: node scripts/vclip-smoke.cjs <video> [--no-ai]");
	await fs.access(source);
	await fs.mkdir(validation, { recursive: true });
	const made = spawnSync(
		path.join(native, "ffmpeg-shared.exe"),
		[
			"-hide_banner",
			"-loglevel",
			"error",
			"-y",
			"-f",
			"lavfi",
			"-i",
			"sine=frequency=330:sample_rate=48000",
			"-t",
			"12",
			audio,
		],
		{ windowsHide: true, encoding: "utf8" },
	);
	assert.equal(made.status, 0, made.stderr);
	const env = {
		...process.env,
		DONQUI_USER_DATA: profile,
		OPENSCREEN_DISABLE_CONTENT_PROTECTION: "1",
	};
	delete env.ELECTRON_RUN_AS_NODE;
	const app = await electron.launch({
		executablePath: path.join(root, "node_modules/electron/dist/electron.exe"),
		args: [".", "--disable-backgrounding-occluded-windows", "--disable-renderer-backgrounding"],
		cwd: root,
		env,
		timeout: 30000,
	});
	let page;
	const started = Date.now();
	const log = (message) =>
		console.log(`[${((Date.now() - started) / 1000).toFixed(1)}s] ${message}`);
	try {
		page = await app.firstWindow();
		page.on("pageerror", (error) => console.error("RENDERER", error.message));
		await page.setViewportSize({ width: 1440, height: 900 }).catch(() => undefined);
		await page.getByRole("button", { name: "Donqui Studio", exact: true }).waitFor();
		const tabs = await page.getByRole("tab").allTextContents();
		assert.deepEqual(tabs.slice(0, 3), ["Audio", "V.Clip", tabs[2]]);
		await page
			.getByRole("button", { name: /^(새 프로젝트|New project)$/ })
			.first()
			.click();
		await page.locator("#np-name").fill("V.Clip validation");
		await page.getByRole("button", { name: /^(프로젝트 만들기|Create project)$/ }).click();
		await app.evaluate(
			({ dialog }, files) => {
				dialog.showOpenDialog = async (options) => ({
					canceled: false,
					filePaths: [
						options.filters?.[0]?.extensions?.includes("mp3") ? files.audio : files.source,
					],
				});
			},
			{ audio, source },
		);
		await page.getByRole("button", { name: "음악 가져오기", exact: true }).click();
		await savedDocument((doc) => doc.audioTracks.length === 1);
		log("PASS Audio: 12 s music bed imported");

		await page.getByRole("button", { name: /V\.Clip으로 이동/ }).click();
		assert.equal(
			await page.getByRole("tab", { name: "V.Clip", exact: true }).getAttribute("aria-selected"),
			"true",
		);
		await page.getByRole("button", { name: "영상 가져오기", exact: true }).click();
		const fileName = path.basename(source);
		await page
			.getByRole("button", { name: new RegExp(fileName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")) })
			.waitFor();
		const probe = page.getByText(/\d+×\d+/).first();
		await probe.waitFor({ timeout: 60000 });
		log(`PASS V.Clip source probed by FFmpeg: ${await probe.textContent()}`);
		await page
			.getByText(/Ollama (연결됨|에 연결할 수 없어|에 비전 모델이 없어)/)
			.waitFor({ timeout: 20000 });
		if (withoutAi) await page.getByLabel("분석 모델", { exact: true }).selectOption("");
		const model = await page.getByLabel("분석 모델", { exact: true }).inputValue();
		log(`model: ${model || "(frame quality only)"}`);

		await page.getByRole("button", { name: "구간 찾기", exact: true }).click();
		await page
			.getByRole("button", { name: "구간 다시 찾기", exact: true })
			.waitFor({ timeout: 900000 });
		const cards = page.getByRole("article");
		const count = await cards.count();
		assert(count > 0, "V.Clip found no segments");
		for (let index = 0; index < count; index++)
			log(`  ${(await cards.nth(index).innerText()).replace(/\s+/g, " ").slice(0, 160)}`);
		const failures = await page.getByText(/AI가 \d+개 구간을 판단하지 못해/).count();
		if (model) assert.equal(failures, 0, "the vision model failed on some segments");
		await page.screenshot({ path: path.join(validation, "vclip-segments.png"), fullPage: false });
		log(`PASS analysis: ${count} segments${model ? ` judged by ${model}` : ""}`);

		await page.getByRole("button", { name: "남은 Audio만큼 선택", exact: true }).click();
		await page.getByLabel("Remotion 효과", { exact: true }).selectOption("random");
		const selectedText = await page.getByText(/^선택 \d+개/).textContent();
		const selected = Number(/선택 (\d+)개/.exec(selectedText)?.[1]);
		log(`selection: ${selectedText}`);
		assert(selected > 0);

		const firstSelected = page.locator("article[data-selected='true']").first();
		await firstSelected.getByRole("button", { name: "미리보기", exact: true }).click();
		await page.locator("video").first().waitFor({ timeout: 30000 });
		await page.waitForTimeout(1500);
		await page.screenshot({ path: path.join(validation, "vclip-preview.png") });
		log("PASS preview mounted for the first selected segment");

		await page.getByRole("button", { name: /^선택한 구간 \d+개를 클립으로/ }).click();
		const doc = await savedDocument((value) => value.timeline.clips.length === selected, 1800000);
		const pictureSec = doc.timeline.clips.reduce(
			(sum, clip) => sum + clip.timelineEndSec - clip.timelineStartSec,
			0,
		);
		log(`timeline: ${doc.timeline.clips.length} clips, ${pictureSec.toFixed(2)} s of picture`);
		assert(pictureSec >= 12 - 0.1 || selected === count, "selection did not fill the music bed");
		assert.equal(doc.audioTracks[0].endMs, 12000);
		const clips = doc.assets.filter(
			(asset) => asset.label.startsWith(fileName) && asset.label.includes("초 · "),
		);
		assert.equal(clips.length, selected);
		log(`clip assets: ${clips.map((asset) => asset.label).join(" | ")}`);
		await page
			.getByText(/클립 완성/)
			.first()
			.waitFor();
		await page.screenshot({ path: path.join(validation, "vclip-timeline.png") });
		await fs.writeFile(path.join(validation, "project.openscreen"), JSON.stringify(doc, null, 2));
		log("PASS clips rendered with random effects, placed in filmed order, music bed intact");
	} catch (error) {
		console.error("VCLIP SMOKE FAILURE", error);
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

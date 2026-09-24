const { _electron: electron } = require("playwright");
const fs = require("node:fs/promises");
const path = require("node:path");
const assert = require("node:assert/strict");
const root = process.cwd();
const profile = path.join(root, ".local", "smoke-profile-" + Date.now());
async function savedDocument(check) {
	const deadline = Date.now() + 30000;
	while (Date.now() < deadline) {
		const dir = path.join(profile, "projects");
		const files = await fs.readdir(dir).catch(() => []);
		for (const f of files.filter((f) => f.endsWith(".openscreen"))) {
			const doc = await fs
				.readFile(path.join(dir, f), "utf8")
				.then(JSON.parse)
				.catch(() => null);
			if (doc && check(doc)) return doc;
		}
		await new Promise((r) => setTimeout(r, 200));
	}
	throw new Error("Project did not persist the expected state");
}
async function launch() {
	return electron.launch({
		executablePath: path.join(root, "node_modules/electron/dist/electron.exe"),
		args: ["."],
		cwd: root,
		env: {
			...process.env,
			MANGOPANG_USER_DATA: profile,
			OPENSCREEN_DISABLE_CONTENT_PROTECTION: "1",
		},
		timeout: 30000,
	});
}
(async () => {
	let app = await launch();
	try {
		let page = await app.firstWindow();
		await page.getByRole("button", { name: "Mangopang Studio", exact: true }).waitFor();
		assert.equal(await page.evaluate(() => document.documentElement.dataset.theme), "dark");
		await page.getByRole("button", { name: /^(새 프로젝트|New project)$/ }).click();
		await page.locator("#np-name").fill("Mangopang Studio 자동 검증");
		await page.getByRole("button", { name: /^(프로젝트 만들기|Create project)$/ }).click();
		await app.evaluate(
			({ dialog }, files) => {
				dialog.showOpenDialog = async (options) => ({
					canceled: false,
					filePaths: [options.filters?.[0]?.name === "Photos" ? files.photo : files.video],
				});
			},
			{
				photo: path.join(root, ".local/validation/photo 한글.png"),
				video: path.join(root, ".local/validation/full-video.mp4"),
			},
		);
		await page.getByLabel("사진 클립 길이 (초)", { exact: true }).fill("3.5");
		await page.getByRole("button", { name: "사진 추가", exact: true }).click();
		let doc = await savedDocument(
			(d) => d.timeline.clips.length === 1 && d.timeline.clips[0].sourceEndSec === 3.5,
		);
		console.log("PASS photo import: 3.5s, persisted clip");
		await page.getByRole("button", { name: "전체 영상 추가", exact: true }).click();
		doc = await savedDocument(
			(d) => d.timeline.clips.length === 2 && d.timeline.clips[1].sourceEndSec === 2,
		);
		assert.equal(doc.assets.length, 2);
		console.log("PASS full video import: 2s, previous photo retained");
		await page.getByRole("tab", { name: /^(편집|Edit)$/ }).click();
		await page.getByRole("button", { name: "직접 자막 추가", exact: true }).click();
		await page
			.getByRole("textbox", { name: "자막 내용", exact: true })
			.fill("사진과 영상 위에 직접 넣은 자막");
		await page.getByLabel("자막 시작 (초)", { exact: true }).fill("0.5");
		await page.getByLabel("자막 길이 (초)", { exact: true }).fill("4.5");
		await page.getByRole("button", { name: "자막 추가", exact: true }).click();
		doc = await savedDocument((d) => d.annotations.length === 2);
		assert(
			doc.annotations.every(
				(a) =>
					a.content === "사진과 영상 위에 직접 넣은 자막" &&
					a.style.fontSize === 57 &&
					a.position.x === 7,
			),
		);
		console.log("PASS manual subtitle: text, size 57, two clip anchors saved");
		await page.screenshot({ path: path.join(root, ".local/validation/editor-project.png") });
		await app.close();
		app = await launch();
		page = await app.firstWindow();
		await page
			.getByText("Mangopang Studio 자동 검증", { exact: true })
			.first()
			.waitFor({ timeout: 30000 });
		console.log("PASS restart: saved project restored");
		await fs.writeFile(
			path.join(root, ".local/validation/ui-project.openscreen"),
			JSON.stringify(doc, null, 2),
		);
	} finally {
		await app.close();
	}
})().catch((error) => {
	console.error(error);
	process.exitCode = 1;
});

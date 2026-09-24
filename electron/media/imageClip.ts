import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, rename, rm, stat } from "node:fs/promises";
import path from "node:path";
import { resolveFfmpeg } from "./audioPeaks";

export const IMAGE_EXTENSIONS = ["png", "jpg", "jpeg", "webp", "bmp"];
export function imageClipArgs(input: string, duration: number, output: string): string[] {
	if (!Number.isFinite(duration) || duration < 0.5 || duration > 600)
		throw new Error("Photo duration must be between 0.5 and 600 seconds");
	return [
		"-hide_banner",
		"-loglevel",
		"error",
		"-nostdin",
		"-y",
		"-threads",
		"2",
		"-loop",
		"1",
		"-framerate",
		"30",
		"-i",
		input,
		"-t",
		String(duration),
		"-vf",
		"scale=w='min(1920,iw)':h='min(1080,ih)':force_original_aspect_ratio=decrease:force_divisible_by=2,setsar=1,format=yuv420p",
		"-an",
		"-c:v",
		"libopenh264",
		"-b:v",
		"6M",
		"-threads",
		"2",
		"-filter_threads",
		"1",
		"-movflags",
		"+faststart",
		output,
	];
}
let queue: Promise<unknown> = Promise.resolve();
/** Serial, content-addressed conversion; original images are read only. */
export function createImageClip(
	input: string,
	duration: number,
	cacheDir: string,
): Promise<string> {
	const work = queue.then(() => convert(input, duration, cacheDir));
	queue = work.catch(() => undefined);
	return work;
}
async function convert(input: string, duration: number, cacheDir: string): Promise<string> {
	imageClipArgs(input, duration, "validate.mp4");
	if (!IMAGE_EXTENSIONS.includes(path.extname(input).slice(1).toLowerCase()))
		throw new Error("Unsupported photo format");
	const source = await stat(input);
	if (!source.isFile() || source.size > 100 * 1024 * 1024)
		throw new Error("Choose a photo smaller than 100 MB");
	const hash = createHash("sha256").update(
		JSON.stringify({ step: "image-clip", version: 1, duration }),
	);
	for await (const chunk of createReadStream(input)) hash.update(chunk);
	await mkdir(cacheDir, { recursive: true });
	const output = path.join(cacheDir, hash.digest("hex") + ".mp4");
	if (
		await stat(output)
			.then((s) => s.size > 0)
			.catch(() => false)
	)
		return output;
	const ffmpeg = resolveFfmpeg();
	if (!ffmpeg)
		throw new Error(
			"Photo import requires the bundled FFmpeg. Run the Donqui Studio runtime setup first.",
		);
	const temporary = path.join(cacheDir, randomUUID() + ".tmp.mp4");
	try {
		await new Promise<void>((resolve, reject) => {
			const child = spawn(ffmpeg, imageClipArgs(input, duration, temporary), {
				windowsHide: true,
				stdio: ["ignore", "ignore", "pipe"],
			});
			let stderr = "";
			let timedOut = false;
			const timer = setTimeout(
				() => {
					timedOut = true;
					child.kill();
				},
				60 * 60 * 1000,
			);
			child.stderr.on("data", (chunk) => {
				stderr = (stderr + String(chunk)).slice(-8192);
			});
			child.once("error", (error) => {
				clearTimeout(timer);
				reject(error);
			});
			child.once("close", (code) => {
				clearTimeout(timer);
				if (code === 0 && !timedOut) resolve();
				else
					reject(
						new Error(
							timedOut
								? "Photo conversion timed out after 60 minutes"
								: "Photo conversion failed: " + stderr,
						),
					);
			});
		});
		if ((await stat(temporary)).size === 0)
			throw new Error("Photo conversion produced an empty file");
		await rename(temporary, output);
		return output;
	} finally {
		await rm(temporary, { force: true });
	}
}

// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type AxcutDocument, createEmptyDocument } from "@/lib/ai-edition/schema";
import { enqueueDocumentWrite } from "@/lib/ai-edition/store/documentWriteQueue";
import { useProjectStore } from "@/lib/ai-edition/store/projectStore";
import { MediaClipBuilder } from "./MediaClipBuilder";

vi.mock("@/lib/ai-edition/timeline/duration", () => ({
	probeVideoDuration: vi.fn(async () => 10),
	probeVideoDimensions: vi.fn(async () => ({ width: 640, height: 360 })),
}));
vi.mock("./ClipPreview", () => ({
	ClipPreview: (props: { effect: string; startMs: number; endMs: number }) => (
		<div data-testid="clip-preview">
			{props.effect}:{props.startMs}:{props.endMs}
		</div>
	),
}));
vi.mock("sonner", () => ({ toast: { success: vi.fn() } }));
const asset = {
	id: "source",
	kind: "video" as const,
	label: "Source",
	originalPath: "C:/source.mp4",
	cameraTrack: null,
};
const renderClip = vi.fn();
const addAsset = vi.fn();
const onAdd = vi.fn(async () => undefined);
const originalStore = useProjectStore.getState();

beforeEach(() => {
	vi.clearAllMocks();
	useProjectStore.setState({
		projectId: "p",
		document: createEmptyDocument({ projectId: "p", title: "test" }),
		addAsset,
	});
	Object.defineProperty(window, "electronAPI", {
		configurable: true,
		value: { createClipEffect: renderClip },
	});
	renderClip.mockResolvedValue({ success: true, filePath: "C:/derived.mp4" });
	addAsset.mockResolvedValue({ ...asset, id: "derived" });
});
afterEach(() => {
	cleanup();
	useProjectStore.setState(originalStore);
});

async function mount() {
	render(<MediaClipBuilder asset={asset} onAddToTimeline={onAdd} />);
	await waitFor(() =>
		expect((screen.getByLabelText("클립 끝 (초)") as HTMLInputElement).value).toBe("10"),
	);
}

describe("MediaClipBuilder", () => {
	it("creates a trimmed clip without requiring audio", async () => {
		await mount();
		fireEvent.change(screen.getByLabelText("클립 시작 (초)"), { target: { value: "2" } });
		fireEvent.change(screen.getByLabelText("클립 끝 (초)"), { target: { value: "5" } });
		fireEvent.click(screen.getByRole("button", { name: "클립 만들고 타임라인에 추가" }));
		await waitFor(() => expect(onAdd).toHaveBeenCalledWith("derived"));
		expect(renderClip).toHaveBeenCalledWith(
			expect.objectContaining({ startMs: 2000, endMs: 5000, effect: "none" }),
		);
	});
	it("uses the same random effect for preview and generated output", async () => {
		await mount();
		fireEvent.change(screen.getByLabelText("Remotion 효과"), { target: { value: "random" } });
		fireEvent.click(screen.getByRole("button", { name: "클립 미리보기" }));
		const effect = screen.getByTestId("clip-preview").textContent?.split(":")[0];
		fireEvent.click(screen.getByRole("button", { name: "클립 만들고 타임라인에 추가" }));
		await waitFor(() => expect(onAdd).toHaveBeenCalled());
		expect(renderClip).toHaveBeenCalledWith(expect.objectContaining({ effect }));
		expect(effect).not.toBe("random");
	});
	it("does not add a failed render to the project", async () => {
		renderClip.mockResolvedValue({ success: false, error: "Unable to render source" });
		await mount();
		fireEvent.click(screen.getByRole("button", { name: "클립 만들고 타임라인에 추가" }));
		await screen.findByText("Unable to render source");
		expect(addAsset).not.toHaveBeenCalled();
		expect(onAdd).not.toHaveBeenCalled();
	});
	it("discards stale results after a project switch", async () => {
		let finish!: (result: { success: boolean; filePath: string }) => void;
		renderClip.mockImplementation(
			() =>
				new Promise((resolve) => {
					finish = resolve;
				}),
		);
		await mount();
		fireEvent.click(screen.getByRole("button", { name: "클립 만들고 타임라인에 추가" }));
		await act(async () => {
			useProjectStore.setState({ projectId: "other" });
			finish({ success: true, filePath: "C:/derived.mp4" });
		});
		expect(addAsset).not.toHaveBeenCalled();
	});
	it("disables invalid source ranges", async () => {
		await mount();
		fireEvent.change(screen.getByLabelText("클립 끝 (초)"), { target: { value: "12" } });
		expect(
			(screen.getByRole("button", { name: "클립 만들고 타임라인에 추가" }) as HTMLButtonElement)
				.disabled,
		).toBe(true);
	});
	it("preserves a concurrent import when saving the rendered duration", async () => {
		let release!: () => void;
		const blocked = enqueueDocumentWrite(
			() =>
				new Promise<void>((resolve) => {
					release = resolve;
				}),
		);
		await Promise.resolve();
		const document = createEmptyDocument({ projectId: "p", title: "test" });
		document.assets = [{ ...asset, id: "derived" }];
		const save = vi.fn(async (next: AxcutDocument) => {
			useProjectStore.setState({ document: next });
			return true;
		});
		useProjectStore.setState({ document, saveDocument: save });
		await mount();
		fireEvent.click(screen.getByRole("button", { name: "클립 만들고 타임라인에 추가" }));
		await waitFor(() => expect(addAsset).toHaveBeenCalled());
		expect(save).not.toHaveBeenCalled();
		await act(async () => {
			useProjectStore.setState({
				document: { ...document, assets: [...document.assets, { ...asset, id: "another-import" }] },
			});
			release();
			await blocked;
		});
		await waitFor(() => expect(onAdd).toHaveBeenCalledWith("derived"));
		expect(save.mock.calls[0][0].assets.map((item) => item.id)).toEqual([
			"derived",
			"another-import",
		]);
		expect(save.mock.calls[0][0].assets[0].durationSec).toBe(10);
	});
});

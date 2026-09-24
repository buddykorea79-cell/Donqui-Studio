// @vitest-environment jsdom
import "@testing-library/jest-dom";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { I18nProvider } from "@/contexts/I18nContext";
import { LOCALE_STORAGE_KEY } from "@/i18n/config";
import {
	type AxcutAsset,
	type AxcutDocument,
	createAudioTrack,
	createEmptyDocument,
} from "@/lib/ai-edition/schema";
import { useProjectStore } from "@/lib/ai-edition/store/projectStore";
import {
	addBoardImages,
	addBoardItems,
	boardOf,
	clipItem,
	itemDurationSec,
	upsertBoardClips,
} from "@/lib/media-board/board";
import { useComposeStore } from "@/lib/media-board/store";
import { MediaStage } from "./MediaStage";

const mocks = vi.hoisted(() => ({
	toast: { success: vi.fn(), error: vi.fn(), warning: vi.fn(), info: vi.fn() },
}));
vi.mock("sonner", () => ({ toast: mocks.toast }));
vi.mock("@/native/client", () => ({ nativeBridgeClient: { aiEdition: {} } }));
vi.mock("./ClipPreview", () => ({
	ClipPreview: (props: { effect: string; sourceKind?: string; startMs: number; endMs: number }) => (
		<div data-testid="clip-preview">
			{props.sourceKind ?? "video"}:{props.effect}:{props.startMs}:{props.endMs}
		</div>
	),
}));
vi.mock("@/lib/media-board/apply", async (importOriginal) => ({
	...(await importOriginal<typeof import("@/lib/media-board/apply")>()),
	readImageSize: vi.fn(async () => ({ width: 4000, height: 3000 })),
}));

const drone: AxcutAsset = {
	id: "drone",
	kind: "video",
	label: "DJI_0017.MP4",
	originalPath: "C:/footage/DJI_0017.MP4",
	durationSec: 60,
	video: { codec: "hevc", fps: 29.97, width: 3840, height: 2160 },
	cameraTrack: null,
};
const api = {
	openImageFilesPicker: vi.fn(),
	openVideoFilesPicker: vi.fn(),
	vclipThumbnail: vi.fn(),
	vclipProbe: vi.fn(),
};
const save = vi.fn(async (document: AxcutDocument, _options: { history: boolean }) => {
	useProjectStore.setState({ document });
	return true;
});
const apply = vi.fn(async () => undefined);
const onAddToTimeline = vi.fn(async () => undefined);
const onOpenInVClip = vi.fn();
const initialProject = useProjectStore.getState();
const initialCompose = useComposeStore.getState();

/** Two clips split in V.Clip and 12 s of music. */
function project(): AxcutDocument {
	const document = {
		...createEmptyDocument({ projectId: "p", title: "Media" }),
		assets: [drone],
		audioTracks: [
			{
				...createAudioTrack({ assetId: "music", durationSec: 12, kind: "music" as const }),
				timelineLocked: true,
			},
		],
	};
	return upsertBoardClips(document, [
		{
			assetId: "drone",
			startSec: 10,
			endSec: 15,
			label: "DJI · 0:10.0–0:15.0",
			note: "절벽을 돌아",
		},
		{ assetId: "drone", startSec: 0, endSec: 4, label: "DJI · 0:00.0–0:04.0", score: 88 },
	]).document;
}

function board() {
	return boardOf(useProjectStore.getState().document);
}

function renderMedia() {
	return render(
		<I18nProvider>
			<MediaStage onAddToTimeline={onAddToTimeline} onOpenInVClip={onOpenInVClip} />
		</I18nProvider>,
	);
}

const composition = () => screen.getByRole("region", { name: "조합" });

beforeEach(() => {
	vi.clearAllMocks();
	localStorage.clear();
	localStorage.setItem(LOCALE_STORAGE_KEY, "ko-KR");
	useProjectStore.setState({ projectId: "p", document: project(), saveDocument: save });
	useComposeStore.setState({ ...initialCompose, applying: null, apply });
	Object.defineProperty(window, "electronAPI", { configurable: true, value: api });
	api.vclipThumbnail.mockResolvedValue({ success: true, dataUrl: "data:image/jpeg;base64,AA==" });
});
afterEach(() => {
	cleanup();
	useProjectStore.setState(initialProject);
	useComposeStore.setState(initialCompose);
});

describe("Media's library", () => {
	it("opens on V.Clip's clips, in filmed order, and composes them with the chosen effect", async () => {
		renderMedia();
		expect(screen.getByRole("tab", { name: /V\.Clip 클립 2/ })).toHaveAttribute(
			"aria-selected",
			"true",
		);
		const cards = screen.getAllByRole("article");
		expect(within(cards[0]).getByText("0:00.0–0:04.0")).toBeInTheDocument();
		expect(within(cards[1]).getByText("절벽을 돌아")).toBeInTheDocument();

		fireEvent.change(screen.getByLabelText("새 항목 효과"), { target: { value: "zoom-in" } });
		fireEvent.click(screen.getByRole("button", { name: /모두 조합에 넣기/ }));
		await waitFor(() => expect(board().items).toHaveLength(2));
		expect(board().items.map((item) => [item.startSec, item.effect])).toEqual([
			[0, "zoom-in"],
			[10, "zoom-in"],
		]);
		expect(localStorage.getItem("donqui.media.defaultEffect")).toBe("zoom-in");
		expect(within(composition()).getAllByRole("listitem")).toHaveLength(2);
	});

	it("adds photos by their original files, sized, and composes them at the photo length", async () => {
		api.openImageFilesPicker.mockResolvedValue({
			success: true,
			files: [{ path: "C:/photos/sea.jpg", name: "sea.jpg" }],
			rejected: [],
		});
		renderMedia();
		fireEvent.click(screen.getByRole("tab", { name: /사진 0/ }));
		fireEvent.click(screen.getByRole("button", { name: "사진 추가" }));
		await waitFor(() => expect(board().images).toHaveLength(1));
		expect(board().images[0]).toMatchObject({
			path: "C:/photos/sea.jpg",
			label: "sea.jpg",
			width: 4000,
			height: 3000,
		});
		fireEvent.change(screen.getByLabelText("사진 길이 (초)"), { target: { value: "3.5" } });
		fireEvent.click(screen.getByRole("button", { name: "조합에 넣기" }));
		await waitFor(() => expect(board().items).toHaveLength(1));
		expect(board().items[0]).toMatchObject({ kind: "image", startSec: 0, endSec: 3.5 });
	});

	it("hands a video to V.Clip, and puts a whole one in the composition", async () => {
		renderMedia();
		fireEvent.click(screen.getByRole("tab", { name: /영상 1/ }));
		fireEvent.click(screen.getByRole("button", { name: "DJI_0017.MP4 V.Clip에서 나누기" }));
		expect(onOpenInVClip).toHaveBeenCalledWith("drone");
		fireEvent.click(screen.getByRole("button", { name: /전체 넣기/ }));
		await waitFor(() => expect(board().items).toHaveLength(1));
		expect(board().items[0]).toMatchObject({ kind: "video", startSec: 0, endSec: 60 });
	});
});

describe("Media's composition", () => {
	function composed() {
		const document = project();
		const clips = boardOf(document).clips;
		const photos = addBoardImages(document, [
			{ path: "C:/photos/sea.jpg", label: "sea.jpg", width: 4000, height: 3000 },
		]);
		useProjectStore.setState({
			document: addBoardItems(photos.document, [
				clipItem(clips[1], { effect: "none" }),
				clipItem(clips[0], { effect: "random", seed: "fixed" }),
			]),
		});
	}

	it("changes an item's length, effect and place", async () => {
		composed();
		renderMedia();
		const length = screen.getByLabelText("1번 길이 (초)");
		fireEvent.change(length, { target: { value: "6" } });
		fireEvent.blur(length);
		await waitFor(() => expect(board().items[0]).toMatchObject({ startSec: 0, endSec: 6 }));

		fireEvent.change(screen.getByLabelText("2번 효과"), { target: { value: "pan-left" } });
		await waitFor(() => expect(board().items[1].effect).toBe("pan-left"));

		fireEvent.click(screen.getByRole("button", { name: "2번 위로" }));
		await waitFor(() => expect(board().items[0].startSec).toBe(10));
		fireEvent.click(screen.getByRole("button", { name: "1번 빼기" }));
		await waitFor(() => expect(board().items).toHaveLength(1));
		expect(save.mock.calls.every((call) => call[1].history)).toBe(true);
	});

	it("previews an item with the effect it will be rendered with", async () => {
		composed();
		renderMedia();
		fireEvent.click(screen.getByRole("button", { name: "1번 미리보기" }));
		expect(screen.getByTestId("clip-preview")).toHaveTextContent("video:none:0:4000");
		fireEvent.click(screen.getByRole("button", { name: "1번 미리보기" }));
		expect(screen.queryByTestId("clip-preview")).toBeNull();
	});

	it("fits the composition to the audio", async () => {
		composed();
		renderMedia();
		expect(within(composition()).getByText("0:03.0 모자람")).toBeInTheDocument();
		fireEvent.click(screen.getByRole("button", { name: "Audio 길이에 맞추기" }));
		await waitFor(() =>
			expect(board().items.reduce((sum, item) => sum + itemDurationSec(item), 0)).toBeCloseTo(12),
		);
		// 4 s and 5 s stretched together to 12 s.
		const [first, second] = board().items.map(itemDurationSec);
		expect(first).toBeCloseTo(5.333, 3);
		expect(second).toBeCloseTo(6.667, 3);
		expect(mocks.toast.success).toHaveBeenCalledWith(
			"조합을 Audio 길이 0:12.0에 맞췄습니다.",
			undefined,
		);
		expect(await within(composition()).findByText("길이가 맞습니다")).toBeInTheDocument();
	});

	it("says so when the clips can only cover the audio by showing the same footage", async () => {
		composed();
		const current = useProjectStore.getState().document;
		if (!current) throw new Error("no document");
		// A 16 s video leaves the two clips 16 s of footage between them, short of 20 s of music.
		useProjectStore.setState({
			document: {
				...current,
				assets: [{ ...drone, durationSec: 16 }],
				audioTracks: [
					{
						...createAudioTrack({ assetId: "music", durationSec: 20, kind: "music" as const }),
						timelineLocked: true,
					},
				],
			},
		});
		renderMedia();
		fireEvent.click(screen.getByRole("button", { name: "Audio 길이에 맞추기" }));
		await waitFor(() =>
			expect(board().items.reduce((sum, item) => sum + itemDurationSec(item), 0)).toBeCloseTo(20),
		);
		expect(mocks.toast.success).not.toHaveBeenCalled();
		expect(mocks.toast.warning).toHaveBeenCalledWith("조합을 Audio 길이 0:20.0에 맞췄습니다.", {
			description: expect.stringContaining("같은 장면을 다시 씁니다"),
		});
	});

	it("offers cuts on the narration's pauses once it is transcribed", () => {
		const document = project();
		document.audioTracks.push({
			...createAudioTrack({ assetId: "voice", durationSec: 10, kind: "voiceover" }),
			timelineLocked: true,
		});
		document.transcripts = [
			{
				assetId: "voice",
				language: "ko",
				segments: [],
				words: [
					{ id: "a", segmentId: "s", startSec: 1, endSec: 2, text: "안녕" },
					{ id: "b", segmentId: "s", startSec: 3, endSec: 4, text: "하세요" },
				],
			},
		];
		useProjectStore.setState({ document });
		renderMedia();
		// Before the first word, between the two, and after the last.
		expect(screen.getByLabelText(/나레이션이 쉬는 곳에 컷 맞추기 \(3곳\)/)).toBeChecked();
	});

	it("applies straight onto an empty timeline, and asks before replacing a full one", async () => {
		composed();
		const { unmount } = renderMedia();
		fireEvent.click(screen.getByRole("button", { name: /타임라인에 적용/ }));
		expect(apply).toHaveBeenCalledWith("replace");
		unmount();

		const document = useProjectStore.getState().document as AxcutDocument;
		useProjectStore.setState({
			document: {
				...document,
				timeline: {
					...document.timeline,
					clips: [
						{
							id: "old",
							assetId: "drone",
							sourceStartSec: 0,
							sourceEndSec: 3,
							timelineStartSec: 0,
							timelineEndSec: 3,
							wordRefs: [],
							origin: "user",
							reason: "",
						},
					],
				},
			},
		});
		apply.mockClear();
		renderMedia();
		fireEvent.click(screen.getByRole("button", { name: /타임라인에 적용/ }));
		expect(apply).not.toHaveBeenCalled();
		const confirm = screen.getByRole("alertdialog", { name: "타임라인 바꾸기" });
		expect(within(confirm).getByText(/클립 1개를 이 조합으로 바꿉니다/)).toBeInTheDocument();
		fireEvent.click(within(confirm).getByRole("button", { name: "바꾸기" }));
		expect(apply).toHaveBeenCalledWith("replace");
		fireEvent.click(screen.getByRole("button", { name: "타임라인 끝에 추가" }));
		expect(apply).toHaveBeenLastCalledWith("append");
	});

	it("shows the renders in progress and stops them on request", () => {
		composed();
		const cancel = vi.fn();
		useComposeStore.setState({
			applying: { mode: "replace", done: 1, total: 3, label: "sea.jpg" },
			cancel,
		});
		renderMedia();
		expect(screen.getByText("렌더링 2 / 3 · sea.jpg")).toBeInTheDocument();
		expect(screen.getByLabelText("1번 효과")).toBeDisabled();
		fireEvent.click(screen.getByRole("button", { name: /멈추기/ }));
		expect(cancel).toHaveBeenCalled();
	});
});

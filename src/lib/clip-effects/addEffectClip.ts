import { enqueueDocumentWrite } from "@/lib/ai-edition/store/documentWriteQueue";
import { useProjectStore } from "@/lib/ai-edition/store/projectStore";
import { currentWriteEpoch } from "@/lib/ai-edition/store/undoStack";
import type { ClipEffectId } from "./catalog";

export interface EffectClipRequest {
	sourcePath: string;
	startMs: number;
	endMs: number;
	effect: ClipEffectId;
	/** The source's picture size; the render keeps its aspect ratio. */
	width: number;
	height: number;
	/** Name of the new asset in the media list. */
	label: string;
}

/**
 * Renders one clip, adds it to the project's media and records the length and size the
 * render actually produced. Resolves to the new asset's id — or null when a project switch
 * or an undo superseded the work while it was rendering, in which case nothing is kept.
 */
export async function addEffectClip(request: EffectClipRequest): Promise<string | null> {
	const projectId = useProjectStore.getState().projectId;
	if (!projectId) throw new Error("프로젝트를 먼저 열어 주세요.");
	const epoch = currentWriteEpoch();
	const superseded = () =>
		useProjectStore.getState().projectId !== projectId || currentWriteEpoch() !== epoch;
	const create = window.electronAPI?.createClipEffect;
	if (!create) throw new Error("클립 만들기는 Donqui Studio 데스크톱 앱에서 사용할 수 있습니다.");
	const { label, ...render } = request;
	const result = await create(render);
	if (!result.success || !result.filePath)
		throw new Error(result.error || "클립을 만들지 못했습니다.");
	if (superseded()) return null;
	const created = await useProjectStore.getState().addAsset(result.filePath, label);
	if (!created) throw new Error("만든 클립을 프로젝트에 저장하지 못했습니다.");
	if (superseded()) return null;
	const saved = await enqueueDocumentWrite(async () => {
		if (superseded()) return false;
		const state = useProjectStore.getState();
		if (!state.document?.assets.some((item) => item.id === created.id)) return true;
		return state.saveDocument(
			{
				...state.document,
				assets: state.document.assets.map((item) =>
					item.id === created.id
						? {
								...item,
								durationSec: (result.durationMs ?? request.endMs - request.startMs) / 1000,
								video: {
									codec: "h264",
									fps: 30,
									width: result.width ?? request.width,
									height: result.height ?? request.height,
								},
							}
						: item,
				),
			},
			{ history: false },
		);
	});
	if (superseded()) return null;
	if (!saved) throw new Error("클립 길이를 저장하지 못했습니다.");
	return created.id;
}

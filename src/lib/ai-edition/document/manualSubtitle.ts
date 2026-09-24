import { type AxcutDocument, annotationRegionSchema } from "../schema";
import { anchorRegionsWithDerivedMs } from "../timeline/timelineMap";
import { createId } from "./ids";
export interface ManualSubtitleInput {
	text: string;
	startSec: number;
	endSec: number;
}
/** User text is an authored overlay, independent of ASR regeneration. */
export function addManualSubtitle(doc: AxcutDocument, input: ManualSubtitleInput): AxcutDocument {
	const { startSec, endSec } = input;
	if (!input.text.trim()) throw new Error("자막 내용을 입력해 주세요.");
	if (!Number.isFinite(startSec) || !Number.isFinite(endSec) || startSec < 0 || endSec <= startSec)
		throw new Error("자막 시작·종료 시간을 확인해 주세요.");
	const end = Math.max(0, ...doc.timeline.clips.map((c) => c.timelineEndSec));
	if (
		startSec >= end ||
		!doc.timeline.clips.some((c) => c.timelineStartSec < endSec && c.timelineEndSec > startSec)
	)
		throw new Error("자막을 넣을 클립을 먼저 추가해 주세요.");
	const region = annotationRegionSchema.parse({
		id: createId("subtitle"),
		type: "text",
		content: input.text.trim(),
		startMs: Math.round(startSec * 1000),
		endMs: Math.round(Math.min(endSec, end) * 1000),
		position: { x: 7, y: 80 },
		size: { width: 86, height: 16 },
		style: {
			fontSize: 57,
			fontFamily: "Malgun Gothic",
			fontWeight: "normal",
			color: "#ffffff",
			backgroundColor: "#181b20",
			textAlign: "center",
		},
		zIndex: Math.max(0, ...doc.annotations.map((a) => a.zIndex)) + 1,
	});
	const regions = anchorRegionsWithDerivedMs([region], doc.timeline.clips, () =>
		createId("subtitle"),
	);
	return { ...doc, annotations: [...doc.annotations, ...regions] };
}

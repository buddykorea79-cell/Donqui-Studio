import { useState } from "react";
import { toast } from "sonner";
import type { ManualSubtitleInput } from "@/lib/ai-edition/document/manualSubtitle";
import { useProjectStore } from "@/lib/ai-edition/store/projectStore";
import styles from "./EditorShellV4.module.css";
export function ManualSubtitlePane({
	onAdd,
}: {
	onAdd: (input: ManualSubtitleInput) => Promise<void>;
}) {
	const [text, setText] = useState("");
	const [start, setStart] = useState(() => useProjectStore.getState().currentTimeSec);
	const [duration, setDuration] = useState(5);
	const [busy, setBusy] = useState(false);
	const hasClips = useProjectStore((s) => Boolean(s.document?.timeline.clips.length));
	const field = {
		width: "100%",
		border: "1px solid var(--border)",
		borderRadius: 8,
		padding: 8,
		background: "var(--surface-2)",
		color: "var(--fg)",
	};
	return (
		<div style={{ padding: 16, display: "grid", gap: 14 }}>
			<h2 style={{ fontSize: 15, margin: 0 }}>직접 자막 추가</h2>
			<p style={{ color: "var(--muted)", margin: 0 }}>
				사진과 영상에 자막을 넣습니다. 추가한 자막은 타임라인에서 선택하여 수정할 수 있습니다.
			</p>
			<label>
				자막 내용
				<textarea
					aria-label="자막 내용"
					value={text}
					onChange={(e) => setText(e.target.value)}
					rows={4}
					style={field}
				/>
			</label>
			<label>
				시작 (초)
				<input
					aria-label="자막 시작 (초)"
					type="number"
					min={0}
					step={0.1}
					value={start}
					onChange={(e) => setStart(Number(e.target.value))}
					style={field}
				/>
			</label>
			<button
				type="button"
				className={styles.importBtn}
				onClick={() => setStart(useProjectStore.getState().currentTimeSec)}
			>
				현재 재생 위치 사용
			</button>
			<label>
				길이 (초)
				<input
					aria-label="자막 길이 (초)"
					type="number"
					min={0.1}
					step={0.1}
					value={duration}
					onChange={(e) => setDuration(Number(e.target.value))}
					style={field}
				/>
			</label>
			<button
				type="button"
				className={styles.importBtn}
				disabled={
					busy ||
					!hasClips ||
					!text.trim() ||
					!Number.isFinite(start) ||
					start < 0 ||
					!Number.isFinite(duration) ||
					duration <= 0
				}
				onClick={async () => {
					if (busy) return;
					setBusy(true);
					try {
						await onAdd({ text, startSec: start, endSec: start + duration });
						setText("");
						toast.success("자막을 추가했습니다.");
					} catch (error) {
						toast.error(error instanceof Error ? error.message : String(error));
					} finally {
						setBusy(false);
					}
				}}
			>
				{busy ? "저장 중…" : "자막 추가"}
			</button>
			<p style={{ color: "var(--muted)", margin: 0 }}>
				기본 크기 57 · 음성 인식 없이 사용 · MP4에 포함
			</p>
		</div>
	);
}

# Donqui Studio

OpenScreen을 기반으로 만든 음악·나레이션 중심의 사진·영상 편집 데스크톱 프로젝트입니다. 당나귀 마스코트, 차콜/청록 색상과 한국어 시작 화면을 사용합니다.

![Donqui Studio](public/donqui.png)

## 실행

의존성과 Windows 네이티브 구성요소를 준비하고 `npm run build-vite`를 실행한 뒤 이 폴더의 `start-donqui.cmd`를 더블클릭합니다. 기존 `start-mangopang.cmd` 바로가기도 새 실행기로 연결됩니다. 네이티브 구성요소의 준비 방법은 [AGENTS.md](AGENTS.md)를 확인하세요.

개발 모드는 Node 22.22.1 / npm 10.9.4에서 `npm run dev`로 시작합니다. 코드를 수정한 후 일반 실행에 반영하려면 `npm run build-vite`를 실행합니다.

## 사용 순서

1. 상단 **새 프로젝트**로 이름을 정한 뒤 **Audio** 탭에 음악이나 나레이션을 먼저 추가할 수 있습니다. 오디오 없이 사진·영상만으로 시작해도 됩니다.
2. **Media** 탭에서 **사진 추가** 또는 **전체 영상 추가**를 누릅니다. 사진 길이는 0.5~600초로 지정할 수 있고 기본은 5초입니다.
3. 기본적으로 소스를 보관함에 가져옵니다. **가져온 미디어를 전체 클립으로 타임라인에 추가**를 켜면 원본 전체를 바로 배치합니다. 소스를 선택하면 오른쪽에 구간·효과·미리보기가 열립니다.
4. 클립 시작·끝을 지정합니다. **남은 Audio 길이에 맞추기**는 이미 배치한 영상의 실제 재생 길이를 제외한 음원 길이에 맞추며, 소스 끝을 넘기지 않습니다. 부족한 길이는 다음 소재로 채웁니다. 한 번에 만들 수 있는 클립은 0.1초~10분입니다.
5. **Remotion 효과**에서 줌 인·줌 아웃·상하좌우 이동·페이드·슬라이드·떠오르기·시네마틱 틸트 중 선택합니다. **효과 없음**이 기본이며 **랜덤 적용**을 선택하면 선택된 효과를 표시합니다. **다시 선택**을 누르기 전까지 미리보기와 클립 만들기는 같은 효과를 사용합니다.
6. **클립 미리보기**로 재생·탐색한 뒤 **클립 만들고 타임라인에 추가**를 누릅니다. 효과를 합성한 새 MP4가 저장되어 재시작·내보내기에서도 유지됩니다. 기존 클립은 **편집 → 클립 편집**에서 추가로 자르거나 이동·복제·삭제할 수 있습니다. **직접 자막 추가**에서는 수동 자막을 별도로 저장합니다.
7. **내보내기**에서 MP4를 선택합니다. 사진과 영상, 오디오, 수동 자막이 함께 출력됩니다.

## 저장과 안정성

- 원본 사진·영상은 수정하지 않습니다. 사진은 앱 데이터 폴더의 `media/image-clips`에 파생 MP4를 만듭니다. 이 폴더의 파일도 프로젝트에 필요한 미디어이므로 임의로 삭제하지 마세요.
- 사진 변환은 한 번에 하나씩, FFmpeg CPU 스레드 2개로 처리합니다. 제한은 60분이며 내용 해시+변환 버전+길이로 결과를 재사용합니다. 임시 파일은 성공한 경우에만 완성 파일로 바뀝니다.
- Audio 탭으로 가져온 음악·나레이션은 영상 편집과 독립된 시간에 고정됩니다. 영상 클립을 줄이거나 재배치해도 음원 길이는 보존됩니다. 최종 영상 길이는 배치한 영상 클립으로 정해지므로 Audio 길이까지 화면을 채워 주세요.
- Remotion 클립은 앱 데이터의 `media/clip-effects`에 보관하며 원본 내용·효과·구간·버전으로 캐시합니다. 첫 생성에는 렌더 시간이 필요합니다. 효과 출력은 최대 1080p(세로형 포함), 30fps입니다.
- 효과 렌더링에는 설치된 Chrome 또는 Edge가 필요합니다. 별도 위치의 브라우저는 `DONQUI_CHROME_PATH`로 지정할 수 있으며 렌더 중 자동 다운로드는 하지 않습니다. `npm run build-vite`와 `npm run dev`가 전용 효과 번들을 준비합니다.
- 이름을 바꿔도 기존 프로젝트·설정·사진 파생 클립을 계속 찾도록 OS 앱 데이터 폴더 아래 `MangopangStudio` 경로를 유지합니다. 원본 OpenScreen 및 AutoVeo와 분리됩니다. 개발용 분리 프로필은 `DONQUI_USER_DATA`로 지정하며, 기존 `MANGOPANG_USER_DATA`도 지원합니다.
- 테마는 기존 `mangopang-theme` 값을 읽어 `donqui-theme`에 보존합니다. `.openscreen` 프로젝트 파일 형식은 그대로 사용합니다.
- OpenScreen 업데이트로 이 프로젝트가 덮어써지지 않도록 원본 자동 업데이트 채널을 비활성화했습니다.
- Windows/macOS/Linux용 당나귀 아이콘과 패키징 설정을 포함합니다. 설치 프로그램과 각 운영체제의 네이티브 기능은 별도 빌드·검증이 필요합니다.

## 개발/검증

```text
npm ci
npm run build-vite
npx tsc --noEmit
npx tsc -p tsconfig.test.json --noEmit
npm run lint
npm run test -- --maxWorkers=2
npm run i18n:check
npm run docs:check
```

외부 미디어 검증은 PowerShell에서 아래 순서로 실행합니다.

```powershell
$env:MANGOPANG_INTEGRATION = '1'
npx vitest run electron/media/imageClip.test.ts src/lib/ai-edition/document/manualSubtitle.test.ts --maxWorkers=2
Remove-Item Env:MANGOPANG_INTEGRATION
node scripts/donqui-smoke.cjs
```

검증 산출물과 로그는 `.local/`에 저장합니다. 자동 UI 검증은 별도 프로필을 사용하며, 파일 선택 대화상자만 테스트 파일로 대체합니다. 실제 OS 대화상자·녹화·웹캠·트레이를 검증한 것으로 간주하지 않습니다.

이번 변경의 검증 범위와 결과는 [DONQUI-VALIDATION.md](DONQUI-VALIDATION.md)를 확인하세요.

현재는 개발 실행본입니다. 설치 프로그램은 아직 제작하지 않았습니다. 네이티브 소스 변경/설치 패키지 제작에는 upstream의 Windows C++/Rust 빌드 절차와 검증이 필요합니다.

## 기반과 다음 범위

- 기반: OpenScreen 소스와 기존 Mangopang Studio의 사진·영상·수동 자막 편집 기능입니다.
- 네이티브 파일은 소스와 맞는 전체 묶음을 준비해야 합니다. `npm run dev`와 `npm run build-vite`는 네이티브 파일을 컴파일하지 않습니다.
- AutoVeo의 AI 장면 추천, 그룹 자동 구성, 음성 생성 등 전체 기능 통합은 별도 개발 범위입니다.
- 원본 안내는 [README.openscreen.md](README.openscreen.md), 저작권/라이선스는 [LICENSE](LICENSE), 외부 구성요소 고지는 [THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md)를 확인하세요.

## 아이콘 편집

원본은 `public/donqui.svg`입니다. `scripts/generate-donqui-icons.cjs`는 sharp로 PNG·ICO·ICNS와 렌더러 로고를 생성하고, `npm run assets:appx`는 Windows 타일을 생성합니다. sharp를 별도 설치한 경우 `DONQUI_SHARP_MODULE`에 모듈 경로를 지정할 수 있습니다. 기존 OpenScreen 아이콘과 저작권 고지는 보존합니다.

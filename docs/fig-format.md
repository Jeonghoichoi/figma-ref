# `.fig` 포맷 분석 노트 (2단계)

상태 표기: ✅ 검증됨 · 🟡 가설 · ❌ 가설 기각 · ⏳ 수동 확인 필요

> 분석 대상은 사용자가 직접 내보낸(Save local copy) 파일로 한정한다.
> 검증 샘플 (2026-10-28 분석, 둘 다 `fig-kiwi` v106):
> - `fixtures/sample.fig`: 16 MB, 노드 22개 (이미지 5개, 별 1개)
> - `fixtures/sample222.fig`: 노드 37개. 위 파일에 "Frame 4"를 추가한 것 (펜 곡선, 그라디언트, 오토 레이아웃, 컴포넌트, 그룹, 꺾은선)
> - `fixtures/sample333.fig`: 노드 53개. "Frame 5" 추가 (선, 불리언 연산, 컴포넌트 세트, 드롭 섀도)
> 회귀 테스트: [real-files.test.ts](../packages/fig-format/test/real-files.test.ts). `fixtures/*.fig`에 있는 모든 파일에 대해 실행된다.

## 1. 컨테이너

| 항목 | 내용 | 상태 |
|---|---|---|
| ZIP 래퍼 | `canvas.fig`, `meta.json`, `thumbnail.png`, `images/<hash>` | ✅ |
| raw 매직 | `fig-kiwi` | ✅ (`fig-jam.`은 🟡) |
| 버전 | 매직 직후 uint32 LE. 샘플은 **106** | ✅ |
| 청크 | `[uint32 LE 길이][바이트]`. 0 = 스키마, 1 = 메시지, 추가 청크 없음 | ✅ |
| 압축 | **스키마 = raw deflate, 메시지 = zstd** (청크마다 다름) | ✅ |
| `images/` 키 | 이미지 바이트의 SHA-1 hex (5/5 일치) | ✅ |
| `meta.json` | `file_name`, `client_meta.background_color`, `thumbnail_size`, `render_coordinates`, `exported_at` | ✅ |

## 2. Kiwi 인코딩

레퍼런스 구현과 바이트 단위 비교로 검증했고([oracle.test.ts](../packages/kiwi/test/oracle.test.ts)), 실제 파일(정의 666개)도 오류 없이 디코딩된다. ✅

| 타입 | 와이어 형식 |
|---|---|
| uint | LEB128, 최대 5바이트 |
| int | zigzag + LEB128 |
| float | float32 비트를 왼쪽으로 9비트 회전, 지수 바이트가 0이면 `0x00` 1바이트 |
| string | UTF-8 + NUL 종료 |
| int64/uint64 | BigInt LEB128, 최대 9바이트 |
| byte[] | 길이 varuint + 원시 바이트 |
| message | `[field id][value]...` + `0`, 스키마 순서로 기록 |
| struct | 모든 필드를 선언 순서로, 종료자 없음 |
| enum | varuint |

바이너리 스키마 구조: `varuint 정의 수` → 정의마다 (`이름`, `종류 byte`, `필드 수`) → 필드마다 (`이름`, `타입 varint`(음수 = 원시 타입), `isArray byte`, `값 varuint`)

### 발견 사항

- **float는 float32다.** `0.1`을 기록했다가 읽으면 `0.10000000149…`가 된다. 따라서 호환성 비교는 *한 번 디코딩한 값*을 기준으로 해야 한다.
- 비정규수와 `-0`은 0으로 바뀐다 (포맷 자체의 동작).
- 실제 스키마의 메시지 필드 ID는 공백 없이 1..N으로 연속된다. (`NodeChange`는 필드 622개, 최대 ID 622) ✅
- enum 멤버의 type varint는 의미가 없다 → 원본 값을 `rawType`으로 보존해서 스키마를 바이트 그대로 재현한다.

## 3. 메시지

```
Message { type: NODE_CHANGES, nodeChanges: NodeChange[], blobs: Blob[] }   ✅
```

### 트리

- `parentIndex { guid, position }` 하나로 트리를 만든다. 부모가 없는 노드는 `DOCUMENT` 하나뿐이다. ✅
- `DOCUMENT` 아래에 페이지(`CANVAS`)들이 오고, 숨겨진 `"Internal Only Canvas"` 페이지(`internalOnly: true`, position `"~"`)가 별도로 있다. ✅ → 에디터에서는 숨기고, 저장할 때는 보존한다.
- **`position` 알파벳 = 0x20(공백)..0x7E** ❌ 원래 가설(`!`..`~`)은 기각. 실제 키 `" }"`이 관찰되었다. 키는 단순 문자열 비교로 정렬된다. → `@figref/model` 분수 인덱스의 알파벳을 수정함.

### 노드 타입

- `NodeType` enum은 65개(`NONE`..`NATIVE_CODE_LAYER_INSTANCE`)다. 전체 목록은 `fixtures/out/sample/schema.kiwi`에 있다.
- **그룹이 `GROUP` 타입이 아니라 `FRAME` + `resizeToFit: true` + 채우기 없음으로 저장된다.** 🟡 (샘플의 "Group 1/2/3"이 모두 이 형태) → 매핑할 때 이 조합이면 그룹으로 취급한다.
- 이미지가 들어간 사각형은 `ROUNDED_RECTANGLE` 노드에 `IMAGE` 페인트가 붙은 형태다. ✅

### 별 (`STAR`) ✅

```
count: 5, starInnerScale: 0.381966 (= 1/φ², 기본값), size: 389×393
fillGeometry: [{ windingRule: NONZERO, commandsBlob: 48 }]
```

경로가 11개 점(M + L×10 + Z)으로 미리 계산되어 저장되어 있다. → 렌더러는 파라미터로 다시 계산하지 않고 `fillGeometry`를 그대로 그리면 된다.

### 이미지 페인트 ✅

```
{ type: IMAGE, image: { hash: byte[20], name }, imageThumbnail: { hash, name },
  imageScaleMode: FILL, transform, scale, originalImageWidth/Height, thumbHash, ... }
```

`image.hash`(20바이트)를 hex로 바꾸면 `images/` 키와 같다. ✅

### 경로 blob (`commandsBlob`) ✅

`blobs[i].bytes` = `[cmd byte][float32 LE 좌표...]` 반복:
`0` close · `1` moveTo(x,y) · `2` lineTo(x,y) · `3` quadTo(4개) 🟡 · `4` cubicTo(6개) ✅

- 원(ellipse)은 cubic 4개로 저장된다. (예: `M120,60 C120,93.1,93.1,120,60,120 …`) ✅
- **`strokeGeometry`는 선의 중심선이 아니라 선 두께만큼 부풀린 외곽선(채울 도형)이다.** 펜 경로의 stroke가 두께 1짜리 폐곡선 여러 개로 저장된다. ✅ → 렌더러는 stroke를 그릴 때 `strokeGeometry`를 *채우면* 되고, 편집할 때는 `vectorNetworkBlob`을 쓴다.
- quadTo(`3`)는 아직 실제 파일에서 관찰되지 않았다 🟡

### 벡터 네트워크 (`vectorData.vectorNetworkBlob`) ✅

펜 도구로 그린 편집 가능한 경로의 원본 데이터다. 모든 값은 4바이트 LE이다.

```
u32 vertexCount, u32 segmentCount, u32 regionCount
vertex  × N: u32 styleID, f32 x, f32 y                                       (12B)
segment × M: u32 styleID, u32 start, f32 tanStartX, f32 tanStartY,
             u32 end,     f32 tanEndX, f32 tanEndY                           (28B)
region  × R: ❓ (샘플에 region이 0개라 아직 미해독)
```

- 검증: "Vector 1"(정점 4, 세그먼트 3) = 12 + 48 + 84 = **144B로 정확히 일치** ✅
- 탄젠트는 정점 기준의 상대 좌표이고, (0,0)이면 직선이다. ("Vector 2" 꺾은선이 그렇다)
- 정점의 `styleID`는 `vectorData.styleOverrideTable[]`의 `styleID`를 가리킨다. (예: `handleMirroring: ANGLE`)

### 그라디언트 ✅

```
{ type: GRADIENT_LINEAR, stops: [{ color, position }], transform: Matrix, ... }
```

`transform`은 그라디언트 공간 → 노드의 정규화 좌표(0..1)로 가는 행렬로 보인다 🟡. 샘플은 위→아래 방향이고 값은 `[[0,1,0],[-1,0,1]]`. 같은 정보가 `stopsVar`(변수 바인딩용)에 한 번 더 들어 있다.

### 오토 레이아웃 ✅

`FRAME`에 `stackMode: HORIZONTAL|VERTICAL`, `stackSpacing`, `stackHorizontalPadding`, `stackVerticalPadding`,
`stackPaddingRight`, `stackPaddingBottom`, `stackCounterAlignItems`, `stackCounterSizing` 필드가 붙는다.
자식 노드의 `transform`에는 레이아웃이 끝난 뒤의 위치가 이미 들어 있다. (Ellipse 3/4 → x = 0, 270)

### 컴포넌트 ✅ / 컴포넌트 세트 ✅ / 인스턴스 ❓

- 컴포넌트 = `SYMBOL` 노드 (`isSymbolPublishable`, `sharedSymbolVersion`). 자식에는 `horizontalConstraint/verticalConstraint: SCALE` 제약이 붙는다.
- **컴포넌트 세트(Variants) = `FRAME` + `isStateGroup: true`** (`sample333.fig`). 세트에 `componentPropDefs[]`(속성 정의, `type: VARIANT`)와 `stateGroupPropertyValueOrders`가 들어 있고,
  각 변형 `SYMBOL`은 `variantPropSpecs[{ propDefId, value }]`로 속성 정의를 참조한다. 세트의 보라색 점선 테두리는 일반 stroke(`dashPattern: [10,5]`)로 저장된다.
- `INSTANCE`는 아직 샘플에 없다 ❓ (`sample333.fig`의 두 번째 "Union"은 인스턴스가 아니라 컴포넌트 세트를 통째로 복사한 것)

### 선 (`LINE`) ✅

- `size.y = 0`이고 방향은 `transform`의 회전으로 표현된다. (샘플: 약 8.8° 기울기 → `m00=0.988, m01=-0.154`)
- `fillGeometry`는 없고 `strokeGeometry`(두께 1짜리 직사각형 외곽선)만 있다.

### 불리언 연산 (`BOOLEAN_OPERATION`) ✅

- `booleanOperation: UNION|SUBTRACT|INTERSECT|EXCLUDE` (샘플은 UNION), `vectorOperationVersion: 1`
- 자식 도형은 그대로 보존되고, **연산 결과가 부모의 `fillGeometry`에 미리 계산되어 저장된다** (원 2개의 합집합 → moveTo 1 + cubic 10 + close 1).
  → 렌더러는 저장된 결과를 그리면 되므로, 경로 불리언 연산 엔진은 *편집할 때*만 필요하다 (6단계).
- 노드 자체의 `strokeWeight`은 0이다.

### 효과 (`effects`) ✅

```
{ type: DROP_SHADOW, offset: {x:0, y:4}, radius: 4, spread: 0,
  color: {r:0,g:0,b:0,a:0.25}, blendMode: NORMAL, visible, showShadowBehindNode: false }
```

## 4. 왕복 변환

| 항목 | 결과 |
|---|---|
| 디코딩 → 인코딩 → 디코딩 (스키마·메시지·ZIP) | ✅ 구조 동일 |
| 파일 크기 | 16,019,391 → 16,019,439 바이트 (메시지 압축이 zstd에서 deflate로 바뀐 영향) |
| 재인코딩 파일을 Figma에서 열기 | ⏳ `fixtures/out/sample-roundtrip.fig` 로 수동 확인 필요 |

## 5. 모델 매핑 규칙 (3단계)

구현: [packages/fig-format/src/mapping/](../packages/fig-format/src/mapping/)

**원칙:** 저장할 때 원본 NodeChange(`node.raw`)를 그대로 깔고, *모델 값이 원본에서 디코딩한 값과 다른 필드만* 다시 쓴다.
→ 편집하지 않은 노드는 원본 메시지와 완전히 같고(실제 샘플 3개에서 `nodeChanges`와 `blobs` 모두 일치 ✅), 모델에 없는 필드는 편집 후에도 남는다.

| 모델 | `.fig` | 비고 |
|---|---|---|
| `id` | `guid` → `"sessionID:localID"` | |
| `parentId`, `position` | `parentIndex { guid, position }` | |
| `type: GROUP` | `FRAME` + `resizeToFit: true` + 채우기 없음 | 🟡 샘플 6개 모두 맞음 |
| `clipsContent` | `!frameMaskDisabled` (FRAME/SYMBOL/INSTANCE/SECTION) | 필드가 없으면 false로 본다 = 클리핑함 |
| `fills` / `strokes` | `fillPaints` / `strokePaints` | 페인트마다 `raw`를 보존 |
| `effects` | `effects` | `FOREGROUND_BLUR` = 레이어 블러 |
| `fillGeometry` / `strokeGeometry` | `Path[]` + `blobs[commandsBlob]` | 바뀌지 않은 경로는 기존 blob 인덱스를 그대로 쓴다 |
| `text.characters` | `textData.characters` | |
| `text.style` | `fontName`, `fontSize`, `lineHeight`, `letterSpacing`, `textAlign*` | |
| `componentId` | `symbolData.symbolID` | INSTANCE (샘플 없음 ❓) |

### 편집했을 때 함께 지우는 파생 데이터

어떤 값이 바뀌면, 그 값에서 파생된 데이터가 새 값과 모순되지 않도록 함께 지운다.

| 바뀐 값 | 함께 지우는 것 |
|---|---|
| 페인트 색 | `authoredColor`, `colorVar` |
| 그라디언트 정지점 | `stopsVar`, `authoredStops`, `gradientVar` |
| 이미지 해시 | `imageThumbnail`, `thumbHash*`, `originalImageWidth/Height`, `imageVar` |
| 텍스트 내용·스타일 | `derivedTextData`, `textData`의 레이아웃 결과(glyphs, baselines 등) |

- 텍스트 내용이 바뀌면 문단 수에 맞춰 `textData.lines`를 다시 만든다. `characterStyleIDs`는 스타일이 하나뿐이면 새 길이로 늘리고, 섞여 있으면 지운다.
- 자간이 PERCENT 단위면 `textTracking = value / 100`으로 함께 맞춘다 (샘플: 5% ↔ 0.05) 🟡

### 검증이 남은 가설 (7단계)

- ⏳ 레이아웃 결과(`derivedTextData`)를 지운 텍스트를 원본 앱이 다시 배치해 주는지
- ⏳ 편집한 파일이 원본 앱에서 열리는지: `fixtures/out/*-edited.fig` (별 색상을 빨간색으로 바꾼 버전)
- 노드를 삭제하면 `nodeChanges`에서 뺀다. 스키마에 `phase: REMOVED`가 있지만 저장 파일에서는 쓰이지 않는 것으로 보인다 🟡
- 새 문서는 스키마가 필요하므로, 기존 `.fig` 하나를 base로 받아서 그 스키마를 쓴다 (스키마 파일은 저장소에 넣지 않음)

## 6. 개인정보 주의

`editInfo.userId`, `lastEditedAt` 같은 편집자 정보가 노드마다 들어 있다.
`fixtures/out/`의 덤프 파일에도 그대로 포함되므로 공유하지 말 것 (`.gitignore`로 제외되어 있음).

## 7. 분석 도구 사용법

```bash
pnpm inspect fixtures/<name>.fig --out fixtures/out/<name> --roundtrip
```

출력: `schema.kiwi` (전체 스키마), `field-usage.json` (필드 사용 빈도), `message.json`, `tree.txt`, `meta.json`

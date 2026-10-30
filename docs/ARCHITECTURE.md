# 아키텍처 설계 (1단계)

## 목표

- 브라우저 기반 벡터 디자인 에디터
- `.fig` 파일 **읽기 + 쓰기 (왕복 변환)** 호환
- 리버스 엔지니어링은 사용자가 보유한 `.fig` 파일의 **포맷 분석(상호운용성 목적)**으로 한정한다.
  서버 API 우회, 클라이언트 코드 변조, 상표/브랜딩 사용은 범위 밖.

## 단계 로드맵

| 단계 | 내용 | 산출물 |
|---|---|---|
| 1 | 구조 설계 ✅ | 이 문서, 모노레포, `@figref/model` |
| 2 | 포맷 리버스 엔지니어링 ✅ | `@figref/kiwi`, `@figref/fig-format`, `tools/fig-inspect`, [fig-format.md](fig-format.md) |
| 3 | 파서/시리얼라이저 ✅ | `.fig` NodeChange ⇄ 내부 모델 매핑 ([mapping/](../packages/fig-format/src/mapping/)) |
| 4 | 렌더링 엔진 | `@figref/renderer` (Canvas2D) |
| 5 | 에디터 | `apps/editor` (React + Vite) |
| 6 | 고급 기능 | 오토 레이아웃, 컴포넌트/인스턴스, 제약, SVG/PNG 내보내기 |
| 7 | 데이터 호환성 검증 | 왕복 diff, 스키마 버전 diff, 픽셀 비교 테스트 |

## 계층 구조

```
┌──────────────────────────────────────────────┐
│ apps/editor        UI, 도구, 패널, 입력 처리      │  (5, 6단계)
├──────────────────────────────────────────────┤
│ @figref/renderer   Node 트리 → Canvas2D 그리기   │  (4단계)
├──────────────────────────────────────────────┤
│ @figref/model      내부 문서 모델 + 트리 연산      │  (1단계)
├──────────────────────────────────────────────┤
│ @figref/fig-format 컨테이너/청크/압축 + 매핑       │  (2, 3단계)
├──────────────────────────────────────────────┤
│ @figref/kiwi       스키마 기반 바이너리 코덱        │  (2단계)
└──────────────────────────────────────────────┘
```

의존 방향은 위 → 아래 단방향. `model`은 `kiwi`/`fig-format`을 모른다.
(`fig-format`이 `model`에 의존해서 매핑한다.)

## `.fig` 파일 구조 (가설 → 2단계에서 검증)

```
[ZIP]  (최근 "Save local copy" 형식)
 ├─ canvas.fig      ← 아래 raw 형식
 ├─ meta.json       ← 파일명, 배경색 등 메타데이터
 ├─ thumbnail.png
 └─ images/<sha1>   ← 이미지 바이너리 (해시로 참조)

[raw canvas.fig]
 "fig-kiwi" (8B 매직, FigJam은 "fig-jam.")
 uint32 LE  version
 반복: uint32 LE length + bytes
   chunk[0] = 압축된 Kiwi 바이너리 스키마
   chunk[1] = 압축된 Kiwi 메시지 (root 타입 "Message")
   압축 = raw deflate 또는 zstd (매직 28 B5 2F FD)
```

**핵심 통찰:** 파일이 자기 스키마를 포함한다. 따라서 디코더는 스키마를 하드코딩하지 않고
**파일에 들어있는 스키마로 해석**하는 범용 Kiwi 코덱으로 만든다. 포맷 버전이 바뀌어도
디코딩은 깨지지 않고, 바뀌는 건 3단계 매핑 계층뿐이다.

## 핵심 설계 결정

### 1. 플랫 노드 맵 + 부모 포인터 + 분수 인덱스

`.fig` 메시지는 노드를 트리가 아닌 **플랫 리스트 (`nodeChanges`)** 로 저장하고,
각 노드가 `parentIndex { guid, position }`를 가진다. `position`은 문자열 분수 인덱스.

내부 모델도 동일하게:

```ts
nodes: Map<NodeId, Node>          // NodeId = "sessionID:localID"
node.parentId, node.position      // 자식 순서 = position 문자열 비교
```

- 장점: 매핑이 1:1, 이동/재정렬 시 형제 노드 재번호 불필요, 추후 멀티플레이어(CRDT)에 유리.

### 2. 무손실 왕복: 알려지지 않은 필드 보존

모든 필드를 매핑할 수는 없다. 매핑하지 않은 필드는 사라지면 안 되므로

- 노드마다 `raw` (원본 NodeChange 객체)를 보관
- 직렬화 시 `raw`를 베이스로 깔고, 편집된(매핑된) 필드만 덮어씀
- 문서 레벨에서 원본 스키마 + `nodeChanges` 이외의 메시지 필드 + blob 보관

→ "열고 → 아무것도 안 하고 → 저장" 시 의미적으로 동일한 파일이 나와야 한다 (7단계 테스트 기준).

### 3. 스키마는 쓰기 시에도 원본을 재사용

저장할 때 원본 파일의 스키마를 그대로 다시 넣는다. 새 문서는 기준 스키마
(검증된 샘플에서 추출한 것)를 사용한다.

### 4. 브라우저/Node 공용

모든 코어 패키지는 순수 TS + `Uint8Array`. Node 전용 API(`fs`, `zlib`) 금지.
압축은 `fflate`(deflate/zip), `fzstd`(zstd 해제) 사용. CLI 도구만 `fs` 사용.

## 패키지 레이아웃

```
packages/
  model/        @figref/model       내부 문서 모델, 트리 연산, 분수 인덱스
  kiwi/         @figref/kiwi        ByteBuffer, 바이너리 스키마 코덱, 메시지 코덱, .kiwi 텍스트 출력
  fig-format/   @figref/fig-format  ZIP/raw 컨테이너, 청크, 압축, (3단계) 모델 매핑
  renderer/     (4단계)
apps/
  editor/       (5단계)
tools/
  fig-inspect/  .fig 분석 CLI (스키마 덤프, 메시지 JSON, 필드 통계)
fixtures/       분석용 샘플 .fig (git 제외 권장)
docs/           설계/포맷 문서
```

## 테스트 전략

- **오라클 테스트:** 자체 Kiwi 코덱 출력을 레퍼런스 구현(`kiwi-schema` npm, devDependency)과
  바이트 단위로 비교
- **합성 픽스처:** 실제 파일 구조를 흉내낸 스키마로 인코드→디코드 왕복
- **실 파일 (7단계):** `fixtures/*.fig` 전부에 대해 decode → encode → decode 구조 동일성

# figref

`.fig` 파일과 호환되는 브라우저 기반 벡터 디자인 에디터 (개인 학습/상호운용성 프로젝트).

- 설계: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)
- 포맷 분석: [docs/fig-format.md](docs/fig-format.md)

```bash
pnpm install
pnpm dev                  # 뷰어 실행 → http://127.0.0.1:5173
pnpm test                 # 전체 테스트
pnpm typecheck
pnpm inspect <file.fig> --out fixtures/out/<name> --roundtrip
```

분석할 샘플은 `fixtures/` 에 넣는다 (`*.fig` 는 git에서 제외됨).

## 뷰어

`.fig` 파일을 창에 끌어다 놓거나 "파일 열기"로 연다. `fixtures/`에 있는 샘플은 상단 목록에서 바로 열 수 있다.

- `http://127.0.0.1:5173/?open=sample.fig` → fixtures 샘플 바로 열기
- `&node=19:2` → 해당 노드를 선택하고 확대

| 조작 | 동작 |
|---|---|
| 스크롤 / Space+드래그 / 휠 클릭 드래그 | 이동 |
| ⌘/Ctrl+스크롤, 트랙패드 핀치 | 확대/축소 |
| Shift+1 / Shift+0 / Shift+2 | 전체 보기 / 100% / 선택 항목으로 |
| 클릭 / Shift+클릭 | 선택 / 선택 추가 |
| 레이어 더블클릭 | 해당 레이어로 이동 |
| .fig로 저장 | 현재 문서를 다시 인코딩해 다운로드 (왕복 호환성 확인용) |

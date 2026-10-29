# figref

`.fig` 파일과 호환되는 브라우저 기반 벡터 디자인 에디터 (개인 학습/상호운용성 프로젝트).

- 설계: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)
- 포맷 분석: [docs/fig-format.md](docs/fig-format.md)

```bash
pnpm install
pnpm test                 # 전체 테스트
pnpm typecheck
pnpm inspect <file.fig> --out fixtures/out/<name> --roundtrip
```

분석할 샘플은 `fixtures/` 에 넣는다 (`*.fig` 는 git에서 제외됨).

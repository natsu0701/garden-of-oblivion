# 망각의 정원 — 방명록

검은 화면에서 포스터를 지나 정원으로 열리는 전시 방명록이다.

열리는 주소: https://natsu0701.github.io/garden-of-oblivion/

## 실행

```bash
npm install
npm start
```

기본 주소는 `http://localhost:8787` 이다. 포트는 `PORT`로 바꿀 수 있다.

서버가 떠 있으면 말은 파일(`data/entries.json`)에 남고, 다른 방문객과 나뉜다. `DATABASE_URL`이 있으면 Postgres를 쓴다. 스키마는 `migrations/001_entries.sql`과 같다. 서버 없이 페이지만 열면 그 브라우저 안에만 남는다.

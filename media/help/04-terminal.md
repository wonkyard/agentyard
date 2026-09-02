# 터미널이 안 될 때

Run 뷰에서 `could not start the terminal` / `posix_spawnp failed` / `ENOENT` 같은
메시지가 뜨면, 대개 Agentyard가 `claude` 실행 파일을 못 찾은 것입니다.

## 1. 진단부터

아래 **[진단 실행]** 버튼(또는 명령 팔레트 → `Agentyard: Diagnostics`)을 누르면
Output 패널에 지금 어떤 경로를 찾았는지, `node-pty` 가 로드됐는지, 플랫폼이
무엇인지 나옵니다.

## 2. `claude` 경로 직접 지정

일반 터미널에서:

```
which claude      # Windows: where claude
```

나온 전체 경로를 복사해서, 아래 **[claudePath 설정 열기]** 버튼으로 열리는
`agentyard.claudePath` 에 붙여 넣으세요.

## 3. 왜 이런 일이 생기나

Finder / Dock / 시작 메뉴에서 실행한 VS Code는 로그인 셸의 PATH를 물려받지
못하고 최소 PATH만 갖습니다. npm 전역 설치된 `claude` 는 `#!/usr/bin/env node`
스크립트라서, node를 그 최소 PATH에서 못 찾으면 실행이 실패합니다. v1.0.2부터
Agentyard는 흔한 설치 위치를 PATH에 보강하고, node 스크립트는 VS Code 내장
Node로 직접 실행하지만, 특이한 설치 위치라면 위 2번으로 경로를 직접 알려주는
게 확실합니다.

## 4. 대안: 일반 터미널에서 열기

명령 팔레트 → `Agentyard: Open Claude Code Terminal` 은 VS Code 기본 통합
터미널에서 세션을 엽니다. 이건 항상 동작합니다.

## 5. 데모 모드에서 벗어나기

패널이 데모 데이터를 보여준다면, `state/company.db` 와 `.claude/agents/` 가 있는
폴더를 열어야 실제 데이터로 바뀝니다. 부서만 필요하면 `~/.claude/agents/` 에
`.md` 파일을 만드세요 (헤더의 **?** → 부서 만들기).

# Agentyard가 뭔가요

Agentyard는 **당신의 에이전트 회사**를 VS Code 패널에 픽셀아트 사무실로 보여줍니다.
각 방은 하나의 **부서**이고, 부서는 `~/.claude/agents/` 폴더의 `.md` 파일 하나에
대응합니다. 에이전트가 일하는 중이면 책상에 앉아 타이핑하고, 쉬는 중이면 방을
돌아다니고, 막혀 있으면 빨간 `!` 를 띄웁니다. 네트워크도, API 키도, 텔레메트리도
없습니다 — 전부 로컬 파일을 읽을 뿐입니다.

## 회사 구조는 자유입니다

예를 들어 이런 부서들로 시작할 수 있습니다:

- `research` — 아이디어를 검증한다 (만들기 전에)
- `engineering` — 제품을 만든다
- `growth` — 다 만든 제품을 사람들에게 알린다

여기에 `design`, `support`, `operations` 처럼 필요한 부서를 직접 추가하면 됩니다.
회사 조직은 당신이 만드는 것이지 Agentyard가 정해주는 게 아닙니다.

## 프로젝트 별관 (Project Annexes)

`state/company.db` 의 프로젝트 중 `repo_url` 이 있는 것은 화면 아래쪽에 **별관**으로
그려지고, 그 레포의 팀(`project-lead` / `project-eng` / `release-check`)이 함께
표시됩니다. 이건 회사 워크스페이스에서 Agentyard를 열었을 때만 나옵니다.

# 데이터 모드

## 데모 (기본)

워크스페이스가 없거나, `state/company.db` 또는 `.claude/agents/` 가 없으면
Agentyard는 번들된 **가짜 데이터**를 보여줍니다 (`dev-data/` 의 합성 부서와
`DEMO-*` 프로젝트). 헤더에 보라색 **DEMO DATA** 배지가 뜹니다. 아무것도 실제가
아니니 마음껏 눌러봐도 됩니다.

## 워크스페이스

첫 워크스페이스 폴더에 `state/company.db` 와 `.claude/agents/` 가 **둘 다** 있으면
그 데이터를 읽습니다:

- **부서 방** ← `.claude/agents/*.md` + `~/.claude/agents/*.md`
- **상태** (working / idle / blocked) ← `company.db` 의 `status_log` 테이블,
  `project_id` + `department` 조합별 최신 행
- **회사 보드** ← `projects` 테이블의 `current_stage`
- **별관** ← `repo_url` 이 있는 프로젝트, 팀은
  `templates/project-repo/.claude/agents/` (없으면 번들 기본 역할)

## 라이브 모드 (선택)

`Agentyard: Turn On Live Mode` 는 `~/.claude/settings.json` 에 훅을 추가해서
지금 돌고 있는 Claude Code 세션·서브에이전트를 실시간으로 방에 띄웁니다. 훅은
로컬 JSONL 파일에만 append 하고 아무 데도 전송하지 않습니다. 백업
(`settings.json.agentyard-backup`)을 먼저 만듭니다.

# 부서(에이전트) 만들기

부서 하나 = 마크다운 파일 하나입니다.

## 어디에 두나요

- **내 모든 프로젝트에서 쓰는 부서** → `~/.claude/agents/<이름>.md`
- **이 워크스페이스 전용 부서** → `<워크스페이스>/.claude/agents/<이름>.md`
  (같은 이름이면 워크스페이스 쪽이 이깁니다)

## 파일 형식

맨 위에 `---` 로 감싼 프론트매터가 있고, 그 아래가 에이전트 지시문입니다.

```
---
name: research
description: 아이디어를 검증한다 — 시장 규모, 경쟁, 실제 수요.
model: sonnet
tools: Read, Write, WebSearch
---

너는 리서치 부서다. 아이디어가 오면 만들 가치가 있는지 확인한다 …
```

Agentyard가 읽는 필드:

| 필드 | 쓰임 |
|---|---|
| `name` | 방 이름 (파일 이름과 같게) |
| `model` | 방의 색 띠 (teal = sonnet, yellow = haiku) |
| `description` | 방을 클릭하면 나오는 설명 |
| `tools` | 이 에이전트가 쓸 수 있는 도구 |

## 빠르게 시작하기

아래 **[샘플 부서 만들기]** 버튼을 누르면 `research` / `engineering` / `growth` 와
빈 템플릿(`_template.md`)이 `~/.claude/agents/` 에 생깁니다. 이미 있는 파일은
건드리지 않습니다. 만든 뒤에는 파일을 열어 자기 회사에 맞게 고치세요.

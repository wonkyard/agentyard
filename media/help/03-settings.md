# 환경 설정

모두 VS Code 설정에서 `agentyard.` 로 찾을 수 있습니다. 대부분 기본값 그대로 두면 됩니다.

## `agentyard.claudePath`

Run 뷰의 터미널이 실행할 Claude Code CLI 명령입니다. 기본값은 `claude` (PATH에서
찾음). GUI로 실행한 VS Code가 `claude` 를 못 찾을 때는, 일반 터미널에서
`which claude` (Windows: `where claude`) 를 실행해 나온 **전체 경로**를 여기에
넣으세요.

## `agentyard.claudePermissionMode`

Run 뷰 세션을 시작할 때 넘기는 `--permission-mode`. 기본 `default` 는 아무 플래그도
안 붙입니다. `plan` 은 플랜 모드로 시작합니다. `bypassPermissions` 는 신뢰하는
워크스페이스에서만 쓰세요.

## `agentyard.pollSeconds`

DB와 에이전트 파일을 다시 읽는 주기 (초). 기본 3.

## `agentyard.dbPath` / `agentyard.agentsGlob`

워크스페이스 첫 폴더 기준 상대 경로. 기본은 `state/company.db` 와 `.claude/agents`.
둘 다 존재해야 "워크스페이스 데이터" 모드로 들어갑니다. 아니면 번들 데모 데이터를
보여줍니다.

## `agentyard.staleWorkingHours`

`company.db` 의 `working` 상태 행이 이 시간(기본 3h)보다 오래되면 idle로 표시합니다.
세션이 끝났다고 로그를 남기지 않은 경우를 대비한 것입니다. 0이면 끕니다.

#!/bin/zsh
set -eu
task_root="${0:A:h:h}"
cd "$task_root"
exec node dist/cli.js claude-session --project "$task_root"

#!/bin/zsh
set -euo pipefail

EXTENSION_DIR="$(cd "$(dirname "$0")" && pwd)"
printf '扩展目录：%s\n' "$EXTENSION_DIR"
printf 'Chrome 打开后：开启“开发者模式” -> “加载已解压的扩展程序” -> 选择上面的目录。\n'
open -a "Google Chrome" "chrome://extensions"

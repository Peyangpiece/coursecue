#!/bin/bash
# saboro の Mac 向けインストーラー：
#   curl -fsSL https://coursecue.hrk-6888.workers.dev/install.sh | bash
# ~/saboro/app にアプリを置き（資料は ~/saboro/<授業名>/ に保存）、必要なものを入れて設定画面を開く。
set -euo pipefail
REPO="${SABORO_REPO:-https://github.com/Peyangpiece/coursecue.git}"
HOME_DIR="${SABORO_HOME:-$HOME/saboro}"
APP="$HOME_DIR/app"
need(){ command -v "$1" >/dev/null 2>&1; }
if [ "$(uname -s)" != "Darwin" ]; then echo "saboro の Mac サービスは macOS 専用です。"; exit 1; fi
if ! xcode-select -p >/dev/null 2>&1; then echo "Xcode コマンドラインツールが必要です。表示された画面で「インストール」を押し、終わってからもう一度実行してください。"; xcode-select --install || true; exit 1; fi
if ! need node || [ "$(node -p 'process.versions.node.split(".")[0]')" -lt 22 ]; then
  if need brew; then echo "Node.js 22 を入れます（Homebrew）"; brew install node@22 >/dev/null; export PATH="$(brew --prefix node@22)/bin:$PATH"; else echo "Node.js 22 以上が必要です。https://nodejs.org/ から入れてからもう一度実行してください。"; exit 1; fi
fi
mkdir -p "$HOME_DIR"
if [ -d "$APP/.git" ]; then echo "▶ 更新：$APP"; git -C "$APP" pull --ff-only; else echo "▶ 取得：$APP"; git clone --depth 1 --branch deployed "$REPO" "$APP" 2>/dev/null || git clone --depth 1 "$REPO" "$APP"; fi
cd "$APP"
echo "▶ 依存関係"; npm ci --no-audit --no-fund
echo "▶ セットアップ"; npm run setup

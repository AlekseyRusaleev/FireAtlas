#!/usr/bin/env bash
# Сборка настольной Linux-версии «Пожарного Атласа».
#
# Проверено на Ubuntu 22.04/24.04. На выходе в dist-linux/:
#   FireAtlas-<версия>-linux-<arch>            — portable-бинарник (канал автообновления);
#   FireAtlas-<версия>-linux-<arch>.AppImage   — портативный однофайловый вариант;
#   FireAtlas-<версия>-linux-<arch>.deb        — системный установщик;
#   install-fireatlas-linux.sh, fireatlas.png  — установщик и иконка.
#
# Использование:
#   ./scripts/build-linux.sh            # собрать (зависимости уже стоят)
#   ./scripts/build-linux.sh --deps     # поставить зависимости и собрать
set -euo pipefail

cd "$(dirname "$0")/.."
ROOT="$(pwd)"
OUT="$ROOT/dist-linux"
INSTALL_DEPS=0
for arg in "$@"; do
  case "$arg" in
    --deps) INSTALL_DEPS=1 ;;
    -h|--help) sed -n '2,16p' "$0"; exit 0 ;;
  esac
done

if [[ "$(uname -s)" != "Linux" ]]; then
  echo "Ошибка: сборка Linux-версии возможна только на Linux." >&2
  exit 1
fi

if [[ "$INSTALL_DEPS" == "1" ]]; then
  echo "==> Устанавливаю системные зависимости"
  sudo apt-get update
  sudo apt-get install -y --no-install-recommends \
    ca-certificates curl wget file build-essential pkg-config \
    libwebkit2gtk-4.1-dev libgtk-3-dev libayatana-appindicator3-dev librsvg2-dev \
    libssl-dev libxdo-dev patchelf dpkg-dev
fi

if ! command -v cargo >/dev/null 2>&1; then
  echo "==> Устанавливаю Rust (rustup)"
  curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y --profile minimal
  # shellcheck disable=SC1091
  source "$HOME/.cargo/env"
fi

if ! command -v npm >/dev/null 2>&1; then
  echo "Ошибка: не найден Node.js/npm (нужен Node 20+)." >&2
  echo "Установите Node 20+ (например, https://deb.nodesource.com) и повторите." >&2
  exit 1
fi

echo "==> Node $(node -v), npm $(npm -v), $(cargo -V)"

echo "==> npm ci"
npm ci

echo "==> tauri build (deb + appimage)"
npm run tauri -- build --bundles deb appimage

echo "==> Собираю артефакты в $OUT"
rm -rf "$OUT"
mkdir -p "$OUT"
cp -v src-tauri/target/release/fire-atlas "$OUT/fire-atlas"
find src-tauri/target/release/bundle -type f \( -name '*.deb' -o -name '*.AppImage' \) -exec cp -v {} "$OUT/" \;
cp -v src-tauri/icons/128x128-2x.png "$OUT/fireatlas.png"
cp -v scripts/install-fireatlas-linux.sh "$OUT/install-fireatlas-linux.sh"
chmod +x "$OUT/install-fireatlas-linux.sh" "$OUT/fire-atlas"
"$ROOT/scripts/pack-linux-artifacts.sh" "$OUT"
ls -la "$OUT"
echo "==> Готово: $OUT"

#!/usr/bin/env bash
# Приводит имена Linux-артефактов к стабильному ASCII-виду, считает sha256
# и печатает готовый фрагмент latest.json для канала обновлений.
#
# Использование: scripts/pack-linux-artifacts.sh [каталог-с-артефактами]
set -euo pipefail

cd "$(dirname "$0")/.."
DIR="$(readlink -f "${1:-dist-linux}")"
VERSION="$(sed -n 's/.*"version": *"\([^"]*\)".*/\1/p' package.json | head -1)"
ARCH="$(uname -m)"
[[ -z "$VERSION" ]] && { echo "Не удалось определить версию из package.json" >&2; exit 1; }
BASE="FireAtlas-$VERSION-linux-$ARCH"

if [[ -f "$DIR/fire-atlas" ]]; then
  mv -f "$DIR/fire-atlas" "$DIR/$BASE"
fi

# Tauri кладёт бандлы как FireAtlas_<версия>_<arch>.[deb|AppImage].
shopt -s nullglob
for f in "$DIR"/FireAtlas_*.deb; do mv -f "$f" "$DIR/$BASE.deb"; done
for f in "$DIR"/FireAtlas_*.AppImage; do mv -f "$f" "$DIR/$BASE.AppImage"; done
shopt -u nullglob

( cd "$DIR" && sha256sum "$BASE" "$BASE.deb" "$BASE.AppImage" install-fireatlas-linux.sh fireatlas.png 2>/dev/null | tee sha256sums.txt )

sha_of() {
  local f="$DIR/$1"
  [[ -f "$f" ]] || { echo ""; return; }
  sha256sum "$f" | awk '{print $1}'
}
BIN_SHA="$(sha_of "$BASE")"
APP_SHA="$(sha_of "$BASE.AppImage")"
DEB_SHA="$(sha_of "$BASE.deb")"

echo
echo "Фрагмент latest.json для https://geo.infocardmchs.ru/updates/latest.json:"
echo "  \"portableLinux\": {"
echo "    \"url\": \"https://geo.infocardmchs.ru/updates/$BASE\","
echo "    \"sha256\": \"$BIN_SHA\""
echo "  },"
echo "  \"appimageLinux\": {"
echo "    \"url\": \"https://geo.infocardmchs.ru/updates/$BASE.AppImage\","
echo "    \"sha256\": \"$APP_SHA\""
echo "  },"
echo "  \"installerLinux\": {"
echo "    \"url\": \"https://geo.infocardmchs.ru/updates/$BASE.deb\","
echo "    \"sha256\": \"$DEB_SHA\""
echo "  }"

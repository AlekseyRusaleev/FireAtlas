#!/usr/bin/env bash
# Установка «Пожарного Атласа» на Linux (Ubuntu/Debian и совместимые).
#
# Ставит portable-бинарник (или AppImage) в домашнюю папку пользователя,
# создаёт ярлык в меню приложений и иконку. Автообновление с сервера работает,
# потому что файл программы лежит в домашней папке (её можно перезаписать).
#
# Использование:
#   ./install-fireatlas-linux.sh FireAtlas-<версия>-linux-x86_64
#   ./install-fireatlas-linux.sh FireAtlas-<версия>-linux-x86_64.AppImage
# Если путь не указан — подходящий файл ищется рядом со скриптом.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
SRC="${1:-}"
if [[ -z "$SRC" ]]; then
  # По умолчанию portable-бинарник (не требует FUSE), затем AppImage.
  SRC="$(find "$SCRIPT_DIR" -maxdepth 1 -type f -iname 'FireAtlas-*-linux-*' ! -name '*.deb' ! -name '*.AppImage' | head -1 || true)"
  if [[ -z "$SRC" ]]; then
    SRC="$(find "$SCRIPT_DIR" -maxdepth 1 -type f -iname 'FireAtlas-*-linux-*.AppImage' | head -1 || true)"
  fi
fi
if [[ -z "$SRC" || ! -f "$SRC" ]]; then
  echo "Не найден файл сборки. Укажите путь, например:" >&2
  echo "  $0 FireAtlas-0.1.44-linux-x86_64" >&2
  exit 1
fi
SRC="$(readlink -f "$SRC")"

DATA_HOME="${XDG_DATA_HOME:-$HOME/.local/share}"
APP_DIR="$DATA_HOME/FireAtlas"
BIN_DIR="$HOME/.local/bin"
DESKTOP_DIR="$DATA_HOME/applications"
ICON_DIR="$DATA_HOME/icons/hicolor/256x256/apps"
mkdir -p "$APP_DIR" "$DESKTOP_DIR" "$ICON_DIR" "$BIN_DIR"

if [[ "$SRC" == *.AppImage ]]; then
  APP_DEST="$APP_DIR/FireAtlas.AppImage"
else
  APP_DEST="$APP_DIR/FireAtlas"
fi
install -m 0755 "$SRC" "$APP_DEST"
ln -sf "$APP_DEST" "$BIN_DIR/fireatlas"

# Иконка: рядом со скриптом, из AppImage или из репозитория.
ICON_SRC=""
for cand in "$SCRIPT_DIR/fireatlas.png" "$SCRIPT_DIR/../src-tauri/icons/128x128-2x.png"; do
  if [[ -f "$cand" ]]; then ICON_SRC="$cand"; break; fi
done
tmp_icon=""
if [[ -z "$ICON_SRC" && "$APP_DEST" == *.AppImage ]]; then
  tmp_icon="$(mktemp -d)"
  if (cd "$tmp_icon" && "$APP_DEST" --appimage-extract >/dev/null 2>&1); then
    ICON_SRC="$(find "$tmp_icon" -name '*.png' -printf '%s %p\n' 2>/dev/null | sort -nr | head -1 | cut -d' ' -f2-)"
  fi
fi
if [[ -n "$ICON_SRC" && -f "$ICON_SRC" ]]; then
  install -m 0644 "$ICON_SRC" "$ICON_DIR/fireatlas.png"
fi
[[ -n "$tmp_icon" ]] && rm -rf "$tmp_icon"

cat > "$DESKTOP_DIR/fireatlas.desktop" <<DESKTOP
[Desktop Entry]
Type=Application
Name=Пожарный Атлас
Comment=Поиск водоисточников (ИППВ) и информационных карточек
Exec="$APP_DEST"
Icon=fireatlas
Terminal=false
Categories=Utility;Office;
StartupWMClass=fire-atlas
DESKTOP
chmod 0644 "$DESKTOP_DIR/fireatlas.desktop"

update-desktop-database "$DESKTOP_DIR" >/dev/null 2>&1 || true
gtk-update-icon-cache -f -t "$DATA_HOME/icons/hicolor" >/dev/null 2>&1 || true

echo "Готово. «Пожарный Атлас» установлен."
echo "  Приложение:   $APP_DEST"
echo "  Ярлык в меню: $DESKTOP_DIR/fireatlas.desktop"
echo "  Из терминала: $BIN_DIR/fireatlas"
echo
if ! ldconfig -p 2>/dev/null | grep -q 'libwebkit2gtk-4.1'; then
  echo "ВНИМАНИЕ: не найдена библиотека WebKitGTK. Установите её:"
  echo "  sudo apt-get update && sudo apt-get install -y libwebkit2gtk-4.1-0 libgtk-3-0"
  echo
fi
echo "Обновления приложение проверяет само (баннер при запуске и «О программе»)."

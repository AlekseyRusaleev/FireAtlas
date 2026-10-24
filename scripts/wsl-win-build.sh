#!/bin/bash
set -euo pipefail
export PATH="$HOME/.cargo/bin:$HOME/zig:/usr/bin:/bin:$PATH"
export CARGO_HOME=$HOME/.cargo
export RUSTUP_HOME=$HOME/.rustup
SRC=/mnt/c/Users/Admin/Desktop/FireAtlas
WORK=$HOME/fireatlas-winbuild
LOG=$HOME/fa-build.log
WINLOG=$SRC/dist-app/wsl-build.log
mkdir -p "$WORK" "$SRC/dist-app"
exec >"$LOG" 2>&1
sync_log() { cp -f "$LOG" "$WINLOG" 2>/dev/null || true; }
echo "== start $(date) =="
free -h
sync_log

echo "== copy sources =="
rm -rf "$WORK/src-tauri" "$WORK/dist"
tar -C "$SRC" --exclude src-tauri/resources/maps --exclude src-tauri/target -cf - src-tauri dist | tar -C "$WORK" -xf -
sync_log

echo "== rustup =="
if [ ! -x "$HOME/.rustup/toolchains/stable-x86_64-unknown-linux-gnu/bin/rustc" ]; then
  echo "wiping incomplete rustup"
  rm -rf "$HOME/.rustup" "$HOME/.cargo"
  curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y --profile minimal --default-toolchain stable
fi
if [ -f "$HOME/.cargo/env" ]; then source "$HOME/.cargo/env"; fi
rustup target add x86_64-pc-windows-msvc
rustc --version
sync_log

echo "== zig =="
ZIG_VER=0.14.1
ZIG_NAME=zig-x86_64-linux-${ZIG_VER}
if [ ! -x "$HOME/zig/zig" ]; then
  mkdir -p "$HOME/zig"
  curl -L --fail "https://ziglang.org/download/${ZIG_VER}/${ZIG_NAME}.tar.xz" -o /tmp/zig.tar.xz
  tar -C /tmp -xf /tmp/zig.tar.xz
  mv /tmp/${ZIG_NAME}/* "$HOME/zig/"
fi
zig version
sync_log

echo "== cargo-zigbuild =="
if ! command -v cargo-zigbuild >/dev/null 2>&1; then
  cargo install cargo-zigbuild --locked
fi
sync_log

export CARGO_TARGET_DIR=$HOME/fireatlas-wsl-target
export CARGO_BUILD_JOBS=1
export RAYON_NUM_THREADS=1
mkdir -p "$CARGO_TARGET_DIR"

echo "== cargo zigbuild =="
cd "$WORK/src-tauri"
cargo zigbuild --release --target x86_64-pc-windows-msvc
sync_log
echo "== artifacts =="
find "$CARGO_TARGET_DIR" -name 'fire-atlas.exe'
echo "== done $(date) =="
free -h
sync_log

#!/bin/bash
set -e
uname -a
free -h
df -h / /tmp
id
command -v rustc || echo "no-rustc"
command -v cargo || echo "no-cargo"
command -v apt-get
ls /mnt/c/Users/Admin/Desktop/FireAtlas/src-tauri/Cargo.toml
ls "$HOME/.cargo/bin" 2>/dev/null || true

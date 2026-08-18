//! Проверка и установка portable-обновлений с geo.infocardmchs.ru.

use hex::encode as hex_encode;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::fs::{self, File};
use std::io::copy;
use std::path::{Component, Path, PathBuf};
use std::process::Command;
use zip::ZipArchive;

pub const UPDATES_MANIFEST_URL: &str = "https://geo.infocardmchs.ru/updates/latest.json";

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PortableArtifact {
    pub url: String,
    pub sha256: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateManifest {
    pub version: String,
    #[serde(default)]
    pub notes: String,
    #[serde(default)]
    pub published_at: String,
    pub portable: PortableArtifact,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateCheckResult {
    pub current_version: String,
    pub update_available: bool,
    pub latest: Option<UpdateManifest>,
}

pub fn current_version() -> String {
    env!("CARGO_PKG_VERSION").to_string()
}

fn parse_semver(raw: &str) -> Option<(u64, u64, u64)> {
    let s = raw.trim().trim_start_matches('v');
    let mut parts = s.split('.');
    let major = parts.next()?.parse().ok()?;
    let minor = parts.next().unwrap_or("0").parse().ok()?;
    let patch = parts
        .next()
        .unwrap_or("0")
        .split(|c: char| !c.is_ascii_digit())
        .next()?
        .parse()
        .ok()?;
    Some((major, minor, patch))
}

pub fn is_newer(latest: &str, current: &str) -> bool {
    match (parse_semver(latest), parse_semver(current)) {
        (Some(l), Some(c)) => l > c,
        _ => latest.trim() != current.trim() && !latest.trim().is_empty(),
    }
}

pub fn fetch_manifest() -> Result<UpdateManifest, String> {
    let resp = ureq::get(UPDATES_MANIFEST_URL)
        .set("Accept", "application/json")
        .set("User-Agent", concat!("FireAtlas/", env!("CARGO_PKG_VERSION")))
        .timeout(std::time::Duration::from_secs(20))
        .call()
        .map_err(|e| format!("Не удалось проверить обновления: {e}"))?;
    resp.into_json::<UpdateManifest>()
        .map_err(|e| format!("Некорректный манифест обновлений: {e}"))
}

pub fn check_for_updates() -> Result<UpdateCheckResult, String> {
    let current = current_version();
    let latest = fetch_manifest()?;
    let update_available = is_newer(&latest.version, &current);
    Ok(UpdateCheckResult {
        current_version: current,
        update_available,
        latest: if update_available { Some(latest) } else { None },
    })
}

fn normalize_sha256(raw: &str) -> String {
    raw.trim().to_lowercase().replace([' ', '-'], "")
}

fn download_to_file(url: &str, dest: &Path) -> Result<(), String> {
    let resp = ureq::get(url)
        .set("User-Agent", concat!("FireAtlas/", env!("CARGO_PKG_VERSION")))
        .timeout(std::time::Duration::from_secs(300))
        .call()
        .map_err(|e| format!("Ошибка загрузки обновления: {e}"))?;
    let mut reader = resp.into_reader();
    let mut file = File::create(dest).map_err(|e| format!("Не удалось создать файл: {e}"))?;
    copy(&mut reader, &mut file).map_err(|e| format!("Ошибка записи обновления: {e}"))?;
    Ok(())
}

fn sha256_file(path: &Path) -> Result<String, String> {
    let mut file = File::open(path).map_err(|e| format!("Не удалось открыть архив: {e}"))?;
    let mut hasher = Sha256::new();
    copy(&mut file, &mut hasher).map_err(|e| format!("Ошибка чтения архива: {e}"))?;
    Ok(hex_encode(hasher.finalize()))
}

fn safe_zip_path(name: &str) -> Option<PathBuf> {
    let path = Path::new(name);
    if path.is_absolute() {
        return None;
    }
    let mut out = PathBuf::new();
    for comp in path.components() {
        match comp {
            Component::Normal(p) => out.push(p),
            Component::CurDir => {}
            _ => return None,
        }
    }
    if out.as_os_str().is_empty() {
        None
    } else {
        Some(out)
    }
}

fn extract_zip(zip_path: &Path, dest_dir: &Path) -> Result<(), String> {
    fs::create_dir_all(dest_dir).map_err(|e| format!("Не удалось создать staging: {e}"))?;
    let file = File::open(zip_path).map_err(|e| format!("Не удалось открыть ZIP: {e}"))?;
    let mut archive = ZipArchive::new(file).map_err(|e| format!("Повреждённый ZIP: {e}"))?;
    for i in 0..archive.len() {
        let mut entry = archive
            .by_index(i)
            .map_err(|e| format!("Ошибка чтения ZIP: {e}"))?;
        let Some(rel) = entry.enclosed_name().and_then(|p| safe_zip_path(&p.to_string_lossy()))
        else {
            continue;
        };
        let out_path = dest_dir.join(&rel);
        if entry.is_dir() {
            fs::create_dir_all(&out_path).map_err(|e| format!("mkdir: {e}"))?;
            continue;
        }
        if let Some(parent) = out_path.parent() {
            fs::create_dir_all(parent).map_err(|e| format!("mkdir: {e}"))?;
        }
        let mut out = File::create(&out_path).map_err(|e| format!("create: {e}"))?;
        copy(&mut entry, &mut out).map_err(|e| format!("extract: {e}"))?;
    }
    Ok(())
}

fn ps_single_quote(path: &Path) -> String {
    path.display()
        .to_string()
        .replace('/', "\\")
        .replace('\'', "''")
}

fn write_helper_script(
    script_path: &Path,
    pid: u32,
    staging: &Path,
    install_dir: &Path,
    exe_name: &str,
    temp_root: &Path,
) -> Result<(), String> {
    let staging_s = ps_single_quote(staging);
    let install_s = ps_single_quote(install_dir);
    let temp_root_s = ps_single_quote(temp_root);
    let exe_name_s = exe_name.replace('\'', "''");
    // PowerShell: copy over the running exe name AND FireAtlas.exe, then retarget shortcuts.
    // Otherwise NSIS/ярлык открывает «Пожарный Атлас.exe», а в папку легла только FireAtlas.exe —
    // после закрытия снова стартует старая версия.
    let body = format!(
        "$ErrorActionPreference = 'Continue'\r\n\
$staging = '{staging}'\r\n\
$install = '{install}'\r\n\
$exeName = '{exe_name}'\r\n\
$tempRoot = '{temp_root}'\r\n\
Start-Sleep -Seconds 2\r\n\
Stop-Process -Id {pid} -Force -ErrorAction SilentlyContinue\r\n\
Get-Process | Where-Object {{ $_.Path -and $_.Path.StartsWith($install, $true, [Globalization.CultureInfo]::InvariantCulture) }} | Stop-Process -Force -ErrorAction SilentlyContinue\r\n\
Start-Sleep -Seconds 2\r\n\
$srcExe = Join-Path $staging $exeName\r\n\
if (-not (Test-Path -LiteralPath $srcExe)) {{ $srcExe = Join-Path $staging 'FireAtlas.exe' }}\r\n\
$copied = $false\r\n\
for ($i = 0; $i -lt 12; $i++) {{\r\n\
  Copy-Item -Path (Join-Path $staging '*') -Destination $install -Recurse -Force -ErrorAction SilentlyContinue\r\n\
  if (Test-Path -LiteralPath $srcExe) {{\r\n\
    $targets = New-Object System.Collections.Generic.List[string]\r\n\
    [void]$targets.Add((Join-Path $install $exeName))\r\n\
    [void]$targets.Add((Join-Path $install 'FireAtlas.exe'))\r\n\
    [void]$targets.Add((Join-Path $install 'fire-atlas.exe'))\r\n\
    Get-ChildItem -LiteralPath $install -Filter '*.exe' -ErrorAction SilentlyContinue | ForEach-Object {{\r\n\
      if ($_.Name -match 'FireAtlas|fire-atlas|Атлас|Atlas') {{ [void]$targets.Add($_.FullName) }}\r\n\
    }}\r\n\
    $targets | Select-Object -Unique | ForEach-Object {{\r\n\
      Copy-Item -LiteralPath $srcExe -Destination $_ -Force -ErrorAction SilentlyContinue\r\n\
    }}\r\n\
  }}\r\n\
  $launch = Join-Path $install $exeName\r\n\
  if (-not (Test-Path -LiteralPath $launch)) {{ $launch = Join-Path $install 'FireAtlas.exe' }}\r\n\
  if ((Test-Path -LiteralPath $launch) -and ((Get-Item -LiteralPath $launch).Length -gt 1000000)) {{ $copied = $true; break }}\r\n\
  Start-Sleep -Seconds 1\r\n\
}}\r\n\
if (-not $copied) {{ exit 1 }}\r\n\
$launch = Join-Path $install $exeName\r\n\
if (-not (Test-Path -LiteralPath $launch)) {{ $launch = Join-Path $install 'FireAtlas.exe' }}\r\n\
try {{\r\n\
  $ws = New-Object -ComObject WScript.Shell\r\n\
  $dirs = @([Environment]::GetFolderPath('Desktop'), (Join-Path $env:APPDATA 'Microsoft\\Windows\\Start Menu\\Programs'))\r\n\
  foreach ($dir in $dirs) {{\r\n\
    if (-not (Test-Path -LiteralPath $dir)) {{ continue }}\r\n\
    $lnk = Join-Path $dir 'Пожарный Атлас.lnk'\r\n\
    $s = $ws.CreateShortcut($lnk)\r\n\
    $s.TargetPath = $launch\r\n\
    $s.WorkingDirectory = $install\r\n\
    $s.Save()\r\n\
  }}\r\n\
}} catch {{ }}\r\n\
Start-Process -FilePath $launch -WorkingDirectory $install\r\n\
Remove-Item -LiteralPath $tempRoot -Recurse -Force -ErrorAction SilentlyContinue\r\n\
Remove-Item -LiteralPath $PSCommandPath -Force -ErrorAction SilentlyContinue\r\n",
        pid = pid,
        staging = staging_s,
        install = install_s,
        exe_name = exe_name_s,
        temp_root = temp_root_s
    );
    let mut bytes = vec![0xEF, 0xBB, 0xBF];
    bytes.extend(body.as_bytes());
    fs::write(script_path, bytes).map_err(|e| format!("Не удалось записать helper: {e}"))?;
    Ok(())
}

#[cfg(windows)]
fn spawn_helper_detached(script_path: &Path) -> Result<(), String> {
    use std::os::windows::process::CommandExt;
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    const DETACHED_PROCESS: u32 = 0x0000_0008;
    Command::new("powershell.exe")
        .args([
            "-NoProfile",
            "-ExecutionPolicy",
            "Bypass",
            "-File",
            &script_path.to_string_lossy(),
        ])
        .creation_flags(CREATE_NO_WINDOW | DETACHED_PROCESS)
        .spawn()
        .map_err(|e| format!("Не удалось запустить установщик обновления: {e}"))?;
    Ok(())
}

#[cfg(not(windows))]
fn spawn_helper_detached(_script_path: &Path) -> Result<(), String> {
    Err("Автообновление поддерживается только на Windows".into())
}

/// Скачать portable ZIP, проверить sha256, подготовить helper и выйти из приложения.
pub fn download_and_apply_update(app: tauri::AppHandle, url: String, sha256: String) -> Result<(), String> {
    let expected = normalize_sha256(&sha256);
    if expected.len() != 64 || !expected.chars().all(|c| c.is_ascii_hexdigit()) {
        return Err("Некорректный SHA-256 в манифесте обновления".into());
    }

    let current_exe = std::env::current_exe().map_err(|e| format!("current_exe: {e}"))?;
    let install_dir = current_exe
        .parent()
        .ok_or_else(|| "Не удалось определить папку программы".to_string())?
        .to_path_buf();
    let exe_name = current_exe
        .file_name()
        .map(|s| s.to_string_lossy().into_owned())
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| "FireAtlas.exe".to_string());

    let temp_root = std::env::temp_dir().join(format!("fireatlas-update-{}", std::process::id()));
    let _ = fs::remove_dir_all(&temp_root);
    fs::create_dir_all(&temp_root).map_err(|e| format!("temp dir: {e}"))?;
    let zip_path = temp_root.join("update.zip");
    let staging = temp_root.join("staging");

    download_to_file(&url, &zip_path)?;
    let actual = sha256_file(&zip_path)?;
    if actual != expected {
        let _ = fs::remove_dir_all(&temp_root);
        return Err(format!(
            "Контрольная сумма не совпала (ожидалось {expected}, получено {actual})"
        ));
    }

    extract_zip(&zip_path, &staging)?;

    // ZIP может содержать вложенную папку FireAtlas-portable — поднимем содержимое, если exe не в корне
    let staging_effective = if staging.join(&exe_name).is_file() {
        staging.clone()
    } else if staging.join("FireAtlas.exe").is_file() {
        staging.clone()
    } else {
        let mut found: Option<PathBuf> = None;
        if let Ok(rd) = fs::read_dir(&staging) {
            for entry in rd.flatten() {
                let p = entry.path();
                if p.is_dir()
                    && (p.join(&exe_name).is_file() || p.join("FireAtlas.exe").is_file())
                {
                    found = Some(p);
                    break;
                }
            }
        }
        found.unwrap_or(staging.clone())
    };

    // Helper вне temp_root — иначе Windows не даст удалить папку со скриптом внутри.
    let script_path = std::env::temp_dir().join(format!(
        "update-fireatlas-{}.ps1",
        std::process::id()
    ));
    write_helper_script(
        &script_path,
        std::process::id(),
        &staging_effective,
        &install_dir,
        if staging_effective.join(&exe_name).is_file() {
            &exe_name
        } else {
            "FireAtlas.exe"
        },
        &temp_root,
    )?;
    spawn_helper_detached(&script_path)?;

    // Дать helper стартовать, затем закрыть приложение
    std::thread::sleep(std::time::Duration::from_millis(400));
    app.exit(0);
    Ok(())
}

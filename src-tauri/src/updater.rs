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
    /// Установщик для новых компьютеров. Старые клиенты поле игнорируют.
    #[serde(default)]
    pub installer: Option<PortableArtifact>,
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

fn backup_path(path: &Path) -> PathBuf {
    let mut raw = path.as_os_str().to_os_string();
    raw.push(".old");
    PathBuf::from(raw)
}

fn copy_over(src: &Path, dest: &Path, running_exe: &Path) -> Result<(), String> {
    if dest.exists() {
        let same = dest == running_exe
            || dest.file_name() == running_exe.file_name()
                && dest.parent() == running_exe.parent();
        if same {
            let bak = backup_path(dest);
            let _ = fs::remove_file(&bak);
            fs::rename(dest, &bak).map_err(|e| {
                format!("Не удалось освободить файл программы {}: {e}", dest.display())
            })?;
        }
    }
    match fs::copy(src, dest) {
        Ok(_) => Ok(()),
        Err(e) => {
            let bak = backup_path(dest);
            let _ = fs::remove_file(&bak);
            let _ = fs::rename(dest, &bak);
            fs::copy(src, dest).map_err(|e2| {
                format!("Не удалось записать {}: {e} / {e2}", dest.display())
            })?;
            Ok(())
        }
    }
}

fn copy_staging_into(staging: &Path, install_dir: &Path, running_exe: &Path) -> Result<(), String> {
    fs::create_dir_all(install_dir).map_err(|e| format!("install dir: {e}"))?;
    let mut copied_exe = false;
    for entry in fs::read_dir(staging).map_err(|e| format!("staging: {e}"))? {
        let entry = entry.map_err(|e| format!("staging: {e}"))?;
        let src = entry.path();
        if src.is_dir() {
            continue;
        }
        let dest = install_dir.join(entry.file_name());
        copy_over(&src, &dest, running_exe)?;
        if dest.extension().and_then(|s| s.to_str()).map(|s| s.eq_ignore_ascii_case("exe")) == Some(true)
        {
            copied_exe = true;
        }
    }
    if !copied_exe {
        return Err("В обновлении нет файла программы".into());
    }
    Ok(())
}

#[cfg(windows)]
fn launch_replaced_exe(exe: &Path) -> Result<(), String> {
    use std::os::windows::process::CommandExt;
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    const CREATE_NEW_PROCESS_GROUP: u32 = 0x0000_0200;
    const DETACHED_PROCESS: u32 = 0x0000_0008;
    const CREATE_BREAKAWAY_FROM_JOB: u32 = 0x0100_0000;
    let dir = exe.parent().unwrap_or(Path::new("."));
    let flags = [
        CREATE_NO_WINDOW | CREATE_NEW_PROCESS_GROUP | DETACHED_PROCESS | CREATE_BREAKAWAY_FROM_JOB,
        CREATE_NO_WINDOW | CREATE_NEW_PROCESS_GROUP | DETACHED_PROCESS,
        CREATE_NEW_PROCESS_GROUP | DETACHED_PROCESS,
    ];
    let mut last = String::from("не удалось запустить новую версию");
    for flag in flags {
        let mut cmd = Command::new("cmd.exe");
        cmd.arg("/C")
            .arg("start")
            .arg("")
            .arg("/D")
            .arg(dir)
            .arg(exe)
            .creation_flags(flag);
        match cmd.spawn() {
            Ok(_) => return Ok(()),
            Err(e) => last = e.to_string(),
        }
    }
    Err(last)
}

#[cfg(not(windows))]
fn launch_replaced_exe(_exe: &Path) -> Result<(), String> {
    Err("Автообновление поддерживается только на Windows".into())
}

fn write_helper_script(script_path: &Path) -> Result<(), String> {
    // Пути не вшиваются в файл: кириллица в UTF-8 .ps1 на WinPS 5.1 превращалась
    // в «РђС‚Р»Р°СЃ» и создавала дубликаты папки на C:\. Аргументы идут как UTF-16.
    let body = r#"param(
  [Parameter(Mandatory=$true)][string]$Install,
  [Parameter(Mandatory=$true)][string]$Staging,
  [Parameter(Mandatory=$true)][string]$TempRoot,
  [Parameter(Mandatory=$true)][string]$ExeName,
  [Parameter(Mandatory=$true)][string]$Launch,
  [Parameter(Mandatory=$true)][int]$AppPid
)
$ErrorActionPreference = 'Continue'
$logDir = 'C:\ProgramData\FireAtlas'
$log = Join-Path $logDir 'update-last.log'
function Log($m) {
  try {
    if (-not (Test-Path -LiteralPath $logDir)) { New-Item -ItemType Directory -Path $logDir -Force | Out-Null }
    Add-Content -LiteralPath $log -Value (("[{0}] {1}" -f (Get-Date -Format 'HH:mm:ss'), $m)) -Encoding UTF8
  } catch {}
}
Log 'helper start'
try { Wait-Process -Id $AppPid -Timeout 45 -ErrorAction SilentlyContinue } catch {}
Stop-Process -Id $AppPid -Force -ErrorAction SilentlyContinue
Start-Sleep -Seconds 1
$srcExe = Join-Path $Staging $ExeName
if (-not (Test-Path -LiteralPath $srcExe)) { $srcExe = Join-Path $Staging 'FireAtlas.exe' }
$copied = $false
for ($i = 0; $i -lt 12; $i++) {
  if (-not (Test-Path -LiteralPath $Install)) { New-Item -ItemType Directory -Path $Install -Force | Out-Null }
  Copy-Item -Path (Join-Path $Staging '*') -Destination $Install -Recurse -Force -ErrorAction SilentlyContinue
  if (Test-Path -LiteralPath $srcExe) {
    $targets = New-Object System.Collections.Generic.List[string]
    [void]$targets.Add((Join-Path $Install $ExeName))
    [void]$targets.Add((Join-Path $Install 'FireAtlas.exe'))
    [void]$targets.Add((Join-Path $Install 'fire-atlas.exe'))
    Get-ChildItem -LiteralPath $Install -Filter '*.exe' -ErrorAction SilentlyContinue | ForEach-Object {
      if ($_.Name -match 'FireAtlas|fire-atlas|Атлас|Atlas') { [void]$targets.Add($_.FullName) }
    }
    $targets | Select-Object -Unique | ForEach-Object {
      Copy-Item -LiteralPath $srcExe -Destination $_ -Force -ErrorAction SilentlyContinue
    }
  }
  $launch = Join-Path $Install $ExeName
  if (-not (Test-Path -LiteralPath $launch)) { $launch = Join-Path $Install 'FireAtlas.exe' }
  if ((Test-Path -LiteralPath $launch) -and ((Get-Item -LiteralPath $launch).Length -gt 1000000)) { $copied = $true; break }
  Start-Sleep -Seconds 1
}
if (-not $copied) { Log 'copy failed'; exit 1 }
$toStart = Join-Path $Install $ExeName
if (-not (Test-Path -LiteralPath $toStart)) { $toStart = Join-Path $Install 'FireAtlas.exe' }
if (-not (Test-Path -LiteralPath $toStart)) { $toStart = $Launch }
$launch = $toStart
Log ('launch ' + $launch)
try {
  $ws = New-Object -ComObject WScript.Shell
  $dirs = @(
    [Environment]::GetFolderPath('Desktop'),
    [Environment]::GetFolderPath('CommonDesktopDirectory'),
    (Join-Path $env:APPDATA 'Microsoft\Windows\Start Menu\Programs')
  )
  foreach ($dir in $dirs) {
    if (-not $dir -or -not (Test-Path -LiteralPath $dir)) { continue }
    $junk = Join-Path $dir 'FireAtlas.exe - ярлык.lnk'
    if (Test-Path -LiteralPath $junk) { Remove-Item -LiteralPath $junk -Force -ErrorAction SilentlyContinue }
    Get-ChildItem -LiteralPath $dir -Filter '*.lnk' -ErrorAction SilentlyContinue | ForEach-Object {
      try {
        $sc = $ws.CreateShortcut($_.FullName)
        if ($sc.TargetPath -and ($sc.TargetPath -like '*FireAtlas.exe*' -or $sc.TargetPath -like '*Атлас.exe*' -or $sc.TargetPath -like '*fire-atlas.exe*')) {
          $sc.TargetPath = $launch
          $sc.WorkingDirectory = $Install
          $sc.Save()
        }
      } catch {}
    }
  }
} catch {}
# Удалить дубликаты папки, появившиеся из-за кракозябр в пути (UTF-8 как CP1251).
try {
  $parent = Split-Path -Parent $Install
  $realName = Split-Path -Leaf $Install
  $utf8 = [Text.Encoding]::UTF8
  $cp1251 = [Text.Encoding]::GetEncoding(1251)
  $v1 = $cp1251.GetString($utf8.GetBytes($realName))
  $v2 = $utf8.GetString($cp1251.GetBytes($realName))
  $v3 = $cp1251.GetString($utf8.GetBytes($v1))
  $bad = @($v1, $v2, $v3) | Where-Object { $_ -and $_ -ne $realName } | Select-Object -Unique
  Get-ChildItem -LiteralPath $parent -Directory -ErrorAction SilentlyContinue | ForEach-Object {
    if ($_.FullName -eq $Install) { return }
    if ($bad -notcontains $_.Name) { return }
    if (-not (Test-Path -LiteralPath (Join-Path $_.FullName 'FireAtlas.exe'))) { return }
    Remove-Item -LiteralPath $_.FullName -Recurse -Force -ErrorAction SilentlyContinue
  }
} catch {}
$started = $false
$already = Get-Process | Where-Object { $_.Path -and ($_.Path -eq $launch) }
if ($already) { $started = $true; Log ('already running pid ' + $already.Id) }
if (-not $started) {
  try {
    $cmd = 'cmd.exe'
    $arg = '/C start "" /D "' + $Install + '" "' + $launch + '"'
    Start-Process -FilePath $cmd -ArgumentList $arg -WindowStyle Hidden | Out-Null
    $started = $true
    Log 'started via cmd start'
  } catch { Log ('start0 ' + $_.Exception.Message) }
}
if (-not $started) {
  try {
    $psi = New-Object System.Diagnostics.ProcessStartInfo
    $psi.FileName = $launch
    $psi.WorkingDirectory = $Install
    $psi.UseShellExecute = $true
    $p = [Diagnostics.Process]::Start($psi)
    if ($p) { $started = $true; Log ('started pid ' + $p.Id) }
  } catch { Log ('start1 ' + $_.Exception.Message) }
}
if (-not $started) {
  try {
    $ws2 = New-Object -ComObject WScript.Shell
    $null = $ws2.Run(('"{0}"' -f $launch), 1, $false)
    $started = $true
    Log 'started via wscript'
  } catch { Log ('start2 ' + $_.Exception.Message) }
}
if (-not $started) {
  try {
    Start-Process -FilePath explorer.exe -ArgumentList $launch | Out-Null
    Log 'started via explorer'
  } catch { Log ('start3 ' + $_.Exception.Message) }
}
Start-Sleep -Seconds 1
Remove-Item -LiteralPath $TempRoot -Recurse -Force -ErrorAction SilentlyContinue
Remove-Item -LiteralPath $PSCommandPath -Force -ErrorAction SilentlyContinue
"#;
    let mut bytes = vec![0xFF, 0xFE];
    for unit in body.encode_utf16() {
        bytes.extend_from_slice(&unit.to_le_bytes());
    }
    fs::write(script_path, bytes).map_err(|e| format!("Не удалось записать helper: {e}"))?;
    Ok(())
}

#[cfg(windows)]
fn spawn_helper_detached(
    script_path: &Path,
    staging: &Path,
    install_dir: &Path,
    temp_root: &Path,
    exe_name: &str,
    launch_path: &Path,
    pid: u32,
) -> Result<(), String> {
    use std::os::windows::process::CommandExt;
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    const CREATE_NEW_PROCESS_GROUP: u32 = 0x0000_0200;
    const DETACHED_PROCESS: u32 = 0x0000_0008;
    const CREATE_BREAKAWAY_FROM_JOB: u32 = 0x0100_0000;
    let flags = [
        CREATE_NO_WINDOW | CREATE_NEW_PROCESS_GROUP | DETACHED_PROCESS | CREATE_BREAKAWAY_FROM_JOB,
        CREATE_NO_WINDOW | CREATE_NEW_PROCESS_GROUP | DETACHED_PROCESS,
        CREATE_NO_WINDOW | CREATE_NEW_PROCESS_GROUP,
    ];
    let mut last = String::from("spawn helper");
    for flag in flags {
        let mut cmd = Command::new("cmd.exe");
        cmd.arg("/C")
            .arg("start")
            .arg("")
            .arg("/MIN")
            .arg("powershell.exe")
            .args([
                "-NoProfile",
                "-WindowStyle",
                "Hidden",
                "-ExecutionPolicy",
                "Bypass",
                "-File",
            ])
            .arg(script_path)
            .arg("-Install")
            .arg(install_dir)
            .arg("-Staging")
            .arg(staging)
            .arg("-TempRoot")
            .arg(temp_root)
            .arg("-ExeName")
            .arg(exe_name)
            .arg("-Launch")
            .arg(launch_path)
            .arg("-AppPid")
            .arg(pid.to_string())
            .creation_flags(flag);
        match cmd.spawn() {
            Ok(_) => return Ok(()),
            Err(e) => last = e.to_string(),
        }
    }
    Err(format!("Не удалось запустить установщик обновления: {last}"))
}

#[cfg(not(windows))]
fn spawn_helper_detached(
    _script_path: &Path,
    _staging: &Path,
    _install_dir: &Path,
    _temp_root: &Path,
    _exe_name: &str,
    _launch_path: &Path,
    _pid: u32,
) -> Result<(), String> {
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

    let pid = std::process::id();
    let preferred_root = PathBuf::from(r"C:\ProgramData\FireAtlas").join(format!("update-{pid}"));
    let temp_root = if fs::create_dir_all(&preferred_root).is_ok() {
        preferred_root
    } else {
        let fallback = std::env::temp_dir().join(format!("fireatlas-update-{pid}"));
        let _ = fs::remove_dir_all(&fallback);
        fs::create_dir_all(&fallback).map_err(|e| format!("temp dir: {e}"))?;
        fallback
    };
    let _ = fs::create_dir_all(&temp_root);
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

    // Главное: подменить exe ДО выхода. Иначе Windows убивает helper вместе с приложением
    // и на диске остаётся старая версия.
    copy_staging_into(&staging_effective, &install_dir, &current_exe)?;
    let launch_exe = if install_dir.join(&exe_name).is_file() {
        install_dir.join(&exe_name)
    } else {
        install_dir.join("FireAtlas.exe")
    };

    // Helper в ASCII-пути: кириллица в %TEMP% под пользователем «Админ» ломала старые скрипты.
    let script_path = {
        let ascii_dir = PathBuf::from(r"C:\ProgramData\FireAtlas");
        if fs::create_dir_all(&ascii_dir).is_ok() {
            ascii_dir.join(format!("update-fireatlas-{}.ps1", std::process::id()))
        } else {
            std::env::temp_dir().join(format!("update-fireatlas-{}.ps1", std::process::id()))
        }
    };
    let helper_exe = if staging_effective.join(&exe_name).is_file() {
        exe_name.as_str()
    } else {
        "FireAtlas.exe"
    };
    write_helper_script(&script_path)?;
    let _ = spawn_helper_detached(
        &script_path,
        &staging_effective,
        &install_dir,
        &temp_root,
        helper_exe,
        &launch_exe,
        std::process::id(),
    );
    let _ = launch_replaced_exe(&launch_exe);

    std::thread::sleep(std::time::Duration::from_millis(800));
    app.exit(0);
    Ok(())
}

/// Удаляет ярлыки, которые старый updater сам создавал на рабочем столе.
pub fn cleanup_spurious_shortcuts() {
    let mut dirs: Vec<PathBuf> = Vec::new();
    if let Ok(home) = std::env::var("USERPROFILE") {
        dirs.push(PathBuf::from(home).join("Desktop"));
    }
    dirs.push(PathBuf::from(r"C:\Users\Public\Desktop"));
    if let Ok(appdata) = std::env::var("APPDATA") {
        dirs.push(
            PathBuf::from(appdata).join(r"Microsoft\Windows\Start Menu\Programs"),
        );
    }
    const JUNK: &[&str] = &[
        "FireAtlas.exe - ярлык.lnk",
        "FireAtlas.exe - Shortcut.lnk",
    ];
    for dir in dirs {
        for name in JUNK {
            let _ = fs::remove_file(dir.join(name));
        }
    }
}

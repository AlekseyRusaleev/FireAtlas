//! Проверка и установка обновлений с geo.infocardmchs.ru.
//!
//! Манифест и UI одинаковы на всех ОС, различается только способ установки:
//! * **Windows** — portable ZIP + helper `.cmd` (подменяет файлы в папке программы
//!   после выхода процесса, т.к. Windows держит запущенный EXE).
//! * **Linux** — AppImage (или portable-бинарник) + helper `.sh`, который дожидается
//!   выхода процесса и подменяет файл атомарным `mv`.
//!
//! В манифесте `portable`/`installer` — сборки для Windows (исторический формат),
//! `portableLinux`/`installerLinux` — сборки для Linux. Клиент всегда выбирает
//! артефакт под свою ОС и никогда не тянет чужой EXE.

use hex::encode as hex_encode;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::fs::{self, File};
use std::io::copy;
use std::path::{Path, PathBuf};
use std::process::Command;

#[cfg(windows)]
use std::path::Component;
#[cfg(windows)]
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
    /// Windows portable ZIP (историческое поле, используется и установщик).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub portable: Option<PortableArtifact>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub installer: Option<PortableArtifact>,
    /// Linux portable-сборка (одиночный бинарник, обновляется на месте).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub portable_linux: Option<PortableArtifact>,
    /// Linux AppImage (обновляется, если приложение запущено из AppImage).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub appimage_linux: Option<PortableArtifact>,
    /// Linux .deb (только для ручной установки — автообновление не применяет).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub installer_linux: Option<PortableArtifact>,
}

impl UpdateManifest {
    /// Артефакт под текущую ОС. На Linux никогда не отдаёт Windows EXE.
    fn artifact_for_this_platform(&self) -> Option<PortableArtifact> {
        #[cfg(windows)]
        {
            self.portable.clone().or_else(|| self.installer.clone())
        }
        #[cfg(target_os = "linux")]
        {
            // Форма установки определяет, какой файл подменяет helper:
            // AppImage → файл $APPIMAGE, portable → сам бинарник.
            let running_appimage = std::env::var_os("APPIMAGE").is_some();
            if running_appimage {
                self.appimage_linux
                    .clone()
                    .or_else(|| self.portable_linux.clone())
            } else {
                self.portable_linux
                    .clone()
                    .or_else(|| self.appimage_linux.clone())
            }
        }
        #[cfg(not(any(windows, target_os = "linux")))]
        {
            None
        }
    }
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
    let mut latest = fetch_manifest()?;
    if !is_newer(&latest.version, &current) {
        return Ok(UpdateCheckResult {
            current_version: current,
            update_available: false,
            latest: None,
        });
    }

    match latest.artifact_for_this_platform() {
        Some(artifact) => {
            // UI получает уже готовый для этой ОС артефакт в поле `portable`.
            latest.portable = Some(artifact);
            latest.installer = None;
            latest.portable_linux = None;
            latest.appimage_linux = None;
            latest.installer_linux = None;
            Ok(UpdateCheckResult {
                current_version: current,
                update_available: true,
                latest: Some(latest),
            })
        }
        // Версия новее, но сборки под эту ОС в манифесте нет — обновляться нечем.
        None => Ok(UpdateCheckResult {
            current_version: current,
            update_available: false,
            latest: None,
        }),
    }
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

/// Скачать обновление, проверить sha256 и перезапустить приложение новой версией.
pub fn download_and_apply_update(
    app: tauri::AppHandle,
    url: String,
    sha256: String,
) -> Result<(), String> {
    let expected = normalize_sha256(&sha256);
    if expected.len() != 64 || !expected.chars().all(|c| c.is_ascii_hexdigit()) {
        return Err("Некорректный SHA-256 в манифесте обновления".into());
    }

    let current_exe = std::env::current_exe().map_err(|e| format!("current_exe: {e}"))?;
    let temp_root = std::env::temp_dir().join(format!("fireatlas-update-{}", std::process::id()));
    let _ = fs::remove_dir_all(&temp_root);
    fs::create_dir_all(&temp_root).map_err(|e| format!("temp dir: {e}"))?;

    #[cfg(windows)]
    {
        apply_update_windows(app, &url, &expected, &current_exe, &temp_root)
    }
    #[cfg(target_os = "linux")]
    {
        apply_update_linux(app, &url, &expected, &current_exe, &temp_root)
    }
    #[cfg(not(any(windows, target_os = "linux")))]
    {
        let _ = (app, &url, &expected, &current_exe, &temp_root);
        Err("Автообновление поддерживается только на Windows и Linux".into())
    }
}

// ---------------------------------------------------------------------------
// Windows: portable ZIP + .cmd helper
// ---------------------------------------------------------------------------

#[cfg(windows)]
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

#[cfg(windows)]
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

#[cfg(windows)]
fn write_windows_helper(
    script_path: &Path,
    pid: u32,
    staging: &Path,
    install_dir: &Path,
    exe_name: &str,
    temp_root: &Path,
) -> Result<(), String> {
    let staging_s = staging.display().to_string().replace('/', "\\");
    let install_s = install_dir.display().to_string().replace('/', "\\");
    let temp_root_s = temp_root.display().to_string().replace('/', "\\");
    let exe_path = install_dir.join(exe_name);
    let exe_s = exe_path.display().to_string().replace('/', "\\");
    // cmd helper: wait for process, copy files, relaunch, remove staging leftovers.
    // Script lives outside temp_root so rmdir can delete the whole update folder.
    let body = format!(
        "@echo off\r\n\
setlocal\r\n\
rem FireAtlas portable updater\r\n\
timeout /t 2 /nobreak >nul\r\n\
taskkill /PID {pid} /F >nul 2>&1\r\n\
timeout /t 1 /nobreak >nul\r\n\
xcopy /Y /E /I /Q \"{staging}\\*\" \"{install}\\\" >nul\r\n\
if errorlevel 1 (\r\n\
  echo Update copy failed\r\n\
  pause\r\n\
  exit /b 1\r\n\
)\r\n\
start \"\" \"{exe}\"\r\n\
rmdir /s /q \"{temp_root}\" >nul 2>&1\r\n\
endlocal\r\n\
del \"%~f0\" >nul 2>&1\r\n",
        pid = pid,
        staging = staging_s,
        install = install_s,
        exe = exe_s,
        temp_root = temp_root_s
    );
    fs::write(script_path, body).map_err(|e| format!("Не удалось записать helper: {e}"))?;
    Ok(())
}

#[cfg(windows)]
fn apply_update_windows(
    app: tauri::AppHandle,
    url: &str,
    expected: &str,
    current_exe: &Path,
    temp_root: &Path,
) -> Result<(), String> {
    let install_dir = current_exe
        .parent()
        .ok_or_else(|| "Не удалось определить папку программы".to_string())?
        .to_path_buf();
    let exe_name = current_exe
        .file_name()
        .and_then(|s| s.to_str())
        .unwrap_or("FireAtlas.exe")
        .to_string();

    let zip_path = temp_root.join("update.zip");
    let staging = temp_root.join("staging");

    download_to_file(url, &zip_path)?;
    let actual = sha256_file(&zip_path)?;
    if actual != expected {
        let _ = fs::remove_dir_all(temp_root);
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
        found.unwrap_or_else(|| staging.clone())
    };

    // Helper вне temp_root — иначе Windows не даст удалить папку со скриптом внутри.
    let script_path = std::env::temp_dir().join(format!("update-fireatlas-{}.cmd", std::process::id()));
    write_windows_helper(
        &script_path,
        std::process::id(),
        &staging_effective,
        &install_dir,
        if staging_effective.join(&exe_name).is_file() {
            &exe_name
        } else {
            "FireAtlas.exe"
        },
        temp_root,
    )?;
    spawn_helper_detached(&script_path)?;

    // Дать helper стартовать, затем закрыть приложение
    std::thread::sleep(std::time::Duration::from_millis(400));
    app.exit(0);
    Ok(())
}

// ---------------------------------------------------------------------------
// Linux: AppImage / portable binary + .sh helper
// ---------------------------------------------------------------------------

#[cfg(target_os = "linux")]
fn shell_quote(s: &str) -> String {
    format!("'{}'", s.replace('\'', "'\\''"))
}

#[cfg(target_os = "linux")]
fn can_replace(target: &Path) -> bool {
    let dir = target.parent().unwrap_or_else(|| Path::new("/"));
    let probe = dir.join(format!(".fireatlas-write-test-{}", std::process::id()));
    match File::create(&probe) {
        Ok(_) => {
            let _ = fs::remove_file(&probe);
            true
        }
        Err(_) => false,
    }
}

#[cfg(target_os = "linux")]
fn write_linux_helper(
    script_path: &Path,
    pid: u32,
    new_file: &Path,
    target: &Path,
    launch: &Path,
    temp_root: &Path,
) -> Result<(), String> {
    // Дожидаемся выхода процесса и атомарно подменяем файл (`mv` в пределах ФС,
    // иначе — копирование). Затем запускаем новую версию и убираем мусор.
    let body = format!(
        "#!/bin/sh\n\
# FireAtlas portable updater (Linux)\n\
sleep 2\n\
kill {pid} 2>/dev/null || true\n\
sleep 1\n\
chmod +x {new} 2>/dev/null || true\n\
if ! mv -f {new} {target} 2>/dev/null; then\n\
  cp -f {new} {target} || exit 1\n\
fi\n\
chmod +x {target} 2>/dev/null || true\n\
setsid {launch} >/dev/null 2>&1 &\n\
rm -rf {temp}\n\
rm -f \"$0\"\n",
        pid = pid,
        new = shell_quote(&new_file.display().to_string()),
        target = shell_quote(&target.display().to_string()),
        launch = shell_quote(&launch.display().to_string()),
        temp = shell_quote(&temp_root.display().to_string()),
    );
    fs::write(script_path, body).map_err(|e| format!("Не удалось записать helper: {e}"))?;
    use std::os::unix::fs::PermissionsExt;
    fs::set_permissions(script_path, fs::Permissions::from_mode(0o755))
        .map_err(|e| format!("Не удалось сделать helper исполняемым: {e}"))?;
    Ok(())
}

#[cfg(target_os = "linux")]
fn apply_update_linux(
    app: tauri::AppHandle,
    url: &str,
    expected: &str,
    current_exe: &Path,
    temp_root: &Path,
) -> Result<(), String> {
    // Если приложение запущено из AppImage, настоящий файл лежит в $APPIMAGE,
    // а current_exe указывает внутрь смонтированного образа.
    let appimage = std::env::var_os("APPIMAGE")
        .map(PathBuf::from)
        .filter(|p| p.is_file());

    let (target, launch) = match appimage {
        Some(ai) => (ai.clone(), ai),
        None => {
            // Portable-бинарник: подменяем сам исполняемый файл.
            (current_exe.to_path_buf(), current_exe.to_path_buf())
        }
    };

    if !can_replace(&target) {
        return Err(format!(
            "Нет прав на запись в «{}». \
             Установите portable-сборку в домашнюю папку (scripts/install-fireatlas-linux.sh) \
             либо обновите .deb вручную — тогда автообновление сработает.",
            target.display()
        ));
    }

    let file_name = url
        .rsplit('/')
        .next()
        .filter(|s| !s.is_empty())
        .unwrap_or("FireAtlas-linux-update")
        .to_string();
    let download_path = temp_root.join(&file_name);

    download_to_file(url, &download_path)?;
    let actual = sha256_file(&download_path)?;
    if actual != expected {
        let _ = fs::remove_dir_all(temp_root);
        return Err(format!(
            "Контрольная сумма не совпала (ожидалось {expected}, получено {actual})"
        ));
    }

    let script_path =
        std::env::temp_dir().join(format!("update-fireatlas-{}.sh", std::process::id()));
    write_linux_helper(
        &script_path,
        std::process::id(),
        &download_path,
        &target,
        &launch,
        temp_root,
    )?;
    spawn_helper_detached(&script_path)?;

    std::thread::sleep(std::time::Duration::from_millis(400));
    app.exit(0);
    Ok(())
}

// ---------------------------------------------------------------------------
// Detached helpers
// ---------------------------------------------------------------------------

#[cfg(windows)]
fn spawn_helper_detached(script_path: &Path) -> Result<(), String> {
    use std::os::windows::process::CommandExt;
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    const DETACHED_PROCESS: u32 = 0x0000_0008;
    Command::new("cmd.exe")
        .args(["/C", &script_path.to_string_lossy()])
        .creation_flags(CREATE_NO_WINDOW | DETACHED_PROCESS)
        .spawn()
        .map_err(|e| format!("Не удалось запустить установщик обновления: {e}"))?;
    Ok(())
}

#[cfg(unix)]
fn spawn_helper_detached(script_path: &Path) -> Result<(), String> {
    use std::process::Stdio;
    let spawn = |program: &str, args: &[&std::ffi::OsStr]| {
        Command::new(program)
            .args(args)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
    };
    // setsid отвязывает helper от сессии приложения; если его нет — запускаем напрямую.
    let sh = std::ffi::OsStr::new("/bin/sh");
    let res = spawn("setsid", &[sh, script_path.as_os_str()]);
    match res {
        Ok(_) => Ok(()),
        Err(_) => {
            spawn("/bin/sh", &[script_path.as_os_str()])
                .map_err(|e| format!("Не удалось запустить установщик обновления: {e}"))?;
            Ok(())
        }
    }
}


#[cfg(test)]
mod tests {
    use super::*;

    const MANIFEST: &str = r#"{
      "version": "0.1.45",
      "notes": "test",
      "publishedAt": "2026-09-15",
      "portable": {"url": "https://example/win-portable.zip", "sha256": "aa"},
      "installer": {"url": "https://example/win-setup.exe", "sha256": "ab"},
      "portableLinux": {"url": "https://example/fireatlas-linux", "sha256": "bb"},
      "appimageLinux": {"url": "https://example/fireatlas-linux.AppImage", "sha256": "cc"},
      "installerLinux": {"url": "https://example/fireatlas-linux.deb", "sha256": "dd"}
    }"#;

    #[test]
    fn parses_manifest_with_all_platforms() {
        let m: UpdateManifest = serde_json::from_str(MANIFEST).expect("manifest");
        assert_eq!(m.version, "0.1.45");
        assert!(m.portable.is_some());
        assert!(m.installer.is_some());
        assert!(m.portable_linux.is_some());
        assert!(m.appimage_linux.is_some());
        assert!(m.installer_linux.is_some());
    }

    #[test]
    fn semver_comparison() {
        assert!(is_newer("0.1.45", "0.1.44"));
        assert!(is_newer("1.0.0", "0.9.9"));
        assert!(!is_newer("0.1.44", "0.1.44"));
        assert!(!is_newer("0.1.43", "0.1.44"));
    }

    #[test]
    fn old_manifest_without_linux_fields_still_parses() {
        let m: UpdateManifest = serde_json::from_str(
            r#"{"version":"0.1.1","portable":{"url":"https://example/a.zip","sha256":"aa"}}"#,
        )
        .expect("old manifest");
        assert!(m.portable.is_some());
        assert!(m.portable_linux.is_none());
        assert!(m.appimage_linux.is_none());
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn linux_never_selects_windows_artifact() {
        let m: UpdateManifest = serde_json::from_str(MANIFEST).expect("manifest");
        let a = m.artifact_for_this_platform().expect("linux artifact");
        assert!(!a.url.ends_with(".zip"), "must not pick Windows ZIP: {}", a.url);
        assert!(!a.url.ends_with(".exe"), "must not pick Windows EXE: {}", a.url);
        assert!(a.url.contains("linux"), "unexpected url: {}", a.url);
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn shell_quote_escapes_quotes() {
        assert_eq!(shell_quote("a'b c"), "'a'\\''b c'");
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn linux_helper_script_is_valid_shell() {
        let root = std::env::temp_dir().join(format!("fireatlas-shcheck-{}", std::process::id()));
        let _ = fs::remove_dir_all(&root);
        fs::create_dir_all(&root).unwrap();
        let script = root.join("u.sh");
        write_linux_helper(
            &script,
            1,
            &root.join("new file"),
            &root.join("t'x"),
            &root.join("launch'x"),
            &root.join("tmp dir"),
        )
        .unwrap();
        let out = Command::new("sh").arg("-n").arg(&script).output().unwrap();
        assert!(
            out.status.success(),
            "sh -n: {}",
            String::from_utf8_lossy(&out.stderr)
        );
        let _ = fs::remove_dir_all(&root);
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn linux_helper_replaces_target_and_relaunches() {
        let root = std::env::temp_dir().join(format!("fireatlas-helper-{}", std::process::id()));
        let _ = fs::remove_dir_all(&root);
        let temp_root = root.join("update");
        fs::create_dir_all(&temp_root).unwrap();

        let new_file = temp_root.join("new");
        fs::write(&new_file, b"NEW").unwrap();
        let target = root.join("FireAtlas");
        fs::write(&target, b"OLD").unwrap();
        let launch = root.join("launch.sh");
        fs::write(&launch, b"#!/bin/sh\ntouch \"$0.launched\"\n").unwrap();
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(&launch, fs::Permissions::from_mode(0o755)).unwrap();
        let script = root.join("helper.sh");

        write_linux_helper(&script, 999_999, &new_file, &target, &launch, &temp_root).unwrap();
        let status = Command::new("sh").arg(&script).status().unwrap();
        assert!(status.success(), "helper exited with {status}");
        assert_eq!(fs::read(&target).unwrap(), b"NEW");
        assert!(!temp_root.exists(), "temp dir not removed");
        assert!(!script.exists(), "helper script not removed");

        std::thread::sleep(std::time::Duration::from_millis(800));
        assert!(
            root.join("launch.sh.launched").exists(),
            "relaunch did not run"
        );
        let _ = fs::remove_dir_all(&root);
    }
}

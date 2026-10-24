# Канал обновлений FireAtlas

Публичный манифест и сборки:

- `https://geo.infocardmchs.ru/updates/latest.json`
- Windows: `FireAtlas-Setup.exe`, `FireAtlas-<версия>-portable.zip`
- Linux: `FireAtlas-<версия>-linux-x86_64` (portable), `...AppImage`, `...deb`

Клиент при старте читает `latest.json`, сравнивает `version` с локальной и
предлагает обновление (баннер и кнопка в «О программе»). Артефакт выбирается
под ОС и форму установки:

| Поле манифеста | ОС / форма | Что делает клиент |
|----------------|-----------|-------------------|
| `portable` / `installer` | Windows | portable ZIP: helper закрывает процесс, копирует файлы, запускает EXE |
| `portableLinux` | Linux portable-бинарник | helper подменяет сам бинарник (`mv`) и перезапускает |
| `appimageLinux` | Linux AppImage (`$APPIMAGE`) | helper подменяет файл AppImage и перезапускает |
| `installerLinux` | Linux `.deb` | только ручная установка (`sudo apt install ./…deb`) |

`.deb`-установка лежит в `/usr/bin` и недоступна для записи без root, поэтому
автообновление для неё не применяется — обновляйтесь новым `.deb`.

## На сервере (один раз)

```bash
sudo mkdir -p /var/www/fireatlas-updates
sudo chown -R www-data:www-data /var/www/fireatlas-updates
```

В Nginx для `geo.infocardmchs.ru` (HTTPS server-блок) добавить:

```nginx
location /updates/ {
    alias /var/www/fireatlas-updates/;
    autoindex off;
    add_header Cache-Control "no-cache";
}
```

Затем: `sudo nginx -t && sudo systemctl reload nginx`

## Выкладка релиза (Windows)

1. Поднять версию в `package.json`, `src-tauri/Cargo.toml`, `src-tauri/tauri.conf.json`.
2. Собрать portable: `npm run tauri:build`, скопировать `FireAtlas.exe` в `dist-app/FireAtlas-portable/`, сделать ZIP.
3. Посчитать хеш:

```powershell
# Windows PowerShell
Get-FileHash .\FireAtlas-0.1.1-portable.zip -Algorithm SHA256
```

4. Положить ZIP, `FireAtlas-Setup.exe` и `latest.json` в `/var/www/fireatlas-updates/`.

## Выкладка релиза (Linux)

1. Собрать на Linux: `./scripts/build-linux.sh --deps`.
   Артефакты появятся в `dist-linux/` и получат ASCII-имена
   `FireAtlas-<версия>-linux-x86_64[.AppImage|.deb]`.
2. Скопировать на сервер (по SSH) `FireAtlas-…` (portable), `….AppImage`, `….deb`.
3. Посчитать хеши: `sha256sum /var/www/fireatlas-updates/FireAtlas-<версия>-linux-x86_64*`

## Шаблон `latest.json`

```json
{
  "version": "0.1.45",
  "notes": "Что нового.",
  "publishedAt": "2026-09-15",
  "portable": {
    "url": "https://geo.infocardmchs.ru/updates/FireAtlas-0.1.45-portable.zip",
    "sha256": "…"
  },
  "installer": {
    "url": "https://geo.infocardmchs.ru/updates/FireAtlas-Setup.exe",
    "sha256": "…"
  },
  "portableLinux": {
    "url": "https://geo.infocardmchs.ru/updates/FireAtlas-0.1.45-linux-x86_64",
    "sha256": "…"
  },
  "appimageLinux": {
    "url": "https://geo.infocardmchs.ru/updates/FireAtlas-0.1.45-linux-x86_64.AppImage",
    "sha256": "…"
  },
  "installerLinux": {
    "url": "https://geo.infocardmchs.ru/updates/FireAtlas-0.1.45-linux-x86_64.deb",
    "sha256": "…"
  }
}
```

5. `sudo chown www-data:www-data /var/www/fireatlas-updates/*`

`sha256` — нижний регистр hex без пробелов. Клиент сверяет его после загрузки и
перед установкой; при несовпадении обновление отменяется.

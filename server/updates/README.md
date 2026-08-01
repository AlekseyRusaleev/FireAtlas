# Канал обновлений FireAtlas

Публичный манифест и ZIP-сборки:

- `https://geo.infocardmchs.ru/updates/latest.json`
- `https://geo.infocardmchs.ru/updates/FireAtlas-<версия>-portable.zip`

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

## Выкладка нового релиза

1. Поднять версию в `package.json`, `src-tauri/Cargo.toml`, `src-tauri/tauri.conf.json`.
2. Собрать portable: `npm run tauri:build`, скопировать `FireAtlas.exe` в `dist-app/FireAtlas-portable/`, сделать ZIP.
3. Посчитать хеш:

```bash
# Windows PowerShell
Get-FileHash .\FireAtlas-0.1.1-portable.zip -Algorithm SHA256

# Linux
sha256sum FireAtlas-0.1.1-portable.zip
```

4. Положить ZIP и `latest.json` в `/var/www/fireatlas-updates/`:

```bash
sudo cp FireAtlas-0.1.1-portable.zip latest.json /var/www/fireatlas-updates/
sudo chown www-data:www-data /var/www/fireatlas-updates/*
```

5. В `latest.json` указать точный `version`, `url` и `sha256` (нижний регистр hex без пробелов).

Клиент при старте читает `latest.json`, сравнивает версию и предлагает обновить portable-сборку.

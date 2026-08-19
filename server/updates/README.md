# Канал обновлений FireAtlas

Публичные файлы:

- `https://geo.infocardmchs.ru/updates/latest.json`
- `https://geo.infocardmchs.ru/updates/FireAtlas-Setup.exe` — установщик для **новых** компьютеров (всегда последняя версия)
- `https://geo.infocardmchs.ru/updates/FireAtlas-<версия>-setup.exe` — тот же установщик с номером версии
- `https://geo.infocardmchs.ru/updates/FireAtlas-<версия>-portable.zip` — для кнопки «Обновить» в уже установленной программе

Новым пользователям отдавайте **установщик**, не рабочую папку с `FireData` и настройками.

Установщик кладёт `FireAtlas.exe` и `WebView2Loader.dll` в `%LOCALAPPDATA%\FireAtlas\` и при необходимости ставит Microsoft Edge WebView2 Runtime (встроенный bootstrapper). Без DLL Windows показывает ошибку «не обнаружила WebView2Loader.dll».

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
2. Собрать NSIS: `node node_modules/@tauri-apps/cli/tauri.js build --bundles nsis`.
   Установщик: `FireAtlas_<версия>_x64-setup.exe`.
3. Portable ZIP: `FireAtlas.exe` + копия `fire-atlas.exe` + `WebView2Loader.dll`.
4. Посчитать хеш ZIP и setup.exe:

```powershell
Get-FileHash .\FireAtlas-0.1.33-portable.zip -Algorithm SHA256
Get-FileHash .\FireAtlas-0.1.33-setup.exe -Algorithm SHA256
```

5. Положить файлы в `/var/www/fireatlas-updates/`:

```bash
sudo cp FireAtlas-0.1.33-portable.zip FireAtlas-0.1.33-setup.exe FireAtlas-Setup.exe latest.json /var/www/fireatlas-updates/
sudo chown www-data:www-data /var/www/fireatlas-updates/*
```

`FireAtlas-Setup.exe` — копия текущего setup (стабильная ссылка).

6. В `latest.json` указать `version`, `portable` и `installer` (`url` + `sha256`, hex в нижнем регистре).

Клиент при старте читает `latest.json` и обновляет **уже установленную** копию через portable ZIP. Установщик нужен только для первой установки на новом ПК.

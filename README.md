# Пожарный Атлас

Настольное offline-first приложение для диспетчеров пожарной охраны: поиск водоисточников по KML/KMZ, карточки тушения, карта, единый поиск.

## Стек

- **Tauri 2** (Rust) — лёгкий desktop runtime
- **React + TypeScript + Vite** — UI
- **SQLite + FTS5** — индекс и мгновенный поиск
- **Leaflet / OpenStreetMap** — карта в MVP (поля ключей Яндекс/2ГИС уже в настройках)

## Быстрый старт

### Требования

- Windows 10/11
- [Node.js](https://nodejs.org/) 20+
- [Rust](https://rustup.rs/) (stable)
- WebView2 (обычно уже есть в Windows 10/11)

### Установка и запуск

```bash
npm install
npm run tauri:dev
```

Сборка установщика:

```bash
npm run tauri:build
```

Артефакты: `src-tauri/target/release/` и папка `bundle`.

## Структура базы на диске

В настройках укажите корневую папку, например `D:\FireData`:

```
FireData/
├── KMZ/                 # или Maps / WaterSources
│   ├── district1.kmz
│   └── district2.kml
└── KTP/                 # или Cards
    ├── Школа №15/
    │   ├── карточка.docx
    │   ├── схема.vsdx
    │   └── фото.jpg
    └── Больница/
        └── ...
```

После указания пути нажмите **Переиндексировать**. Приложение создаст локальный `atlas.db` в AppData.

## Возможности MVP

- Импорт KML/KMZ, определение типа ВО (гидрант / водоём / башня / пирс)
- Индекс карточек из папок `/KTP`
- Единый поиск (FTS5) по названию, адресу, номеру, тексту docx
- Карта OSM с фильтрами и маркерами
- Ближайшие водоисточники
- Просмотр JPG/PDF внутри приложения; Word/Visio — открытие внешне (встроенный рендер — следующий этап)
- Избранное и история
- Горячие клавиши: `Ctrl+F` поиск, `F2` карта

## Репозиторий

SSH-ключ для деплоя/доступа уже можно использовать:

`~/.ssh/id_ed25519_fireatlas.pub`

```bash
git init
git add .
git commit -m "Initial commit: Пожарный Атлас MVP"
git remote add origin git@github.com:<org>/FireAtlas.git
git push -u origin main
```

## Дальше по плану

1. Провайдеры Яндекс Maps / 2ГИС по ключу
2. File watcher и частичная переиндексация
3. Встроенный рендер Word→PDF и превью Visio
4. Offline-кэш тайлов
5. Задел под серверную синхронизацию (Offline First)

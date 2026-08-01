# Иконка «Пожарный Атлас»

**Утверждено:** вариант **02b** — щит + маршрут + пожарная машина + пламя.

## Master (`master/`)

| Файл | Размер | Назначение |
|------|--------|------------|
| `fireatlas-app-1024x1024.png` | 1024×1024 | основной знак (ПК, телефон, стор, VK) |
| `fireatlas-app-1024x1024-opaque.png` | 1024×1024 | то же без прозрачности |
| `fireatlas-app-1024x1024-source.png` | 1024×1024 | исходник до скругления углов |
| `fireatlas-favicon-simple-1024x1024.png` | 1024×1024 | упрощённый twin → из него режут favicon 16–48 |
| `fireatlas-icon-1024x1024.svg` | viewBox 1024 | приблизительный вектор (истина — PNG) |
| `fireatlas-logo-shield-{N}x{N}.png` | 128…1024 | **экран входа** — только щит, прозрачный фон |
| `fireatlas-logo-shield-on-light-{N}x{N}.png` | 128…1024 | то же на светло-сером фоне авторизации |
| `_archive-flamepin-rejected-1024x1024.png` | 1024×1024 | архив, отклонённый концепт |

## Экспорты

| Папка | Файлы |
|-------|--------|
| `exports/tauri/` | → уже в `src-tauri/icons/` через `tauri icon` |
| `exports/rustore/` | `icon-512.png`, `icon-1024.png` |
| `exports/web/` | favicon 16/32/48 (simple), apple-touch 180, 192, 512 |
| `exports/vk/` | avatar 400/700, cover |

## Пересборка

```bash
py -3 brand/fireatlas-icon/scripts/build_approved_02b.py
npx tauri icon brand/fireatlas-icon/exports/tauri/app-icon-1024.png
```

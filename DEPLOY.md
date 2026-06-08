# Публикация на GitHub Pages

Сайт: https://designerdianak.github.io/ony-type-lab/

## Один репозиторий

Открывайте в Cursor **корень** `ony-type-lab`, не папку `ony-type-lab/ony-type-lab` внутри.  
Не клонируйте репозиторий внутрь проекта — иначе два `.git` и push уходит не туда.

## Почему был белый экран

GitHub отдавал **исходный** `index.html` (`/src/main.tsx`), а не собранное приложение. Нужна папка `docs/` или деплой через Actions.

## Один раз в настройках репозитория

1. Откройте https://github.com/designerdianak/ony-type-lab/settings/pages  
2. **Build and deployment → Source:** **GitHub Actions** (не «Deploy from a branch /docs»)  

Если стоит деплой из папки `/docs` на ветке `main`, сайт будет отдавать **старый** бандл, пока вы вручную не запустите `npm run build:pages` и не запушите `docs/`.

## Как обновить сайт

### Вариант A — GitHub Desktop (без терминала)

1. Скачайте [GitHub Desktop](https://desktop.github.com/)  
2. File → Add Local Repository → папка `ony-type-lab`  
3. Увидите изменения → **Commit to main** → **Push origin**

### Вариант B — Cursor

1. Панель Source Control (иконка ветки)  
2. Stage → Commit → **Push** (или Sync)

### Вариант C — терминал (если Pages всё ещё из `/docs`)

```bash
cd ony-type-lab
npm run build:pages
git add docs
git commit -m "deploy: update docs for GitHub Pages"
git push origin main
```

При **GitHub Actions** как source достаточно пуша в `main` — workflow сам соберёт `docs/` и задеплоит.

После push подождите 1–2 минуты и обновите страницу с **Cmd+Shift+R** (жёсткое обновление, без кэша).

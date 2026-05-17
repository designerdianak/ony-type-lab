# Публикация на GitHub Pages

Сайт: https://designerdianak.github.io/ony-type-lab/

## Почему был белый экран

GitHub отдавал **исходный** `index.html` (`/src/main.tsx`), а не собранное приложение. Нужна папка `docs/` или деплой через Actions.

## Один раз в настройках репозитория

1. Откройте https://github.com/designerdianak/ony-type-lab/settings/pages  
2. **Build and deployment → Source:** Deploy from a branch  
3. **Branch:** `main` → папка **`/docs`** → Save  

(Либо Source: **GitHub Actions**, если пушите workflow.)

## Как обновить сайт

### Вариант A — GitHub Desktop (без терминала)

1. Скачайте [GitHub Desktop](https://desktop.github.com/)  
2. File → Add Local Repository → папка `ony-type-lab`  
3. Увидите изменения → **Commit to main** → **Push origin**

### Вариант B — Cursor

1. Панель Source Control (иконка ветки)  
2. Stage → Commit → **Push** (или Sync)

### Вариант C — терминал

```bash
cd ony-type-lab
npm run build:pages
git add docs package.json vite.config.ts src .github
git commit -m "deploy: update docs for GitHub Pages"
git push origin main
```

После push подождите 1–2 минуты и обновите страницу с **Cmd+Shift+R**.

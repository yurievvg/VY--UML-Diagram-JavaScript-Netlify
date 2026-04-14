# UML JS + Netlify

Веб-приложение для генерации UML-диаграмм (PlantUML) через YandexGPT.

## Стек

- Frontend: `index.html`, `style.css`, `app.js`
- Backend: Netlify Function `netlify/functions/generate.js`
- Деплой: Netlify

## Требования

- Node.js 18+
- npm
- Аккаунт Netlify
- Доступ к YandexGPT API

## Переменные окружения

Пример (файл `.env.example`):

```env
YANDEX_API_KEY=your_api_key_here
YANDEX_FOLDER_ID=your_folder_id_here
ACCESS_CODE=your_access_code_here
```

Описание:

- `YANDEX_API_KEY` - API-ключ Yandex Cloud для Foundation Models
- `YANDEX_FOLDER_ID` - ID каталога в Yandex Cloud
- `ACCESS_CODE` - код доступа, который вводит пользователь в форме

## Локальный запуск

1. Установите зависимости:

```bash
npm install
```

2. Создайте файл `.env` в корне проекта (по аналогии с `.env.example`).

3. Запустите локальный сервер Netlify:

```bash
npx netlify dev
```

или:

```bash
npm run dev
```

4. Откройте локальный URL, который покажет Netlify CLI (обычно `http://localhost:8888`).

## Деплой на Netlify (через UI)

1. Загрузите проект в Git-репозиторий (GitHub/GitLab/Bitbucket).
2. В Netlify нажмите **Add new site** -> **Import an existing project**.
3. Выберите репозиторий и ветку.
4. Build settings:
   - Build command: оставить пустым
   - Publish directory: `.`
5. Добавьте переменные окружения:
   - **Site configuration** -> **Environment variables** -> **Add variable**
   - Добавьте `YANDEX_API_KEY`, `YANDEX_FOLDER_ID`, `ACCESS_CODE`
6. Запустите деплой (**Deploy site**).

## Деплой через Netlify CLI

1. Авторизуйтесь:

```bash
npx netlify login
```

2. Свяжите проект с сайтом Netlify:

```bash
npx netlify link
```

3. Добавьте переменные окружения:

```bash
npx netlify env:set YANDEX_API_KEY "your_api_key_here"
npx netlify env:set YANDEX_FOLDER_ID "your_folder_id_here"
npx netlify env:set ACCESS_CODE "your_access_code_here"
```

4. Деплой в preview:

```bash
npx netlify deploy
```

5. Продакшен-деплой:

```bash
npx netlify deploy --prod
```

## Как это работает

- Frontend отправляет `POST` запрос на `/api/generate`.
- В `netlify.toml` настроен redirect на `/.netlify/functions/generate`.
- Function вызывает YandexGPT, проверяет/исправляет PlantUML и возвращает:
  - `umlText`
  - `umlImageUrl`
  - `processDescriptions`

## Важные замечания

- Не коммитьте файл `.env` в репозиторий.
- При изменении переменных окружения в Netlify обычно нужен redeploy.
- Для корректной работы функций убедитесь, что Node.js версии 18+.

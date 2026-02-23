# Render Deployment

This repo includes a Render Blueprint at `render.yaml` for:
- `novohaven-server` (Docker web service with persistent disk)
- `novohaven-client` (static site)

## 1. Create services from Blueprint

1. Push this repo to GitHub.
2. In Render, click **New +** -> **Blueprint**.
3. Connect the repository and apply `render.yaml`.

## 2. Set required env vars in Render

Set these on `novohaven-server`:
- `CLIENT_URL` = your actual static site URL (for CORS), e.g. `https://<client-name>.onrender.com`
- `OPENAI_API_KEY` / `ANTHROPIC_API_KEY` / `GOOGLE_API_KEY` (only the providers you use)

Set these on `novohaven-client`:
- `REACT_APP_API_URL` = `https://<server-name>.onrender.com/api`

## 3. Verify deployment

1. Open `https://<server-name>.onrender.com/api/health` and confirm status is `ok`.
2. Open the client URL and test login + skill/workflow execution.
3. Upload a file/image and confirm it loads from `/uploads/...`.

## Notes

- The backend uses SQLite + uploads on Render persistent disk (`/var/data`).
- Keep backend to a single instance while using SQLite.

# Zip → APK Builder

A small web app: upload a zip of an Android project (like your `TyceptApp-fixed.zip`), it pushes
the code to a GitHub repo, triggers the repo's GitHub Actions workflow, waits for the build, and
gives you a download link for the finished APK.

It relies on your project's zip already containing a working `.github/workflows/build.yml` —
which yours does.

---

## Part 1: One-time GitHub setup

### 1. Create the target repo
1. Go to https://github.com/new
2. Name it (e.g. `TyceptApp`)
3. Leave it empty — **do not** initialize with a README (this app pushes the first commit)
4. Click **Create repository**

### 2. Push something once, manually, so the repo has an initial commit on `main`
The app expects the repo/branch to already exist. Easiest way — do the very first push yourself:
```bash
unzip TyceptApp-fixed.zip
cd TyceptApp
git init
git checkout -b main
git add .
git commit -m "Initial commit"
git remote add origin https://github.com/YOURUSERNAME/TyceptApp.git
git push -u origin main
```
After this, the app will handle every future update/push automatically.

### 3. Create a Personal Access Token (PAT)
1. Go to https://github.com/settings/tokens?type=beta (fine-grained tokens)
2. Click **Generate new token**
3. Under **Repository access**, select "Only select repositories" → pick your repo
4. Under **Permissions**, grant:
   - **Contents**: Read and write
   - **Actions**: Read and write
5. Generate the token and **copy it immediately** (you won't see it again)

> Classic tokens work too (https://github.com/settings/tokens) — just check the `repo` and `workflow` scopes.

---

## Part 2: Running the app

### 1. Install dependencies
```bash
cd apk-builder
npm install
```

### 2. Configure
```bash
cp .env.example .env
```
Edit `.env`:
```
GITHUB_TOKEN=your_token_from_above
GITHUB_REPO=yourusername/TyceptApp
GITHUB_BRANCH=main
WORKFLOW_FILE=build.yml
PORT=3000
```

### 3. Start it
```bash
npm start
```
Open http://localhost:3000, upload your zip, click **Build APK**, wait — it'll show live status
and give you a download link when GitHub Actions finishes.

---

## How it works

1. **Upload** — zip is received and extracted server-side
2. **Push** — the extracted project overwrites the repo's contents and is committed + pushed
3. **Trigger** — the app calls GitHub's `workflow_dispatch` API to start the Action
4. **Poll** — the app checks the run status every few seconds
5. **Download** — once the run succeeds, it fetches the build artifact and streams it back to you

## Notes / things to know

- This builds whatever the workflow builds — for your zip, that's a **debug APK**, not signed for
  the Play Store.
- GitHub Actions minutes are limited on the free tier — fine for personal use, watch usage if this
  gets real traffic.
- The `GITHUB_TOKEN` never reaches the browser — it stays server-side the whole time.
- This is a single-process demo (jobs live in memory). If you restart the server mid-build, that
  job's status is lost — the GitHub Action itself keeps running regardless.
- For production use: put jobs in a real database/queue, add auth so random people can't push to
  your repo, and validate the zip structure before pushing.

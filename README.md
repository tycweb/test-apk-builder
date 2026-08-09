# APK Builder

Upload an Android project as a `.zip`, it gets built into an APK by GitHub
Actions, and you download the result. Built so multiple people can use the
same deployment at the same time without stepping on each other.

## What changed from the original version

**The old version had a real bug:** every build wiped the entire target
branch (`main`) and force-pushed the new project into it, then guessed which
workflow run was "yours" by picking whichever run started in the last two
minutes. If you and a friend built at close to the same time, one of you
would silently overwrite the other's files mid-build, or download the
*other person's* APK.

**Fixed by giving every build its own branch:**
- Each upload creates a throwaway branch (`build/<jobId>`) off your base
  branch and pushes only there — `main` is never touched.
- The workflow is triggered *on that branch*, and the app looks up the run
  by branch name instead of a time guess, so it can never grab the wrong
  run even if ten people build at once.
- Once a build finishes (or fails), its branch is deleted automatically so
  nothing accumulates in your repo. Job status is also forgotten after
  `JOB_TTL_MINUTES` (default 60).

Two people can now upload at the same second and each will reliably get
their own APK back.

## Setup

1. **Create a GitHub repo** to host the build workflow (can be empty).
2. Copy `example-workflow/build.yml` into that repo at
   `.github/workflows/build.yml`, and adjust the build steps if your
   project isn't a plain Gradle app (e.g. add a signing step, change the
   Java version, etc). If you already have a working build workflow, just
   make sure it has `workflow_dispatch:` as a trigger.
3. **Create a GitHub token**: Settings → Developer settings → Personal
   access tokens, with `repo` and `workflow` scopes.
4. Copy `.env.example` to `.env` and fill in `GITHUB_TOKEN` and
   `GITHUB_REPO`.
5. Install and run:
   ```bash
   npm install
   npm start
   ```
6. Open `http://localhost:3000` (or your deployed URL), upload a project
   `.zip`, and share the URL with your friend — you can both build at once.

## Notes

- The in-memory job store resets if the server restarts. For real
  multi-user traffic beyond casual use, swap `jobs` in `server.js` for a
  small database (SQLite/Redis) so jobs survive a restart.
- `MAX_UPLOAD_MB` in `.env` caps upload size (default 200 MB).
- The GitHub token never reaches the browser — downloads are proxied
  through the server.

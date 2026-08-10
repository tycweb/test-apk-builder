require('dotenv').config();
const express = require('express');
const multer = require('multer');
const AdmZip = require('adm-zip');
const simpleGit = require('simple-git');
const fetch = require('node-fetch');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');

const app = express();

const {
  GITHUB_TOKEN,
  GITHUB_REPO,          // "owner/repo"
  GITHUB_BRANCH = 'main', // base branch the workflow files live on
  WORKFLOW_FILE = 'build.yml',
  PORT = 3000,
  MAX_UPLOAD_MB = 200,
  JOB_TTL_MINUTES = 60   // how long a finished job (and its branch) stays around
} = process.env;

if (!GITHUB_TOKEN || !GITHUB_REPO) {
  console.error('Missing GITHUB_TOKEN or GITHUB_REPO in .env — see .env.example');
  process.exit(1);
}

const upload = multer({
  dest: os.tmpdir(),
  limits: { fileSize: Number(MAX_UPLOAD_MB) * 1024 * 1024 }
});

const [OWNER, REPO] = GITHUB_REPO.split('/');
const API = 'https://api.github.com';
const authHeaders = {
  Authorization: `token ${GITHUB_TOKEN}`,
  Accept: 'application/vnd.github+json',
  'User-Agent': 'apk-builder-app'
};

app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json());

// In-memory job store (fine for a single-instance demo; use a DB/queue for real traffic).
// Every job gets its own git branch, so two people building at the same time
// never overwrite each other's project files or pick up each other's run.
const jobs = {}; // jobId -> { status, message, branch, runId, artifactId, artifactName, createdAt }

function newJobId() {
  return Date.now().toString(36) + crypto.randomBytes(4).toString('hex');
}

function setJob(jobId, patch) {
  jobs[jobId] = { ...jobs[jobId], ...patch, updatedAt: Date.now() };
}

// Fallback workflow used when neither the uploaded zip NOR the base branch
// has a .github/workflows/*.yml file. This is the "make any zip work" net:
// it doesn't assume the uploaded project is CI-ready. At run time it:
//   - finds the Gradle project wherever it landed (any depth, any name of
//     top-level folder), instead of trusting a fixed path,
//   - deletes any committed local.properties, since those almost always
//     hardcode a developer's local Android SDK path (e.g. a Mac/Windows
//     path) which doesn't exist on the runner and would otherwise break
//     the build even though the project itself is fine,
//   - fixes the Gradle wrapper if it's there but broken (CRLF line endings
//     from a Windows zip, or missing the exec bit — both are extremely
//     common causes of a project that "should" build but 422s/fails),
//   - falls back to a runner-installed Gradle if there's no usable wrapper
//     at all, instead of just failing.
// This single workflow is regenerated per job (see buildFallbackWorkflowYaml)
// so it can be biased toward whatever that job's project actually contains.
function buildFallbackWorkflowYaml() {
  return `name: Build APK

on:
  push:
    branches: [ "main" ]
  workflow_dispatch:

jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - name: Checkout
        uses: actions/checkout@v4

      - name: Set up JDK 17
        uses: actions/setup-java@v4
        with:
          distribution: 'temurin'
          java-version: '17'

      - name: Set up Android SDK
        uses: android-actions/setup-android@v3

      - name: Set up Gradle
        uses: gradle/actions/setup-gradle@v4

      - name: Locate Android project
        id: locate
        run: |
          MATCH=$(find "$GITHUB_WORKSPACE" \\
            -path '*/.git' -prune -o \\
            -path '*/__MACOSX' -prune -o \\
            -path '*/node_modules' -prune -o \\
            \\( -name settings.gradle -o -name settings.gradle.kts \\) -print | head -n 1)
          if [ -z "$MATCH" ]; then
            echo "::error::No settings.gradle or settings.gradle.kts found anywhere in the uploaded project."
            exit 1
          fi
          PROJECT_DIR=$(dirname "$MATCH")
          echo "Using Gradle project at: $PROJECT_DIR"
          echo "dir=$PROJECT_DIR" >> "$GITHUB_OUTPUT"

      - name: Normalize the project for CI
        working-directory: \${{ steps.locate.outputs.dir }}
        run: |
          # A committed local.properties almost always points at a developer's
          # own machine (sdk.dir=/Users/xxx/Library/Android/sdk) and will make
          # the build fail to find the SDK on the runner even though the
          # project itself is fine. setup-android already exports ANDROID_HOME,
          # so it's safe to drop.
          rm -f local.properties

          # If a wrapper script exists, make sure it will actually run:
          # strip Windows CRLF line endings (breaks the '#!/usr/bin/env sh'
          # shebang on Linux) and set the executable bit, which zip uploads
          # frequently lose.
          if [ -f "./gradlew" ]; then
            sed -i 's/\\r$//' ./gradlew
            chmod +x ./gradlew
          fi

      - name: Build debug APK
        working-directory: \${{ steps.locate.outputs.dir }}
        run: |
          if [ -x "./gradlew" ] && [ -f "./gradle/wrapper/gradle-wrapper.properties" ]; then
            echo "Building with the project's own Gradle wrapper"
            ./gradlew assembleDebug --no-daemon
          else
            echo "No usable Gradle wrapper found — building with the runner's Gradle instead"
            gradle assembleDebug --no-daemon
          fi

      - name: Upload APK
        uses: actions/upload-artifact@v4
        with:
          name: debug-apk-\${{ github.run_id }}
          path: \${{ steps.locate.outputs.dir }}/**/build/outputs/apk/debug/*.apk
          if-no-files-found: error
`;
}

// Directories that are never the real project and should be skipped both
// when searching for it and when copying files into the build branch.
const IGNORED_DIR_NAMES = new Set(['.git', '__MACOSX', 'node_modules', '.gradle', '.idea', 'build']);

// Walks the extracted zip looking for every directory that contains
// settings.gradle or settings.gradle.kts — the actual root of a Gradle
// project can be at the top level, one level deep inside a wrapper folder
// (the common case), or buried further in if someone zipped a whole
// workspace. Rather than guess based on "is there exactly one top-level
// folder", this finds every real candidate and picks the shallowest one,
// so almost any zip shape is handled the same way GitHub Actions itself
// would locate it.
function findGradleProjectRoots(dir, depth = 0, maxDepth = 8) {
  const found = [];
  if (depth > maxDepth) return found;

  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return found;
  }

  const hasSettings = entries.some(
    (e) => e.isFile() && (e.name === 'settings.gradle' || e.name === 'settings.gradle.kts')
  );
  if (hasSettings) found.push({ dir, depth });

  for (const e of entries) {
    if (!e.isDirectory() || IGNORED_DIR_NAMES.has(e.name)) continue;
    found.push(...findGradleProjectRoots(path.join(dir, e.name), depth + 1, maxDepth));
  }
  return found;
}

// Picks the best root among candidates: shallowest wins (a settings.gradle
// closer to the top of the zip is virtually always the intended project;
// deeper matches are usually included sample/library sub-projects).
function pickProjectRoot(extractDir) {
  const candidates = findGradleProjectRoots(extractDir);
  if (candidates.length === 0) return { root: null, ambiguous: false };
  candidates.sort((a, b) => a.depth - b.depth);
  const ambiguous = candidates.length > 1 && candidates[0].depth === candidates[1].depth;
  return { root: candidates[0].dir, ambiguous };
}

// Best-effort fixes for the most common reasons a real Android/Gradle
// project fails to build once it lands on a CI runner, even though it
// builds fine on the developer's own machine:
//   - a committed local.properties hardcodes that developer's SDK path
//   - the gradlew wrapper lost its executable bit or has CRLF line endings
//     (both very common after zipping on Windows or via some zip tools)
// Doing this server-side means it's fixed even if a project brings its own
// custom workflow that doesn't already handle these.
function normalizeProjectForCI(projectRoot) {
  const localProps = path.join(projectRoot, 'local.properties');
  if (fs.existsSync(localProps)) fs.rmSync(localProps, { force: true });

  const gradlew = path.join(projectRoot, 'gradlew');
  if (fs.existsSync(gradlew)) {
    const content = fs.readFileSync(gradlew, 'utf8');
    if (content.includes('\r')) {
      fs.writeFileSync(gradlew, content.replace(/\r\n/g, '\n'), 'utf8');
    }
    fs.chmodSync(gradlew, 0o755);
  }
}

function hasWorkflowFiles(dir) {
  if (!fs.existsSync(dir)) return false;
  return fs.readdirSync(dir)
    .filter((f) => f.endsWith('.yml') || f.endsWith('.yaml'))
    .some((f) => /^\s*workflow_dispatch\s*:/m.test(fs.readFileSync(path.join(dir, f), 'utf8')));
}

// GitHub only honors workflow_dispatch for a workflow that has been
// registered via the repo's DEFAULT branch — a copy that exists only on a
// throwaway job branch is not enough, even with the trigger correctly
// declared. This runs once at boot: if the base branch doesn't already have
// .github/workflows/<WORKFLOW_FILE> WITH a workflow_dispatch trigger in it,
// a working one is committed straight there so every future dispatch (on
// any branch) actually works.
async function ensureBaseBranchWorkflow() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'apkbuild-baseinit-'));
  try {
    const remote = `https://x-access-token:${GITHUB_TOKEN}@github.com/${OWNER}/${REPO}.git`;
    await simpleGit().clone(remote, dir, ['--branch', GITHUB_BRANCH, '--single-branch', '--depth', '1']);
    const workflowsDir = path.join(dir, '.github', 'workflows');
    const targetPath = path.join(workflowsDir, WORKFLOW_FILE);

    if (fs.existsSync(targetPath)) {
      const existing = fs.readFileSync(targetPath, 'utf8');
      // Cheap but reliable check: workflow_dispatch has to appear as its own
      // key under `on:`, not just anywhere in a comment/string.
      const hasDispatchTrigger = /^\s*workflow_dispatch\s*:/m.test(existing);
      if (hasDispatchTrigger) {
        console.log(`Base branch "${GITHUB_BRANCH}" already has .github/workflows/${WORKFLOW_FILE} with workflow_dispatch — good.`);
        return;
      }
      console.warn(
        `WARNING: .github/workflows/${WORKFLOW_FILE} exists on "${GITHUB_BRANCH}" but has NO workflow_dispatch trigger. ` +
        `This is exactly what causes the 422 "does not have workflow_dispatch trigger" error. Replacing it with a working default now.`
      );
    } else {
      console.warn(
        `WARNING: .github/workflows/${WORKFLOW_FILE} was missing entirely on "${GITHUB_BRANCH}". ` +
        `Committing a default one now — dispatches would 422 until this exists on the default branch.`
      );
    }

    fs.mkdirSync(workflowsDir, { recursive: true });
    fs.writeFileSync(targetPath, buildFallbackWorkflowYaml(), 'utf8');

    const git = simpleGit(dir);
    await git.addConfig('user.email', 'apk-builder@example.com');
    await git.addConfig('user.name', 'apk-builder-bot');
    await git.add('.');
    await git.commit(`Add missing ${WORKFLOW_FILE} workflow (auto-recovered on boot)`);
    await git.push(['origin', GITHUB_BRANCH]);
    console.log(`Pushed .github/workflows/${WORKFLOW_FILE} to "${GITHUB_BRANCH}".`);
  } catch (err) {
    console.error('ensureBaseBranchWorkflow failed — dispatches will likely keep 422ing until this is fixed manually:', err.message);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

// ---- Step 1: upload zip, unzip, push to a job-only branch, trigger workflow ----
app.post('/api/build', upload.single('projectZip'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No zip file uploaded' });
  if (!req.file.originalname.toLowerCase().endsWith('.zip')) {
    fs.rmSync(req.file.path, { force: true });
    return res.status(400).json({ error: 'Please upload a .zip file' });
  }

  const jobId = newJobId();
  const branch = `build/${jobId}`;
  setJob(jobId, { status: 'starting', message: 'Preparing project files', branch, createdAt: Date.now() });
  res.json({ jobId });

  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'apkbuild-'));

  try {
    // 1. Extract the uploaded zip
    const zip = new AdmZip(req.file.path);
    const extractDir = path.join(workDir, 'extracted');
    zip.extractAllTo(extractDir, true);

    // Find the actual Gradle project inside the zip, whatever shape it's
    // in — a bare project, one wrapped in a single top-level folder, or
    // buried a bit deeper. Fail fast with a clear message rather than
    // pushing something that can only fail later on GitHub's side.
    const { root: projectRoot, ambiguous } = pickProjectRoot(extractDir);
    if (!projectRoot) {
      throw new Error(
        'No settings.gradle or settings.gradle.kts found anywhere in the zip. ' +
        'Zip the folder that contains one of those files (see "How to prep it").'
      );
    }
    if (ambiguous) {
      setJob(jobId, { message: 'Multiple Gradle projects found in the zip — using the top-level one' });
    }

    // Fix the most common reasons a real project fails to build on a CI
    // runner even though it builds fine locally (stale local.properties,
    // a non-executable or CRLF-damaged gradlew).
    normalizeProjectForCI(projectRoot);

    setJob(jobId, { status: 'pushing', message: 'Pushing project to a private build branch' });

    // 2. Clone the base branch, create a job-only branch, wipe it, copy in the
    //    new project, commit, push. The base branch (and every other user's
    //    branch) is never touched — this is what keeps concurrent builds
    //    from ever colliding.
    const repoDir = path.join(workDir, 'repo');
    const remote = `https://x-access-token:${GITHUB_TOKEN}@github.com/${OWNER}/${REPO}.git`;
    const git = simpleGit();

    await git.clone(remote, repoDir, ['--branch', GITHUB_BRANCH, '--single-branch', '--depth', '1']);
    const repoGit = simpleGit(repoDir);
    await repoGit.checkoutLocalBranch(branch);

    // Preserve the base branch's .github/workflows before wiping the repo,
    // so we can restore it if the uploaded project doesn't bring its own.
    const baseWorkflowsDir = path.join(repoDir, '.github', 'workflows');
    let preservedWorkflowsDir = null;
    if (hasWorkflowFiles(baseWorkflowsDir)) {
      preservedWorkflowsDir = path.join(workDir, 'preserved-workflows');
      copyRecursive(baseWorkflowsDir, preservedWorkflowsDir);
    }

    for (const entry of fs.readdirSync(repoDir)) {
      if (entry === '.git') continue;
      fs.rmSync(path.join(repoDir, entry), { recursive: true, force: true });
    }
    copyRecursive(projectRoot, repoDir);

    // fs.copyFileSync doesn't reliably carry the executable bit across the
    // copy, so re-apply it here — this is what git actually commits (a
    // gradlew that isn't marked executable in the tree still fails on the
    // runner even if it was fixed in the tmp extraction dir a moment ago).
    const repoGradlew = path.join(repoDir, 'gradlew');
    if (fs.existsSync(repoGradlew)) fs.chmodSync(repoGradlew, 0o755);

    // If the uploaded project didn't include its own workflow, restore the
    // base branch's, or generate a sensible default as a last resort — this
    // is what was 422ing before: the branch had no workflow file at all.
    const newWorkflowsDir = path.join(repoDir, '.github', 'workflows');
    if (!hasWorkflowFiles(newWorkflowsDir)) {
      fs.mkdirSync(newWorkflowsDir, { recursive: true });
      if (preservedWorkflowsDir) {
        copyRecursive(preservedWorkflowsDir, newWorkflowsDir);
        setJob(jobId, { message: 'No workflow in upload — reused existing build workflow' });
      } else {
        fs.writeFileSync(path.join(newWorkflowsDir, WORKFLOW_FILE), buildFallbackWorkflowYaml(), 'utf8');
        setJob(jobId, { message: 'No workflow in upload — generated a default build workflow' });
      }
    }

    await repoGit.addConfig('user.email', 'apk-builder@example.com');
    await repoGit.addConfig('user.name', 'apk-builder-bot');
    await repoGit.add('.');
    await repoGit.commit(`Build ${jobId}`);
    await repoGit.push(['-u', 'origin', branch, '--force']);

    setJob(jobId, { status: 'queued', message: 'Triggering Tycept Actions build' });

    // 3. Trigger the workflow on that branch specifically.
    //    GitHub can take a moment to index a just-pushed branch/file, so a
    //    422 right after push is retried a few times before giving up.
    let dispatchRes, dispatchBody;
    for (let attempt = 1; attempt <= 4; attempt++) {
      dispatchRes = await fetch(`${API}/repos/${OWNER}/${REPO}/actions/workflows/${WORKFLOW_FILE}/dispatches`, {
        method: 'POST',
        headers: { ...authHeaders, 'Content-Type': 'application/json' },
        body: JSON.stringify({ ref: branch })
      });
      if (dispatchRes.ok) break;
      dispatchBody = await dispatchRes.text();
      if (dispatchRes.status !== 422 || attempt === 4) {
        throw new Error(`Could not start the workflow (${dispatchRes.status}): ${dispatchBody.slice(0, 200)}`);
      }
      await sleep(1500 * attempt);
    }

    // 4. Poll for the run on THIS branch (not a time guess — every job has its
    //    own branch name, so there's no ambiguity even if many jobs start at once)
    const runId = await findRunForBranch(branch);
    if (!runId) {
      setJob(jobId, { status: 'error', message: 'Could not find the triggered workflow run' });
      await deleteBranch(branch);
      return;
    }
    setJob(jobId, { status: 'building', message: 'Build running', runId });
    await pollRun(jobId, runId, branch);

  } catch (err) {
    console.error(err);
    setJob(jobId, { status: 'error', message: err.message || 'Build failed' });
    await deleteBranch(branch);
  } finally {
    fs.rmSync(workDir, { recursive: true, force: true });
    fs.rmSync(req.file.path, { force: true });
  }
});

// ---- Step 2: frontend polls this for status ----
app.get('/api/status/:jobId', (req, res) => {
  const job = jobs[req.params.jobId];
  if (!job) return res.status(404).json({ error: 'Unknown job' });
  res.json(job);
});

// ---- Step 3: proxy-download the finished APK (keeps the GitHub token server-side) ----
// GitHub always wraps an artifact in its OWN zip container, even when the
// artifact is a single .apk — so naively piping that response gives the
// browser a .zip, not an .apk. This downloads that wrapper server-side,
// finds the actual .apk entry inside it, and streams just that file back
// with the right name and content-type.
app.get('/api/download/:jobId', async (req, res) => {
  const job = jobs[req.params.jobId];
  if (!job || job.status !== 'done' || !job.artifactId) {
    return res.status(400).send('Build not ready');
  }

  let tmpZipPath;
  try {
    const zipRes = await fetch(
      `${API}/repos/${OWNER}/${REPO}/actions/artifacts/${job.artifactId}/zip`,
      { headers: authHeaders, redirect: 'follow' }
    );
    if (!zipRes.ok) {
      return res.status(502).send('Could not fetch the build artifact from GitHub');
    }

    tmpZipPath = path.join(os.tmpdir(), `artifact-${req.params.jobId}.zip`);
    const buffer = Buffer.from(await zipRes.arrayBuffer());
    fs.writeFileSync(tmpZipPath, buffer);

    const zip = new AdmZip(tmpZipPath);
    const apkEntry = zip.getEntries().find((e) => !e.isDirectory && e.entryName.toLowerCase().endsWith('.apk'));

    if (!apkEntry) {
      // Not an APK artifact at all (e.g. someone re-hit this URL for a lint
      // report job) — say so plainly instead of silently sending a zip.
      return res.status(400).send('This build artifact does not contain an APK file');
    }

    const apkBuffer = apkEntry.getData();
    const downloadName = path.basename(apkEntry.entryName);
    res.setHeader('Content-Type', 'application/vnd.android.package-archive');
    res.setHeader('Content-Disposition', `attachment; filename="${downloadName}"`);
    res.setHeader('Content-Length', apkBuffer.length);
    res.send(apkBuffer);
  } catch (err) {
    console.error('Download failed:', err);
    res.status(500).send('Failed to prepare the APK for download');
  } finally {
    if (tmpZipPath) fs.rmSync(tmpZipPath, { force: true });
  }
});

// ---------- helpers ----------

// A workflow can upload more than one artifact (lint report, test results,
// the APK itself, etc). Previously we always grabbed artifacts[0], which is
// whatever GitHub happens to list first — sometimes the lint report. This
// scores each artifact and picks the one that actually looks like the APK.
function pickApkArtifact(artifacts) {
  if (!artifacts || artifacts.length === 0) return null;
  const NEGATIVE = /lint|report|test-results?|checkstyle|pmd|coverage|jacoco|proguard-mapping|mapping\.txt/i;
  const POSITIVE = /apk|assembledebug|assemblerelease|debug-apk|release-apk/i;

  const scored = artifacts.map((a) => {
    let score = 0;
    if (POSITIVE.test(a.name)) score += 10;
    if (NEGATIVE.test(a.name)) score -= 10;
    return { a, score };
  });
  scored.sort((x, y) => y.score - x.score);
  return scored[0].a;
}

function copyRecursive(src, dest) {
  fs.mkdirSync(dest, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    // Skip junk/build-output folders that some zip tools or IDEs leave
    // behind (__MACOSX from macOS zips, stale build/.gradle/.idea dirs) —
    // they only bloat the push and can occasionally shadow real project
    // files. A user's own .github/workflows is never affected since it's
    // handled separately before/after this copy.
    if (entry.isDirectory() && IGNORED_DIR_NAMES.has(entry.name)) continue;
    const s = path.join(src, entry.name);
    const d = path.join(dest, entry.name);
    if (entry.isDirectory()) copyRecursive(s, d);
    else fs.copyFileSync(s, d);
  }
}

async function findRunForBranch(branch, attempts = 10) {
  for (let i = 0; i < attempts; i++) {
    await sleep(2000);
    const r = await fetch(
      `${API}/repos/${OWNER}/${REPO}/actions/workflows/${WORKFLOW_FILE}/runs?branch=${encodeURIComponent(branch)}&per_page=1`,
      { headers: authHeaders }
    );
    const data = await r.json();
    if (data.workflow_runs && data.workflow_runs.length > 0) {
      return data.workflow_runs[0].id;
    }
  }
  return null;
}

async function pollRun(jobId, runId, branch, maxAttempts = 90) {
  for (let i = 0; i < maxAttempts; i++) {
    await sleep(5000);
    const r = await fetch(`${API}/repos/${OWNER}/${REPO}/actions/runs/${runId}`, { headers: authHeaders });
    const run = await r.json();

    if (run.status !== 'completed') {
      setJob(jobId, { status: 'building', message: `Build in progress (${run.status})`, runId });
      continue;
    }

    if (run.conclusion !== 'success') {
      setJob(jobId, { status: 'error', message: `Build failed (${run.conclusion})`, runId });
      await deleteBranch(branch);
      return;
    }

    const artRes = await fetch(`${API}/repos/${OWNER}/${REPO}/actions/runs/${runId}/artifacts`, { headers: authHeaders });
    const artData = await artRes.json();
    const artifact = pickApkArtifact(artData.artifacts);

    if (!artifact) {
      setJob(jobId, { status: 'error', message: 'Build succeeded but no APK artifact was found', runId });
      await deleteBranch(branch);
      return;
    }

    setJob(jobId, {
      status: 'done',
      message: 'APK ready',
      runId,
      artifactId: artifact.id,
      artifactName: artifact.name
    });
    scheduleCleanup(jobId, branch);
    return;
  }
  setJob(jobId, { status: 'error', message: 'Timed out waiting for build', runId });
  await deleteBranch(branch);
}

// Once a job is done (or after it errors), remove its build branch on GitHub
// and forget the job after a while, so nothing lingers to conflict with the
// next person's build.
function scheduleCleanup(jobId, branch) {
  setTimeout(async () => {
    await deleteBranch(branch);
    delete jobs[jobId];
  }, Number(JOB_TTL_MINUTES) * 60 * 1000);
}

async function deleteBranch(branch) {
  try {
    await fetch(`${API}/repos/${OWNER}/${REPO}/git/refs/heads/${encodeURIComponent(branch)}`, {
      method: 'DELETE',
      headers: authHeaders
    });
  } catch (err) {
    console.error(`Could not delete branch ${branch}:`, err.message);
  }
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

app.listen(PORT, async () => {
  console.log(`apk-builder running on http://localhost:${PORT}`);
  await ensureBaseBranchWorkflow();
});

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
// has a .github/workflows/*.yml file. Locates the Android project dynamically
// since an uploaded zip's project may not sit at the repo root.
const DEFAULT_WORKFLOW_YAML = `name: Build APK

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
        with:
          gradle-version: '8.7'

      - name: Locate Android project
        id: locate
        run: |
          PROJECT_DIR=$(dirname "$(find "$GITHUB_WORKSPACE" -maxdepth 4 -name settings.gradle -o -maxdepth 4 -name settings.gradle.kts | head -n 1)")
          if [ -z "$PROJECT_DIR" ]; then
            echo "Could not find settings.gradle anywhere in the repo (searched 4 levels deep)."
            exit 1
          fi
          echo "dir=$PROJECT_DIR" >> "$GITHUB_OUTPUT"

      - name: Build debug APK
        working-directory: \${{ steps.locate.outputs.dir }}
        run: gradle assembleDebug --no-daemon

      - name: Upload APK
        uses: actions/upload-artifact@v4
        with:
          name: debug-apk-\${{ github.run_id }}
          path: \${{ steps.locate.outputs.dir }}/app/build/outputs/apk/debug/*.apk
          if-no-files-found: error
`;

function hasWorkflowFiles(dir) {
  return fs.existsSync(dir) &&
    fs.readdirSync(dir).some((f) => f.endsWith('.yml') || f.endsWith('.yaml'));
}

// GitHub only honors workflow_dispatch for a workflow that has been
// registered via the repo's DEFAULT branch — a copy that exists only on a
// throwaway job branch is not enough, even with the trigger correctly
// declared. This runs once at boot: if the base branch doesn't already have
// .github/workflows/<WORKFLOW_FILE>, it's committed straight there so every
// future dispatch (on any branch) actually works.
async function ensureBaseBranchWorkflow() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'apkbuild-baseinit-'));
  try {
    const remote = `https://x-access-token:${GITHUB_TOKEN}@github.com/${OWNER}/${REPO}.git`;
    await simpleGit().clone(remote, dir, ['--branch', GITHUB_BRANCH, '--single-branch', '--depth', '1']);
    const workflowsDir = path.join(dir, '.github', 'workflows');
    const targetPath = path.join(workflowsDir, WORKFLOW_FILE);

    if (fs.existsSync(targetPath)) {
      console.log(`Base branch "${GITHUB_BRANCH}" already has .github/workflows/${WORKFLOW_FILE} — good.`);
      return;
    }

    console.warn(
      `WARNING: .github/workflows/${WORKFLOW_FILE} was missing on "${GITHUB_BRANCH}". ` +
      `Committing a default one now — dispatches would 422 until this exists on the default branch.`
    );
    fs.mkdirSync(workflowsDir, { recursive: true });
    fs.writeFileSync(targetPath, DEFAULT_WORKFLOW_YAML, 'utf8');

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

    // If the zip has a single top-level folder (like MyApp/...), step into it
    const entries = fs.readdirSync(extractDir);
    const projectRoot = (entries.length === 1 && fs.statSync(path.join(extractDir, entries[0])).isDirectory())
      ? path.join(extractDir, entries[0])
      : extractDir;

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
        fs.writeFileSync(path.join(newWorkflowsDir, WORKFLOW_FILE), DEFAULT_WORKFLOW_YAML, 'utf8');
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
app.get('/api/download/:jobId', async (req, res) => {
  const job = jobs[req.params.jobId];
  if (!job || job.status !== 'done' || !job.artifactId) {
    return res.status(400).send('Build not ready');
  }
  const zipRes = await fetch(
    `${API}/repos/${OWNER}/${REPO}/actions/artifacts/${job.artifactId}/zip`,
    { headers: authHeaders, redirect: 'follow' }
  );
  res.setHeader('Content-Disposition', `attachment; filename="${job.artifactName || 'apk-build'}.zip"`);
  zipRes.body.pipe(res);
});

// ---------- helpers ----------

function copyRecursive(src, dest) {
  fs.mkdirSync(dest, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
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
    const artifact = artData.artifacts && artData.artifacts[0];

    if (!artifact) {
      setJob(jobId, { status: 'error', message: 'Build succeeded but no artifact was found', runId });
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

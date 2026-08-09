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

    for (const entry of fs.readdirSync(repoDir)) {
      if (entry === '.git') continue;
      fs.rmSync(path.join(repoDir, entry), { recursive: true, force: true });
    }
    copyRecursive(projectRoot, repoDir);

    await repoGit.addConfig('user.email', 'apk-builder@example.com');
    await repoGit.addConfig('user.name', 'apk-builder-bot');
    await repoGit.add('.');
    await repoGit.commit(`Build ${jobId}`);
    await repoGit.push(['-u', 'origin', branch, '--force']);

    setJob(jobId, { status: 'queued', message: 'Triggering GitHub Actions build' });

    // 3. Trigger the workflow on that branch specifically
    const dispatchRes = await fetch(`${API}/repos/${OWNER}/${REPO}/actions/workflows/${WORKFLOW_FILE}/dispatches`, {
      method: 'POST',
      headers: { ...authHeaders, 'Content-Type': 'application/json' },
      body: JSON.stringify({ ref: branch })
    });
    if (!dispatchRes.ok) {
      const body = await dispatchRes.text();
      throw new Error(`Could not start the workflow (${dispatchRes.status}): ${body.slice(0, 200)}`);
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

app.listen(PORT, () => console.log(`apk-builder running on http://localhost:${PORT}`));

require('dotenv').config();
const express = require('express');
const multer = require('multer');
const AdmZip = require('adm-zip');
const simpleGit = require('simple-git');
const fetch = require('node-fetch');
const fs = require('fs');
const path = require('path');
const os = require('os');

const app = express();
const upload = multer({ dest: os.tmpdir() });

const {
  GITHUB_TOKEN,
  GITHUB_REPO,        // "owner/repo"
  GITHUB_BRANCH = 'main',
  WORKFLOW_FILE = 'build.yml',
  PORT = 3000
} = process.env;

if (!GITHUB_TOKEN || !GITHUB_REPO) {
  console.error('Missing GITHUB_TOKEN or GITHUB_REPO in .env — see .env.example');
  process.exit(1);
}

const [OWNER, REPO] = GITHUB_REPO.split('/');
const API = 'https://api.github.com';
const authHeaders = {
  Authorization: `token ${GITHUB_TOKEN}`,
  Accept: 'application/vnd.github+json',
  'User-Agent': 'apk-builder-app'
};

app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json());

// In-memory job store (fine for a single-instance demo; use a DB/queue for real traffic)
const jobs = {}; // jobId -> { status, message, downloadUrl, runId }

function newJobId() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

// ---- Step 1: upload zip, unzip, push to GitHub, trigger workflow ----
app.post('/api/build', upload.single('projectZip'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No zip file uploaded' });

  const jobId = newJobId();
  jobs[jobId] = { status: 'starting', message: 'Preparing project files' };
  res.json({ jobId });

  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'apkbuild-'));

  try {
    // 1. Extract the uploaded zip
    const zip = new AdmZip(req.file.path);
    const extractDir = path.join(workDir, 'extracted');
    zip.extractAllTo(extractDir, true);

    // If the zip has a single top-level folder (like TyceptApp/...), step into it
    const entries = fs.readdirSync(extractDir);
    const projectRoot = (entries.length === 1 && fs.statSync(path.join(extractDir, entries[0])).isDirectory())
      ? path.join(extractDir, entries[0])
      : extractDir;

    jobs[jobId] = { status: 'pushing', message: 'Pushing project to GitHub' };

    // 2. Clone the target repo, wipe it, copy in the new project, commit, push
    const repoDir = path.join(workDir, 'repo');
    const remote = `https://x-access-token:${GITHUB_TOKEN}@github.com/${OWNER}/${REPO}.git`;
    const git = simpleGit();

    await git.clone(remote, repoDir, ['--branch', GITHUB_BRANCH, '--single-branch']);
    const repoGit = simpleGit(repoDir);

    // Clear existing tracked files (keep .git) then copy new project in
    for (const entry of fs.readdirSync(repoDir)) {
      if (entry === '.git') continue;
      fs.rmSync(path.join(repoDir, entry), { recursive: true, force: true });
    }
    copyRecursive(projectRoot, repoDir);

    await repoGit.add('.');
    const diff = await repoGit.diffSummary(['--cached']);
    if (diff.files.length === 0) {
      jobs[jobId] = { status: 'error', message: 'Nothing changed — zip is identical to what is already in the repo' };
      return;
    }
    await repoGit.addConfig('user.email', 'apk-builder@example.com');
    await repoGit.addConfig('user.name', 'apk-builder-bot');
    await repoGit.commit(`Build request ${jobId}`);
    await repoGit.push('origin', GITHUB_BRANCH);

    jobs[jobId] = { status: 'queued', message: 'Triggering GitHub Actions build' };

    // 3. Trigger the workflow explicitly (in case push-trigger is slow/disabled)
    await fetch(`${API}/repos/${OWNER}/${REPO}/actions/workflows/${WORKFLOW_FILE}/dispatches`, {
      method: 'POST',
      headers: { ...authHeaders, 'Content-Type': 'application/json' },
      body: JSON.stringify({ ref: GITHUB_BRANCH })
    });

    // 4. Poll for the run that just started, then poll until it completes
    const runId = await findNewRun(jobId);
    if (!runId) {
      jobs[jobId] = { status: 'error', message: 'Could not find the triggered workflow run' };
      return;
    }
    jobs[jobId] = { status: 'building', message: 'Build running', runId };
    await pollRun(jobId, runId);

  } catch (err) {
    console.error(err);
    jobs[jobId] = { status: 'error', message: err.message || 'Build failed' };
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
  res.setHeader('Content-Disposition', 'attachment; filename="apk-build.zip"');
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

async function findNewRun(jobId, attempts = 10) {
  for (let i = 0; i < attempts; i++) {
    await sleep(2000);
    const r = await fetch(
      `${API}/repos/${OWNER}/${REPO}/actions/workflows/${WORKFLOW_FILE}/runs?branch=${GITHUB_BRANCH}&per_page=1`,
      { headers: authHeaders }
    );
    const data = await r.json();
    if (data.workflow_runs && data.workflow_runs.length > 0) {
      const run = data.workflow_runs[0];
      // Only trust runs started in the last couple minutes to avoid grabbing a stale one
      if (Date.now() - new Date(run.created_at).getTime() < 2 * 60 * 1000) {
        return run.id;
      }
    }
  }
  return null;
}

async function pollRun(jobId, runId, maxAttempts = 90) {
  for (let i = 0; i < maxAttempts; i++) {
    await sleep(5000);
    const r = await fetch(`${API}/repos/${OWNER}/${REPO}/actions/runs/${runId}`, { headers: authHeaders });
    const run = await r.json();

    if (run.status !== 'completed') {
      jobs[jobId] = { status: 'building', message: `Build in progress (${run.status})`, runId };
      continue;
    }

    if (run.conclusion !== 'success') {
      jobs[jobId] = { status: 'error', message: `Build failed (${run.conclusion})`, runId };
      return;
    }

    const artRes = await fetch(`${API}/repos/${OWNER}/${REPO}/actions/runs/${runId}/artifacts`, { headers: authHeaders });
    const artData = await artRes.json();
    const artifact = artData.artifacts && artData.artifacts[0];

    if (!artifact) {
      jobs[jobId] = { status: 'error', message: 'Build succeeded but no artifact was found', runId };
      return;
    }

    jobs[jobId] = {
      status: 'done',
      message: 'APK ready',
      runId,
      artifactId: artifact.id,
      artifactName: artifact.name
    };
    return;
  }
  jobs[jobId] = { status: 'error', message: 'Timed out waiting for build', runId };
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

app.listen(PORT, () => console.log(`apk-builder running on http://localhost:${PORT}`));

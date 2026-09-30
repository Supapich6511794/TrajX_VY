// dev.mjs — zero-dependency bootstrap launcher for `npm run dev`.
//
// Why this exists: on a fresh machine `npm run dev` would normally fail
// because the `dev` command itself uses `concurrently` (a devDependency)
// which isn't there until `npm install` has run. This script needs nothing
// but Node + Python already on PATH, so `npm run dev` works on the very
// first run with no extra commands:
//
//   1. web/node_modules missing  -> `npm install`
//   2. <repo>/.venv missing      -> create venv + pip install (cross-platform)
//   3. start API + web together with auto-restart (npm run dev:serve)
//
// Each step is a fast no-op once provisioned, so it is safe every run.

import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const scriptsDir = dirname(fileURLToPath(import.meta.url));
const repo = dirname(scriptsDir);
const web = join(repo, "web");

function run(cmd, args, cwd) {
  // shell:true is needed so Windows resolves `npm`/`py`, but the
  // shell then splits args on spaces — so any arg with a space (e.g. the
  // repo path "Flight Trajectory Generator") must be quoted ourselves.
  const quoted = args.map((a) => (/\s/.test(a) ? `"${a}"` : a));
  const r = spawnSync(cmd, quoted, { cwd, stdio: "inherit", shell: true });
  if (r.status !== 0) {
    console.error(`\n[dev] step failed: ${cmd} ${args.join(" ")}`);
    process.exit(r.status ?? 1);
  }
}

// Locate a Python interpreter without aborting if a candidate is missing.
// NOTE: requirements.txt pins numpy/pyproj/shapely/geopandas — use Python
// 3.11–3.13 (no wheels for 3.14 yet).
function findPython() {
  const cands = isWin ? ["py", "python", "python3"] : ["python3", "python"];
  for (const c of cands) {
    const r = spawnSync(c, ["--version"], { stdio: "ignore", shell: true });
    if (r.status === 0) return c;
  }
  return null;
}

const isWin = process.platform === "win32";
const venv = join(repo, ".venv");
const venvBin = join(venv, isWin ? "Scripts" : "bin");
const venvPython = join(venvBin, isWin ? "python.exe" : "python");
const venvUvicorn = join(venvBin, isWin ? "uvicorn.exe" : "uvicorn");

// 1. Web dependencies.
if (!existsSync(join(web, "node_modules"))) {
  console.log("[setup] Installing web dependencies (one-time) ...");
  run("npm", ["install"], web);
}

// 2. Python venv + deps (fast no-op once provisioned).
if (!existsSync(venvUvicorn)) {
  const py = findPython();
  if (!py) {
    console.error("[dev] No Python found on PATH. Install Python 3.11–3.13 and reopen the terminal.");
    process.exit(1);
  }
  console.log(`[setup] Creating Python venv at ${venv} ...`);
  run(py, ["-m", "venv", venv], repo);
  console.log("[setup] Installing Python dependencies (one-time) ...");
  run(venvPython, ["-m", "pip", "install", "--upgrade", "pip"], repo);
  run(venvPython, ["-m", "pip", "install", "-r", join(repo, "requirements.txt")], repo);
}

// 3. Start API + web together (each hot-reloads itself). Ctrl+C stops both.
console.log("[run] Starting API (:8000) + web (:3000). Open http://localhost:3000");
run("npm", ["run", "dev:serve"], web);

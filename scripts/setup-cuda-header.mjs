import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import { pathToFileURL } from "node:url";

// The driver header in this NVIDIA wheel is shared by both Windows targets.
const wheelUrl = "https://files.pythonhosted.org/packages/35/99/e07dd9565d2e0317c1a62ff39ae9fc0542c048f74bcfc777c8be97710347/nvidia_cuda_runtime-13.5.37-py3-none-win_amd64.whl";
const wheelSha256 = "f225d3fa5ea6bfbb58fc4979ef72375cbe661d9107f0d8a4ff22cc151525e4a9";

function findCudaInclude() {
  const toolkit = process.env.CUDA_PATH || String.raw`C:\Program Files\NVIDIA GPU Computing Toolkit\CUDA\v13.2`;
  return [resolve("."), resolve(toolkit, "include")].find(dir =>
    statSync(join(dir, "cuda.h"), { throwIfNoEntry: false })?.isFile()
  );
}

async function confirmDownload() {
  if (!process.stdin.isTTY || !process.stdout.isTTY) return false;
  const terminal = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = await terminal.question(
      "No cuda.h found. Download NVIDIA's header to this checkout and build both NVENC installers? [y/N] "
    );
    return /^(y|yes)$/i.test(answer.trim());
  } finally {
    terminal.close();
  }
}

export async function prepareCudaHeader({ prompt = false } = {}) {
  if (process.platform !== "win32") throw new Error("Run Windows CUDA header setup on Windows.");
  const existing = findCudaInclude();
  if (existing) {
    console.log(`Using CUDA header at ${join(existing, "cuda.h")}`);
    return existing;
  }
  if (prompt && !(await confirmDownload())) return undefined;

  console.log("Downloading NVIDIA's CUDA 13.5.37 header package from PyPI (2.8 MB)...");
  const response = await fetch(wheelUrl, { signal: AbortSignal.timeout(120_000) });
  if (!response.ok) throw new Error(`CUDA header download failed (HTTP ${response.status}).`);
  const wheel = Buffer.from(await response.arrayBuffer());
  if (createHash("sha256").update(wheel).digest("hex") !== wheelSha256) {
    throw new Error("The CUDA package failed its SHA-256 check. Retry the download.");
  }

  // Windows ships bsdtar with ZIP support. Git Bash may put GNU tar first on PATH.
  const tar = join(process.env.SystemRoot, "System32", "tar.exe");
  const header = execFileSync(tar, ["-xOf", "-", "nvidia/cu13/include/cuda.h"], {
    input: wheel,
    maxBuffer: 4 * 1024 * 1024,
  });
  const destination = resolve("cuda.h");
  const temporary = `${destination}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temporary, header, { flag: "wx" });
    const alreadyInstalled = findCudaInclude();
    if (alreadyInstalled) return alreadyInstalled;
    renameSync(temporary, destination);
  } finally {
    rmSync(temporary, { force: true });
  }
  console.log(`Installed ${destination}`);
  return resolve(".");
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  await prepareCudaHeader();
}

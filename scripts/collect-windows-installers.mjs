import { execFileSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync } from "node:fs";
import { basename, join } from "node:path";

const { productName, version } = JSON.parse(readFileSync("src-tauri/tauri.conf.json", "utf8"));
const metadata = execFileSync("cargo", ["metadata", "--format-version", "1", "--no-deps"], {
  cwd: "src-tauri",
  encoding: "utf8",
});
const { target_directory: targetDir } = JSON.parse(metadata);
const installers = [];
for (const [target, label] of [["x86_64", "x64"], ["aarch64", "arm64"]]) {
  const bundle = join(targetDir, `${target}-pc-windows-msvc`, "release", "bundle");
  const prefix = `${productName}_${version}_${label}`;
  installers.push(join(bundle, "msi", `${prefix}_en-US.msi`));
  installers.push(join(bundle, "nsis", `${prefix}-setup.exe`));
}

const output = join("release", "windows");
mkdirSync(output, { recursive: true });
const staging = mkdtempSync(join(output, ".build-"));
try {
  for (const file of installers) {
    copyFileSync(file, join(staging, basename(file)));
  }
  for (const file of installers) {
    const name = basename(file);
    renameSync(join(staging, name), join(output, name));
  }
} finally {
  rmSync(staging, { recursive: true, force: true });
}
console.log(`Windows installers are ready in ${output}`);

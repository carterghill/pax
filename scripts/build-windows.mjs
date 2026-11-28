import { execFileSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { prepareCudaHeader } from "./setup-cuda-header.mjs";

if (process.platform !== "win32") throw new Error("Run build:windows on Windows.");

const tauri = fileURLToPath(import.meta.resolve("@tauri-apps/cli/tauri.js"));
const include = await prepareCudaHeader({ prompt: true });
const variants = [{ profile: "release", suffix: "", include: "off" }];
if (include) {
  variants.push({ profile: "release-nvenc", suffix: "-nvenc", include });
} else {
  console.log("Building the two standard installers. To enable NVENC later, run npm run setup:cuda-header.");
}

const { productName, version } = JSON.parse(readFileSync("src-tauri/tauri.conf.json", "utf8"));
const metadata = execFileSync("cargo", ["metadata", "--format-version", "1", "--no-deps"], {
  cwd: "src-tauri",
  encoding: "utf8",
});
const { target_directory: targetDir } = JSON.parse(metadata);
const output = join("release", "windows");
mkdirSync(output, { recursive: true });
const staging = mkdtempSync(join(output, ".build-"));
const obsolete = [];
try {
  for (const [cpu, label] of [["x86_64", "x64"], ["aarch64", "arm64"]]) {
    const target = `${cpu}-pc-windows-msvc`;
    const prefix = `${productName}_${version}_${label}`;
    for (const variant of variants) {
      console.log(`Building ${label} ${variant.suffix ? "with NVENC" : "without NVENC"}`);
      execFileSync(process.execPath, [
        tauri, "build", "--target", target, "--bundles", "nsis", "--", "--profile", variant.profile,
      ], {
        stdio: "inherit",
        env: { ...process.env, PAX_WINDOWS_NVENC_INCLUDE: variant.include },
      });
      const bundle = join(targetDir, target, variant.profile, "bundle", "nsis");
      copyFileSync(join(bundle, `${prefix}-setup.exe`), join(staging, `${prefix}${variant.suffix}-setup.exe`));
    }
    // Retire outputs of the previous MSI collector and any earlier NVENC run of this version.
    obsolete.push(`${prefix}_en-US.msi`);
    if (!include) obsolete.push(`${prefix}-nvenc-setup.exe`);
  }
  for (const name of readdirSync(staging)) {
    renameSync(join(staging, name), join(output, name));
  }
  for (const name of obsolete) rmSync(join(output, name), { force: true });
} finally {
  rmSync(staging, { recursive: true, force: true });
}
console.log(`${variants.length * 2} Windows setup EXEs are ready in ${output}`);

import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";

if (process.platform !== "linux") {
  console.log("Pax's GStreamer setup is for Linux.");
  process.exit(0);
}

const config = JSON.parse(readFileSync(new URL("../src-tauri/tauri.conf.json", import.meta.url)));
const packages = config.bundle.linux.deb.depends.filter((name) => name.startsWith("gstreamer1.0-"));
const installed = spawnSync("dpkg-query", ["-W", "-f=${db:Status-Status} ${Package}\n", ...packages], {
  encoding: "utf8",
});
if (installed.error?.code === "ENOENT") {
  console.error("This setup command requires a Debian-based Linux distribution.");
  process.exit(1);
}
if (installed.error || ![0, 1].includes(installed.status)) {
  console.error(installed.error?.message ?? installed.stderr.trim());
  process.exit(1);
}

const installedPackages = new Set(installed.stdout.trim().split("\n"));
const packagesToInstall = packages.filter((name) => !installedPackages.has(`installed ${name}`));
if (packagesToInstall.length === 0) {
  console.log("Pax's GStreamer packages are already installed.");
  process.exit(0);
}

const args = ["install", ...packagesToInstall];
const result = process.getuid() === 0
  ? spawnSync("apt-get", args, { stdio: "inherit" })
  : spawnSync("sudo", ["apt-get", ...args], { stdio: "inherit" });
if (result.error) console.error(result.error.message);
process.exit(result.status ?? 1);

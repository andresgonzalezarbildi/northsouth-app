import { copyFileSync, existsSync, mkdirSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join, resolve } from "node:path";

const root = resolve(process.cwd());
const androidDir = join(root, "android");
const gradle = process.platform === "win32" ? "gradlew.bat" : "./gradlew";

const result = spawnSync(gradle, ["assembleDebug"], {
  cwd: androidDir,
  stdio: "inherit",
  shell: process.platform === "win32",
});

if (result.status !== 0) {
  process.exit(result.status ?? 1);
}

const source = join(androidDir, "app", "build", "outputs", "apk", "debug", "app-debug.apk");
if (!existsSync(source)) {
  console.error(`No se encontró la APK en: ${source}`);
  process.exit(1);
}

const distDir = join(root, "dist");
mkdirSync(distDir, { recursive: true });
const destination = join(distDir, "NorthSouth-debug.apk");
copyFileSync(source, destination);

console.log(`\nAPK generada: ${destination}`);

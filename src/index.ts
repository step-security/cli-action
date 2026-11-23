import { execSync, execFileSync } from "child_process";
import crypto from "crypto";
import fs from "fs";
import os from "os";
import path from "path";
import * as core from "@actions/core";
import * as io from "@actions/io";
import * as tc from "@actions/tool-cache";
import axios, { isAxiosError } from "axios";

async function validateSubscription() {
  const eventPath = process.env.GITHUB_EVENT_PATH;
  let repoPrivate: boolean | undefined;

  if (eventPath && fs.existsSync(eventPath)) {
    const eventData = JSON.parse(fs.readFileSync(eventPath, "utf8"));
    repoPrivate = eventData?.repository?.private;
  }

  const upstream = "dopplerhq/cli-action";
  const action = process.env.GITHUB_ACTION_REPOSITORY;
  const docsUrl = "https://docs.stepsecurity.io/actions/stepsecurity-maintained-actions";

  core.info("");
  core.info("\u001b[1;36mStepSecurity Maintained Action\u001b[0m");
  core.info(`Secure drop-in replacement for ${upstream}`);
  if (repoPrivate === false) core.info("\u001b[32m\u2713 Free for public repositories\u001b[0m");
  core.info(`\u001b[36mLearn more:\u001b[0m ${docsUrl}`);
  core.info("");

  if (repoPrivate === false) return;

  const serverUrl = process.env.GITHUB_SERVER_URL || "https://github.com";
  const body: Record<string, string> = { action: action || "" };
  if (serverUrl !== "https://github.com") body.ghes_server = serverUrl;
  try {
    await axios.post(
      `https://agent.api.stepsecurity.io/v1/github/${process.env.GITHUB_REPOSITORY}/actions/maintained-actions-subscription`,
      body,
      { timeout: 3000 },
    );
  } catch (error) {
    if (isAxiosError(error) && error.response?.status === 403) {
      core.error(`\u001b[1;31mThis action requires a StepSecurity subscription for private repositories.\u001b[0m`);
      core.error(`\u001b[31mLearn how to enable a subscription: ${docsUrl}\u001b[0m`);
      process.exit(1);
    }
    core.info("Timeout or API not reachable. Continuing to next step.");
  }
}

const workspace = process.env.GITHUB_WORKSPACE;
const binDir = `${workspace}/bin`;

run().catch((error) => {
  core.setFailed(error.message);
});

async function run() {
  await validateSubscription();

  switch (process.platform) {
    case "win32": {
      const url = "https://cli.doppler.com/download?os=windows&arch=amd64&format=zip";
      await installZip(binDir, url);
      await verifyBinary(binDir);
      break;
    }
    case "linux":
    case "darwin": {
      await executeInstallSh(binDir);
      await verifyBinary(binDir);
      break;
    }
    default: {
      throw new Error(`Unsupported platform '${process.platform}'`);
    }
  }
}

async function installZip(dir: string, url: string) {
  await io.mkdirP(dir);
  const downloadPath = await tc.downloadTool(url);
  await tc.extractZip(downloadPath, dir);
  core.addPath(dir);
}

async function executeInstallSh(installPath: string) {
  // download script
  const url = "https://cli.doppler.com/install.sh";
  const downloadPath = await tc.downloadTool(url);
  execSync(`chmod +x ${downloadPath}`);

  // execute script
  await io.mkdirP(installPath);
  const installCommand = `${downloadPath} --debug --no-package-manager --install-path ${installPath}`;
  execSync(installCommand, { timeout: 30000, stdio: "inherit" });

  // add binary to PATH
  core.addPath(installPath);
}

class ChecksumMismatchError extends Error {}

function sha256(file: string) {
  return crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

// Cross-checks the installed binary against the checksums published on the DopplerHQ/cli GitHub release.
// Only a checksum mismatch fails the action; any other problem is logged and the install proceeds.
async function verifyBinary(installPath: string) {
  try {
    const isWindows = process.platform === "win32";
    const binaryName = isWindows ? "doppler.exe" : "doppler";
    const installedBinary = path.join(installPath, binaryName);

    const versionOutput = execFileSync(installedBinary, ["--version"], { encoding: "utf8", timeout: 10000 });
    const version = versionOutput.match(/\d+\.\d+\.\d+/)?.[0];
    if (!version) throw new Error(`could not determine version from '${versionOutput.trim()}'`);

    const arch = isWindows ? "amd64" : ({ x64: "amd64", arm64: "arm64" } as Record<string, string>)[process.arch];
    if (!arch) throw new Error(`unsupported architecture '${process.arch}'`);
    const platform = isWindows ? "windows" : process.platform === "darwin" ? "macOS" : "linux";
    const archiveName = `doppler_${version}_${platform}_${arch}.${isWindows ? "zip" : "tar.gz"}`;
    const releaseUrl = `https://github.com/DopplerHQ/cli/releases/download/${version}`;

    const checksumsPath = await tc.downloadTool(`${releaseUrl}/checksums.txt`);
    const expected = fs
      .readFileSync(checksumsPath, "utf8")
      .split("\n")
      .map((line) => line.trim().split(/\s+/))
      .find(([, name]) => name === archiveName)?.[0];
    if (!expected) throw new Error(`no checksum listed for ${archiveName}`);

    const archivePath = await tc.downloadTool(`${releaseUrl}/${archiveName}`);
    const actual = sha256(archivePath);
    if (actual !== expected) {
      throw new ChecksumMismatchError(`checksum mismatch for ${archiveName}: expected ${expected}, got ${actual}`);
    }

    const extractDir = fs.mkdtempSync(path.join(process.env.RUNNER_TEMP || os.tmpdir(), "doppler-verify-"));
    await (isWindows ? tc.extractZip(archivePath, extractDir) : tc.extractTar(archivePath, extractDir));
    if (sha256(path.join(extractDir, binaryName)) !== sha256(installedBinary)) {
      throw new ChecksumMismatchError(`installed ${binaryName} does not match the binary in the official ${archiveName}`);
    }
    core.info(`Verified doppler ${version} against the DopplerHQ/cli release checksums`);
  } catch (error) {
    if (error instanceof ChecksumMismatchError) throw error;
    core.warning(`Skipping binary checksum verification: ${error instanceof Error ? error.message : error}`);
  }
}

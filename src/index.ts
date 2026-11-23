import { execSync } from "child_process";
import fs from "fs";
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
      break;
    }
    case "linux":
    case "darwin": {
      await executeInstallSh(binDir);
      break;
    }
    default: {
      throw new Error(`Unsupported platform '${process.platform}'`);
    }
  }
}

async function installZip(path: string, url: string) {
  await io.mkdirP(path);
  const downloadPath = await tc.downloadTool(url);
  await tc.extractZip(downloadPath, path);
  core.addPath(path);
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

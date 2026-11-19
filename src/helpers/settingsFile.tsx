import {
  readTextFile,
  writeTextFile,
  exists,
  mkdir,
} from "@tauri-apps/plugin-fs";
import { documentDir, join } from "@tauri-apps/api/path";
import { getName } from "@tauri-apps/api/app";
import { RecordingMethod, Settings } from "../types/settings";

export const loadSettings = async (
  setSettings: React.Dispatch<React.SetStateAction<Settings>> | null,
) => {
  const appName = await getName();
  const settingsPath = await join(
    await documentDir(),
    `${appName}/settings.json`,
  );

  const settingsExists = await exists(settingsPath);

  if (!settingsExists) {
    console.warn("Settings file not found. Creating default settings.");

    await saveSettings(defaultSettings);
    return defaultSettings;
  }

  try {
    const settingsData = await readTextFile(settingsPath);
    const settings = normalizeSettings(JSON.parse(settingsData));

    if (setSettings) {
      setSettings(settings);
    }

    await saveSettings(settings);

    return settings;
  } catch (error) {
    console.error("Failed to load settings:", error);
  }
};

export const normalizeSettings = (rawSettings: Partial<Settings>): Settings => {
  const recordingMethod: RecordingMethod =
    rawSettings.recordingMethod === "gpu-screen-recorder"
      ? "gpu-screen-recorder"
      : "obs";

  return {
    ...defaultSettings,
    ...rawSettings,
    gamesConfig: rawSettings.gamesConfig ?? {},
    obs: {
      ...defaultSettings.obs,
      ...(rawSettings.obs ?? {}),
    },
    gsr: {
      ...defaultSettings.gsr,
      ...(rawSettings.gsr ?? {}),
      audioDevices:
        rawSettings.gsr?.audioDevices?.length
          ? rawSettings.gsr.audioDevices
          : defaultSettings.gsr.audioDevices,
    },
    recordingMethod,
  };
};

export const saveSettings = async (settings: Settings) => {
  const appName = await getName();
  const docsPath = await documentDir();
  const appDir = await join(docsPath, appName);
  const settingsPath = await join(appDir, "settings.json");

  try {
    const dirExists = await exists(appDir);
    if (!dirExists) {
      await mkdir(appDir, { recursive: true });
    }

    await writeTextFile(settingsPath, JSON.stringify(settings));
  } catch (error) {
    console.error("Failed to save settings:", error);
  }
};

export const defaultSettings: Settings = {
  theme: "Mocha",
  gamesDir: null,
  gamesConfig: {},
  scrollbarOff: false,
  clipDeletion: false,
  clipsDeleteThreshold: 999999,
  borderRadiusOff: false,
  obs: {
    port: "0",
    password: "",
  },
  gsr: {
    captureTarget: "portal",
    fps: 60,
    codec: "auto",
    audioDevices: ["default_output"],
    replaySeconds: 120,
  },
  accentVariable: "--red",
  recordingSoundEnabled: true,
  recordingMethod: "obs",
};

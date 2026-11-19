import {
  createContext,
  useState,
  useContext,
  useEffect,
  useRef,
  ReactNode,
} from "react";

import { loadSettings } from "../helpers/settingsFile";
import { useSettings } from "./SettingsContext";
import { invoke } from "@tauri-apps/api/core";

import { GamesConfig, OBSSettings, RecordingMethod } from "../types/settings";
import yodaSound from "../assets/yoda.mp3";

import {
  obs,
  connectOBS,
  setOutputPathForGame,
  startOBSRecording,
  stopOBSRecording,
} from "../helpers/OBS";
import { useClips } from "./ClipsContext";
import { Clip } from "../types/clip";

interface ConnectionState {
  status: "disconnected" | "connected" | "error";
  version: string | null;
  error: string | null;
}

interface RecordingContextValue {
  connection: ConnectionState;
  connect: (port: string, password: string) => Promise<boolean>;
  obsSettings: OBSSettings;
  setObsSettings: (settings: OBSSettings) => void;
  startGameDetection: (settings: { gamesConfig: GamesConfig }) => void;
  recordingMethod: RecordingMethod;
  gsrSupported: boolean | null;
}

const RecordingContext = createContext<RecordingContextValue | undefined>(
  undefined,
);

interface RecordingProviderProps {
  children: ReactNode;
}

export const RecordingProvider = ({ children }: RecordingProviderProps) => {
  const { setAllClips } = useClips();
  const { settings, setSettings, loadedSettings } = useSettings();
  const isRecordingInProgress = useRef(false);

  const [connection, setConnection] = useState<ConnectionState>({
    status: "disconnected",
    version: null,
    error: null,
  });
  const [gsrSupported, setGsrSupported] = useState<boolean | null>(null);

  useEffect(() => {
    let cancelled = false;

    invoke<boolean>("gsr_supported")
      .then((supported) => {
        if (!cancelled) setGsrSupported(supported);
      })
      .catch((error) => {
        console.error("Failed to check GPU Screen Recorder support:", error);
        if (!cancelled) setGsrSupported(false);
      });

    return () => {
      cancelled = true;
    };
  }, []);

  const obsSettings = settings.obs;
  const setObsSettings = (update: Partial<OBSSettings>) => {
    setSettings((current) => ({
      ...current,
      obs: {
        ...current.obs,
        ...update,
      },
    }));
  };

  const gameDetectionInterval = useRef<NodeJS.Timeout | null>(null);
  const clearGameDetectionInterval = () => {
    if (gameDetectionInterval.current) {
      clearInterval(gameDetectionInterval.current);
      gameDetectionInterval.current = null;
    }
  };

  const playSound = () => {
    const audio = new Audio(yodaSound);
    audio.play().catch((err) => console.error("Failed to play sound:", err));
  };

  useEffect(() => {
    const handleConnectionClosed = (data: { message?: string }) => {
      console.log("OBS WebSocket disconnected:", data);

      clearGameDetectionInterval();
      setConnection({
        status: "disconnected",
        version: null,
        error: data?.message || "Connection closed",
      });
    };

    const handleConnectionError = (error: Error) => {
      console.error("OBS WebSocket error:", error);

      clearGameDetectionInterval();
      setConnection({
        status: "error",
        version: null,
        error: error.message,
      });
    };

    obs.on("ConnectionClosed", handleConnectionClosed);
    obs.on("ConnectionError", handleConnectionError);

    return () => {
      obs.off("ConnectionClosed", handleConnectionClosed);
      obs.off("ConnectionError", handleConnectionError);
    };
  }, []);

  useEffect(() => {
    const start = async () => {
      const loadedSettings = await loadSettings(null);
      setObsSettings(loadedSettings.obs);
    };
    start();
  }, []);

  useEffect(() => {
    if (gsrSupported === null) return;

    const initialize = async () => {
      try {
        if (
          !gsrSupported &&
          settings.recordingMethod === "gpu-screen-recorder"
        ) {
          setSettings((current) => ({
            ...current,
            recordingMethod: "obs",
          }));
          return;
        }

        if (settings.recordingMethod === "obs") {
          if (obsSettings.port && obsSettings.password) {
            await connect(obsSettings.port, obsSettings.password);
          }
          return;
        }

        const status = await invoke<{
          available: boolean;
          version: string | null;
          error: string | null;
        }>("gsr_check");

        setConnection({
          status: status.available ? "connected" : "error",
          version: status.version,
          error: status.error,
        });
      } catch (error) {
        console.error("Failed to initialize recording context:", error);
        setConnection({
          status: "error",
          version: null,
          error: (error as Error).message,
        });
      }
    };

    initialize();
  }, [gsrSupported, obsSettings, settings.recordingMethod]);

  useEffect(() => {
    if (loadedSettings && connection.status === "connected") {
      clearGameDetectionInterval();
      startGameDetection(settings);
    }
  }, [connection, settings, loadedSettings]);

  const connect = async (port: string, password: string): Promise<boolean> => {
    if (settings.recordingMethod !== "obs") return false;

    const result = await connectOBS(port, password);
    if (result.success) {
      setConnection({
        status: "connected",
        version: result.version ?? null,
        error: null,
      });
      return true;
    } else {
      setConnection({
        status: "error",
        version: null,
        error: result.error ?? "Unknown error",
      });
      return false;
    }
  };

  const detectNewClips = async () => {
    const lastChecked = localStorage.getItem("lastCheckedTimestamp");
    if (!lastChecked || !settings.gamesDir) return;

    const sinceTimestamp = parseInt(lastChecked, 10);
    const newClips = await invoke<Clip[]>("get_new_clips_since", {
      dir: settings.gamesDir,
      sinceTimestamp,
    });

    console.log(lastChecked, newClips)

    if (newClips.length > 0) {
      const now = Math.floor(Date.now() / 1000);
      localStorage.setItem("lastCheckedTimestamp", now.toString());

      window.dispatchEvent(
        new CustomEvent("newClipsDetected", { detail: newClips }),
      );
    }
  };

  const startRecording = async (
    currentGame: string,
    record: boolean,
  ): Promise<{ success: boolean; message?: string }> => {
    try {
      if (settings.recordingMethod === "obs") {
        if (settings.gamesDir) {
          await setOutputPathForGame(currentGame, settings.gamesDir);
        }
        return await startOBSRecording(
          currentGame,
          record,
          settings.recordingSoundEnabled,
          playSound,
        );
      }

      if (settings.recordingMethod === "gpu-screen-recorder") {
        if (!settings.gamesDir) {
          return {
            success: false,
            message: "Clips directory is not configured",
          };
        }

        await invoke("gsr_start_session", {
          gameName: currentGame,
          gamesDir: settings.gamesDir,
          options: {
            captureTarget: settings.gsr.captureTarget,
            fps: settings.gsr.fps,
            codec: settings.gsr.codec,
            audioDevices: settings.gsr.audioDevices,
            replaySeconds: settings.gsr.replaySeconds,
            record,
          },
        });

        if (settings.recordingSoundEnabled) playSound();

        return { success: true };
      }

      return { success: false, message: "Unknown recording method" };
    } catch (error) {
      console.error("Failed to start recording:", error);
      return { success: false, message: (error as Error).message };
    }
  };

  const stopRecording = async (
    record: boolean,
  ): Promise<{ success: boolean; message?: string }> => {
    try {
      let result: { success: boolean; message?: string };

      if (settings.recordingMethod === "obs") {
        result = await stopOBSRecording(record);
      } else if (settings.recordingMethod === "gpu-screen-recorder") {
        await invoke("gsr_stop_session");
        result = { success: true };
      } else {
        return { success: false, message: "Unknown recording method" };
      }

      if (result.success) {
        await detectNewClips();
      }

      return result;
    } catch (error) {
      console.error("Failed to stop recording:", error);
      return { success: false, message: (error as Error).message };
    }
  };

  async function getForegroundWindowTitle(): Promise<string | null> {
    try {
      return await invoke<string>("get_foreground_window_title");
    } catch (error) {
      console.error("Error getting foreground window title:", error);
      return null;
    }
  }

  async function isGameWindowFocused(
    gameName: string,
    gamesConfig: GamesConfig,
  ): Promise<boolean> {
    const config = gamesConfig[gameName];
    if (!config.windowTitles?.length) return true;

    const title = await getForegroundWindowTitle();
    if (!title) return true;

    return config.windowTitles.some((wt) =>
      title.toLowerCase().includes(wt.toLowerCase()),
    );
  }

  async function checkGameRunning(
    gamesConfig: GamesConfig,
  ): Promise<[string | null, boolean | null]> {
    if (connection.status !== "connected") return [null, null];
    try {
      const { running_processes } = await invoke<{
        running_processes: string[];
      }>("get_running_processes");

      const processGameMap = new Map<string, [string, boolean]>();
      for (const [gameName, config] of Object.entries(gamesConfig)) {
        for (const processName of config.processes) {
          processGameMap.set(processName.toLowerCase(), [
            gameName,
            config.record,
          ]);
        }
      }

      for (const process of running_processes) {
        const gameInfo = processGameMap.get(process.toLowerCase());
        if (gameInfo) {
          return [gameInfo[0], gameInfo[1]];
        }
      }

      return [null, null];
    } catch (error) {
      console.error("Error checking running processes:", error);
      return [null, null];
    }
  }

  function startGameDetection(gameSettings: { gamesConfig: GamesConfig }) {
    let lastDetectedRecord: boolean | null = null;
    let lastDetectedGame: string | null = null;

    const interval = setInterval(async () => {
      if (isRecordingInProgress.current) return;

      const [currentGame, record] = await checkGameRunning(
        gameSettings.gamesConfig,
      );

      if (currentGame !== lastDetectedGame) {
        if (currentGame) {
          const focused = await isGameWindowFocused(
            currentGame,
            gameSettings.gamesConfig,
          );
          if (!focused) {
            console.log(
              `${currentGame} process running but window not in focus. Waiting...`,
            );
            return;
          }

          console.log(
            `${currentGame} detected and window in focus! Starting recording with ${settings.recordingMethod}.`,
          );

          isRecordingInProgress.current = true;

          try {
            await startRecording(currentGame, record ?? false);
            console.log(`Started recording for ${currentGame}`);
          } catch (error) {
            console.error("Failed to start recording:", error);
          }

          isRecordingInProgress.current = false;
        } else if (lastDetectedGame) {
          isRecordingInProgress.current = true;

          try {
            await stopRecording(lastDetectedRecord ?? false);
            console.log(`Stopped recording for ${lastDetectedGame}`);

            await new Promise((resolve) => setTimeout(resolve, 5000));
          } catch (error) {
            console.error("Failed to stop recording:", error);
          }

          isRecordingInProgress.current = false;
        }

        lastDetectedGame = currentGame;
        lastDetectedRecord = record;
      }
    }, 2500);

    gameDetectionInterval.current = interval;

    return () => {
      clearInterval(interval);
    };
  }

  const value: RecordingContextValue = {
    connection,
    connect,
    obsSettings,
    setObsSettings,
    startGameDetection,
    recordingMethod: settings.recordingMethod,
    gsrSupported,
  };

  return (
    <RecordingContext.Provider value={value}>
      {children}
    </RecordingContext.Provider>
  );
};

export const useRecording = (): RecordingContextValue => {
  const context = useContext(RecordingContext);
  if (!context) {
    throw new Error("useRecording must be used within a RecordingProvider");
  }
  return context;
};

export default RecordingContext;

import React, { useCallback, useEffect, useMemo, useState } from "react";

import { invoke } from "@tauri-apps/api/core";
import { useSettings } from "../contexts/SettingsContext";
import { GSRSettings, GsrStatus } from "../types/settings";
import SettingButton from "./SettingButton";
import styles from "./Settings.module.css";

type AudioDevice = GsrStatus["audioDevices"][number];

const getAudioDeviceType = (device: AudioDevice) => {
  if (
    device.name === "default_output" ||
    device.name.endsWith(".monitor") ||
    device.name.startsWith("alsa_output.")
  ) {
    return "output";
  }

  if (
    device.name === "default_input" ||
    device.name.startsWith("alsa_input.")
  ) {
    return "input";
  }

  return "other";
};

const getAudioDeviceLabel = (device: AudioDevice) => {
  if (device.name === "default_output") return "Desktop audio";
  if (device.name === "default_input") return "Default microphone";

  return device.description
    .replace(/^Monitor of /i, "")
    .replace(/ Analog Stereo$/i, "")
    .replace(/ Digital Stereo.*$/i, "");
};

const GsrSettingsForm = React.memo(() => {
  const { settings, setSettings } = useSettings();
  const [status, setStatus] = useState<GsrStatus | null>(null);

  const updateGsr = useCallback(
    (update: Partial<GSRSettings>) => {
      setSettings((current) => ({
        ...current,
        gsr: {
          ...current.gsr,
          ...update,
        },
      }));
    },
    [setSettings],
  );

  const refreshStatus = useCallback(async () => {
    try {
      const result = await invoke<GsrStatus>("gsr_check");
      setStatus(result);
    } catch (error) {
      setStatus({
        available: false,
        version: null,
        supportsIpc: false,
        captureOptions: [],
        audioDevices: [],
        error: (error as Error).message,
      });
    }
  }, []);

  useEffect(() => {
    refreshStatus();
  }, [refreshStatus]);

  const captureOptions = Array.from(
    new Set(["portal", ...(status?.captureOptions ?? [])]),
  );

  const audioDevices = status?.audioDevices ?? [];

  const selectedAudioDevices =
    settings.gsr.audioDevices.length > 0
      ? settings.gsr.audioDevices
      : ["default_output"];

  const groupedDevices = useMemo(
    () => ({
      output: audioDevices.filter(
        (device) => getAudioDeviceType(device) === "output",
      ),
      input: audioDevices.filter(
        (device) => getAudioDeviceType(device) === "input",
      ),
      other: audioDevices.filter(
        (device) => getAudioDeviceType(device) === "other",
      ),
    }),
    [audioDevices],
  );

  const toggleAudioDevice = (deviceName: string, checked: boolean) => {
    const nextDevices = checked
      ? [...selectedAudioDevices, deviceName]
      : selectedAudioDevices.filter((name) => name !== deviceName);

    updateGsr({ audioDevices: [...new Set(nextDevices)] });
  };

  const renderAudioGroup = (title: string, devices: AudioDevice[]) => {
    if (devices.length === 0) return null;

    const selectedCount = devices.filter((device) =>
      selectedAudioDevices.includes(device.name),
    ).length;

    return (
      <section className={styles.audioDeviceGroup}>
        <div className={styles.audioGroupHeader}>
          <strong>{title}</strong>
          <span>
            {selectedCount} of {devices.length} selected
          </span>
        </div>

        <div className={styles.audioDeviceList}>
          {devices.map((device) => {
            const selected = selectedAudioDevices.includes(device.name);

            return (
              <label
                key={device.name}
                className={`${styles.audioDevice} ${
                  selected ? styles.audioDeviceSelected : ""
                }`}
              >
                <input
                  type="checkbox"
                  checked={selected}
                  onChange={(event) =>
                    toggleAudioDevice(device.name, event.target.checked)
                  }
                />

                <span className={styles.audioDeviceInfo}>
                  <span className={styles.audioDeviceName}>
                    {getAudioDeviceLabel(device)}
                  </span>
                  <span className={styles.audioDeviceDescription}>
                    {device.description}
                  </span>
                </span>
              </label>
            );
          })}
        </div>
      </section>
    );
  };

  return (
    <div className={styles.settingIndividual}>
      <div className={styles.subSectionTitle}>
        <strong>GPU Screen Recorder</strong>
        <SettingButton text="Refresh" func={refreshStatus} />
      </div>

      <div className={styles.currentSetting}>
        {status?.available
          ? `Available${status.version ? ` (${status.version})` : ""}`
          : (status?.error ?? "Checking gpu-screen-recorder...")}
      </div>

      {!status?.isWayland && (
        <div className={styles.inputGroup}>
          <label htmlFor="gsrCaptureTarget">Capture Target</label>
          <input
            autoComplete="off"
            id="gsrCaptureTarget"
            list="gsr-capture-targets"
            value={settings.gsr.captureTarget}
            onChange={(event) =>
              updateGsr({ captureTarget: event.target.value })
            }
            placeholder="portal"
          />
          <datalist id="gsr-capture-targets">
            {captureOptions.map((option) => (
              <option key={option} value={option} />
            ))}
          </datalist>
        </div>
      )}

      <div className={styles.inputGroup}>
        <label htmlFor="gsrFps">FPS</label>
        <input
          autoComplete="off"
          id="gsrFps"
          type="number"
          min={1}
          max={360}
          value={settings.gsr.fps}
          onChange={(event) =>
            updateGsr({ fps: Number(event.target.value) || 60 })
          }
        />
      </div>

      <div className={styles.inputGroup}>
        <label htmlFor="gsrCodec">Video Codec</label>
        <input
          autoComplete="off"
          id="gsrCodec"
          list="gsr-codecs"
          value={settings.gsr.codec}
          onChange={(event) => updateGsr({ codec: event.target.value })}
          placeholder="auto"
        />
        <datalist id="gsr-codecs">
          <option value="auto" />
          <option value="h264" />
          <option value="h265" />
          <option value="av1" />
        </datalist>
      </div>

      <div className={styles.audioSection}>
        {audioDevices.length > 0 ? (
          <>
            {renderAudioGroup("Output devices", groupedDevices.output)}
            {renderAudioGroup("Input devices", groupedDevices.input)}
            {renderAudioGroup("Other devices", groupedDevices.other)}

            <div className={styles.audioSelectionSummary}>
              <strong>
                {selectedAudioDevices.length}{" "}
                {selectedAudioDevices.length === 1 ? "source" : "sources"}{" "}
                selected
              </strong>
              <span>
                {selectedAudioDevices
                  .map((name) => {
                    const device = audioDevices.find(
                      (item) => item.name === name,
                    );
                    return device ? getAudioDeviceLabel(device) : name;
                  })
                  .join(", ")}
              </span>
            </div>
          </>
        ) : (
          <p className={styles.audioEmptyState}>
            {status?.available
              ? "No audio devices were found."
              : "Audio devices will appear here when GPU Screen Recorder is available."}
          </p>
        )}
      </div>

      <div className={styles.inputGroup}>
        <label htmlFor="gsrReplaySeconds">Replay Buffer (seconds)</label>
        <input
          autoComplete="off"
          id="gsrReplaySeconds"
          type="number"
          min={2}
          max={86400}
          value={settings.gsr.replaySeconds}
          onChange={(event) =>
            updateGsr({
              replaySeconds: Number(event.target.value) || 120,
            })
          }
        />
      </div>
    </div>
  );
});

export default GsrSettingsForm;

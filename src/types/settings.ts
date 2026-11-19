type GameConfig = {
  processes: string[];
  record: boolean;
  windowTitles?: string[];
};

export type GamesConfig = {
  [gameName: string]: GameConfig;
};

export type OBSSettings = {
  port: string | null;
  password: string | null;
};

export type GSRSettings = {
  captureTarget: string;
  fps: number;
  codec: string;
  audioDevices: string[];
  replaySeconds: number;
};

export interface GsrStatus {
  available: boolean;
  version: string | null;
  supportsIpc: boolean;
  captureOptions: string[];
  audioDevices: {
    name: string;
    description: string;
  }[];
  error: string | null;
}

export type RecordingMethod = "obs" | "gpu-screen-recorder";
export type Settings = {
  gamesDir: string | null;
  gamesConfig: GamesConfig;
  scrollbarOff: boolean;
  borderRadiusOff: boolean;
  clipsDeleteThreshold: number;
  clipDeletion: boolean;
  obs: OBSSettings;
  gsr: GSRSettings;
  theme: string;
  accentVariable: string;
  recordingSoundEnabled: boolean;
  recordingMethod: RecordingMethod;
};

export type SemanticColor = {
  name: string;
  variable: string;
  previewColor: string;
};

export type ThemeModeType = "Dark" | "Light" | "System";
export type ThemeFamily = "Catppuccin";

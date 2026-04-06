export const SYSTEM_AUDIO_DEVICE_ID = "system";

const AUDIO_INPUT_DEVICE_KEY = "pax-audio-input-device";
const AUDIO_OUTPUT_DEVICE_KEY = "pax-audio-output-device";

export interface AudioDeviceInfo {
  id: string;
  name: string;
  isDefault: boolean;
}

export interface AudioDeviceList {
  input: AudioDeviceInfo[];
  output: AudioDeviceInfo[];
}

export interface AudioDevicePreferences {
  inputDeviceId: string | null;
  outputDeviceId: string | null;
}

function getStoredDeviceId(key: string): string | null {
  try {
    const value = localStorage.getItem(key);
    if (!value || value === SYSTEM_AUDIO_DEVICE_ID) {
      return null;
    }
    return value;
  } catch {
    return null;
  }
}

function storeDeviceId(key: string, deviceId: string | null) {
  try {
    localStorage.setItem(key, deviceId ?? SYSTEM_AUDIO_DEVICE_ID);
  } catch {
    // Ignore persistence failures.
  }
}

export function getStoredAudioDevicePreferences(): AudioDevicePreferences {
  return {
    inputDeviceId: getStoredDeviceId(AUDIO_INPUT_DEVICE_KEY),
    outputDeviceId: getStoredDeviceId(AUDIO_OUTPUT_DEVICE_KEY),
  };
}

export function getStoredInputDeviceId(): string {
  return getStoredDeviceId(AUDIO_INPUT_DEVICE_KEY) ?? SYSTEM_AUDIO_DEVICE_ID;
}

export function getStoredOutputDeviceId(): string {
  return getStoredDeviceId(AUDIO_OUTPUT_DEVICE_KEY) ?? SYSTEM_AUDIO_DEVICE_ID;
}

export function storeInputDeviceId(deviceId: string) {
  storeDeviceId(
    AUDIO_INPUT_DEVICE_KEY,
    deviceId === SYSTEM_AUDIO_DEVICE_ID ? null : deviceId,
  );
}

export function storeOutputDeviceId(deviceId: string) {
  storeDeviceId(
    AUDIO_OUTPUT_DEVICE_KEY,
    deviceId === SYSTEM_AUDIO_DEVICE_ID ? null : deviceId,
  );
}

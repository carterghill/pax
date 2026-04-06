import { useState, useCallback, useEffect, useMemo } from "react";
import { AudioLines } from "lucide-react";
import { useTheme } from "../theme/ThemeContext";
import {
  AudioDeviceList,
  getStoredInputDeviceId,
  getStoredOutputDeviceId,
  storeInputDeviceId,
  storeOutputDeviceId,
  SYSTEM_AUDIO_DEVICE_ID,
} from "../hooks/useVoiceAudioDevices";

export interface VoiceAudioSettingsSectionProps {
  /** When false, skips loading device list and noise config (e.g. hidden tab). */
  active: boolean;
  listAudioDevices: () => Promise<AudioDeviceList>;
  getNoiseSuppressionConfig: () => Promise<{
    extraAttenuation: number;
    agcTargetRms: number;
  }>;
  setNoiseSuppressionConfig: (config: {
    extraAttenuation: number;
    agcTargetRms: number;
  }) => void | Promise<void>;
  toggleNoiseSuppression: () => void;
  isNoiseSuppressed: boolean;
  /** After input/output preference is stored; e.g. force-reconnect if in a voice room. */
  onAfterDevicePreferenceChange?: () => void | Promise<void>;
}

export default function VoiceAudioSettingsSection({
  active,
  listAudioDevices,
  getNoiseSuppressionConfig,
  setNoiseSuppressionConfig,
  toggleNoiseSuppression,
  isNoiseSuppressed,
  onAfterDevicePreferenceChange,
}: VoiceAudioSettingsSectionProps) {
  const { palette, spacing, typography } = useTheme();
  const [noiseConfig, setNoiseConfig] = useState({
    extraAttenuation: 0.1,
    agcTargetRms: 6000,
  });
  const [audioDevices, setAudioDevices] = useState<AudioDeviceList>({
    input: [],
    output: [],
  });
  const [audioDevicesLoading, setAudioDevicesLoading] = useState(false);
  const [audioDeviceError, setAudioDeviceError] = useState<string | null>(null);
  const [selectedInputDeviceId, setSelectedInputDeviceId] = useState(() =>
    getStoredInputDeviceId(),
  );
  const [selectedOutputDeviceId, setSelectedOutputDeviceId] = useState(() =>
    getStoredOutputDeviceId(),
  );

  useEffect(() => {
    if (!active) return;
    let cancelled = false;
    getNoiseSuppressionConfig()
      .then((c) => {
        if (!cancelled) setNoiseConfig(c);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [active, getNoiseSuppressionConfig]);

  useEffect(() => {
    if (!active) return;
    let cancelled = false;
    setAudioDevicesLoading(true);
    setAudioDeviceError(null);
    listAudioDevices()
      .then((devices) => {
        if (!cancelled) {
          setAudioDevices(devices);
        }
      })
      .catch((e) => {
        if (!cancelled) {
          setAudioDeviceError(String(e));
        }
      })
      .finally(() => {
        if (!cancelled) {
          setAudioDevicesLoading(false);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [active, listAudioDevices]);

  const visibleInputDeviceId = useMemo(() => {
    if (
      selectedInputDeviceId !== SYSTEM_AUDIO_DEVICE_ID &&
      !audioDevices.input.some((device) => device.id === selectedInputDeviceId)
    ) {
      return SYSTEM_AUDIO_DEVICE_ID;
    }
    return selectedInputDeviceId;
  }, [audioDevices.input, selectedInputDeviceId]);

  const visibleOutputDeviceId = useMemo(() => {
    if (
      selectedOutputDeviceId !== SYSTEM_AUDIO_DEVICE_ID &&
      !audioDevices.output.some((device) => device.id === selectedOutputDeviceId)
    ) {
      return SYSTEM_AUDIO_DEVICE_ID;
    }
    return selectedOutputDeviceId;
  }, [audioDevices.output, selectedOutputDeviceId]);

  const handleAudioDeviceChange = useCallback(
    async (kind: "input" | "output", deviceId: string) => {
      setAudioDeviceError(null);
      if (kind === "input") {
        setSelectedInputDeviceId(deviceId);
        storeInputDeviceId(deviceId);
      } else {
        setSelectedOutputDeviceId(deviceId);
        storeOutputDeviceId(deviceId);
      }
      try {
        await onAfterDevicePreferenceChange?.();
      } catch (e) {
        setAudioDeviceError(String(e));
      }
    },
    [onAfterDevicePreferenceChange],
  );

  return (
    <>
      <div
        style={{
          marginBottom: spacing.unit * 2,
          fontWeight: 600,
          fontSize: typography.fontSizeSmall,
        }}
      >
        Audio devices
      </div>
      <div
        style={{
          display: "flex",
          flexDirection: "column",
          gap: spacing.unit * 2,
        }}
      >
        <label
          style={{
            display: "flex",
            flexDirection: "column",
            gap: spacing.unit,
            fontSize: typography.fontSizeSmall,
          }}
        >
          <span>Input device</span>
          <select
            value={visibleInputDeviceId}
            disabled={audioDevicesLoading}
            onChange={(e) => {
              void handleAudioDeviceChange("input", e.target.value);
            }}
            style={{
              width: "100%",
              padding: `${spacing.unit}px ${spacing.unit * 1.5}px`,
              borderRadius: spacing.unit,
              border: `1px solid ${palette.border}`,
              backgroundColor: palette.bgTertiary,
              color: palette.textPrimary,
              fontSize: typography.fontSizeSmall,
            }}
          >
            <option value={SYSTEM_AUDIO_DEVICE_ID}>System default</option>
            {audioDevices.input.map((device) => (
              <option key={device.id} value={device.id}>
                {device.isDefault
                  ? `${device.name} (current default)`
                  : device.name}
              </option>
            ))}
          </select>
        </label>
        <label
          style={{
            display: "flex",
            flexDirection: "column",
            gap: spacing.unit,
            fontSize: typography.fontSizeSmall,
          }}
        >
          <span>Output device</span>
          <select
            value={visibleOutputDeviceId}
            disabled={audioDevicesLoading}
            onChange={(e) => {
              void handleAudioDeviceChange("output", e.target.value);
            }}
            style={{
              width: "100%",
              padding: `${spacing.unit}px ${spacing.unit * 1.5}px`,
              borderRadius: spacing.unit,
              border: `1px solid ${palette.border}`,
              backgroundColor: palette.bgTertiary,
              color: palette.textPrimary,
              fontSize: typography.fontSizeSmall,
            }}
          >
            <option value={SYSTEM_AUDIO_DEVICE_ID}>System default</option>
            {audioDevices.output.map((device) => (
              <option key={device.id} value={device.id}>
                {device.isDefault
                  ? `${device.name} (current default)`
                  : device.name}
              </option>
            ))}
          </select>
        </label>
        {audioDevicesLoading && (
          <div
            style={{
              fontSize: typography.fontSizeSmall,
              color: palette.textSecondary,
            }}
          >
            Loading audio devices...
          </div>
        )}
        {audioDeviceError && (
          <div style={{ fontSize: typography.fontSizeSmall, color: "#f23f43" }}>
            {audioDeviceError}
          </div>
        )}
        <div
          style={{
            fontSize: typography.fontSizeSmall,
            color: palette.textSecondary,
          }}
        >
          Device changes apply immediately and briefly reconnect voice.
        </div>
      </div>

      <div
        style={{
          marginTop: spacing.unit * 3,
          marginBottom: spacing.unit * 2,
          fontWeight: 600,
          fontSize: typography.fontSizeSmall,
        }}
      >
        Noise suppression
      </div>
      <button
        type="button"
        onClick={toggleNoiseSuppression}
        style={{
          width: "100%",
          padding: `${spacing.unit}px ${spacing.unit * 1.5}px`,
          borderRadius: spacing.unit,
          border: `1px solid ${palette.border}`,
          cursor: "pointer",
          backgroundColor: isNoiseSuppressed ? palette.accent : palette.bgTertiary,
          color: isNoiseSuppressed ? "#fff" : palette.textPrimary,
          fontSize: typography.fontSizeSmall,
          fontWeight: 600,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          gap: spacing.unit,
        }}
      >
        <AudioLines size={16} />
        {isNoiseSuppressed ? "Enabled" : "Disabled"}
      </button>

      <div
        style={{
          display: "flex",
          flexDirection: "column",
          gap: spacing.unit * 2,
          marginTop: spacing.unit * 2,
          opacity: isNoiseSuppressed ? 1 : 0.45,
          pointerEvents: isNoiseSuppressed ? "auto" : "none",
        }}
      >
        <label style={{ fontSize: typography.fontSizeSmall }}>
          Extra attenuation: {noiseConfig.extraAttenuation.toFixed(2)}
          <input
            type="range"
            min="0"
            max="1"
            step="0.05"
            value={noiseConfig.extraAttenuation}
            onChange={(e) => {
              const v = parseFloat(e.target.value);
              setNoiseConfig((c) => {
                const next = { ...c, extraAttenuation: v };
                setNoiseSuppressionConfig(next);
                return next;
              });
            }}
            style={{ display: "block", width: "100%", marginTop: 4 }}
          />
          <span
            style={{
              fontSize: typography.fontSizeSmall - 1,
              color: palette.textSecondary,
            }}
          >
            0 = pure RNNoise, higher = more silence suppression
          </span>
        </label>
        <label style={{ fontSize: typography.fontSizeSmall }}>
          AGC target RMS: {noiseConfig.agcTargetRms}{" "}
          {noiseConfig.agcTargetRms === 0 ? "(off)" : ""}
          <input
            type="range"
            min="0"
            max="12000"
            step="500"
            value={noiseConfig.agcTargetRms}
            onChange={(e) => {
              const v = parseInt(e.target.value, 10);
              setNoiseConfig((c) => {
                const next = { ...c, agcTargetRms: v };
                setNoiseSuppressionConfig(next);
                return next;
              });
            }}
            style={{ display: "block", width: "100%", marginTop: 4 }}
          />
          <span
            style={{
              fontSize: typography.fontSizeSmall - 1,
              color: palette.textSecondary,
            }}
          >
            0 = disabled, higher = louder normalisation target
          </span>
        </label>
      </div>
      <div
        style={{
          fontSize: typography.fontSizeSmall,
          color: palette.textSecondary,
          marginTop: spacing.unit * 2,
        }}
      >
        Noise suppression settings apply immediately
      </div>
    </>
  );
}

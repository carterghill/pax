/**
 * Noise suppression pipeline using RNNoise via @timephy/rnnoise-wasm.
 * 
 * Takes a raw microphone MediaStreamTrack, pipes it through an AudioWorklet
 * running RNNoise WASM, and returns a cleaned MediaStreamTrack.
 */

// @ts-ignore — Vite-specific import: ?worker&url bundles the worklet as a standalone script URL
import NoiseSuppressorWorkletUrl from "@timephy/rnnoise-wasm/NoiseSuppressorWorklet?worker&url";
import { NoiseSuppressorWorklet_Name } from "@timephy/rnnoise-wasm";

export interface NoiseSuppressorHandle {
  /** The denoised output track — publish this to LiveKit */
  track: MediaStreamTrack;
  /** Call to clean up all audio resources */
  destroy: () => void;
  /** Toggle noise suppression on/off (bypass mode) */
  setEnabled: (enabled: boolean) => void;
}

/**
 * Create a noise suppression pipeline for a microphone track.
 * 
 * @param inputTrack - Raw microphone MediaStreamTrack
 * @returns A handle with the denoised track and cleanup function
 */
export async function createNoiseSuppressor(
  inputTrack: MediaStreamTrack
): Promise<NoiseSuppressorHandle> {
  // Create AudioContext at 48kHz (RNNoise's native sample rate)
  const audioCtx = new AudioContext({ sampleRate: 48000 });

  // Load the RNNoise worklet
  await audioCtx.audioWorklet.addModule(NoiseSuppressorWorkletUrl);

  // Create the worklet node
  const suppressorNode = new AudioWorkletNode(audioCtx, NoiseSuppressorWorklet_Name);

  // Wire up: input track → suppressor → stereo splitter → destination
  const inputStream = new MediaStream([inputTrack]);
  const source = audioCtx.createMediaStreamSource(inputStream);
  const destination = audioCtx.createMediaStreamDestination();

  // Force the destination to output stereo so mono doesn't end up in left ear only
  destination.channelCount = 2;
  destination.channelCountMode = "explicit";
  destination.channelInterpretation = "speakers";

  // Use a gain node as a stereo upmixer between suppressor and destination
  const stereoUpMix = audioCtx.createGain();
  stereoUpMix.channelCount = 2;
  stereoUpMix.channelCountMode = "explicit";
  stereoUpMix.channelInterpretation = "speakers";
  stereoUpMix.gain.value = 1;

  source.connect(suppressorNode);
  suppressorNode.connect(stereoUpMix);
  stereoUpMix.connect(destination);

  // Get the denoised output track
  const outputTrack = destination.stream.getAudioTracks()[0];

  return {
    track: outputTrack,
    destroy: () => {
      source.disconnect();
      suppressorNode.disconnect();
      stereoUpMix.disconnect();
      audioCtx.close().catch(() => {});
    },
    setEnabled: (enabled: boolean) => {
      source.disconnect();
      suppressorNode.disconnect();
      stereoUpMix.disconnect();
      if (enabled) {
        source.connect(suppressorNode);
        suppressorNode.connect(stereoUpMix);
      } else {
        source.connect(stereoUpMix);
      }
      stereoUpMix.connect(destination);
    },
  };
}
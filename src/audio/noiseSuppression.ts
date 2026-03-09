/**
 * Noise suppression pipeline using RNNoise via @timephy/rnnoise-wasm.
 * 
 * Takes a raw microphone MediaStreamTrack, pipes it through an AudioWorklet
 * running RNNoise WASM, and returns a cleaned MediaStreamTrack.
 * 
 * RNNoise outputs mono. We use a ChannelMergerNode to explicitly duplicate
 * the mono output to both L and R channels so audio plays in both ears.
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
  const audioCtx = new AudioContext({ sampleRate: 48000 });

  await audioCtx.audioWorklet.addModule(NoiseSuppressorWorkletUrl);

  const suppressorNode = new AudioWorkletNode(audioCtx, NoiseSuppressorWorklet_Name);

  const inputStream = new MediaStream([inputTrack]);
  const source = audioCtx.createMediaStreamSource(inputStream);

  // ChannelMerger: explicitly duplicate mono (channel 0) to both L and R
  const merger = audioCtx.createChannelMerger(2);

  const destination = audioCtx.createMediaStreamDestination();

  // Initial wiring: source -> suppressor -> merger(both channels) -> destination
  source.connect(suppressorNode);
  suppressorNode.connect(merger, 0, 0); // mono output -> left
  suppressorNode.connect(merger, 0, 1); // mono output -> right
  merger.connect(destination);

  const outputTrack = destination.stream.getAudioTracks()[0];

  let enabled = true;

  return {
    track: outputTrack,
    destroy: () => {
      source.disconnect();
      suppressorNode.disconnect();
      merger.disconnect();
      audioCtx.close().catch(() => {});
    },
    setEnabled: (newEnabled: boolean) => {
      if (newEnabled === enabled) return;
      enabled = newEnabled;

      source.disconnect();
      suppressorNode.disconnect();
      merger.disconnect();

      if (enabled) {
        // source -> suppressor -> merger -> destination
        source.connect(suppressorNode);
        suppressorNode.connect(merger, 0, 0);
        suppressorNode.connect(merger, 0, 1);
      } else {
        // Bypass: source -> merger -> destination
        source.connect(merger, 0, 0);
        source.connect(merger, 0, 1);
      }
      merger.connect(destination);
    },
  };
}
// Turn-timer cues. Each cue plays one preloaded Audio element when a file is published under /sounds/ui/ (listed in
// /sounds/ui/manifest.json); otherwise a short generated tone stands in. Browser autoplay rules apply: the first user
// gesture unlocks audio (call unlock() from any tap). Nothing plays unless the viewer's Sounds setting is on.

import type { TimerCue } from "./clock";

export interface CuePlayerDeps {
  enabled: () => boolean;
  /** Cue name -> file path from the sound manifest (none published = tones only). */
  files?: () => Partial<Record<TimerCue, string>>;
  makeAudio?: (src: string) => { play(): Promise<unknown> | void; preload?: string; load?(): void };
  /** Plays a generated tone (frequency Hz, duration ms, repeats). */
  tone?: (hz: number, durationMs: number, times: number) => void;
}

/** Frequency, length and repeats of the stand-in tone per cue (one long chime, a double pip, a triple pip). */
export const CUE_TONES: Record<TimerCue, [number, number, number]> = { minute: [880, 260, 1], ten: [660, 120, 2], three: [1000, 90, 3] };

export function createCuePlayer(deps: CuePlayerDeps) {
  const audio = new Map<TimerCue, ReturnType<NonNullable<CuePlayerDeps["makeAudio"]>>>();
  let ctx: { resume?: () => unknown; createOscillator: () => any; createGain: () => any; destination: unknown; currentTime: number } | undefined;
  let unlocked = false;

  const defaultTone = (hz: number, durationMs: number, times: number): void => {
    try {
      const AC = (globalThis as { AudioContext?: new () => typeof ctx }).AudioContext;
      if (!AC) return;
      ctx ??= new AC() as typeof ctx;
      for (let i = 0; i < times; i++) {
        const osc = ctx!.createOscillator();
        const gain = ctx!.createGain();
        osc.frequency.value = hz;
        gain.gain.value = 0.15;
        osc.connect(gain); gain.connect(ctx!.destination);
        const at = ctx!.currentTime + (i * (durationMs + 70)) / 1000;
        osc.start(at); osc.stop(at + durationMs / 1000);
      }
    } catch { /* no audio */ }
  };
  const makeAudio = deps.makeAudio ?? ((src: string) => { const a = new Audio(src); a.preload = "auto"; return a; });

  return {
    /** First user gesture: lets audio start. Preloads each published cue file once. */
    unlock(): void {
      if (unlocked) return;
      unlocked = true;
      try {
        const files = deps.files?.() ?? {};
        for (const [cue, src] of Object.entries(files) as Array<[TimerCue, string]>) if (src && !audio.has(cue)) audio.set(cue, makeAudio(src));
        const AC = (globalThis as { AudioContext?: new () => typeof ctx }).AudioContext;
        if (AC) { ctx ??= new AC() as typeof ctx; void ctx?.resume?.(); }
      } catch { /* no audio */ }
    },
    get unlocked(): boolean { return unlocked; },
    /** Plays a cue unless Sounds is off or audio is still locked by the browser. Returns what it used. */
    play(cue: TimerCue): "file" | "tone" | "off" {
      if (!deps.enabled() || !unlocked) return "off";
      const a = audio.get(cue);
      try {
        if (a) { void a.play(); return "file"; }
      } catch { /* fall through to the tone */ }
      const [hz, d, n] = CUE_TONES[cue];
      (deps.tone ?? defaultTone)(hz, d, n);
      return "tone";
    },
  };
}

export type CuePlayer = ReturnType<typeof createCuePlayer>;

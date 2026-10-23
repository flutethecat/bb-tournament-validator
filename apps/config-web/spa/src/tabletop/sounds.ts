// Turn-timer cues. Each cue plays one preloaded Audio element when a file is published under /sounds/ui/ (listed in
// /sounds/ui/manifest.json); otherwise a short generated tone stands in. Browser autoplay rules apply: the first user
// gesture unlocks audio (call unlock() from any tap). Nothing plays unless the viewer's Sounds setting is on.

import type { TimerCue } from "./clock";

/** Which published file backs which cue: the warning tone reuses the minute sound, like the client. */
export const CUE_FILE: Record<TimerCue, "minute" | "countdown"> = { minute: "minute", warning: "minute", countdown: "countdown" };

export interface CuePlayerDeps {
  enabled: () => boolean;
  /** "minute" / "countdown" -> file path, from /sounds/ui/manifest.json (none published = generated tones only). */
  files?: () => Partial<Record<"minute" | "countdown", string>>;
  makeAudio?: (src: string) => { play(): Promise<unknown> | void; currentTime?: number; preload?: string; load?(): void };
  /** Plays a generated tone (frequency Hz, duration ms). */
  tone?: (hz: number, durationMs: number) => void;
}

/** The stand-in tone: one long chime at 1:00, a short beep each second after, rising a little on the last three. */
export function toneFor(cue: TimerCue, seconds: number): [number, number] {
  if (cue === "minute") return [880, 320];
  const hz = seconds > 3 ? 700 : seconds === 3 ? 760 : seconds === 2 ? 820 : 880;
  return [hz, 110];
}

export function createCuePlayer(deps: CuePlayerDeps) {
  const audio = new Map<"minute" | "countdown", ReturnType<NonNullable<CuePlayerDeps["makeAudio"]>>>();
  let ctx: { resume?: () => unknown; createOscillator: () => any; createGain: () => any; destination: unknown; currentTime: number } | undefined;
  let unlocked = false;

  const defaultTone = (hz: number, durationMs: number): void => {
    try {
      const AC = (globalThis as { AudioContext?: new () => typeof ctx }).AudioContext;
      if (!AC) return;
      ctx ??= new AC() as typeof ctx;
      const osc = ctx!.createOscillator();
      const gain = ctx!.createGain();
      osc.frequency.value = hz;
      gain.gain.value = 0.15;
      osc.connect(gain); gain.connect(ctx!.destination);
      osc.start(); osc.stop(ctx!.currentTime + durationMs / 1000);
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
        for (const [name, src] of Object.entries(files) as Array<["minute" | "countdown", string]>) if (src && !audio.has(name)) audio.set(name, makeAudio(src));
        const AC = (globalThis as { AudioContext?: new () => typeof ctx }).AudioContext;
        if (AC) { ctx ??= new AC() as typeof ctx; void ctx?.resume?.(); }
      } catch { /* no audio */ }
    },
    get unlocked(): boolean { return unlocked; },
    /** Plays a cue (a published file when there is one, else a generated tone) unless Sounds is off or audio is locked. */
    play(cue: TimerCue, seconds = 0): "file" | "tone" | "off" {
      if (!deps.enabled() || !unlocked) return "off";
      const a = audio.get(CUE_FILE[cue]);
      try {
        if (a) { if (typeof a.currentTime === "number") a.currentTime = 0; void a.play(); return "file"; }
      } catch { /* fall through to the tone */ }
      const [hz, d] = toneFor(cue, seconds);
      (deps.tone ?? defaultTone)(hz, d);
      return "tone";
    },
  };
}

export type CuePlayer = ReturnType<typeof createCuePlayer>;

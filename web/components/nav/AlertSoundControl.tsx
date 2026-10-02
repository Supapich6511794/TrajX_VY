"use client";

/**
 * AlertSoundControl — the speaker button in the bar's utility group, and the
 * small popover it opens: a volume slider for the conflict alert tones, a
 * mute toggle and a Test button.
 *
 * The volume itself lives in `lib/cdr/sound` (persisted there), so this is a
 * view of it and nothing more — `playAlert` reads the same value wherever it
 * is called from.
 */

import {
  memo,
  useEffect,
  useRef,
  useState,
  type CSSProperties,
} from "react";

import NavIcon from "@/components/nav/NavIcon";
import {
  getAlertVolume,
  onAlertVolume,
  playAlert,
  setAlertVolume,
} from "@/lib/cdr/sound";

export interface AlertSoundControlProps {
  /** Called when the popover opens, so the bar can close its own dropdown. */
  onOpen?: () => void;
}

function AlertSoundControl({ onOpen }: AlertSoundControlProps) {
  const [open, setOpen] = useState(false);
  // Starts at the default and syncs after mount: localStorage is not there
  // during the server render, and reading it then would mismatch hydration.
  const [volume, setVolume] = useState(0.5);
  // The level to return to when un-muting from the speaker toggle.
  const lastAudible = useRef(0.5);
  const wrapRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const v = getAlertVolume();
    setVolume(v);
    if (v > 0) lastAudible.current = v;
    return onAlertVolume(setVolume);
  }, []);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const muted = volume <= 0;
  const pct = Math.round(volume * 100);

  const change = (v: number) => {
    if (v > 0) lastAudible.current = v;
    setAlertVolume(v);
  };

  return (
    <div className="mnav-sound" ref={wrapRef}>
      <button
        type="button"
        className={`mnav-util-btn${open ? " open" : ""}`}
        onClick={() => {
          if (!open) onOpen?.();
          setOpen((o) => !o);
        }}
        title={muted ? "Alert sound: muted" : `Alert sound: ${pct}%`}
        aria-label="Alert sound"
        aria-expanded={open}
        aria-haspopup="dialog"
      >
        <NavIcon name={muted ? "volume-off" : "volume"} size={15} />
      </button>

      {open && (
        <div className="mnav-sound-pop" role="dialog" aria-label="Alert sound">
          <div className="mnav-sound-head">
            <span className="mnav-sound-title">Alert sound</span>
            <span className={`mnav-sound-pct${muted ? " muted" : ""}`}>
              {muted ? "Muted" : `${pct}%`}
            </span>
          </div>

          <div className="mnav-sound-row">
            <button
              type="button"
              className="mnav-sound-mute"
              onClick={() => change(muted ? lastAudible.current : 0)}
              title={muted ? "Unmute" : "Mute"}
              aria-label={muted ? "Unmute alert sound" : "Mute alert sound"}
              aria-pressed={muted}
            >
              <NavIcon name={muted ? "volume-off" : "volume"} size={15} />
            </button>
            <input
              type="range"
              className="mnav-sound-slider"
              min={0}
              max={100}
              step={5}
              value={pct}
              onChange={(e) => change(Number(e.target.value) / 100)}
              aria-label="Alert volume"
              aria-valuetext={muted ? "Muted" : `${pct} percent`}
              style={{ "--fill": `${pct}%` } as CSSProperties}
            />
          </div>

          <div className="mnav-sound-foot">
            <span>Applies to conflict alerts.</span>
            <button
              type="button"
              className="mnav-sound-test"
              onClick={() => playAlert("STCA")}
              disabled={muted}
            >
              Test
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

export default memo(AlertSoundControl);

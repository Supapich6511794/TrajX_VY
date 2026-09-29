"use client";

/**
 * SearchCombo — a free-text search input with a rich suggestion dropdown.
 *
 * Unlike a native <datalist> (which can only show a flat list of single
 * values), each suggestion is ONE row combining a tag + label + optional
 * meta — e.g. "R1 · BGO W13 MIA · 330 NM" — mirroring the Download dialog's
 * route picker. Typing filters the rows; picking one commits its `value`
 * to the input (which the parent's matcher then filters on).
 */

import { useRef, useState } from "react";

export interface ComboSuggestion {
  /** Committed to the input when this row is picked. */
  value: string;
  /** Left chip — e.g. "R1" or a callsign. */
  tag: string;
  /** Main label — e.g. the route string or "VYYY → VYMD". */
  text: string;
  /** Optional right-aligned detail — e.g. distance. */
  meta?: string;
}

interface Props {
  value: string;
  onChange: (v: string) => void;
  suggestions: ComboSuggestion[];
  placeholder?: string;
}

const SEPARATORS = /[\s,]+/;

export default function SearchCombo({
  value,
  onChange,
  suggestions,
  placeholder,
}: Props) {
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const blurTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const tokens = value.trim().toUpperCase().split(SEPARATORS).filter(Boolean);
  const matches = suggestions.filter((s) => {
    if (tokens.length === 0) return true;
    const hay = `${s.tag} ${s.text} ${s.value}`.toUpperCase();
    return tokens.every((t) => hay.includes(t));
  });
  const showList = open && matches.length > 0;

  const pick = (s: ComboSuggestion) => {
    onChange(s.value);
    setOpen(false);
    setActive(0);
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (!showList) {
      if (e.key === "ArrowDown" && matches.length) setOpen(true);
      return;
    }
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setActive((a) => (a + 1) % matches.length);
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActive((a) => (a - 1 + matches.length) % matches.length);
    } else if (e.key === "Enter") {
      e.preventDefault();
      pick(matches[Math.min(active, matches.length - 1)]);
    } else if (e.key === "Escape") {
      setOpen(false);
    }
  };

  return (
    <div className={`sc${open ? " open" : ""}`}>
      <input
        type="text"
        className="sc-input"
        value={value}
        placeholder={placeholder}
        onChange={(e) => {
          onChange(e.target.value);
          setOpen(true);
          setActive(0);
        }}
        onFocus={() => setOpen(true)}
        onBlur={() => {
          blurTimer.current = setTimeout(() => setOpen(false), 140);
        }}
        onKeyDown={onKeyDown}
        role="combobox"
        aria-expanded={showList}
        aria-autocomplete="list"
        autoComplete="off"
      />
      {showList && (
        <ul className="sc-list" role="listbox">
          {matches.map((s, idx) => (
            <li key={`${s.tag}-${s.value}-${idx}`} role="option" aria-selected={idx === active}>
              <button
                type="button"
                className={idx === active ? "active" : undefined}
                onMouseEnter={() => setActive(idx)}
                onMouseDown={(e) => {
                  // Keep focus so the blur-close doesn't fire before click.
                  e.preventDefault();
                  if (blurTimer.current) clearTimeout(blurTimer.current);
                }}
                onClick={() => pick(s)}
              >
                <span className="sc-tag">{s.tag}</span>
                <span className="sc-text">{s.text}</span>
                {s.meta && <span className="sc-meta">{s.meta}</span>}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

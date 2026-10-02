"use client";

/**
 * MainNavigation — the application's global bar, above everything else.
 *
 * It is the only navigation at this level: Home, the tool menus, and the
 * export action. What it is NOT is a view of the Generator — the workspace
 * below it (the rail + the map) is one page of the application, and this bar
 * stays put while that page changes.
 *
 * The bar itself renders `MAIN_NAV_ITEMS` in order and asks the caller for a
 * `slot` per id: whether the tab is active, what its badge says, what pressing
 * it does, and what its dropdown contains. Which dropdown is open is the only
 * state it keeps — everything a menu reads or writes lives in MapApp, where
 * the map state already is.
 */

import {
  memo,
  useCallback,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";

import AlertSoundControl from "@/components/nav/AlertSoundControl";
import MainNavItem from "@/components/nav/MainNavItem";
import NavIcon from "@/components/nav/NavIcon";
import { MAIN_NAV_ITEMS } from "@/components/nav/mainNavItems";
import type { MainNavId } from "@/components/nav/types";
import type { Theme } from "@/lib/mapPrefs";

/** What the caller supplies per tab. A tab with no slot renders disabled. */
export interface MainNavSlot {
  /** The page or panel this tab leads to is the one currently showing. */
  active?: boolean;
  disabled?: boolean;
  /** Overrides the registry's hint — used to say WHY a tab is disabled. */
  hint?: string;
  badge?: { text: string; tone?: "accent" | "alert" } | null;
  /** Fired when an action tab is pressed, and when a menu tab is opened.
   *  Menu tabs use it for the side-effects that opening implies (the
   *  Conflicts tab, for instance, needs playback on "all routes"). */
  onSelect?: () => void;
  /** Dropdown contents, as a render prop. Its presence is what makes the tab
   *  a menu; `close` lets a row that navigates somewhere dismiss the dropdown
   *  behind it, while a row that toggles something leaves it up. Only called
   *  while the dropdown is open. */
  menu?: (close: () => void) => ReactNode;
}

export interface MainNavigationProps {
  slots: Partial<Record<MainNavId, MainNavSlot>>;
  /** UI theme switch — a global preference, so it sits with the bar rather
   *  than on the map it recolours. */
  theme: Theme;
  onTheme: (t: Theme) => void;
  onZoomIn?: () => void;
  onZoomOut?: () => void;
  /** Phone only: the workspace rail is a drawer there, and this opens it. */
  onToggleSidebar?: () => void;
}

function MainNavigation({
  slots,
  theme,
  onTheme,
  onZoomIn,
  onZoomOut,
  onToggleSidebar,
}: MainNavigationProps) {
  const [openId, setOpenId] = useState<MainNavId | null>(null);
  const barRef = useRef<HTMLElement>(null);

  const close = useCallback(() => setOpenId(null), []);

  // A click anywhere outside the bar closes the open dropdown. Registered on
  // mousedown so it beats the click that would otherwise re-open it.
  useEffect(() => {
    if (!openId) return;
    const onDown = (e: MouseEvent) => {
      if (barRef.current && !barRef.current.contains(e.target as Node)) close();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") close();
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [openId, close]);

  return (
    <header className="mnav" ref={barRef}>
      {/* Phone only: the workspace rail is off-canvas there. */}
      {onToggleSidebar && (
        <button
          type="button"
          className="mnav-drawer"
          onClick={() => {
            close();
            onToggleSidebar();
          }}
          aria-label="Toggle the workspace panel"
          title="Show or hide the workspace panel"
        >
          <NavIcon name="menu" size={17} />
        </button>
      )}

      <nav className="mnav-tabs" aria-label="Main navigation">
        {MAIN_NAV_ITEMS.map((def) => {
          const slot = slots[def.id];
          const hasMenu = def.kind === "menu" && !!slot?.menu;
          const open = openId === def.id;
          return (
            <MainNavItem
              key={def.id}
              id={def.id}
              icon={<NavIcon name={def.icon} />}
              label={def.label}
              iconOnly={def.iconOnly}
              hint={slot?.hint ?? def.hint}
              active={slot?.active}
              // No slot at all means the tab is registered but not wired up
              // yet: it shows, in place, and does nothing.
              disabled={
                slot ? slot.disabled ?? (!slot.onSelect && !slot.menu) : true
              }
              hasMenu={hasMenu}
              open={open}
              badge={slot?.badge}
              onSelect={() => {
                slot?.onSelect?.();
                setOpenId(hasMenu && !open ? def.id : null);
              }}
            >
              {hasMenu && open ? slot!.menu!(close) : null}
            </MainNavItem>
          );
        })}
      </nav>

      {/* Chrome that belongs to no tab: alert sound, the UI theme and the
          map's zoom. */}
      <div className="mnav-util">
        <AlertSoundControl onOpen={close} />
        <button
          type="button"
          className="mnav-util-btn"
          onClick={() => {
            close();
            onTheme(theme === "dark" ? "light" : "dark");
          }}
          title="Toggle light / dark mode"
          aria-label="Toggle light / dark mode"
        >
          <NavIcon name={theme === "dark" ? "moon" : "sun"} size={15} />
        </button>
        {onZoomIn && (
          <button
            type="button"
            className="mnav-util-btn"
            onClick={() => {
              close();
              onZoomIn();
            }}
            title="Zoom in"
            aria-label="Zoom in"
          >
            +
          </button>
        )}
        {onZoomOut && (
          <button
            type="button"
            className="mnav-util-btn"
            onClick={() => {
              close();
              onZoomOut();
            }}
            title="Zoom out"
            aria-label="Zoom out"
          >
            −
          </button>
        )}
      </div>
    </header>
  );
}

export default memo(MainNavigation);

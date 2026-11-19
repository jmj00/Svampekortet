// "My location" as a single answer, not a mode.
//
// MapLibre's GeolocateControl with `trackUserLocation: true` keeps a GPS
// watch running and re-fires "geolocate" on every update. Any camera move it
// did not make itself -- the user dragging the map to look for a forest, or
// the app's own flight to the pin on a phone -- puts it in a "background"
// state: the watch and the "geolocate" events go on, but the control reports
// "trackuserlocationend". The app took that as "off", so a tap elsewhere no
// longer stopped the watch, and the next GPS update put the pin (and on a
// phone the camera) straight back on the user's position. A press of the
// button in that state locks on again instead of switching off, so it took
// two presses or more to get rid of it (the bug as reported from a phone; a
// desktop's position hardly ever updates, so it did not show there).
//
// The control is now set up without tracking (map.ts): each press asks for one
// position, moves the camera there once and fires "geolocate" once. This
// module decides what that one answer may do: set the pin, unless the user
// has chosen a spot of their own since asking (a slow fix must not undo a
// tap), or has given up on it (the start screen's place step).

export interface LocateGate {
  /** A position was asked for (the button, or the app on the user's behalf). */
  asked(): void;
  /** The user chose a spot themselves, or gave up waiting: an answer still on
   * its way no longer sets the pin. */
  superseded(): void;
  /** A position arrived: whether it should set the pin. Only the first
   * answer to a request does. */
  accept(): boolean;
}

export function createLocateGate(): LocateGate {
  let waiting = false;
  return {
    asked() {
      waiting = true;
    },
    superseded() {
      waiting = false;
    },
    accept() {
      if (!waiting) return false;
      waiting = false;
      return true;
    },
  };
}

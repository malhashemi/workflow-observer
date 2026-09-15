import { useLayoutEffect, useState, useSyncExternalStore } from "react";
import { createObservation, sameSelection, type Selection } from "./index";

export function useObservation(selection: Selection) {
  const [observation] = useState(createObservation);
  const state = useSyncExternalStore(
    observation.subscribe,
    observation.getSnapshot,
    observation.getSnapshot,
  );
  useLayoutEffect(() => {
    observation.dispatch({ type: "select", selection });
  }, [observation, selection.days, selection.runKey]);
  // A render for another target must never borrow the previous target's data.
  const selected = sameSelection(state.selection, selection);
  return {
    ...state,
    library: selected ? state.library : { ...state.library, value: null },
    detail: selected ? state.detail : { ...state.detail, value: null },
    refreshNow: () => observation.dispatch({ type: "refresh" }),
  };
}

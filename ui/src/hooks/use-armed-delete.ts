import { useEffect, useState } from "react";

/**
 * Two-step destructive actions.
 *
 * A `confirm()` dialog is one tap through, and on a phone it can be dismissed by
 * reflex. This arms the control instead: the first press changes the button's
 * own appearance, the second performs the action, and arming lapses after a few
 * seconds so a stray press cannot leave a live trigger sitting there.
 *
 * Used by every delete in the app: a chapter, all chapters, and a project.
 */
export function useArmedDelete(timeoutMs = 4000) {
  const [armed, setArmed] = useState<string | null>(null);

  useEffect(() => {
    if (!armed) return;
    const timer = setTimeout(() => setArmed(null), timeoutMs);
    return () => clearTimeout(timer);
  }, [armed, timeoutMs]);

  /** First call arms `id`, second call runs `action`. Anything else disarms. */
  const confirmThen = (id: string, action: () => void) => {
    if (armed === id) {
      setArmed(null);
      action();
      return;
    }
    setArmed(id);
  };

  return { armed, confirmThen };
}

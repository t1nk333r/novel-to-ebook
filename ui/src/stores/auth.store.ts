import { create } from "zustand";
import { persist } from "zustand/middleware";
import { createDisclosure } from "@/lib/store";

type AuthStore = {
  token: string | null;
};

export const authStore = create<AuthStore>()(
  persist<AuthStore>(
    () => ({
      token: null,
    }),
    { name: "app/auth" },
  ),
);

/** Opened with `{ rejected: true }` when a token was sent and still got a 401. */
export const tokenGate = createDisclosure<{ rejected: boolean }>();

export function getApiToken() {
  return authStore.getState().token;
}

export function reportUnauthorized() {
  tokenGate.onOpen({ rejected: Boolean(getApiToken()) });
}

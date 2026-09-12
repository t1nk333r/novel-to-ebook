import { useState } from "react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { authStore, tokenGate } from "@/stores/auth.store";

export default function TokenGate() {
  const { open, data } = tokenGate.useStore();
  const [value, setValue] = useState("");

  function onSubmit(event: React.FormEvent) {
    event.preventDefault();
    const token = value.trim();
    if (!token) return;

    authStore.setState({ token });
    // A reload is the cheapest correct way to re-issue every already-failed
    // query, cached image URL and in-flight stream with the new credential.
    window.location.reload();
  }

  return (
    <Dialog open={open} onOpenChange={tokenGate.setOpen}>
      <DialogContent showCloseButton>
        <DialogHeader>
          <DialogTitle>Authentication required</DialogTitle>
          <DialogDescription>
            This Storvi server requires an API token. Paste the value of{" "}
            <code>API_TOKEN</code> from the server's environment. It is stored in
            this browser only.
          </DialogDescription>
        </DialogHeader>

        <form onSubmit={onSubmit} className="flex flex-col gap-3">
          <div className="flex flex-col gap-2">
            <Label htmlFor="api-token">API token</Label>
            <Input
              id="api-token"
              name="api-token"
              type="password"
              autoComplete="off"
              autoFocus
              value={value}
              onChange={(e) => setValue(e.target.value)}
            />
          </div>

          {data?.rejected ? (
            <p className="text-destructive text-sm">
              That token was rejected. Check <code>API_TOKEN</code> on the
              server.
            </p>
          ) : null}

          <DialogFooter className="mt-1">
            <Button type="submit" disabled={!value.trim()}>
              Save and reload
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

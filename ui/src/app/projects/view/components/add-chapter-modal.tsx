import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Field, FieldLabel } from "@/components/ui/field";
import {
  InputGroup,
  InputGroupAddon,
  InputGroupButton,
  InputGroupInput,
} from "@/components/ui/input-group";
import api, { $api, invalidateQuery, type JsonBody } from "@/lib/api";
import { createDisclosure } from "@/lib/store";
import { zodResolver } from "@hookform/resolvers/zod";
import {
  BookSearchIcon,
  ChevronLeftIcon,
  LinkIcon,
  NotebookPenIcon,
  SquareDashedMousePointerIcon,
} from "lucide-react";
import { useState } from "react";
import { useForm, useWatch } from "react-hook-form";
import z from "zod";
import { useProjectContext } from "../lib/context";
import { toast } from "sonner";
import { fontDecryptMapModal, type FontDecryptData } from "./font-decrypt-map";
import { openEditorTab } from "../lib/utils";
import { importTOCModal } from "./import-toc-dialog";
import { customSelectorModal } from "./custom-selector-modal";

export const addChapterModal = createDisclosure();

const schema = z.union([
  z.object({
    type: z.literal("empty"),
    title: z.string().min(1),
  }),
  z.object({
    type: z.literal("link"),
    url: z.url().min(1),
    // Mirrors the API contract: a hand-typed selector is a string, the picker
    // submits the ordered list of picked blocks. A string-only schema here
    // rejected every picked selection, and the resolver failure surfaced as a
    // Save button that did nothing.
    selector: z.union([z.string(), z.string().array()]).nullish(),
    framePath: z.string().array().nullish(),
  }),
  z.object({ type: z.null() }),
]);

type CreateChapterBody = JsonBody<"/projects/{projectId}/chapters", "post">;

export default function AddChapterModal() {
  const { project } = useProjectContext();
  const { open } = addChapterModal.useStore();
  const form = useForm<any>({
    resolver: zodResolver(schema as any) as any,
    defaultValues: { type: null },
  });
  const type = useWatch({ control: form.control, name: "type" });
  const selectorValue = useWatch({ control: form.control, name: "selector" });
  const urlValue = useWatch({ control: form.control, name: "url" });
  const [isPending, setPending] = useState(false);

  const create = $api.useMutation("post", "/projects/{projectId}/chapters", {
    onSuccess(data) {
      addChapterModal.setOpen(false);
      form.reset({ type: null });
      invalidateQuery("/projects/{projectId}/chapters");
      openEditorTab(data);
    },
    onError(err) {
      toast.error((err as Error).message);
    },
  });

  // Deliberately no reset on open: this dialog is closed and reopened around the
  // selector picker, and clearing the URL there meant the reopened form failed
  // validation silently — Save appeared to do nothing at all. The form is reset
  // after a successful create instead.
  const onSubmit = form.handleSubmit(
    async (values) => {
      const body: CreateChapterBody = { title: "", content: "", index: 0 };
      let obfuscated: FontDecryptData | null = null;

    try {
      setPending(true);

      if (values.type === "empty") {
        body.title = values.title;
      }

      if (values.type === "link") {
        const { data } = await api.POST("/projects/extract", {
          body: {
            projectId: project.id,
            url: values.url!,
            selector: values.selector,
            framePath: values.framePath,
          },
        });

        if (!data?.content) {
          throw new Error("No content!");
        }

        body.title = data.chapter || data.title;
        body.content = data.content;

        if (data.isObfuscated && data.fonts?.length > 0) {
          obfuscated = {
            fonts: data.fonts,
            title: data.chapter || data.title,
            content: data.content,
          };
        }
      }

      // Add new chapter
      create.mutate(
        { params: { path: { projectId: project.id } }, body },
        {
          onSuccess(data) {
            if (obfuscated) {
              setTimeout(
                () =>
                  fontDecryptMapModal.onOpen({
                    ...obfuscated!,
                    chapterId: data.id,
                  }),
                500,
              );
            }
          },
        },
      );
    } catch (err) {
      toast.error((err as Error).message);
    } finally {
      setPending(false);
    }
    },
    // A silent validation failure is how a picked selector looked like a dead
    // Save button. Name the field so the next one is obvious.
    (errors) => {
      const fields = Object.keys(errors);
      toast.error(
        fields.length
          ? `Check the ${fields.join(" and ")} field${fields.length > 1 ? "s" : ""}`
          : "Fill in the form before saving",
      );
    },
  );

  // Mounted only while open. A dialog closed in the same tick as another opens
  // never finishes its exit animation, so Radix left it mounted with its layer
  // still active — which made the dialog opened next unclickable (see plan 025).
  // The component itself stays mounted, so the form state survives.
  if (!open) return null;

  return (
    <Dialog open onOpenChange={addChapterModal.setOpen}>
      <DialogContent>
        <DialogHeader>
          <div className="flex items-center gap-1">
            {type != null && (
              <Button
                variant="ghost"
                className="-ml-4"
                onClick={() => form.setValue("type", null)}
              >
                <ChevronLeftIcon />
              </Button>
            )}
            <DialogTitle>Add Chapter</DialogTitle>
          </div>
          <DialogDescription>
            Select type and add new chapter to the book
          </DialogDescription>
        </DialogHeader>

        {!type ? (
          <div className="grid grid-cols-3 gap-4">
            <Button
              variant="outline"
              className="flex-col h-24"
              onClick={() => form.setValue("type", "empty")}
            >
              <NotebookPenIcon />
              Empty
            </Button>
            <Button
              variant="outline"
              className="flex-col h-24"
              onClick={() => form.setValue("type", "link")}
            >
              <LinkIcon />
              Link
            </Button>
            <Button
              variant="outline"
              className="flex-col h-24"
              onClick={() => {
                addChapterModal.setOpen(false);
                importTOCModal.onOpen();
              }}
            >
              <BookSearchIcon />
              Multi Link
            </Button>
          </div>
        ) : (
          <form onSubmit={onSubmit}>
            {type === "empty" && (
              <div className="space-y-3">
                <Field>
                  <FieldLabel>Title</FieldLabel>
                  <InputGroup>
                    <InputGroupInput
                      autoFocus
                      placeholder="Untitled"
                      {...form.register("title")}
                    />
                  </InputGroup>
                </Field>
              </div>
            )}

            {type === "link" && (
              <div className="space-y-3">
                <Field>
                  <FieldLabel>URL</FieldLabel>
                  <InputGroup>
                    <InputGroupInput
                      autoFocus
                      placeholder="https://"
                      value={urlValue ?? ""}
                      onChange={(e) => form.setValue("url", e.target.value)}
                    />
                  </InputGroup>
                </Field>

                <Field>
                  <FieldLabel>Custom Selector</FieldLabel>
                  <InputGroup>
                    <InputGroupInput
                      placeholder="optional, e.g. body > article"
                      value={
                        Array.isArray(selectorValue)
                          ? selectorValue.join(", ")
                          : (selectorValue ?? "")
                      }
                      onChange={(e) =>
                        form.setValue("selector", e.target.value)
                      }
                    />
                    <InputGroupAddon align="inline-end">
                      <InputGroupButton
                        size="sm"
                        onClick={() => {
                          const url = form.getValues("url");
                          if (!url) return;
                          // Never stack this dialog under the picker: two
                          // overlapping Radix modals left the lower one mounted
                          // but inert, so the form could not be saved after a
                          // pick. The dialog is reopened with the selection.
                          addChapterModal.setOpen(false);
                          customSelectorModal.onOpen({
                            url,
                            onSelect(selectors, framePath) {
                              form.setValue("selector", selectors);
                              form.setValue("framePath", framePath);
                              addChapterModal.setOpen(true);
                            },
                          });
                        }}
                      >
                        <SquareDashedMousePointerIcon />
                        Pick
                      </InputGroupButton>
                    </InputGroupAddon>
                  </InputGroup>
                </Field>
              </div>
            )}

            {type != null && (
              <DialogFooter className="mt-4">
                <Button type="submit" disabled={isPending || create.isPending}>
                  Save
                </Button>
              </DialogFooter>
            )}
          </form>
        )}
      </DialogContent>
    </Dialog>
  );
}

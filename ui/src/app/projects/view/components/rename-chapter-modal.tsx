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
import { InputGroup, InputGroupInput } from "@/components/ui/input-group";
import { $api, invalidateQuery } from "@/lib/api";
import { createDisclosure } from "@/lib/store";
import { zodResolver } from "@hookform/resolvers/zod";
import { useEffect } from "react";
import { useForm } from "react-hook-form";
import z from "zod";
import { useProjectContext } from "../lib/context";
import { toast } from "sonner";

export const renameChapterModal = createDisclosure<{
  id: number;
  title: string;
}>();

const schema = z.object({
  title: z.string().min(1),
});

export default function RenameChapterModal() {
  const { project } = useProjectContext();
  const { open, data } = renameChapterModal.useStore();
  const form = useForm<any>({ resolver: zodResolver(schema as any) as any });

  const update = $api.useMutation(
    "put",
    "/projects/{projectId}/chapters/{id}",
    {
      onSuccess() {
        renameChapterModal.setOpen(false);
        invalidateQuery("/projects/{projectId}/chapters");
      },
      onError(err) {
        toast.error((err as Error).message);
      },
    },
  );

  useEffect(() => {
    if (data) {
      form.reset({ title: data.title || "" });
    }
  }, [data]);

  const onSubmit = form.handleSubmit(async (values) => {
    update.mutate({
      params: { path: { projectId: project.id, id: data!.id } },
      body: { title: values.title },
    });
  });

  return (
    <Dialog open={open} onOpenChange={renameChapterModal.setOpen}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Rename Chapter</DialogTitle>
          <DialogDescription>
            Change the title of this chapter
          </DialogDescription>
        </DialogHeader>

        <form onSubmit={onSubmit}>
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

          <DialogFooter className="mt-4">
            <Button type="submit" disabled={update.isPending}>
              Save
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

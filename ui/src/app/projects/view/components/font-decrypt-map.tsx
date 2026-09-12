import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { createDisclosure } from "@/lib/store";
import { useEffect, useState } from "react";
import { openEditorTab, stripHtmlTags } from "../lib/utils";
import { $api, invalidateQuery } from "@/lib/api";
import { useProjectContext } from "../lib/context";
import { useUpdateProject } from "../lib/hooks";
import { closeTab } from "../lib/stores";

export type FontDecryptData = {
  fonts: string[];
  chapterId?: number;
  title: string;
  content: string;
};

export const fontDecryptMapModal = createDisclosure<FontDecryptData>();

export default function FontDecryptMapModal() {
  const { open, data } = fontDecryptMapModal.useStore();
  const [curFont, setFont] = useState<string | null>(null);
  const { project } = useProjectContext();
  const update = useUpdateProject(project?.id || "");
  const updateChapter = $api.useMutation(
    "put",
    "/projects/{projectId}/chapters/{id}",
  );

  const { data: decrypted } = $api.useQuery(
    "post",
    "/utility/font-decrypt",
    {
      body: {
        fontUrl: curFont,
        text: [data?.content || "", data?.title || ""],
      },
    },
    { enabled: !!curFont && open },
  );

  useEffect(() => {
    if (data) {
      setFont(data.fonts[0]);
    }
  }, [data]);

  const onConfirm = () => {
    if (!decrypted?.map) return;

    // update project config
    const curDecryptMap = project?.config?.fontDecryptMap ?? {};
    const decryptMapObj = JSON.parse(decrypted.map) as Record<string, string>;
    const decryptMap = { ...curDecryptMap, ...decryptMapObj };
    update.mutate({ config: { fontDecryptMap: decryptMap } });

    // update chapter
    const [content, title] = decrypted.result || [];
    if (data?.chapterId && content) {
      updateChapter.mutate(
        {
          params: { path: { projectId: project?.id, id: data.chapterId } },
          body: { content, title },
        },
        {
          onSuccess() {
            fontDecryptMapModal.setOpen(false);
            invalidateQuery("/projects/{projectId}/chapters");
            invalidateQuery("/projects/{projectId}/chapters/{id}");
            closeTab(`chapter/${data.chapterId}`);
            setTimeout(
              () => openEditorTab({ id: data.chapterId!, title }),
              500,
            );
          },
        },
      );
    } else {
      fontDecryptMapModal.setOpen(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={fontDecryptMapModal.setOpen}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Deobfuscate Font</DialogTitle>
          <DialogDescription>
            The content has been obfuscated using custom fonts. Select the font
            to generate a decrypt map.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-1 overflow-y-auto max-h-[100px]">
          {data?.fonts?.map((font) => (
            <label key={font} className="text-sm block">
              <input
                checked={curFont === font}
                type="radio"
                name="font"
                value={font}
                className="mr-2 cursor-pointer"
                onChange={(e) => e.target.checked && setFont(e.target.value)}
              />
              {font.split("/").pop()}
            </label>
          ))}
        </div>

        <Label>Preview</Label>
        <div className="w-full max-h-[200px] overflow-y-scroll">
          {stripHtmlTags(decrypted?.result?.[0] || data?.content || "")
            .split("\n")
            .map((line, i) => (
              <p key={i}>{line}</p>
            ))}
        </div>

        <DialogFooter>
          <Button onClick={onConfirm} disabled={!decrypted?.map}>
            Confirm
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

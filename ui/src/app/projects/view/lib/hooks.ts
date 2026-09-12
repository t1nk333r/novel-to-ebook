import { useDebounceFn } from "@/hooks/use-debounce";
import { $api, invalidateQuery, type JsonBody } from "@/lib/api";
import { useCallback } from "react";
import { toast } from "sonner";
import { closeTab, tabStore } from "./stores";

export function useUpdateProject(id: string) {
  const update = $api.useMutation("put", "/projects/{id}", {
    onError(err) {
      toast.error((err as Error).message);
    },
  });
  const mutate = useCallback(
    (values: JsonBody<"/projects/{id}", "put">) => {
      update.mutate({ params: { path: { id } }, body: values });
    },
    [id],
  );
  const debounce = useDebounceFn(mutate, 500);
  return { mutate, debounce } as const;
}

export function useDeleteChapter(projectId: string) {
  const deleteChapter = $api.useMutation(
    "delete",
    "/projects/{projectId}/chapters/{id}",
  );
  return useCallback((id: number) => {
    deleteChapter.mutate(
      { params: { path: { projectId, id } } },
      {
        onSuccess() {
          invalidateQuery("/projects/{projectId}/chapters");
          toast.success("Chapter deleted");

          const href = `chapter/${id}`;
          const tabs = tabStore.getState();
          if (tabs.curTab === href) closeTab(href);
        },
        onError(err) {
          toast.error((err as Error).message);
        },
      },
    );
  }, []);
}

import { useCallback, useState } from "react";
import type { DragEvent, KeyboardEvent } from "react";

/**
 * Drag-to-reorder for the short vertical lists in the manage modals (quick
 * commands, macros). Both render in array order everywhere else, so moving a
 * row here is what changes the chip order in the dock.
 *
 * Only the grip is `draggable`: these rows carry text inputs, and a draggable
 * row steals click-and-drag text selection from them. The row is still handed
 * to `setDragImage`, so what follows the cursor is the whole entry rather than
 * a lone grip icon.
 *
 * ArrowUp/ArrowDown on a focused grip moves the row too — dragging inside a
 * scrolling modal is fiddly, and this is the same action without the mouse.
 */
export function useDragReorder(move: (from: number, to: number) => void) {
  const [dragIndex, setDragIndex] = useState<number | null>(null);
  const [overIndex, setOverIndex] = useState<number | null>(null);

  const end = useCallback(() => {
    setDragIndex(null);
    setOverIndex(null);
  }, []);

  const drop = useCallback(
    (to: number | null) => {
      if (dragIndex !== null && to !== null) move(dragIndex, to);
      end();
    },
    [dragIndex, move, end]
  );

  return {
    /** Row being dragged, for dimming it while it's in flight. */
    dragIndex,
    /** Row the drop would land on, for the insertion highlight. */
    overIndex,

    /** Props for the scroll container, so a drop in the gaps still lands. */
    listProps: {
      onDragOver: (e: DragEvent) => {
        if (dragIndex !== null) e.preventDefault();
      },
      onDrop: (e: DragEvent) => {
        if (dragIndex === null) return;
        e.preventDefault();
        drop(overIndex);
      },
    },

    /** Props for one row: marks it as the drag image source and drop target. */
    rowProps: (index: number) => ({
      "data-drag-row": "",
      onDragOver: (e: DragEvent) => {
        if (dragIndex === null) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = "move";
        if (index !== overIndex) setOverIndex(index);
      },
      onDrop: (e: DragEvent) => {
        if (dragIndex === null) return;
        e.preventDefault();
        e.stopPropagation();
        drop(index);
      },
    }),

    /** Props for the grip button that starts the drag. */
    gripProps: (index: number) => ({
      draggable: true,
      onDragStart: (e: DragEvent) => {
        setDragIndex(index);
        setOverIndex(index);
        e.dataTransfer.effectAllowed = "move";
        // Firefox won't start a drag that carries no payload.
        e.dataTransfer.setData("text/plain", String(index));
        const row = (e.currentTarget as HTMLElement).closest("[data-drag-row]");
        if (row) e.dataTransfer.setDragImage(row, 16, row.clientHeight / 2);
      },
      onDragEnd: end,
      onKeyDown: (e: KeyboardEvent) => {
        if (e.key !== "ArrowUp" && e.key !== "ArrowDown") return;
        e.preventDefault();
        move(index, index + (e.key === "ArrowDown" ? 1 : -1));
      },
    }),
  };
}

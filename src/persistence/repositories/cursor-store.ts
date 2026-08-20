/**
 * `CursorStore` (src/core/ports.ts) backed by the `layout_cursor` table.
 */

import type { Database } from "better-sqlite3";

import type { LayoutCursor } from "../../core/model.js";
import type { Clock, CursorStore } from "../../core/ports.js";

interface LayoutCursorRow {
  tab_id: string;
  anchor_pane_id: string;
  next_direction: string;
}

function rowToCursor(row: LayoutCursorRow): LayoutCursor {
  return {
    tabId: row.tab_id,
    anchorPaneId: row.anchor_pane_id,
    nextDirection: row.next_direction as LayoutCursor["nextDirection"],
  };
}

export class SqliteCursorStore implements CursorStore {
  constructor(
    private readonly db: Database,
    /** Unused here — kept for constructor-shape consistency across stores. */
    private readonly clock: Clock,
  ) {}

  get(tabId: string): Promise<LayoutCursor | undefined> {
    const row = this.db
      .prepare<[string], LayoutCursorRow>("SELECT * FROM layout_cursor WHERE tab_id = ?")
      .get(tabId);
    return Promise.resolve(row ? rowToCursor(row) : undefined);
  }

  set(cursor: LayoutCursor): Promise<void> {
    this.db
      .prepare(
        `INSERT INTO layout_cursor (tab_id, anchor_pane_id, next_direction)
         VALUES (?, ?, ?)
         ON CONFLICT (tab_id) DO UPDATE SET
           anchor_pane_id = excluded.anchor_pane_id,
           next_direction = excluded.next_direction`,
      )
      .run(cursor.tabId, cursor.anchorPaneId, cursor.nextDirection);
    return Promise.resolve();
  }

  delete(tabId: string): Promise<void> {
    this.db.prepare("DELETE FROM layout_cursor WHERE tab_id = ?").run(tabId);
    return Promise.resolve();
  }
}

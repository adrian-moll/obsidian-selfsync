/** Render a two-column line diff into a container. Shared by the conflict
 * resolver and the file-history diff. Uses the tested `lineDiff`. */
import { lineDiff } from "../util/line-diff.js";

export function renderLineDiff(container: HTMLElement, aText: string, bText: string): void {
  container.addClass("selfsync-diff");
  for (const row of lineDiff(aText, bText)) {
    const r = container.createDiv({ cls: "selfsync-diff-row" + (row.changed ? " changed" : "") });
    r.createDiv({ cls: "selfsync-diff-cell", text: row.left ?? "" });
    r.createDiv({ cls: "selfsync-diff-cell", text: row.right ?? "" });
  }
}

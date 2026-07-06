/**
 * The journal: a crash-safe record of the operations a sync intends to perform.
 * Written BEFORE any transfer runs so an interrupted sync (mobile process kill)
 * can be replayed/reconciled on next startup (NFR1, docs/05-sync-engine.md).
 *
 * M0 ships an in-memory implementation behind an interface; a persistent
 * implementation lands with the real engine.
 */
import type { Op } from "../types.js";

export interface JournalRecord {
  ops: Op[];
  /** Indices (into ops) already completed, for resumable replay. */
  done: number[];
  startedAt: number;
}

export interface Journal {
  /** Begin a new journalled batch (overwrites any previous record). */
  begin(ops: Op[], startedAt: number): Promise<void>;
  /** Mark the op at the given index complete. */
  markDone(index: number): Promise<void>;
  /** The current record if a batch is in progress, else null. */
  current(): Promise<JournalRecord | null>;
  /** Ops not yet completed (for resume), or null if nothing pending. */
  pending(): Promise<Op[] | null>;
  /** Clear the journal once the batch fully completes. */
  clear(): Promise<void>;
}

export class MemoryJournal implements Journal {
  private record: JournalRecord | null = null;

  async begin(ops: Op[], startedAt: number): Promise<void> {
    this.record = { ops: [...ops], done: [], startedAt };
  }

  async markDone(index: number): Promise<void> {
    if (this.record && !this.record.done.includes(index)) {
      this.record.done.push(index);
    }
  }

  async current(): Promise<JournalRecord | null> {
    return this.record ? { ...this.record, ops: [...this.record.ops], done: [...this.record.done] } : null;
  }

  async pending(): Promise<Op[] | null> {
    if (!this.record) return null;
    const doneSet = new Set(this.record.done);
    const rest = this.record.ops.filter((_, i) => !doneSet.has(i));
    return rest.length ? rest : null;
  }

  async clear(): Promise<void> {
    this.record = null;
  }
}

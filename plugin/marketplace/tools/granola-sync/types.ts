/**
 * Granola public API v1 shapes. Authoritative spec lives at
 * https://docs.granola.ai/api-reference/openapi.json — only the fields the
 * sync uses are typed; the API may add more, treat extras as unknown.
 */

export interface User {
  name: string | null;
  email: string;
}

export interface Folder {
  id: string;
  object: 'folder';
  name: string;
  parent_folder_id: string | null;
}

export interface CalendarInvitee {
  email: string;
}

export interface CalendarEvent {
  event_title: string | null;
  invitees: CalendarInvitee[];
  organiser: string | null;
  calendar_event_id: string | null;
  scheduled_start_time: string | null;
  scheduled_end_time: string | null;
}

export interface Speaker {
  /** macOS: `microphone` | `speaker`. iOS currently always `microphone`. */
  source: 'microphone' | 'speaker' | string;
  /** Anonymous diarization bucket on iOS (`Speaker A`, etc.). */
  diarization_label?: string;
}

export interface TranscriptSegment {
  speaker: Speaker;
  text: string;
  start_time: string;
  end_time: string;
}

export interface NoteSummary {
  id: string;
  object: 'note';
  title: string | null;
  owner: User;
  created_at: string;
  updated_at: string;
}

export interface Note extends NoteSummary {
  web_url: string;
  calendar_event: CalendarEvent | null;
  attendees: User[];
  folder_membership: Folder[];
  summary_text: string;
  summary_markdown: string | null;
  /** Present only when `?include=transcript`. */
  transcript: TranscriptSegment[] | null;
}

export interface ListNotesOutput {
  notes: NoteSummary[];
  hasMore: boolean;
  cursor: string | null;
}

export interface ListFoldersOutput {
  folders: Folder[];
  hasMore: boolean;
  cursor: string | null;
}

export interface SyncConfig {
  /** Production MCP endpoint. Discovered from `~/.claude.json` by default. */
  serverUrl: string;
  /** Teammate's personal bearer token. Discovered from `~/.claude.json` by default. */
  bearerToken: string;
}

/**
 * Contract for a user-owned filter at `~/.dent-brain/granola-sync/user/filter.ts`.
 *
 * The filter decides — per Granola note — whether it should reach the shared
 * brain. It runs ONLY on the teammate's laptop, never sees other teammates'
 * data, and is the entire surface that controls which meetings flow upstream.
 *
 * Iron rules:
 * - Pure function. No network, no fs, no env reads. Deterministic on the input.
 * - Returns `keep: false` by default for anything ambiguous (privacy bias).
 * - Anything `keep: true` will be filed and visible to everyone who can read
 *   the shared brain. Treat the return value as a publish gate.
 */
export type FilterResult =
  | { keep: true; reason: string }
  | { keep: false; reason: string };

export interface UserFilterModule {
  /** Bumped only when the runtime contract changes. Stamped by the install/setup skill. */
  RECIPE_VERSION: number;
  /** Required. Decides keep/skip per note. */
  filter: (note: Note) => FilterResult;
  /**
   * Granola folder NAMES whose notes the sync should consider (e.g. `['Dent']`).
   * The reconcile loop pulls only these folders' notes CREATED in the recent
   * look-back window — server-side — each run, then ingests any the brain
   * doesn't already have. Late filing self-heals as long as the note was
   * *created* within that window (the scan filters on creation time): file a
   * recently-recorded meeting into an include folder and the next run picks it
   * up. An older note needs a `--since` backfill. Required for the daemon to do
   * anything; `filter()` still runs as a per-note narrowing gate on top.
   */
  includeFolders: string[];
}

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

export interface SyncCursor {
  /** ISO timestamp of the most-recent `created_at` we've successfully synced. */
  lastSyncedCreatedAt: string;
  /** Note IDs (Granola `not_…` format) we've already pushed to the brain. */
  syncedDocumentIds: string[];
  /** When this cursor was last written. */
  cursorUpdatedAt: string;
  /** Version of the sync tool that wrote this cursor. */
  syncVersion: string;
}

export interface SyncConfig {
  /** Production MCP endpoint. Discovered from `~/.claude.json` by default. */
  serverUrl: string;
  /** Teammate's personal bearer token. Discovered from `~/.claude.json` by default. */
  bearerToken: string;
  /** Path to the cursor JSON. Defaults to `~/.dent-brain/granola-sync/cursor.json`. */
  cursorPath: string;
  /** Keywords identifying the org. Whole-word matched against title and body.
   *  Defaults to `['dent']`. */
  orgKeywords: string[];
  /** Email domains for the org's team (e.g. `dentthefuture.com`). Defaults
   *  to `['dentthefuture.com']`. Backwards-compat alias: `dentDomains`. */
  orgDomains: string[];
  /** Granola folder names (case-insensitive) treated as auto-include.
   *  Defaults to `['Dent']`. */
  orgFolders: string[];
  /** If true, every Granola meeting is filed (folder/title/body/domain checks
   *  are skipped). Default false. */
  fileAll: boolean;
}

/**
 * Shapes from `~/Library/Application Support/Granola/cache-v6.json`.
 * Only the fields the sync needs are typed; Granola adds more, treat
 * extras as unknown.
 */

export interface GranolaCalendarAttendee {
  email: string;
  responseStatus?: string;
  self?: boolean;
  displayName?: string;
}

export interface GranolaCalendarEvent {
  id?: string;
  summary?: string;
  location?: string;
  start?: { dateTime?: string; date?: string; timeZone?: string };
  end?: { dateTime?: string; date?: string; timeZone?: string };
  attendees?: GranolaCalendarAttendee[];
  creator?: { email?: string; displayName?: string };
  organizer?: { email?: string };
  htmlLink?: string;
}

export interface GranolaChapter {
  title?: string;
  summary?: string;
  start_timestamp?: string;
  end_timestamp?: string;
}

export interface GranolaDocument {
  id: string;
  title?: string;
  created_at: string;
  updated_at?: string;
  notes_plain?: string;
  notes_markdown?: string;
  summary?: string | null;
  overview?: string | null;
  type?: string;
  valid_meeting?: boolean;
  transcribe?: boolean;
  google_calendar_event?: GranolaCalendarEvent;
  chapters?: GranolaChapter[] | null;
  people?: unknown;
  user_id?: string;
  workspace_id?: string;
  privacy_mode_enabled?: boolean;
  show_private_notes?: boolean;
  transcript_deleted_at?: string | null;
  deleted_at?: string | null;
  status?: string;
  audio_file_handle?: string | null;
  [k: string]: unknown;
}

export interface GranolaTranscriptSegment {
  document_id: string;
  start_timestamp: string;
  end_timestamp?: string;
  text: string;
  source?: 'microphone' | 'system_audio' | string;
  id?: string;
  is_final?: boolean;
  transcriber_user_id?: string | null;
}

export interface GranolaListMetadata {
  id: string;
  title?: string;
  [k: string]: unknown;
}

export interface GranolaCache {
  cache: {
    state: {
      documents?: Record<string, GranolaDocument>;
      sharedDocuments?: Record<string, GranolaDocument>;
      transcripts?: Record<string, GranolaTranscriptSegment[]>;
      meetingsMetadata?: Record<string, unknown>;
      /** Map of list ID → array of document IDs filed in that list. */
      documentLists?: Record<string, string[]>;
      /** Per-list metadata (title, icon, etc.). Granola stores it as
       *  either an array or a record keyed by list ID. */
      documentListsMetadata?: GranolaListMetadata[] | Record<string, GranolaListMetadata>;
      [k: string]: unknown;
    };
  };
}

export interface SyncCursor {
  /** ISO timestamp of the most-recent `created_at` we've successfully synced. */
  lastSyncedCreatedAt: string;
  /** Document IDs we've already pushed to the brain. Belt + suspenders against
   *  `created_at` ties or clock skew. */
  syncedDocumentIds: string[];
  /** When this cursor was last written. */
  cursorUpdatedAt: string;
  /** Version of the sync tool that wrote this cursor. */
  syncVersion: string;
}

export interface SyncConfig {
  /** Production MCP endpoint, e.g. https://dent-brain.dentthefuture.com/mcp.
   *  When absent, auto-discovered from `~/.claude.json` → mcpServers["dent-brain"].url. */
  serverUrl: string;
  /** The teammate's personal bearer token. When absent, auto-discovered from
   *  `~/.claude.json` → mcpServers["dent-brain"].headers.Authorization (with
   *  the "Bearer " prefix stripped). One source of truth: when the teammate
   *  rotates their token via `/dent-onboard-teammate`, the new value is in
   *  claude.json and the daemon picks it up next run. */
  bearerToken: string;
  /** Path to Granola's cache file. Defaults to the standard macOS location. */
  granolaCachePath: string;
  /** Path to the cursor JSON. Defaults to `~/.dent-brain/granola-sync/cursor.json`. */
  cursorPath: string;
  /** Keywords identifying the org. Whole-word matched against title and body.
   *  Defaults to `['dent']`. */
  orgKeywords: string[];
  /** Email domains for the org's team (e.g. `dentthefuture.com`). Any attendee
   *  on one of these domains marks the meeting as org-relevant. Defaults to
   *  `['dentthefuture.com']`. Backwards-compat: a `dentDomains` field in the
   *  config is read as a fallback. */
  orgDomains: string[];
  /** Granola folder names (case-insensitive) treated as auto-include. Defaults
   *  to `['Dent']`. */
  orgFolders: string[];
  /** If true, every Granola meeting is filed (folder/title/body/domain checks
   *  are skipped). Default false. Use with care: turning this on for a
   *  cross-org user (e.g. someone whose Granola has Dent + TK + Reclaim
   *  Curiosity meetings) leaks the other orgs' content into this brain. */
  fileAll: boolean;
}

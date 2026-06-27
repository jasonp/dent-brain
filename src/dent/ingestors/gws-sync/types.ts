/**
 * Shared types for the gws-sync ingestor (Google Workspace knowledge-graph
 * router). The crawler maintains one lightweight "pointer-card" brain page per
 * Google Doc/Sheet — metadata only, never the body — so agents can DISCOVER the
 * right docs, then read them live. Design: TODOS.md "Google Workspace
 * knowledge-graph router" + memory gws_knowledge_graph_router.md.
 */

export const MIME_DOC = 'application/vnd.google-apps.document';
export const MIME_SHEET = 'application/vnd.google-apps.spreadsheet';
export const MIME_FOLDER = 'application/vnd.google-apps.folder';

export type CardType = 'gdrive-doc' | 'gdrive-sheet';

/** Frontmatter identity key — what get_page_by_identity matches on. */
export const IDENTITY_KEY = 'gdrive_file_id';
export const CREATED_VIA = 'gws-sync';

/** Subset of a Drive `files` resource we request + depend on. */
export interface DriveFile {
  id: string;
  name: string;
  mimeType: string;
  parents?: string[];
  owners?: Array<{ emailAddress?: string; displayName?: string }>;
  /** RFC-3339 string from Drive. */
  modifiedTime?: string;
  webViewLink?: string;
  /** Set when the file lives in a shared drive. */
  driveId?: string;
  trashed?: boolean;
  /** Whether the file is shared with anyone (My Drive only; absent on shared drives). */
  shared?: boolean;
  ownedByMe?: boolean;
  /** Grantee list, for the share-scope filter. Absent when sharing isn't readable.
   *  `deleted`/`expirationTime` let the filter ignore grants that confer no live access. */
  permissions?: Array<{ emailAddress?: string; type?: string; deleted?: boolean; expirationTime?: string }>;
}

/** Folder node for path resolution (id → name + parents). */
export interface FolderNode {
  id: string;
  name: string;
  parents?: string[];
}

/** Structural sheet metadata — tabs + dimensions. NEVER cell values. */
export interface SheetSchema {
  tabs: string[];
  /** Per-tab grid size from gridProperties (rowCount/columnCount). */
  dimensions: Record<string, { rows: number; cols: number }>;
}

/** One entry from Drive's `changes.list`. */
export interface DriveChange {
  fileId?: string;
  removed?: boolean;
  /** Present unless `removed` is true. */
  file?: DriveFile;
}

export type DeltaAction = 'upsert' | 'tombstone' | 'ignore';

/**
 * A built pointer-card, ready for the db-writer. Mirrors regfox's translator
 * output shape: structured frontmatter + body string, serialized downstream.
 */
export interface PointerCard {
  slug: string;
  type: CardType;
  fileId: string;
  /** Drive modifiedTime — drives the modifiedTime-skip idempotency check. */
  modifiedTime: string;
  frontmatter: Record<string, unknown>;
  body: string;
}

export function isTrackedMime(mimeType: string | undefined): boolean {
  return mimeType === MIME_DOC || mimeType === MIME_SHEET;
}

export function cardTypeForMime(mimeType: string): CardType {
  if (mimeType === MIME_SHEET) return 'gdrive-sheet';
  return 'gdrive-doc';
}

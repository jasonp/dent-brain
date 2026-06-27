/**
 * Pure Drive-path resolution. Given a file's parent chain and a lookup map of
 * folder/drive nodes (id → name + parents), produce a human path like
 * `My Drive/Strategy/2026` or `<Shared Drive>/Planning`.
 *
 * No I/O — the orchestrator fetches + caches folder nodes and hands them in.
 * Walking stops at the first id missing from the map (that id is the drive
 * root; the caller seeds the map with driveId→drive-name when known), so an
 * incomplete map degrades to a shorter path rather than throwing.
 */

import type { DriveFile, FolderNode } from './types.ts';

/** Label used when a file has no parents (lives at My Drive root). */
export const MY_DRIVE_ROOT = 'My Drive';

/** Hard cap on chain length — guards against a pathological parent cycle. */
const MAX_DEPTH = 64;

export function resolvePath(
  file: Pick<DriveFile, 'parents' | 'driveId'>,
  folders: Map<string, FolderNode>,
): string {
  const firstParent = file.parents?.[0];
  if (!firstParent) return MY_DRIVE_ROOT;

  const names: string[] = [];
  const seen = new Set<string>();
  let cursor: string | undefined = firstParent;

  for (let depth = 0; depth < MAX_DEPTH && cursor; depth++) {
    if (seen.has(cursor)) break; // cycle guard
    seen.add(cursor);
    const node = folders.get(cursor);
    if (!node) break; // reached an unknown root (drive root not in map)
    names.push(node.name);
    cursor = node.parents?.[0];
  }

  if (names.length === 0) return MY_DRIVE_ROOT;
  // names were collected leaf→root; reverse to root→leaf.
  return names.reverse().join('/');
}

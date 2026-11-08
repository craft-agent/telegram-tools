import type { ArchiveListing } from "../archive/inspect"
import { RESULT_BUDGET } from "../pages"
import type { FileSaveOutput, SavedFile } from "./schema"

type Listing = NonNullable<SavedFile["archive"]>

/** An archive's listing as a result carries it, from the listing inspection made. */
export function listingOf(listing: ArchiveListing): Listing {
  return {
    format: listing.format,
    files: listing.files,
    total_size: listing.total_size,
    entries: listing.entries,
  }
}

function jsonLength(result: FileSaveOutput): number {
  return JSON.stringify(result).length
}

/** Lists only the first `keep` entries of an archive, saying so when that leaves some out. */
function keepFirst(listing: Listing, all: Listing["entries"], keep: number): void {
  listing.entries = all.slice(0, keep)
  if (keep < all.length) listing.entries_cut = true
  else delete listing.entries_cut
}

/**
 * Keeps the result within `RESULT_BUDGET` characters of JSON by cutting the
 * listings of archives, never anything else: the largest listing first, down
 * to as many of its first entries as still let the result fit (none, if need
 * be), then the next. A cut listing says `entries_cut`, and its `files` and
 * `total_size` still count everything. Mutates and returns `result`.
 */
export function fitListings(result: FileSaveOutput): FileSaveOutput {
  if (jsonLength(result) <= RESULT_BUDGET) return result
  const listings = result.files
    .flatMap((file) => (file.archive ? [file.archive] : []))
    .map((listing) => ({ listing, all: listing.entries }))
    .sort((a, b) => b.all.length - a.all.length)
  for (const { listing, all } of listings) {
    keepFirst(listing, all, 0)
    if (jsonLength(result) > RESULT_BUDGET) continue
    let low = 0
    let high = all.length
    while (low < high) {
      const middle = Math.ceil((low + high) / 2)
      keepFirst(listing, all, middle)
      if (jsonLength(result) <= RESULT_BUDGET) low = middle
      else high = middle - 1
    }
    keepFirst(listing, all, low)
    return result
  }
  return result
}

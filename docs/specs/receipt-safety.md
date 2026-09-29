# Receipt safety

Confirmed by the user on 2026-09-29. Baseline: `4bc270195c793157222868ab4cdecdee4ac36659`.

## Accepted behavior

- Automatically retain the statement, both cards' edits and receipt files in this browser only; reopen restores the latest workspace. Keep legacy progress readable and report missing legacy attachments honestly.
- Display persistent save status. A failed save keeps the working copy usable and warns before leaving or replacing it. Offer a complete local backup and explicit current-statement clearing.
- Ambiguous receipt candidates stay unassigned; a weaker fallback must not be selected just because the best row is occupied. Explicit conflicting currencies prevent automatic assignment. Manual decisions remain available.
- Every attachment has a unique final export path, including case-insensitive and suffixed-name collisions.
- Empty/zero-row repeated OCR preserves the existing reviewed rows, attachments, and recognition text. First-time failures remain inspectable.
- Preserve the single-file app, card isolation, and local-only processing. Do not publish real statements, receipts, account data or credentials.

## Agreed verification seams

Reopen/restore, receipt attachment and matching, OCR replacement, and exported archive contents. Use synthetic fixtures only, with a failing behavior test before each fix, followed by browser verification and separate standards/spec reviews. The user's existing live accounting tab must not be reloaded.

## Storage boundaries

Browser storage is not a cloud backup and can be evicted or cleared. Complete backups include both cards and the original files for manual recovery. No automatic cross-device synchronization or backup-import workflow is included.

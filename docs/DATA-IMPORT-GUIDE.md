# Data import guide (Data Studio)

Excel is an **interchange format**, not a system of record. Imports populate the simulators; the simulators' own validation, scopes and transactions still apply. Column-level reference: [`data/templates/SCHEMA.md`](../data/templates/SCHEMA.md) (generated).

## Files

| File | Purpose |
|---|---|
| `data/templates/evidencebridge-template.xlsx` | Sample workbook: `README`, `_meta` (schemaVersion `EB-WB-1.0`) and 10 entity sheets with all synthetic fixtures |
| `data/templates/csv/<entity>.csv` | One CSV per entity (merge mode) |
| `data/templates/invalid/*.xlsx` | Eight negative examples used by the tests |
| UI: Data Studio → *sample workbook* | Same template, served by `GET /api/data/template.xlsx` |

## Sheets and keys

| Sheet | Owner | Primary key | Notes |
|---|---|---|---|
| patients | EHR | id | `SYN-PAT-####` + age band only |
| coverage | EHR | id | FK patient |
| service_requests | EHR | id | coverage must belong to the same patient |
| prior_auth_drafts | EHR | id | `businessStatus` system-managed (import only `DRAFT_INCOMPLETE`); updates need a higher `version` |
| provider_attribution | Payer | patientId + providerOrgId | |
| patient_opt_out | Payer | patientId | |
| explanation_of_benefits | Payer | id | leads only |
| document_references | EHR (`source=EHR`) / HIE (`source=HIE`) | id | `hashSha256` is system-managed (computed on import, exported read-only) |
| document_contents | HIE | documentId + page | one row per page; importing any page replaces that document's text |
| policy_requirements | Policy | policyVersion + requirementCode | flattened; label must start with `SYNTHETIC` |

Dates `YYYY-MM-DD`; date-times ISO 8601 with explicit timezone. Lists are comma-separated.

## Pipeline

1. **Upload** `.xlsx` (preferred) or `<entity>.csv`. `.xlsm` and other formats are refused. Limits: 2 MB, 2,000 rows and 30 columns per sheet (413 / issue otherwise).
2. **Parse** server-side with exceljs. Formula cells are rejected (never evaluated); macros, scripts and links are never executed; hyperlinks/rich text become plain text; strings starting with `=` are rejected.
3. **Validate** structure (schema version, sheets, required/unknown columns — identifier-like headers such as `fullName`, `dob`, `ssn` are flagged), types, enums, duplicates, referential integrity (cascading until stable — a rejected parent rejects its dependents), date semantics, synthetic-identifier guards (SSN/email/phone patterns, non-`SYN-` ids), and domain invariants (stale revisions, version-less changes, system-managed status).
4. **Preview** per sheet: added / updated / unchanged / rejected / removed, plus row/column issues. Nothing is written.
5. **Confirm** with *Commit*. Merge mode commits accepted rows and skips rejected ones (explicitly reported). Replace mode requires every sheet and zero rejected rows.
6. **Commit atomically** in one SQLite transaction across simulator tables. If simulator data changed since preview, commit is refused (409, re-preview).
7. **Verify** by re-querying every committed row (`verified: true`).
8. **History & restore**: each batch is recorded with a pre-import snapshot; *Restore before* returns all simulators to that snapshot (runtime tasks/runs are cleared, stated in the confirmation).

Re-importing identical data shows *all unchanged* and cannot be committed (idempotent). A committed batch cannot be committed twice.

## Modes

| Mode | Effect |
|---|---|
| Merge | Upsert by primary key over current data; tasks and runs are kept; system-managed draft status is preserved |
| Replace | Replaces the whole dataset and clears runtime state (tasks, runs, faults); requires a complete, fully valid workbook |

## Export

`Export snapshot (.xlsx)` includes all entity sheets, a read-only `tasks` sheet and HIE hashes. `Export CSV` exports one entity. Values starting with `= + - @ TAB CR` are prefixed with `'` to prevent spreadsheet formula injection.

## Schema versioning

`_meta.schemaVersion` must share the major version (`EB-WB-1`). Additive columns can be introduced in minor versions; unknown columns are reported. A major change requires a migration that maps old columns before validation.

## Invalid examples (all covered by `tests/import.test.ts`)

missing sheet · wrong types · duplicate ids · orphan reference (cascading) · invalid/system-managed status · formula cell · stale revision · real-looking identifiers · oversized file · non-xlsx/unreadable file · identifier-like column.

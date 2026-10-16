# Optional hardened backend (`Code.gs`)

This is a **drop-in replacement** for the Apps Script project behind the portal.
It is optional: the portal works against the original backend unchanged. Deploy
this only if you want the integrity and credential fixes below.

## What it fixes

| # | Problem in the original backend | What this does |
| --- | --- | --- |
| 1 | Passwords stored in the sheet in **plain text** | Stores a salted SHA-256 hash. Plain-text values found in `Users` are upgraded in place by `setupWorkbook()`. |
| 2 | The lot verdict was **decided by the browser** and merely written down, so it could be forged by editing the request | `submitLot` **recomputes** the verdict from the raw per-unit values and ignores the client's claim. A mismatch is recorded in the audit log, not trusted. |
| 3 | No session concept — every request was implicitly trusted | Login issues an **expiring token**; every write revalidates it. Admin-only actions require an admin session. |
| 4 | Nothing recorded who changed what, when | Writes are appended to an **Audit** sheet; lot closure stamps `closedAt` / `closedBy`. |
| 5 | Serial uniqueness was checked per-lot only | Units are stored globally, so a **duplicate serial anywhere** in the workbook is rejected. |
| 6 | No per-unit data, so no defect analytics | Every sampled unit is stored with its defect flags, enabling the Pareto and report sections. |

## Honest limitations

- **Password hashing is SHA-256 with a per-user salt, not bcrypt/argon2.** Apps
  Script exposes no key-derivation function, so this is the strongest primitive
  available on the platform. It protects stored credentials and blocks password
  reuse; it is not a substitute for a real KDF.
- The browser hashes once and the server hashes again, so the client-side hash
  is a transport convenience, not a second security layer.
- Apps Script web apps are **public URLs**. This backend adds authentication and
  server-side validation, but anyone who has the URL can reach the endpoint.
  Keep the URL private and treat the sheet as the trust boundary.
- If you enable photo attachments later, store image files in Drive and keep
  only the file ID in the sheet — Sheets cells cap at 50,000 characters.

## Required sheets

Created automatically by `setupWorkbook()`:

| Sheet | Columns |
| --- | --- |
| `Users` | username, passwordHash, salt, name, role, active, createdAt |
| `Sessions` | token, username, role, issuedAt, expiresAt |
| `Batches` | batchName, lotNumber, lotSize, sampleSize, bdMax, status, result, batchQty, totalLots, model, prodMonthCode, prodMonthCode2, fgPassQty, minorCount, majorCount, createdBy, createdAt, closedAt, closedBy |
| `Units` | serial, batchName, lotNumber, model, prodMonthCode, aes, general, func, screen, bd, bdMajor, remark, sampleResult, inspectedAt, submittedBy, submittedAt |
| `Audit` | timestamp, user, action, batchName, lotNumber, detail |

## Deploy

1. **Back up** the current Apps Script project (File → Make a copy).
2. Open the script bound to your Google Sheet and replace `Code.gs` with this file.
3. Run **`setupWorkbook()`** once from the editor and approve the permission
   prompt. It creates the sheets, migrates any legacy `Kits` rows into
   `Batches`, and hashes any plain-text passwords it finds.
4. **Deploy → Manage deployments → edit → Version: New version → Deploy.**
5. Reload the portal. It should report *“Server validation active”*.

The portal probes for the `capabilities` action once and caches the result for a
day, so the new features switch on automatically.

## Action reference

Actions the portal may call. All are also reachable with `doGet` returning the
action list.

| Action | Role | Purpose |
| --- | --- | --- |
| `capabilities` | any | Feature discovery |
| `login` / `logout` | any | Session issue and revoke |
| `getBatches` (alias `getKits`) | signed-in | Lot list |
| `getUnits` | signed-in | Per-unit detail for a lot |
| `getAnalytics` | signed-in | Defect category and inspector aggregates |
| `checkSerial` | signed-in | Global duplicate detection |
| `submitLot` | signed-in | **Revalidates and stores the lot verdict** |
| `createBatch` (alias `createKit`) | admin | Create lots for a batch quantity |
| `updateLot` / `deleteLot` / `deleteBatch` | admin | Lot administration |
| `addUser` / `setPassword` / `listUsers` | admin | User administration |

## Server-side verdict rules

`submitLot` recomputes acceptance independently of the client:

- A unit is **minor** only for an aesthetic failure.
- A unit is **major** for any general, functional or screen failure.
- Black dot: no dot or not visible at 2 m → pass; otherwise D > 2.4 mm, N > 3,
  DS < 15 mm, or D > 1.28 mm with N > 1 in Area A (N > 3 in Area B / A+B) → major fail.
- The lot **passes** only when major ≤ 0 and minor ≤ 1.

Because the server recomputes, a tampered request cannot record a false PASS.

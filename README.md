# AI Workshops Share

A small local web app for activating Smartsheet portfolio projects, sharing them with participants, and checking how much each participant has used their tracker. It runs on your own machine, talks directly to the Smartsheet API, and needs no extra packages.

A Google Apps Script version with the same features lives in `../ai-workshops-share-gas-multiuser`. This Node version is single-user: one `config.json`, one API token.

## What it does

Each project in a Smartsheet portfolio has a row in the portfolio's **Project list** sheet. The project name is the participant's email address. The app lists those projects (25 per page) and lets you:

- **Filter** by date range, location, client (Type), Active status and Shared status, using the panel on the left. **Hide filters / Show filters** collapses it.
- **Tick** the projects you want to process. The header checkbox ticks the current page.
- Click **Activate and share**, which for each ticked project:
  1. Sets **Workspace Status** to `Active` in the project list, which makes Smartsheet create the project workspace.
  2. Waits for the workspace to appear (checks every few seconds, up to a timeout).
  3. Shares the whole workspace with the email in the project name (default: **Admin**), with optional custom invite wording.
  4. Optionally gives a different level on the tracker sheet only (default `NONE`, because Admin on the workspace already covers it).
  5. Ticks the **Shared** checkbox in the project list.

Projects that are already Active skip step 1. Running it again on an already shared project is safe, and it upgrades the workspace share to the configured level (for example Editor to Admin).

Once a workspace exists, the project name in the table becomes a link to it. **Reload** re-reads the list from Smartsheet.

The page also has **Analytics**, a **Log**, and a **Help** button with step-by-step instructions and an explanation of every setting.

## Requirements

- [Node.js](https://nodejs.org) 18 or later (check with `node --version`).
- A Smartsheet **API token** (Smartsheet: Account, Personal Settings, API Access, Generate new access token). The token's user needs to own, or be Admin of, the project workspaces.
- A portfolio **Project list** sheet with these columns (the names can be changed in the config):

| Column | Type | Purpose |
|---|---|---|
| Project Name | Text (primary) | The participant's email address |
| Workspace Status | Dropdown | Set to `Active` to create the workspace |
| Date | Date | Used by the date filters |
| Location | Dropdown | Used by the location filter |
| Type | Dropdown | Shown as Client, used by the client filter |
| Shared | Checkbox | Ticked by the app once shared |
| Attended | Checkbox | Analytics only scans attendees. If the column is missing, nobody is hidden. |

## Getting started from a git download

```bash
git clone <repository-url>
cd ai-workshops-share
cp config.example.json config.json
```

Then either edit `config.json` by hand, or start the server and use the Settings button (below). At minimum set your API token and the project list sheet ID.

Start the server:

```bash
node server.js
```

Open **http://localhost:3000** in your browser. Stop the server with `Ctrl+C`. **Keep the server running while you work**: sharing jobs and analytics scans run inside it. If you restart it, anything that was waiting or scanning carries on from where it stopped.

`config.json` and `data/` are listed in `.gitignore`, so your API token and scan results are never committed. Only `config.example.json` (with a placeholder) is in the repository.

### Finding the project list sheet ID

Open the portfolio's Project list sheet in Smartsheet, then File, Properties. The **Sheet ID** is shown there.

## Using the page

1. Use the filters to narrow the list. **Clear filters** resets them, and the list returns to page 1.
2. Tick projects. Ticks stay when you change page, and the count shows the total selected.
3. Click **Activate and share** and confirm. The Status column updates live for each project.
4. When it finishes, the table refreshes. Ticks in the Active and Shared columns show the new state.

Rows with an error show a red message, for example if the workspace wasn't created within the timeout. Fix the cause and run the project again.

## Analytics

The **Analytics** button opens a bar chart of **how many changes each participant has made in their Community Project Tracker**.

- **What counts:** only edits made by the participant (the email in the project name). Edits by you, automations, the AI columns' service account or anyone else are ignored. The email match is not case sensitive.
- **Bars:** the length is the number of changes. The colour shows how recent the latest change is: green within 7 days, amber 8 to 30 days, red over 30 days, blue while scanning, grey for no edits or not scanned.
- **Filters:** it uses the same filters as the project list. **Attended only** is ticked by default and hides projects whose Attended box is not ticked. Only projects whose workspace exists are included.
- **Sorting:** most changes (default), fewest, most recent, oldest, or project name.

### How it counts

Smartsheet only keeps the **last editor of a row**, and formulas that recalculate (such as `TODAY()` or the AI columns) are saved under the sheet owner's name, so row information can't be trusted. The app reads the **history of the cells** and counts the entries made by the participant. A full scan is one request per cell (rows times columns, for example 50 x 15 = 750) per project, paced to stay under Smartsheet's rate limit (about 240 a minute), so it takes a few minutes per project.

**Quick check first.** Each scan first reads the history of 5 key cells: Start Date (row 8), End Date (row 5), Status (row 8) and WBS ID (rows 22 and 36). If the participant edited none of them, the scan stops in seconds and shows **"Partial scan of these rows returned no changes"**. If they edited any, it continues with the full scan. If a configured row or column does not exist in a project's sheet, or a key cell can't be read, the full scan runs. Row N means the row number shown in Smartsheet. The cells are editable in Settings.

**Buttons**

- **Scan new projects:** scans projects that have no result yet, including stopped or failed ones.
- **Quick re-scan selected:** for the ticked projects, quick check first, then the full scan only if needed.
- **Full re-scan selected:** for the ticked projects, skips the quick check and reads every cell.
- **Stop scan:** appears while a scan runs. Results found so far are kept and stopped projects show "Stopped at N%".
- **Select all shown** ticks every project on the chart.

Each result also says why the full scan ran (or that the quick check was skipped). Results are stored in `data/state.json` and stay until you re-scan.

### Limits

- A change is **one cell edit by the participant**. Edits that were later undone still count, because Smartsheet keeps them in the cell history.
- Adding a column is not recorded in any cell's history, so it isn't counted until the participant puts data in it. Deleted rows and cells are not scanned.
- The participant must edit under the same email address as the project name.
- Scanning uses your API token and counts toward its rate limit.

## Log

The **Log** button shows what the app has done, newest first: page opens and reloads, Activate and share steps, scans, and settings changes (setting names and values are logged, and the API key is only ever logged as "API key updated"). You can filter by level, search, refresh or clear it. The last 1,000 entries are kept in `data/state.json`.

## Settings button

The **Settings** button opens a form that edits `config.json` for you. Changes apply immediately and no restart is needed, except for the port. Each save keeps a backup of the previous file as `config.json.bak`. The API key is never shown; leave that box blank to keep the current key. The **Help** dialog explains each field.

## Config file reference

`config.json` has three sections.

```json
{
  "smartsheet": { "apiKey": "...", "baseUrl": "https://api.smartsheet.com/2.0" },
  "server": { "port": 3000 },
  "portfolios": [ { "...": "..." } ]
}
```

### `smartsheet`

| Setting | Description |
|---|---|
| `apiKey` | Your Smartsheet API token. |
| `baseUrl` | API address. Use `https://api.smartsheet.com/2.0` unless your account is in another region (for example the EU or Australia API host). |

### `server`

| Setting | Description |
|---|---|
| `port` | Port the page runs on. Default `3000`. A change needs a server restart. |

### `portfolios`

A list of portfolios. **Only the first entry is used at the moment**; extra entries are stored for future use. Settings missing from an older `config.json` fall back to the defaults shown.

| Setting | Description |
|---|---|
| `name` | Label for the portfolio. |
| `projectListSheetId` | ID of the portfolio's Project list sheet. |
| `workspaceAccess` | Access level given on the whole project workspace: `VIEWER`, `COMMENTER`, `EDITOR`, `EDITOR_SHARE` or `ADMIN`. Default `ADMIN`. |
| `sendInviteEmail` | `true` to have Smartsheet email the workspace invite. |
| `emailSubject`, `emailMessage` | Optional wording for the invitation. Blank uses Smartsheet's default. `{name}` (project name), `{workspace}` and `{url}` (workspace link) are filled in. Only used when `sendInviteEmail` is true. Smartsheet cannot attach files to this email, so put a link in the message. |
| `ccMe` | `true` to also email yourself a copy of each invitation. |
| `trackerSheet.name` | Name of the sheet inside each workspace. Analytics reads this sheet. |
| `trackerSheet.access` | Optional extra level on that sheet only. Default `NONE` (no separate share, since the workspace access already covers it). |
| `columns` | Names of the project list columns: `name`, `status`, `date`, `location`, `type`, `shared`, `attended`. Change these if your sheet uses different titles. |
| `activeValue` | The Workspace Status value that triggers workspace creation. Default `Active`. |
| `pollSeconds` | How often to check whether the workspace exists. Default `5`. |
| `provisionTimeoutSeconds` | How long to wait for a workspace before giving up on that project. Default `300`. |
| `quickCheck` | The analytics quick-check cells, a list of `{ "column": "WBS ID", "row": 22 }`. An empty list always runs the full scan. |

Example of the new settings:

```json
"workspaceAccess": "ADMIN",
"trackerSheet": { "name": "Community Project Tracker", "access": "NONE" },
"quickCheck": [
  { "column": "Start Date", "row": 8 }, { "column": "End Date", "row": 5 }, { "column": "Status", "row": 8 },
  { "column": "WBS ID", "row": 22 }, { "column": "WBS ID", "row": 36 }
]
```

## How the app finds each project's workspace

Smartsheet names each project workspace after the project, so the app looks for a workspace whose name matches the project name (the email). It also honours a workspace link on any cell in the row if there is one. The token's user must be able to see those workspaces.

## Files

| File | Purpose |
|---|---|
| `server.js` | Local server. Holds the API token, calls Smartsheet, runs the sharing jobs and analytics scans, keeps the log. |
| `index.html`, `styles.css`, `app.js` | The page, its styling and its behaviour. |
| `settings.js` | The Settings form. |
| `config.example.json` | Template config. Copy to `config.json`. |
| `config.json` | Your real config, including the API token. Not committed to git. |
| `data/state.json` | Created on first run. Holds scan results, the job list and the log. Not committed to git. |

## Security notes

- The server listens only on `127.0.0.1`, so it is reachable only from your own computer.
- The API token stays on the server and is never sent to the browser.
- All actions (sharing, scanning, saving settings) are accepted only from the local page.
- Keep `config.json` private and never commit it. If a token is ever exposed, revoke it in Smartsheet and generate a new one.

## Known limits

- Smartsheet only allows `ADMIN` for licensed users. If a participant is unlicensed, the share step shows an error naming the level Smartsheet actually set. The API cannot grant Owner, so Admin is the highest level the app can give.
- Sharing sends invitations to external email addresses, so check the list before you click.
- Sharing and scanning only progress while the server is running. If you close it, they pick up again when you start it.

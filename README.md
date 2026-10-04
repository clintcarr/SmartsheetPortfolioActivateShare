# AI Workshops Share

A small local web app for activating Smartsheet portfolio projects and sharing them with participants. It runs on your own machine, talks directly to the Smartsheet API, and needs no extra packages.

## What it does

Each project in a Smartsheet portfolio has a row in the portfolio's **Project list** sheet. The project name is the participant's email address. The app lists those projects and lets you:

- **Filter** by date range, location, client (Type), Active status and Shared status.
- **Tick** the projects you want to process.
- Click **Activate and share**, which for each ticked project:
  1. Sets **Workspace Status** to `Active` in the project list, which makes Smartsheet create the project workspace.
  2. Waits for the workspace to appear (checks every few seconds, up to a timeout).
  3. Shares the workspace with the email in the project name (default: Editor).
  4. Gives that person a higher level (default: Admin) on the tracker sheet inside the workspace, so they can add columns.
  5. Ticks the **Shared** checkbox in the project list.

Projects that are already Active skip step 1. Running it again on a project is safe: existing shares are left as they are, and the tracker sheet access is corrected if needed.

Once a workspace exists, the project name in the table becomes a link to it.

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

Open **http://localhost:3000** in your browser. Stop the server with `Ctrl+C`.

`config.json` is listed in `.gitignore`, so your API token is never committed. Only `config.example.json` (with a placeholder) is in the repository.

### Finding the project list sheet ID

Open the portfolio's Project list sheet in Smartsheet, then File, Properties. The **Sheet ID** is shown there.

## Using the page

1. Use the filters to narrow the list. **Clear filters** resets them.
2. Tick projects, or use the header checkbox to tick everything shown.
3. Click **Activate and share** and confirm. The Status column updates live for each project.
4. When it finishes, the table refreshes. Ticks in the Active and Shared columns show the new state.

Rows with an error show a red message, for example if the workspace wasn't created within the timeout. Fix the cause and run the project again.

## Settings button

The **Settings** button at the top right opens a form that edits `config.json` for you. Changes apply immediately and no restart is needed, except for the port. Each save keeps a backup of the previous file as `config.json.bak`. The API key is never shown; leave that box blank to keep the current key.

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

A list of portfolios. **Only the first entry is used at the moment**; extra entries are stored for future use.

| Setting | Description |
|---|---|
| `name` | Label for the portfolio. |
| `projectListSheetId` | ID of the portfolio's Project list sheet. |
| `workspaceAccess` | Access level given on the project workspace: `VIEWER`, `COMMENTER`, `EDITOR`, `EDITOR_SHARE` or `ADMIN`. Default `EDITOR`. |
| `sendInviteEmail` | `true` to have Smartsheet email the workspace invite. |
| `trackerSheet.name` | Name of the sheet inside each workspace that gets the higher access. |
| `trackerSheet.access` | Access level on that sheet. Default `ADMIN`, which lets participants add columns. |
| `columns` | Names of the project list columns: `name`, `status`, `date`, `location`, `type`, `shared`. Change these if your sheet uses different titles. |
| `activeValue` | The Workspace Status value that triggers workspace creation. Default `Active`. |
| `pollSeconds` | How often to check whether the workspace exists. Default `5`. |
| `provisionTimeoutSeconds` | How long to wait for a workspace before giving up on that project. Default `300`. |

## How the app finds each project's workspace

Smartsheet names each project workspace after the project, so the app looks for a workspace whose name matches the project name (the email). It also honours a workspace link on any cell in the row if there is one. The token's user must be able to see those workspaces.

## Files

| File | Purpose |
|---|---|
| `server.js` | Local server. Holds the API token, calls Smartsheet, runs the activate-and-share jobs. |
| `index.html`, `styles.css`, `app.js` | The page, its styling and its behaviour. |
| `settings.js` | The Settings form. |
| `config.example.json` | Template config. Copy to `config.json`. |
| `config.json` | Your real config, including the API token. Not committed to git. |

## Security notes

- The server listens only on `127.0.0.1`, so it is reachable only from your own computer.
- The API token stays on the server and is never sent to the browser.
- Saving settings is accepted only from the local page.
- Keep `config.json` private and never commit it. If a token is ever exposed, revoke it in Smartsheet and generate a new one.

## Known limits

- Smartsheet only allows `ADMIN` for licensed users. If a participant is unlicensed, the tracker step shows an error naming the level Smartsheet actually set. The API cannot grant Owner on a sheet, so Admin is the highest level the app can give.
- Sharing sends invitations to external email addresses, so check the list before you click.
- Everything runs in memory. If you close the server while a job is running, the job stops; run those projects again.

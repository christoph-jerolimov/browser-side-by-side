# browser-side-by-side

A personal Chrome + Firefox extension that watches your **selection and cursor
position in a Google Docs document** and mirrors matching content into a
second, side-by-side browser window ("sidebar"):

- Select `ABC-1234` → the sidebar opens/navigates to `https://redhat.atlassian.net/browse/ABC-1234`.
- Put the cursor on a link like `https://github.com/org/repo/pull/123` → the
  sidebar opens that link.
- A **Follow / Pause** toggle (toolbar popup) controls whether the sidebar
  keeps following your selection automatically.

There are two independent, self-contained folders:

| Folder     | Browser | Manifest |
|------------|---------|----------|
| `chrome/`  | Chrome / Chromium / Edge | MV3 (service worker) |
| `firefox/` | Firefox | MV2 (background scripts) |

The JavaScript/HTML/JSON files are identical in both folders (a small
`browser ?? chrome` shim makes the code run in both); only the manifests
differ. If you change one folder, copy the changed files to the other.

## How it works

1. A content script runs on `https://docs.google.com/document/*`. It reads:
   - the **link under the cursor** from the Docs link bubble (the small popup
     Docs shows when the caret is on a link), and
   - the **selected text** from the hidden `docs-texteventtarget-iframe` that
     the canvas-based Docs editor uses for copy/IME.
2. Each candidate is tested against the regex **rules in `config.json`**
   (first match wins). `$0`–`$9` in the `url` template are replaced with the
   regex match/groups.
3. On the **first** match, a small pill appears in the bottom-right corner of
   the Docs tab: *"Open in sidebar: Jira: ABC-1234"*. Clicking it opens a new
   browser window and (by default) tiles the doc window to the left half and
   the sidebar to the right half of your screen. You can also rearrange the
   windows manually afterwards (or use **Tile windows side-by-side** in the
   toolbar popup).
4. From then on, while **Follow** is enabled, every new match automatically
   navigates the existing sidebar window — focus stays in your document.
   Closing the sidebar window returns you to step 3.
5. The toolbar popup lets you **Follow / Pause** (badge shows `ON` / `❚❚`),
   re-tile the windows, or close the sidebar. While paused, the pill still
   appears but the sidebar only navigates when you click the pill.

## Configuration

Patterns live in `config.json` **inside each extension folder** — edit the
file and reload the extension. Default:

```json
{
  "autoTile": true,
  "rules": [
    { "name": "Jira link",  "match": "https?://redhat\\.atlassian\\.net/[^\\s)\\]]+",        "url": "$0" },
    { "name": "Jira",       "match": "\\b[A-Z][A-Z0-9]{1,9}-\\d+\\b",                        "url": "https://redhat.atlassian.net/browse/$0" },
    { "name": "GitHub PR",  "match": "https?://github\\.com/[^/\\s]+/[^/\\s]+/pulls?/\\d+",  "url": "$0" }
  ]
}
```

- `rules[]` are tried in order; the first regex that matches the selection /
  link wins. Selections or links that match no rule are ignored.
- `match` is a JavaScript regex (double-escape backslashes in JSON).
- `url` is the page to open; `$0` is the whole match, `$1`–`$9` are capture
  groups. Example with a group:
  `{ "match": "\\b(ABC|XYZ)-(\\d+)\\b", "url": "https://jira.mycorp.com/browse/$1-$2" }`
- `autoTile`: set to `false` if the extension should never move/resize your
  windows and you always want to arrange them yourself.

The Jira rules cover both bare ticket IDs (`ABC-1234` →
`https://redhat.atlassian.net/browse/ABC-1234`) and full
`redhat.atlassian.net` links, which open as-is. Adjust the base URL if you
use a different Jira instance.

## Install — Chrome (unpacked, for development/personal use)

1. Open `chrome://extensions`.
2. Enable **Developer mode** (top right).
3. Click **Load unpacked** and select the `chrome/` folder.
4. Pin "Docs Side-by-Side" to the toolbar (puzzle icon → pin).

After editing `config.json` or any file, click the ↻ reload button on the
extension card and reload the Docs tab.

### Bundle — Chrome

- **Zip** (e.g. to copy to another machine):

  ```sh
  ./build.sh   # writes dist/docs-side-by-side-{chrome,firefox}-<version>.zip
  ```

  Unzip there and "Load unpacked" again (a plain zip cannot be installed
  directly by drag & drop in current Chrome).

- **CRX**: `chrome://extensions` → **Pack extension** → choose the `chrome/`
  folder. Note that Chrome only allows CRX installs from the Web Store on
  standard installs, so for a personal plugin "Load unpacked" is the practical
  route.

## Install — Firefox

### Temporary (quickest, gone after restart)

1. Open `about:debugging#/runtime/this-firefox`.
2. Click **Load Temporary Add-on…**.
3. Select `firefox/manifest.json`.

### Permanent

Regular Firefox releases require signed add-ons. Options:

- **Firefox Developer Edition / Nightly / ESR**: set
  `xpinstall.signatures.required` to `false` in `about:config`, then install
  the zip built below via `about:addons` → gear icon → *Install Add-on From
  File…*.
- **Self-signed via AMO (unlisted)**: get API credentials from
  <https://addons.mozilla.org/developers/addon/api/key/> and run

  ```sh
  npx web-ext sign --source-dir firefox --channel unlisted \
    --api-key <JWT_ISSUER> --api-secret <JWT_SECRET>
  ```

  which produces a signed `.xpi` installable in any Firefox.

### Bundle — Firefox

```sh
./build.sh   # writes dist/docs-side-by-side-{chrome,firefox}-<version>.zip
# or, using Mozilla's tooling:
npx web-ext build --source-dir firefox --artifacts-dir dist
```

For live development: `npx web-ext run --source-dir firefox` starts a Firefox
profile with the extension loaded and auto-reloads on changes.

## Usage tips

- To follow a plain-text ticket ID, **double-click the word** (Docs selects
  it) — the extension reads the selection.
- For links you don't need to select anything: just place the caret on the
  link so Docs shows its link bubble.
- The very first sidebar open needs one click on the pill; after that,
  matches follow automatically while **Follow** is on.
- The sidebar is one shared window; whichever Docs tab you work in last
  drives it.

## Limitations

- Google Docs renders documents to a canvas, so there is no supported API for
  reading the selection. This extension uses the hidden event-target iframe
  Docs maintains for clipboard/IME, which can occasionally hold a stale value
  (e.g. right after deselecting); deduplication prevents the sidebar from
  re-navigating in that case, but the pill may linger a few seconds.
- "Text under the cursor" without a selection only works for links (via the
  link bubble). Plain text must be selected (double-click).
- Sites that refuse to be framed are not an issue here (the sidebar is a real
  browser window, not an iframe), but sites requiring login will show their
  login page in the sidebar the first time.
- Google may change Docs internals at any time; if detection stops working,
  check the class names `docs-texteventtarget-iframe` and
  `docs-linkbubble-bubble` in `content.js`.

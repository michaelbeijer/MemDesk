# Setting up MemDesk

*This is for setting up a copy of your own, with your own Google Cloud
project. If someone sent you links to MemDesk, follow
[INSTALL.md](INSTALL.md) instead: it is much shorter.*

*MemDesk is source available, not open source. Until licences are on sale, a
free preview licence lets you use a copy you set up from this repository for
yourself; it does not let you pass copies on. See [LICENSE](LICENSE).*

MemDesk has three parts. You need the first; the other two are for your
phone and can be added any time.

| Part | Where it runs | Time | Needs |
|---|---|---|---|
| [1. The extension](#part-1-the-extension) | Chrome on a computer: the board, the notes editor and the calendar inside Gmail | about 15 minutes | a free Google Cloud project of your own |
| [2. The phone panel](#part-2-the-phone-panel) | the Gmail app on your phone, at the bottom of an open email: puts it on the board | about 5 minutes | a free Apps Script project |
| [3. The phone app](#part-3-the-phone-app) | your phone's home screen: the board, the notes and the calendar, full-screen | about 3 minutes | part 2 |

It works with a Google Workspace account and with an ordinary @gmail.com
account. Nothing is sent anywhere but Google: there is no MemDesk server.
Everything lives in your own mailbox, as labels and messages.

---

## Part 1: the extension

### 1. Get the files

On the repository's page on GitHub, click **Code → Download ZIP**, and unzip it
somewhere you will keep it (Chrome loads the extension from that folder every
time it starts). Or, with git: `git clone https://github.com/michaelbeijer/MemDesk`.

### 2. Load it into Chrome

1. Open `chrome://extensions` and switch on **Developer mode** (top right).
2. Click **Load unpacked** and choose the folder that has `manifest.json` in it.
3. The extension's setup page opens. Leave it open: it shows the **Redirect
   URI** you need in step 3d. It is the same for everyone:

   `https://lfeogecmdohgofbifobhkolapmjikdih.chromiumapp.org/`

### 3. Your own Google Cloud project (once)

The extension talks to Gmail straight from your browser, which Google allows
through an "OAuth client" in a Cloud project. The project is free and is
yours alone.

**a. Create the project.** Go to
[console.cloud.google.com/projectcreate](https://console.cloud.google.com/projectcreate),
signed in with the account your mail is in. Call it anything (say,
"MemDesk") and click **Create**. Make sure it is the project selected at the
top of the page for the next steps.

**b. Turn on the Gmail API, and the two the calendar uses.** Open each of
these and click **Enable**:

- [the Gmail API](https://console.cloud.google.com/apis/library/gmail.googleapis.com)
- [the Google Calendar API](https://console.cloud.google.com/apis/library/calendar-json.googleapis.com)
- [the Google Tasks API](https://console.cloud.google.com/apis/library/tasks.googleapis.com)

(The last two are only for the **Calendar** tab. Without them the board and
the notes work as ever, and the calendar says which API to switch on.)

**c. Set up the consent screen.** Open
[Google Auth Platform](https://console.cloud.google.com/auth/overview) and click
**Get started**:

- **App information**: any name (it is what Google shows when you sign in) and
  your email address as the support email.
- **Audience**:
  - on a **Google Workspace** account (your own domain), choose **Internal**;
  - on an **@gmail.com** account, choose **External**.
- **Contact information**: your email address. Agree to the policy, and
  **Create**.

On an @gmail.com account (External), one more thing: go to **Audience** and
click **Publish app**, then **Confirm**. You do not need to send it for
review. Leaving it in "Testing" would make Google ask you to sign in again
every seven days; published but unreviewed, it shows a "Google hasn't
verified this app" page when you first connect, which you click through
(it is your own project).

**d. Create the OAuth client.** In Google Auth Platform, open **Clients** and
click **Create client**:

- **Application type**: **Web application**
- **Name**: anything
- **Authorised redirect URIs**: click **Add URI** and paste the redirect URI
  from the setup page, exactly, slash at the end included.

Click **Create**. Copy the **Client ID** it shows (it ends in
`.apps.googleusercontent.com`). You do not need the client secret.

**e. Connect.** On the extension's setup page, paste the client ID, click
**Save**, then **Test connection**. Choose your account and allow access. On
an @gmail.com account, Google first says it "hasn't verified this app": click
**Advanced**, then **Go to …**. The page should then say "Connected as" your
address.

### 4. Use it

Reload Gmail. **Board**, **Notes** and **Calendar** buttons appear at the
bottom left. The first time you open the board, it creates its labels
(`_Board/To do`, `_Board/Doing`, `_Board/Waiting`, `_Board/Done`); the notes
create `_Notes`. The first time you open the calendar, it asks to connect:
click **Connect Google Calendar** and allow it (to see your list of
calendars and change their events and your tasks; the "hasn't verified this
app" page may come up again).
The [README](README.md#usage) explains everything they do.

---

## Part 2: the phone panel

A small Gmail add-on, for your account only, that appears at the bottom of an
open email in the Gmail app (and beside it in Gmail on a computer). It shows
which column of the board the email is in, with a button for each column:
one tap moves it there. (The notes and the calendar on your phone are in the
phone app, part 3, which runs from this same project.) It needs no Cloud
project: Apps Script brings its own.

1. Go to [script.google.com](https://script.google.com), signed in with your
   mail account, and click **New project**. Click "Untitled project" at the
   top and call it MemDesk.
2. Click the gear (**Project Settings**) on the left and tick **Show
   "appsscript.json" manifest file in editor**.
3. Back in the editor (**< >** on the left):
   - click `appsscript.json`, select everything, and paste the contents of
     [`addon/appsscript.json`](addon/appsscript.json) over it;
   - click `Code.gs`, select everything, and paste the contents of
     [`addon/Code.gs`](addon/Code.gs) over it. (It is long: the phone app's page
     is in it too.) If you renamed `_Notes` or `_Board` in Gmail, change
     `MEMDESK_NOTES_LABEL` or `MEMDESK_BOARD_LABEL` at the top;
   - press **Ctrl+S**.
4. Click **Deploy → Test deployments**, then **Install**, then **Done**.
5. Open Gmail on your computer and reload it. The panel's icon is in the strip
   on the right. Click it, then **Authorize access**, choose your account and
   allow it. (If Google says it "hasn't verified this app": **Advanced → Go to
   MemDesk**. It says that about every script that has not been through its
   review, your own included.)
6. On your phone, open the Gmail app, open any email, and scroll to the
   bottom: the icon is in the row of add-ons. Tap the panel's title bar to
   give it the whole screen. If the icon is not there yet, close and reopen
   the app.

---

## Part 3: the phone app

The board, the notes and the calendar on your phone's home screen,
full-screen, with the same editor as in Chrome: formatting, checklists,
folders, search with the words marked, and saving as you type; and your week
as two columns of days. It is served by the same Apps Script project as the phone
panel, so do part 2 first.

1. In the Apps Script project (open [script.google.com/home](https://script.google.com/home)
   and click MemDesk), click **Deploy → Test deployments**. Click the gear
   next to **Select type** and choose **Web app**.
2. Copy the **Web app URL**. It ends in `/dev`, always runs the code you last
   saved, and opens for you alone.
3. Get the address to your phone (email it to yourself, say) and open it in
   **Chrome** on the phone, signed in to the same Google account. The first
   time, Google may ask you to allow access again.
4. In Chrome, tap **⋮ → Add to Home screen → Add**.

The icon on your home screen now opens your notes. They are the same notes as
in Chrome: change one in either, and the other shows the change the next time
it loads. The **Calendar** tab reads your calendars and
tasks with the project's own access, so it needs nothing more.

If the page says "Sorry, unable to open the file at this time", Chrome on
the phone is signed in to more than one Google account and opened it as
another. Open it in an Incognito tab once to check, or use a Chrome profile
with just this account.

---

## Updating

- **The extension**: download the new version over the old folder (or
  `git pull`), then click the reload arrow on its card in `chrome://extensions`
  and reload Gmail.
- **The phone panel and the phone app**: open
  [script.google.com/home](https://script.google.com/home), click MemDesk,
  paste the new `Code.gs` (and `appsscript.json`, if it changed) and press
  **Ctrl+S**. There is nothing to reinstall. The first line
  of `Code.gs` says which version it is.
- **Updating to 0.17.0 (the calendar)**: turn on the Google Calendar API and
  the Google Tasks API in your Cloud project (step 3b), and paste the new
  `appsscript.json` as well as `Code.gs`: it asks for read-only access to
  Calendar and Tasks. Google does not ask for these by itself, so the first
  time, the phone app's **Calendar** tab says Google Calendar and Google
  Tasks need your permission: click **Allow**, allow both on Google's page,
  and go back to the app. (Or, in the script editor, choose `allowCalendar`
  next to **Run**, and run it once.)
- **Updating to 0.24.0 (changing the calendar)**: in Chrome, the first time
  you change something in the calendar it says it needs your permission:
  click **Connect again** and allow it on Google's page (it now asks to
  change events and tasks, not only read them). For the phone app, paste the
  new `appsscript.json` as well as `Code.gs`, then, the first time you change
  something there, click **Allow** (or run `allowCalendar` once in the script
  editor).
- **Updating to 0.21.0 (the panel puts the email on the board, and nothing
  more)**: paste the new `appsscript.json` as well as `Code.gs`. The old one
  names the panel's **All notes** and **New note** menu items, which are gone,
  so leaving it would leave them in the Gmail menu, failing when chosen. The
  permissions are the same, so Google asks for nothing.

## When something goes wrong

| What you see | What it means |
|---|---|
| `redirect_uri_mismatch` when connecting | The redirect URI in the OAuth client (step 3d) is not exactly the one on the setup page. The slash at the end matters. |
| `org_internal` or "access blocked" | The consent screen is Internal, but you signed in with an account outside your Workspace. |
| "Gmail API has not been used in project …" | Step 3b: enable the Gmail API in that project. |
| The calendar says "Google Calendar API (or Tasks API) has not been used in project …" | Step 3b: enable that API too. The message has the link. |
| The calendar says Google Tasks (or Calendar) "was not allowed" | Google's page lets you untick each permission. Click **Connect again** and leave both ticked. |
| The panel says "Run time error … Required permissions" | `appsscript.json` is not the current one. Paste it again. |
| The panel says the Gmail API is not switched on | In the Apps Script editor, open **Services** (left) and check that Gmail is listed; if not, paste `appsscript.json` again and save. |
| The phone app's calendar says an API is not switched on | The same: **Services** should list Gmail, Google Calendar and Tasks. |
| The phone app's calendar says it needs your permission | Click **Allow** next to it and allow both on Google's page. If that does not help: in the script editor, choose `allowCalendar` next to **Run**, run it, and allow what Google asks. |
| The Board, Notes and Calendar buttons are gone from Gmail | Gmail changed its page. The board still opens from the toolbar icon or Alt+Shift+K; please report it. |

## Removing it

- **The extension**: remove it in `chrome://extensions`, and delete the OAuth
  client (or the whole project) in the Cloud console.
- **The phone panel and app**: in Apps Script, **Deploy → Test deployments →
  Uninstall**, then delete the project. To withdraw access as well, see
  [myaccount.google.com/connections](https://myaccount.google.com/connections).
- Your board and notes stay in Gmail as labels and messages either way.

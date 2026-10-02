# Setting up Supermail

*This is for setting up a copy of your own, with your own Google Cloud
project. If someone sent you links to Supermail, follow
[INSTALL.md](INSTALL.md) instead: it is much shorter.*

Supermail has three parts. You need the first; the other two are for your
phone and can be added any time.

| Part | Where it runs | Time | Needs |
|---|---|---|---|
| [1. The extension](#part-1-the-extension) | Chrome on a computer: the board and the notes editor inside Gmail | about 15 minutes | a free Google Cloud project of your own |
| [2. The phone panel](#part-2-the-phone-panel) | the Gmail app on your phone, at the bottom of an open email | about 5 minutes | a free Apps Script project |
| [3. The phone app](#part-3-the-phone-app) | your phone's home screen: the board and the notes, full-screen | about 3 minutes | part 2 |

It works with a Google Workspace account and with an ordinary @gmail.com
account. Nothing is sent anywhere but Google: there is no Supermail server.
Everything lives in your own mailbox, as labels and messages.

---

## Part 1: the extension

### 1. Get the files

On the repository's page on GitHub, click **Code → Download ZIP**, and unzip it
somewhere you will keep it (Chrome loads the extension from that folder every
time it starts). Or, with git: `git clone https://github.com/michaelbeijer/Supermail`.

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
"Supermail") and click **Create**. Make sure it is the project selected at the
top of the page for the next steps.

**b. Turn on the Gmail API.** Open
[the Gmail API page](https://console.cloud.google.com/apis/library/gmail.googleapis.com)
and click **Enable**.

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

Reload Gmail. **Board** and **Notes** buttons appear at the bottom left. The
first time you open the board, it creates its labels (`_Board/To do`,
`_Board/Doing`, `_Board/Waiting`, `_Board/Done`); the notes create `_Notes`.
The [README](README.md#usage) explains everything they do.

---

## Part 2: the phone panel

A small Gmail add-on, for your account only, that appears at the bottom of an
open email in the Gmail app (and beside it in Gmail on a computer). It shows
the open email's place on the board, and your notes: tick checklist items, add
lines, move a note to a folder, search, start a note. It needs no Cloud
project: Apps Script brings its own.

1. Go to [script.google.com](https://script.google.com), signed in with your
   mail account, and click **New project**. Click "Untitled project" at the
   top and call it Supermail.
2. Click the gear (**Project Settings**) on the left. Note the **Time zone**
   shown there, then tick **Show "appsscript.json" manifest file in editor**.
3. Back in the editor (**< >** on the left):
   - click `appsscript.json`, select everything, and paste the contents of
     [`addon/appsscript.json`](addon/appsscript.json) over it. Change
     `"timeZone"` to the one you noted (it only affects times such as
     "edited 3 h");
   - click `Code.gs`, select everything, and paste the contents of
     [`addon/Code.gs`](addon/Code.gs) over it. (It is long: the phone app's page
     is in it too.) If you renamed `_Notes` or `_Board` in Gmail, change
     `SUPERMAIL_NOTES_LABEL` or `SUPERMAIL_BOARD_LABEL` at the top;
   - press **Ctrl+S**.
4. Click **Deploy → Test deployments**, then **Install**, then **Done**.
5. Open Gmail on your computer and reload it. The panel's icon is in the strip
   on the right. Click it, then **Authorize access**, choose your account and
   allow it. (If Google says it "hasn't verified this app": **Advanced → Go to
   Supermail**. It says that about every script that has not been through its
   review, your own included.)
6. On your phone, open the Gmail app, open any email, and scroll to the
   bottom: the icon is in the row of add-ons. Tap the panel's title bar to
   give it the whole screen. If the icon is not there yet, close and reopen
   the app.

---

## Part 3: the phone app

The board and the notes on your phone's home screen, full-screen, with the same editor as
in Chrome: formatting, checklists, folders, search with the words marked, and
saving as you type. It is served by the same Apps Script project as the phone
panel, so do part 2 first.

1. In the Apps Script project (open [script.google.com/home](https://script.google.com/home)
   and click Supermail), click **Deploy → Test deployments**. Click the gear
   next to **Select type** and choose **Web app**.
2. Copy the **Web app URL**. It ends in `/dev`, always runs the code you last
   saved, and opens for you alone.
3. Get the address to your phone (email it to yourself, say) and open it in
   **Chrome** on the phone, signed in to the same Google account. The first
   time, Google may ask you to allow access again.
4. In Chrome, tap **⋮ → Add to Home screen → Add**.

The icon on your home screen now opens your notes. They are the same notes as
in Chrome and in the phone panel: change one anywhere, and the others show the
change the next time they load.

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
  [script.google.com/home](https://script.google.com/home), click Supermail,
  paste the new `Code.gs` (and `appsscript.json`, if it changed, keeping your
  time zone) and press **Ctrl+S**. There is nothing to reinstall. The first line
  of `Code.gs` says which version it is.

## When something goes wrong

| What you see | What it means |
|---|---|
| `redirect_uri_mismatch` when connecting | The redirect URI in the OAuth client (step 3d) is not exactly the one on the setup page. The slash at the end matters. |
| `org_internal` or "access blocked" | The consent screen is Internal, but you signed in with an account outside your Workspace. |
| "Gmail API has not been used in project …" | Step 3b: enable the Gmail API in that project. |
| The panel says "Run time error … Required permissions" | `appsscript.json` is not the current one. Paste it again. |
| The panel says the Gmail API is not switched on | In the Apps Script editor, open **Services** (left) and check that Gmail is listed; if not, paste `appsscript.json` again and save. |
| The Board and Notes buttons are gone from Gmail | Gmail changed its page. The board still opens from the toolbar icon or Alt+Shift+K; please report it. |

## Removing it

- **The extension**: remove it in `chrome://extensions`, and delete the OAuth
  client (or the whole project) in the Cloud console.
- **The phone panel and app**: in Apps Script, **Deploy → Test deployments →
  Uninstall**, then delete the project. To withdraw access as well, see
  [myaccount.google.com/connections](https://myaccount.google.com/connections).
- Your board and notes stay in Gmail as labels and messages either way.

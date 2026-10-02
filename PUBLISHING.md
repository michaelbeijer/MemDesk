# Publishing Supermail for other people

For the publisher: how to give Supermail to people who should not need a
Google Cloud project of their own. They get two links - one to the Chrome
Web Store, one to the phone app - and [INSTALL.md](INSTALL.md) walks them
through the rest.

This is the **unlisted, unverified** way: no review by Google of the app
itself, so it is quick, but people see a "Google hasn't verified this app"
screen once, and **at most 100 people** can ever sign in to it (Google's
limit for unverified apps; it never resets). Going further - public, no
warning, no limit - means Google's verification; see the end.

Everything below is done once, except "Every new version".

---

## 1. A Google Cloud project for everyone's sign-in

Use a **new** project, not the one your own copy uses (that one is
*Internal*, which only lets in your own Workspace domain).

1. [Create a project](https://console.cloud.google.com/projectcreate) called
   "Supermail", and select it at the top of the console for the next steps.
2. Enable [the Gmail API](https://console.cloud.google.com/apis/library/gmail.googleapis.com),
   [the Google Calendar API](https://console.cloud.google.com/apis/library/calendar-json.googleapis.com)
   and [the Google Tasks API](https://console.cloud.google.com/apis/library/tasks.googleapis.com) in it.
3. Open [Google Auth Platform](https://console.cloud.google.com/auth/overview), **Get started**:
   - App name **Supermail**, user support email: yours.
   - Audience: **External**.
   - Contact information: your email. Agree, **Create**.
4. **Branding**: upload `icons/icon-128.png` as the logo; application home
   page `https://github.com/michaelbeijer/Supermail`; privacy policy
   `https://github.com/michaelbeijer/Supermail/blob/main/PRIVACY.md`. Save.
5. **Data access** → **Add or remove scopes**: add
   `https://www.googleapis.com/auth/gmail.modify`, and for the calendar
   `https://www.googleapis.com/auth/calendar.readonly`,
   `https://www.googleapis.com/auth/tasks.readonly` and
   `https://www.googleapis.com/auth/userinfo.email`. Save.
6. **Audience** → **Publish app** → **Confirm** (status "In production").
   No review starts unless you ask for one.
7. **Clients** → **Create client**: type **Web application**, name
   "Supermail extension". Under **Authorised redirect URIs** add
   `https://lfeogecmdohgofbifobhkolapmjikdih.chromiumapp.org/`
   (the repository copy, for trying the build yourself). **Create**, and copy
   the **Client ID**. It is not a secret: it ends up inside the extension.

## 2. Build the package

```
node tools/package-extension.mjs --client-id=YOUR-CLIENT-ID.apps.googleusercontent.com
```

This writes `dist/supermail-<version>.zip`: the extension with your client
built in (so its setup page is one **Connect Gmail** button) and without the
manifest's `key` (the store gives it an ID of its own). Or send the client
ID to whoever maintains the code and ask for the zip.

To try it first: unzip it into a folder, load that folder in
`chrome://extensions` (Developer mode → **Load unpacked**) with your own copy
switched off, and press **Connect Gmail**. That copy has a different ID, so
first add *its* redirect URI (shown in its "Use your own Google Cloud
project" section) to the client from step 1.7.

## 3. The Chrome Web Store

1. Register at the [developer dashboard](https://chrome.google.com/webstore/devconsole)
   (a one-time fee of US$5) with the Google account you want to publish
   under.
2. **New item** → upload the zip.
3. The item's ID appears at the top of its page. Add
   `https://THAT-ID.chromiumapp.org/` to the client's **Authorised redirect
   URIs** (Google Auth Platform → Clients → your client) and save. Without
   it, "Connect Gmail" fails with `redirect_uri_mismatch`.
4. Fill in **Store listing** and **Privacy practices** from
   [store/listing.md](store/listing.md), with the pictures in `store/`.
5. **Distribution**: visibility **Unlisted**.
6. **Submit for review**. It usually takes a few days. Once published, the
   item's page address is the link to give people.

## 4. The phone app, for everyone

In the Apps Script project your own phone panel runs from
([script.google.com/home](https://script.google.com/home) → Supermail):

1. **Deploy → New deployment**, gear → **Web app**.
2. **Execute as: User accessing the web app** - so each person's app works
   on their own Gmail, never yours.
3. **Who has access: Anyone with a Google account**. **Deploy**.
4. Copy the **Web app URL** (it ends in `/exec`): that is the link to give
   people. Your own `/dev` link keeps working as before.

The phone panel inside the Gmail app cannot be shared this way (Google only
lets add-ons out through the Workspace Marketplace), so people who want it
set it up themselves, as in [SETUP.md](SETUP.md) part 2.

## 5. Send the links

Give people the store link and the phone-app link, with
[INSTALL.md](INSTALL.md).

---

## Every new version

1. Raise the version (`manifest.json`, `package.json`), rebuild `Code.gs`
   (`node tools/build-addon.mjs`) and run
   `node tools/package-extension.mjs --client-id=…`.
2. Store dashboard → the item → **Package → Upload new package**, then
   **Submit for review**. Chrome updates everyone by itself once it is through.
3. Apps Script: paste the new `Code.gs` (and `appsscript.json`, if it
   changed), **Ctrl+S**, then **Deploy → Manage deployments** → the web
   app's pencil → **Version: New version** → **Deploy**. The link stays the
   same. When `appsscript.json` asks for more (0.17.0 added read-only
   Calendar and Tasks), everyone is asked to allow it once more the next time
   they open the app.

## Beyond 100 people: Google's verification

To lift the 100-person limit and the warning screen, Google has to verify
the app: in Google Auth Platform → **Verification centre**, with a home page
and privacy policy on a domain you own (supervertaler.com or beijer.uk
would do), a short video showing the sign-in and what Supermail does with
Gmail and with the calendar, and a reason for each permission: `gmail.modify`
(restricted) for the board and the notes, `calendar.readonly` and
`tasks.readonly` (sensitive, which need the review but no security
assessment) for the Calendar tab. It is free but takes weeks. Apps whose Gmail data never leaves the user's device - the Chrome
extension - can usually skip the paid security assessment that comes with
Gmail access; the phone app, which runs on Apps Script, may not, which is a
reason to move it to a plain web page first.

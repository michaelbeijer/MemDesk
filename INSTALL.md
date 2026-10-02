# Installing Supermail

Supermail puts a Kanban board, a notebook and your calendar inside Gmail. This page is for
people who were sent links to it. It takes about two minutes, and you need
nothing but Chrome and your Google account.

(Setting up a copy of your own from this repository instead, with your own
Google Cloud project? That is [SETUP.md](SETUP.md).)

## On your computer

1. Open the **Chrome Web Store link** you were sent, in Chrome, and click
   **Add to Chrome**, then **Add extension**.
2. A Supermail page opens. Click **Connect Gmail**, and choose your Google
   account.
3. Google may say **"Google hasn't verified this app"**. That is because
   Google has not reviewed Supermail yet, not because something is wrong.
   Click **Advanced**, then **Go to Supermail**.
4. Google lists what Supermail may do with your Gmail and asks you to
   allow it. The list is broader than what Supermail does: it never sends
   mail and never deletes anything for good. Click **Continue**.
5. The page says **Connected as** your address. Open
   [Gmail](https://mail.google.com/): the **Board**, **Notes** and
   **Calendar** buttons are at the bottom left.

The first time you open the board, it makes its columns (To do, Doing,
Waiting, Done) as Gmail labels starting with `_Board`; the notes keep
themselves under `_Notes`. The first time you open the calendar, it asks to
connect: click **Connect Google Calendar** and allow it, as in steps 3 and 4.
It only reads your calendars and tasks. The [README](README.md#usage) explains
everything they do.

## On your phone

1. Open the **phone app link** you were sent, in **Chrome** on your phone,
   signed in to the same Google account.
2. Google asks you to allow access, as on the computer (the same
   **Advanced → Go to …** if it says it hasn't verified the app).
3. Your Scratchpad opens; the **Board** and **Calendar** tabs at the top have
   the board and your week. To put the app on your home screen: **⋮ → Add to
   Home screen → Add**.

## If something is not right

| What you see | What to do |
|---|---|
| No Board, Notes or Calendar buttons in Gmail | Reload the Gmail tab. |
| The calendar says Google Tasks (or Calendar) "was not allowed" | Google's page lets you untick each permission. Click **Connect again** and leave both ticked. |
| "Sorry, unable to open the file at this time" on the phone | Chrome on your phone is signed in to more than one Google account and picked another. Open the link in an Incognito tab, or in a Chrome profile with just this account. |
| Gmail asks you to connect again | Click **Connect Gmail** on the board. Google signs you in again after a while, as it does everywhere. |

## Removing it

Remove the extension in `chrome://extensions`, and delete the app from your
home screen. To withdraw its access to your Google account too, see
[myaccount.google.com/connections](https://myaccount.google.com/connections).
Your board and notes stay in Gmail as labels and messages either way.

How Supermail handles your data: [PRIVACY.md](PRIVACY.md).

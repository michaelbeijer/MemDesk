# Supermail privacy policy

*Last updated: 2 October 2026*

Supermail is a Chrome extension, a phone panel in the Gmail app and a
phone app, made by Michael Beijer. This policy says what they do with your
data. The short version: **there is no Supermail server.** Your board and
your notes live in your own Gmail, and the publisher never receives any of
your data.

## What Supermail can see, and why

To work, Supermail asks Google for permission to read and change your Gmail
(the `gmail.modify` permission). With it, Supermail:

- **For the board:** reads the subject, sender, date, snippet and labels of
  the conversations you put on the board, and adds or removes the board's
  labels on them (`_Board/To do` and so on), including taking a conversation
  out of the Inbox when you drop it on a column set to archive.
- **For the notes:** reads the messages under the `_Notes` label and its
  folders, saves each note as a new message there (never in your Inbox, and
  never sent), moves its own older versions and the notes you delete to
  Gmail's Trash, and creates, renames and deletes empty folders under
  `_Notes`.
- **To tell accounts apart:** reads your email address.

The permission Google grants is broader than this. Supermail **never sends
mail, never deletes anything for good**, never touches Spam, and moves
nothing to Trash but its own notes. In the Chrome extension, a gatekeeper in
its background worker refuses any other kind of request before it reaches
Google.

## Where your data is kept

- **In your Gmail:** your board (as labels on your conversations) and your
  notes (as messages under `_Notes`).
- **In Chrome:** the board's column layout and your own card titles, notes
  and colours, in Chrome's sync storage (so they follow your Chrome profile);
  card order and a few view settings in this browser only.
- **The access token** that lets the extension talk to Gmail is kept in
  memory for the browser session only, and is gone when Chrome closes.
- **The phone panel and the phone app** run in Google Apps Script, on
  Google's servers, as you: they read and write your Gmail on your behalf,
  under the same rules, and keep nothing of their own except which folders
  you have folded, in your phone's browser.

## Who your data is shared with

**Nobody.** Supermail talks only to Google's Gmail service. It has no
analytics, no advertising, no tracking, and sends nothing to the publisher or
anyone else. Nothing is sold.

Supermail's use and transfer of information received from Google APIs
adheres to the [Google API Services User Data Policy](https://developers.google.com/terms/api-services-user-data-policy),
including the Limited Use requirements.

## Removing Supermail

Remove the extension in `chrome://extensions`, and withdraw its access to
your Google account at [myaccount.google.com/connections](https://myaccount.google.com/connections).
Your board and notes stay in your Gmail as ordinary labels and messages,
until you delete them there.

## Questions

Ask on [GitHub](https://github.com/michaelbeijer/Supermail/issues), or
through [beijer.uk/contact](https://beijer.uk/contact/). If this policy
changes, the new version will be here, with a new date at the top.

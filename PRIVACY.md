# MemDesk privacy policy

*Last updated: 3 October 2026*

MemDesk is a Chrome extension, a phone panel in the Gmail app and a
phone app, made by Michael Beijer. This policy says what they do with your
data. The short version: **there is no MemDesk server.** Your board and
your notes live in your own Gmail, your calendar stays in Google Calendar and
Google Tasks, and the publisher never receives any of your data.

## What MemDesk can see, and why

To work, MemDesk asks Google for permission to read and change your Gmail
(the `gmail.modify` permission). With it, MemDesk:

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

For the Calendar tab, and only once you allow it there, MemDesk asks
Google for read-only access to Google Calendar and Google Tasks
(`calendar.readonly` and `tasks.readonly`), and for your email address. With
them, it:

- **Reads** the list of your calendars and task lists, the events in the days
  on screen, and your tasks (title, due date, whether it is done, and the
  link to the email a task was made from), to show them.
- **Reads your email address**, to check that the calendar is the one of the
  account open in the tab.

It cannot change, add or delete anything in your calendars or tasks: the
permissions are read-only. Nothing from them is stored; they are read again
when the calendar is shown.

The Gmail permission Google grants is broader than what MemDesk does. MemDesk **never sends
mail, never deletes anything for good**, never touches Spam, and moves
nothing to Trash but its own notes. In the Chrome extension, a gatekeeper in
its background worker refuses any other kind of request before it reaches
Google.

## Where your data is kept

- **In your Gmail:** your board (as labels on your conversations) and your
  notes (as messages under `_Notes`).
- **In Chrome:** the board's column layout and your own card titles, notes
  and colours, in Chrome's sync storage (so they follow your Chrome profile);
  card order and a few view settings (including which calendars to show) in
  this browser only.
- **The access tokens** that let the extension talk to Gmail, and to Calendar
  and Tasks, are kept in memory for the browser session only, and are gone
  when Chrome closes.
- **The phone panel and the phone app** run in Google Apps Script, on
  Google's servers, as you: they read and write your Gmail on your behalf,
  under the same rules (the calendar read-only). In your phone's browser,
  the phone app keeps which folders you have folded and which calendars you
  show, and, so that it opens at once, a copy of your Scratchpad, of the
  list of your notes (titles and first lines) and of the app's settings,
  plus any Scratchpad text not saved yet. That copy never leaves the phone,
  and is replaced each time the app hears from Gmail. The board's layout and
  card edits are kept in the script's settings for your account.

## Who your data is shared with

**Nobody.** MemDesk talks only to Google: Gmail, and for the calendar,
Google Calendar and Google Tasks. It has no
analytics, no advertising, no tracking, and sends nothing to the publisher or
anyone else. Nothing is sold.

MemDesk's use and transfer of information received from Google APIs
adheres to the [Google API Services User Data Policy](https://developers.google.com/terms/api-services-user-data-policy),
including the Limited Use requirements.

## Removing MemDesk

Remove the extension in `chrome://extensions`, and withdraw its access to
your Google account at [myaccount.google.com/connections](https://myaccount.google.com/connections).
Your board and notes stay in your Gmail as ordinary labels and messages,
until you delete them there.

## Questions

Ask on [GitHub](https://github.com/michaelbeijer/MemDesk/issues), or
through [beijer.uk/contact](https://beijer.uk/contact/). If this policy
changes, the new version will be here, with a new date at the top.

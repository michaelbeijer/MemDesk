# MemDesk privacy policy

*Last updated: 8 October 2026*

MemDesk is a Chrome extension, a phone panel in the Gmail app and a
phone app, made by Michael Beijer. This policy says what they do with your
data. The short version: **there is no MemDesk server.** Your board and
your notes live in your own Gmail, your calendar stays in Google Calendar and
Google Tasks, and the publisher never receives any of your data.

## What MemDesk can see, and why

To work, MemDesk asks Google for permission to read and change your Gmail
(the `gmail.modify` permission). With it, MemDesk:

- **For the board:** reads the subject, sender, recipients, date, snippet
  and labels of the conversations you put on the board (the recipients only
  to tell whether you are waiting on someone's reply), and the colours you
  gave your labels in Gmail, and adds or removes the board's
  labels on them (`_Board/To do` and so on), including taking a conversation
  out of the Inbox when you drop it on a column set to archive. It keeps the
  board's column layout as one message, **Board layout**, under `_Board`
  (never in your Inbox, and never sent), so that every computer and phone
  shows the same columns; changing the columns replaces it, and moves the
  old one to Gmail's Trash.
- **For the notes:** reads the messages under the `_Notes` label and its
  folders, saves each note as a new message there (never in your Inbox, and
  never sent), moves its own older versions and the notes you delete to
  Gmail's Trash, and creates, renames and deletes empty folders under
  `_Notes`.
- **To tell accounts apart:** reads your email address.

For the Calendar tab, and only once you allow it there, MemDesk asks
Google to see your list of calendars, to change their events and your tasks
(`calendar.readonly`, `calendar.events` and `tasks`), and for your email
address. With them, it:

- **Reads** the list of your calendars and task lists, the events in the days
  on screen, and your tasks (title, due date, whether it is done, and the
  link to the email a task was made from), to show them.
- **Changes what you change**, and nothing else: an event's title, times,
  place and how it repeats, a task's title, day and whether it is done; and adds an event
  or a task when you add one. Never an event's guests (who would be sent
  invitations), never a calendar itself or who it is shared with.
- **Deletes an event or a task only when you ask**: you choose Delete,
  confirm it, and it waits eight seconds with an Undo before Google is asked
  at all. Only that one event or task - or, for a repeating event, the one
  occurrence or, if you choose "All events", that series - and only if it
  has not been changed in Google since you saw it. Stopping a series
  repeating, which takes its other events away, waits out the same Undo.
- **Reads your email address**, to check that the calendar is the one of the
  account open in the tab.

Events and calendars that MemDesk may not change - shared with you read-only,
birthdays, meetings someone else organises - it only shows. Nothing from
your calendars or tasks is stored; they are read again when the calendar is
shown.

The Gmail permission Google grants is broader than what MemDesk does. MemDesk **never sends
mail, never deletes mail for good**, never touches Spam, and moves
nothing to Trash but its own notes. In the Chrome extension, a gatekeeper in
its background worker refuses any other kind of request before it reaches
Google.

## Where your data is kept

- **In your Gmail:** your board (as labels on your conversations, and its
  column layout as one message under `_Board`) and your notes (as messages
  under `_Notes`).
- **In Chrome:** a copy of the board's column layout, and your own card titles, notes
  and colours, in Chrome's sync storage (so they follow your Chrome profile);
  card order and a few view settings (including which calendars to show) in
  this browser only.
- **The access tokens** that let the extension talk to Gmail, and to Calendar
  and Tasks, are kept in memory for the browser session only, and are gone
  when Chrome closes.
- **The phone panel and the phone app** run in Google Apps Script, on
  Google's servers, as you, under the same rules.
  The panel reads only your list of labels and the labels of the email you
  have open, and changes the board's labels on that email when you move it;
  the app reads and writes your Gmail on your behalf as the extension does.
  In your phone's browser,
  the phone app keeps which folders you have folded and which calendars you
  show, and, so that it opens at once, a copy of your Scratchpad, of the
  list of your notes (titles and first lines) and of the app's settings,
  plus any Scratchpad text not saved yet. That copy never leaves the phone,
  and is replaced each time the app hears from Gmail. The app's copy of the
  board's layout, and its card edits, are kept in the script's settings for
  your account.

## Your licence

MemDesk is free while it is in preview, and then asks for nothing and sends
nothing anywhere about a licence.

Once licences are on sale, MemDesk has a free trial, then needs a licence
key, which it checks with **Lemon Squeezy**, the shop that sells the
licences. It sends Lemon Squeezy only the key and, the first time, a name
for this activation (for example "MemDesk in Chrome, 4 Oct 2026"), so that
you can recognise it in your Lemon Squeezy account. It never sends your
mail, your notes, your calendar, your Google account or any Google sign-in.
It asks about the key now and then, about twice a day while MemDesk is in
use. The key, when the trial started and what Lemon Squeezy last said
about the key are kept in Chrome's sync storage (for the extension) or in
the script's settings for your account (for the phone app and panel). What
Lemon Squeezy does with what it is sent is in its own privacy policy.

## Who your data is shared with

**Nobody.** MemDesk talks only to Google: Gmail, and for the calendar,
Google Calendar and Google Tasks - and, once licences are on sale, to Lemon
Squeezy about your licence key, as above. It has no
analytics, no advertising, no tracking, and sends nothing to the publisher or
anyone else. Nothing is sold.

MemDesk's use and transfer of information received from Google APIs
adheres to the [Google API Services User Data Policy](https://developers.google.com/terms/api-services-user-data-policy),
including the Limited Use requirements.

## The demo on memdesk.app

The website's demo is MemDesk with a made-up mailbox, notes and calendar,
running in your browser. It does not ask for your Google account and sends
nothing anywhere. What you type in it stays in your browser, and a reload
starts afresh.

## Removing MemDesk

Remove the extension in `chrome://extensions`, and withdraw its access to
your Google account at [myaccount.google.com/connections](https://myaccount.google.com/connections).
Your board and notes stay in your Gmail as ordinary labels and messages,
until you delete them there.

## Questions

Ask on [GitHub](https://github.com/michaelbeijer/MemDesk/issues), or
through [beijer.uk/contact](https://beijer.uk/contact/). If this policy
changes, the new version will be here, with a new date at the top.

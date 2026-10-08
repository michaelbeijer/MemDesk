# Privacy and safety

There is no MemDesk server. Your board and your notes live in your own
Gmail, and your calendar stays in Google Calendar and Google Tasks. MemDesk
talks only to Google, from your own browser or your own Google account, and
its maker never receives any of your data. The full policy is on the
[privacy page](https://memdesk.app/privacy/).

## What MemDesk never does

- It **never sends mail**.
- It **never deletes mail for good**. The only things it moves to Gmail's
  Trash are its own notes: old versions, and the notes you delete. Gmail
  keeps them there for 30 days.
- It never touches Spam, and the board never puts anything in your Inbox,
  Spam or Trash.
- It deletes a notes folder only once it is empty.
- In the calendar, it changes only what you change, one event or task at a
  time. It never touches an event's guests (who would be sent
  invitations), a calendar itself, or who a calendar is shared with.
- It deletes an event or a task only when you ask, confirm, and let its
  eight-second Undo pass.
- It has no analytics, no advertising and no tracking, and sells nothing.

When you connect, Google lists what MemDesk may do with your Gmail, and the
list is broader than what MemDesk does. In Chrome, a gatekeeper inside the
extension refuses anything else before it reaches Google.

## Where your data is kept

- **In your Gmail:** the board, as labels on your emails, and your notes,
  as messages under `_Notes`.
- **In Chrome:** the board's columns, and your own card titles, notes and
  colours, in Chrome's sync storage, so they follow your Chrome profile.
  The order of the cards and a few view settings stay in this browser.
- **The keys to your Google account** that the extension uses are kept in
  memory only, and are gone when Chrome closes.
- **The phone panel and the phone app** run in Google Apps Script, on
  Google's servers, as you, under the same rules. So that the app opens at
  once, your phone keeps a copy of your Scratchpad, of the list of your
  notes and of the app's settings. That copy never leaves the phone.
- **Your calendar and tasks** are never stored. They are read again each
  time the calendar is shown.

## Your licence key

While MemDesk is in preview, it asks for nothing and sends nothing anywhere
about a licence. Once licences are on sale, it checks your key with Lemon
Squeezy, the shop that sells them. It sends only the key and, the first
time, a name for this activation: never your mail, your notes, your
calendar or anything about your Google account. See [Licence](licence.md).

## The demo

The [demo](https://memdesk.app/demo/) uses a made-up mailbox, notes and
calendar. It does not ask for your Google account and sends nothing
anywhere. A reload starts afresh.

## Removing MemDesk

Remove the extension in `chrome://extensions`, and delete the app from your
phone's home screen. To withdraw its access to your Google account as well,
go to [myaccount.google.com/connections](https://myaccount.google.com/connections).
Your board and notes stay in Gmail as ordinary labels and messages, until
you delete them there.

Anyone can read every line of MemDesk's code on
[GitHub](https://github.com/michaelbeijer/MemDesk), to check what it does.

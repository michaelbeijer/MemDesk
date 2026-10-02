# Chrome Web Store listing

What to paste into the Chrome Web Store's developer dashboard, field by
field. The pictures are in this folder; `node tools/readme-shots.mjs`
redraws them. See [PUBLISHING.md](../PUBLISHING.md) for the whole process.

## Store listing

**Summary** (the line under the name; 132 characters at most - this is 128):

> A Kanban board, a notebook and your week, inside Gmail. Every card is an email, every note a message in your mailbox. No server.

**Description:**

> Supermail turns Gmail into a Kanban board, a notebook and a calendar, without moving your mail anywhere.
>
> THE BOARD
> • Every card is an email conversation, every column a Gmail label (To do, Doing, Waiting, Done – or your own).
> • Drag a card to the next column; drop it on Done and it leaves the Inbox.
> • Give a card your own title, a note and a colour, without touching the email.
> • While you read an email, one button files it on the board.
>
> THE NOTES
> • Headings, lists, checklists you tick, links – and a paste from Word, Google Docs or Markdown arrives formatted.
> • Saves as you type. Folders, as deep as you like.
> • A Scratchpad that is always open, ready for whatever needs writing down.
> • Search that marks the words, in the list and in the note.
>
> THE CALENDAR
> • Your Google Calendar with Google Tasks in it: the week, the month, or the next four weeks as a list.
> • Tasks with a date sit in their day; the ones without wait at the side. A task made from an email opens the email.
> • Show or hide each calendar and task list with one click. Read-only: it never changes your calendar.
>
> ON YOUR PHONE
> • A home-screen app with the board, your notes, the Scratchpad and your week, and a panel in the Gmail app.
>
> PRIVATE BY DESIGN
> • There is no Supermail server. Everything is in your own Gmail, as labels and messages, and Supermail talks only to Google (Gmail, and Calendar and Tasks for the calendar), from your browser.
> • It never sends mail and never deletes anything for good.
>
> Open source: https://github.com/michaelbeijer/Supermail

**Category:** Productivity › Workflow & Planning
**Language:** English

**Pictures:**

| Field | File |
|---|---|
| Screenshots (1280×800), in this order | `screenshot-1.jpg` … `screenshot-5.jpg` |
| Small promo tile (440×280) | `promo-small.jpg` |
| Store icon (128×128) | `../icons/icon-128.png` |

## Privacy practices

**Single purpose:**

> Organises the user's own working day inside Gmail: shows their email conversations as a Kanban board, by Gmail label, keeps their notes as messages in their own Gmail, and shows their Google Calendar and Google Tasks beside them.

**Permission justifications:**

| Permission | Why |
|---|---|
| `identity` | Signs in with Google (chrome.identity.launchWebAuthFlow) to get a Gmail access token, and, for the calendar, a separate read-only Calendar and Tasks token. |
| `storage` | Keeps the board's column layout, card order, the user's own card titles, notes and colours, which calendars to show, and the short-lived access tokens (session storage only). |
| Host `https://gmail.googleapis.com/*` | The Gmail API, for the board and the notes. |
| Host `https://www.googleapis.com/*` | The Google Calendar API (read-only), and Google's userinfo endpoint to check which account the calendar sign-in belongs to. |
| Host `https://tasks.googleapis.com/*` | The Google Tasks API (read-only), for tasks in the calendar. |
| Content script on `https://mail.google.com/*` | Draws the board, the notes and the "Add to board" button inside Gmail. |
| Remote code | No: every script is in the package. |

**Data usage.** Tick what the extension handles: *Personally identifiable
information* (the account's email address, to tell accounts apart),
*Authentication information* (the access tokens) and *Personal
communications* (email subjects, senders and snippets for the cards, the
notes, and the calendar's events and tasks, which are shown and never
stored). Then certify all three statements: the data is not sold, not
used or transferred for purposes unrelated to the single purpose, and not
used to determine creditworthiness.

**Privacy policy URL:** https://github.com/michaelbeijer/Supermail/blob/main/PRIVACY.md

## Distribution

**Visibility:** Unlisted (only people with the link can find it) for now;
Public once Google has verified the app (see PUBLISHING.md).
**Regions:** all.

# Chrome Web Store listing

What to paste into the Chrome Web Store's developer dashboard, field by
field. The pictures are in this folder; `node tools/readme-shots.mjs`
redraws them. See [PUBLISHING.md](../PUBLISHING.md) for the whole process.

## Store listing

**Summary** (the line under the name; 132 characters at most - this is 121):

> A Kanban board and a notebook, inside Gmail. Every card is an email, every note a message in your own mailbox. No server.

**Description:**

> Supermail turns Gmail into a Kanban board and a notebook, without moving your mail anywhere.
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
> ON YOUR PHONE
> • A home-screen app with your notes and the Scratchpad, and a panel in the Gmail app.
>
> PRIVATE BY DESIGN
> • There is no Supermail server. Everything is in your own Gmail, as labels and messages, and Supermail talks only to Gmail, from your browser.
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

> Organises the user's own Gmail: shows their email conversations as a Kanban board, by Gmail label, and keeps their notes as messages in their own Gmail.

**Permission justifications:**

| Permission | Why |
|---|---|
| `identity` | Signs in with Google (chrome.identity.launchWebAuthFlow) to get a Gmail access token. |
| `storage` | Keeps the board's column layout, card order, the user's own card titles, notes and colours, and the short-lived access token (session storage only). |
| Host `https://gmail.googleapis.com/*` | The Gmail API: the only server the extension talks to. |
| Content script on `https://mail.google.com/*` | Draws the board, the notes and the "Add to board" button inside Gmail. |
| Remote code | No: every script is in the package. |

**Data usage.** Tick what the extension handles: *Personally identifiable
information* (the account's email address, to tell accounts apart),
*Authentication information* (the access token) and *Personal
communications* (email subjects, senders and snippets for the cards, and
the notes). Then certify all three statements: the data is not sold, not
used or transferred for purposes unrelated to the single purpose, and not
used to determine creditworthiness.

**Privacy policy URL:** https://github.com/michaelbeijer/Supermail/blob/main/PRIVACY.md

## Distribution

**Visibility:** Unlisted (only people with the link can find it) for now;
Public once Google has verified the app (see PUBLISHING.md).
**Regions:** all.

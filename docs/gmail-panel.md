# The Gmail panel

The Gmail panel is a small add-on for the Gmail app on your phone. It does
one thing: it puts the email you are reading on the board, as the button
next to **Board** does in Chrome. It also shows in the side panel of Gmail
on a computer.

The notes and the calendar on a phone are in [the phone app](phone-app.md).

## Using it

1. Open an email in the Gmail app, scroll to the bottom and tap the panel's
   icon in the row of add-ons. Tap the panel's title bar to give it the
   whole screen.
2. Its title says where the email is: "On the board: Doing", or "Not on the
   board".
3. There is a button for each column, and the one the email is in is
   filled in. Tap one, and the email moves there at once, out of any other
   column.

A column that archives (Done, to start with) also takes the email out of
the Inbox; the panel says so under the buttons. Tapping Done again archives
an email that a reply has brought back to the Inbox.

**Take off the board** takes the column's label off the email, and leaves
the email where it is. With no email open, the panel just says to open one.

## Its columns

The panel reads the columns from your Gmail labels: every label directly
under `_Board` is a column. To do, Doing, Waiting and Done come first, then
any others in alphabetical order. Only Done archives: if you change which
column archives in Chrome, the panel will not know.

If there are no board labels yet, the panel says so rather than making
them. Open the board once in Chrome or in the phone app, and they are made.

## What it reads

As little as it can: the list of your labels, and the labels of the email
you have open. No subjects, no message text, nothing of your notes.

## Setting it up

If you set up MemDesk yourself, the panel is
[part 2 of SETUP.md](../SETUP.md#part-2-the-phone-panel): a new Apps Script
project with two files pasted in, about five minutes. Afterwards its icon is
in the row of add-ons at the bottom of an email. If it is not there yet,
close the Gmail app and open it again.
